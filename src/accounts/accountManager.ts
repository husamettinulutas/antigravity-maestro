import * as vscode from 'vscode';
import { randomToken } from '../utils/ids';
import { Logger } from '../utils/logger';
import { Config } from '../utils/config';
import { buildAuthUrl, exchangeCode, getUserInfo, refreshAccessToken } from '../auth/googleAuth';
import { startLoopbackServer } from '../auth/loopbackServer';
import { isTieredModel } from '../upstream/thinkingEffort';
import { AccountStore } from './accountStore';
import { fetchQuota, QuotaForbiddenError, QuotaUnauthorizedError } from './quotaService';
import { QuotaHistory } from './quotaHistory';
import { AccessToken, AccountMetadata, ModelQuota, QuotaSnapshot, RetiredModel } from './types';
import { mapWithConcurrency } from '../utils/concurrency';

/** Refresh an access token this long before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;

/** Accounts whose quota is being read at once during a full refresh. */
const QUOTA_REFRESH_CONCURRENCY = 3;

export class AccountManager implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever accounts, the active account, or quota data change. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChooseActiveEmitter = new vscode.EventEmitter<string>();
  /**
   * Fires when the user picks the active account — never when rotation moves
   * it. A choice made by hand outranks the account a conversation was on.
   */
  readonly onDidChooseActive = this.onDidChooseActiveEmitter.event;

  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private autoRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly history: QuotaHistory,
  ) {}

  // ── Reading state ──────────────────────────────────────────────────────────

  list(): AccountMetadata[] {
    return this.store.list();
  }

  get(accountId: string): AccountMetadata | undefined {
    return this.store.get(accountId);
  }

  /** Names this window to the gateways of every window. */
  get windowKey(): string {
    return this.store.windowKey;
  }

  /**
   * The account requests from `window` use by default — this window when it
   * is left out. Falls back to the first usable one.
   */
  getActive(window?: string): AccountMetadata | undefined {
    const activeId = this.store.getActiveId(window);
    if (activeId) {
      return this.store.get(activeId);
    }
    return this.list().find((account) => !account.needsReauth) ?? this.list()[0];
  }

  /**
   * Reorder the accounts. The list order is the order rotation falls back
   * through, so this is the user setting which account backs up which.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    await this.store.reorder(orderedIds);
    this.onDidChangeEmitter.fire();
  }

  /**
   * Make `accountId` the active account of `window` — this one when it is left
   * out. `byUser` is false when rotation moved it.
   */
  async setActive(accountId: string, byUser = true, window?: string): Promise<void> {
    await this.store.setActiveId(accountId, byUser, window);
    if (window !== undefined && window !== this.store.windowKey) {
      return;
    }
    this.onDidChangeEmitter.fire();
    if (byUser) {
      this.onDidChooseActiveEmitter.fire(accountId);
    }
  }

  /** When the user last picked `window`'s account by hand. */
  chosenAt(window?: string): number | undefined {
    return this.store.chosenAt(window);
  }

  // ── Sign-in ────────────────────────────────────────────────────────────────

  /**
   * Run the full Google sign-in flow and store the resulting account.
   * Returns the account, or undefined when the user cancelled.
   */
  async addAccount(): Promise<AccountMetadata | undefined> {
    const state = randomToken(16);
    const session = await startLoopbackServer(state);

    try {
      const authUrl = buildAuthUrl(session.redirectUri, state);
      const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
      if (!opened) {
        throw new Error('Could not open the browser for Google sign-in');
      }

      const code = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Waiting for Google sign-in in your browser…',
          cancellable: true,
        },
        (_progress, token) => {
          token.onCancellationRequested(() => session.dispose());
          return session.waitForCode();
        },
      );

      const tokens = await exchangeCode(code, session.redirectUri);
      if (!tokens.refresh_token) {
        throw new Error(
          'Google did not return a refresh token. Remove this app from your Google account permissions and sign in again.',
        );
      }

      const profile = await getUserInfo(tokens.access_token);
      const existing = this.store.get(profile.id);

      const account: AccountMetadata = {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        oauthClientKey: tokens.oauthClientKey,
        addedAt: existing?.addedAt ?? Date.now(),
        projectId: existing?.projectId,
        subscriptionTier: existing?.subscriptionTier,
        needsReauth: false,
        lastError: undefined,
        quota: existing?.quota,
      };

      await this.store.setRefreshToken(account.id, tokens.refresh_token);
      await this.store.upsert(account);
      this.cacheAccessToken(account.id, tokens.access_token, tokens.expires_in);

      if (!this.store.getActiveId()) {
        await this.store.setActiveId(account.id);
      }
      this.onDidChangeEmitter.fire();

      // Quota also resolves the project id, which generate calls need.
      void this.refreshQuota(account.id);
      return account;
    } catch (error) {
      if (error instanceof Error && /cancel/i.test(error.message)) {
        Logger.info('Google sign-in cancelled');
        return undefined;
      }
      throw error;
    } finally {
      session.dispose();
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    this.accessTokens.delete(accountId);
    this.inFlightRefresh.delete(accountId);
    await this.store.remove(accountId);
    await this.history.forget(accountId);
    this.onDidChangeEmitter.fire();
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * A valid access token for the account, refreshing it when needed.
   * Concurrent callers share one refresh so a burst of requests cannot spend
   * the refresh token several times over.
   */
  async getAccessToken(accountId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.accessTokens.get(accountId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }

    const pending = this.inFlightRefresh.get(accountId);
    if (pending) {
      return pending;
    }

    const refresh = this.performRefresh(accountId, signal).finally(() => {
      this.inFlightRefresh.delete(accountId);
    });
    this.inFlightRefresh.set(accountId, refresh);
    return refresh;
  }

  private async performRefresh(accountId: string, signal?: AbortSignal): Promise<string> {
    const account = this.store.get(accountId);
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    const refreshToken = await this.store.getRefreshToken(accountId);
    if (!refreshToken) {
      await this.markNeedsReauth(accountId, 'No stored refresh token');
      throw new Error(`${account.email} needs to sign in again.`);
    }

    try {
      const tokens = await refreshAccessToken(refreshToken, account.oauthClientKey, signal);
      // Google rotates refresh tokens for some clients; persist the new one.
      if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
        await this.store.setRefreshToken(accountId, tokens.refresh_token);
      }
      if (account.needsReauth || account.lastError) {
        await this.store.patch(accountId, { needsReauth: false, lastError: undefined });
        this.onDidChangeEmitter.fire();
      }
      this.cacheAccessToken(accountId, tokens.access_token, tokens.expires_in);
      return tokens.access_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markNeedsReauth(accountId, message);
      throw new Error(`${account.email}: sign-in expired (${message})`);
    }
  }

  private cacheAccessToken(accountId: string, token: string, expiresInSeconds: number): void {
    this.accessTokens.set(accountId, {
      token,
      expiresAt: Date.now() + Math.max(expiresInSeconds, 60) * 1000,
    });
  }

  private async markNeedsReauth(accountId: string, reason: string): Promise<void> {
    this.accessTokens.delete(accountId);
    await this.store.patch(accountId, { needsReauth: true, lastError: reason });
    this.onDidChangeEmitter.fire();
  }

  // ── Quota ──────────────────────────────────────────────────────────────────

  /** Refresh one account's quota snapshot, project id and tier. */
  async refreshQuota(accountId: string): Promise<void> {
    const account = this.store.get(accountId);
    if (!account) {
      return;
    }

    try {
      const accessToken = await this.getAccessToken(accountId);
      const snapshot = withoutRetired(await fetchQuota(accessToken), this.store.retiredModels());

      await this.store.patch(accountId, {
        quota: snapshot,
        subscriptionTier: snapshot.subscriptionTier ?? account.subscriptionTier,
        projectId: snapshot.projectId ?? account.projectId,
        lastError: undefined,
      });
      await this.history.recordQuota(accountId, snapshot);
      this.onDidChangeEmitter.fire();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(`Quota refresh failed for ${account.email}: ${message}`);

      if (error instanceof QuotaUnauthorizedError) {
        await this.markNeedsReauth(accountId, message);
        return;
      }
      if (error instanceof QuotaForbiddenError) {
        await this.store.patch(accountId, {
          lastError: message,
          quota: { ...(account.quota ?? { fetchedAt: Date.now(), models: {} }), isForbidden: true },
        });
      } else {
        await this.store.patch(accountId, { lastError: message });
      }
      this.onDidChangeEmitter.fire();
    }
  }

  /**
   * Withdraw a model the upstream answered with its "no longer available"
   * notice, on every account, for good.
   *
   * Nothing in the model list marks such a model — it keeps its quota reading
   * and its place in the table — so the notice is the only word the extension
   * gets, and each picker kept offering a model that could only ever answer
   * with that sentence. The notice names the model without its effort
   * ("Gemini 3.5 Flash"), so every effort of it goes together, and each is
   * pointed at the same effort of the model the notice names instead.
   *
   * Returns the id requests for `modelId` should now go to, if one was found.
   */
  async retireModel(
    modelId: string,
    retiredName: string,
    successorName: string | undefined,
  ): Promise<string | undefined> {
    const models = this.list().flatMap((account) => Object.values(account.quota?.models ?? {}));
    const ids = new Set([modelId]);
    for (const model of models) {
      if (namedAs(model, retiredName)) {
        ids.add(model.modelId);
      }
    }

    const live = models.filter((model) => !ids.has(model.modelId));
    const retired = { ...this.store.retiredModels() };
    for (const id of ids) {
      const before = models.find((model) => model.modelId === id);
      retired[id] = {
        name: retiredName,
        successor: successorName ? successorFor(before, successorName, live) : undefined,
        at: Date.now(),
      };
    }
    await this.store.setRetiredModels(retired);

    for (const account of this.list()) {
      if (account.quota) {
        await this.store.patch(account.id, { quota: withoutRetired(account.quota, retired) });
      }
    }

    Logger.info(
      `Antigravity no longer serves ${retiredName}; withdrew ` +
        [...ids].map((id) => `${id} → ${retired[id].successor ?? 'nearest model'}`).join(', '),
    );
    this.onDidChangeEmitter.fire();
    return retired[modelId].successor;
  }

  /**
   * Refresh every account's quota, a few at a time and tolerating failures.
   *
   * Every refresh is up to three round trips per account, and firing them all
   * at once — twelve accounts on activation, again every ten minutes — was a
   * burst the quota endpoints answered with 429s. An account whose reading was
   * refused that way had no model catalog, and no catalog meant the rotation
   * never considered it. Pacing the refresh keeps the readings landing.
   */
  async refreshAllQuotas(): Promise<void> {
    await mapWithConcurrency(this.list(), QUOTA_REFRESH_CONCURRENCY, (account) =>
      this.refreshQuota(account.id),
    );
  }

  /** Start the background quota refresh loop (no-op when disabled). */
  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const minutes = Config.quotaAutoRefreshMinutes();
    if (minutes <= 0) {
      return;
    }
    this.autoRefreshTimer = setInterval(
      () => {
        void this.refreshAllQuotas();
      },
      minutes * 60 * 1000,
    );
    this.autoRefreshTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.onDidChangeEmitter.dispose();
    this.onDidChooseActiveEmitter.dispose();
  }
}

/**
 * A quota reading without the models the upstream has withdrawn, each pointed
 * at its successor while the account is offered one.
 */
function withoutRetired(
  snapshot: QuotaSnapshot,
  retired: Record<string, RetiredModel>,
): QuotaSnapshot {
  const ids = Object.keys(retired).filter((id) => snapshot.models[id]);
  if (ids.length === 0) {
    return snapshot;
  }
  const models = { ...snapshot.models };
  const forwardingRules = { ...snapshot.forwardingRules };
  for (const id of ids) {
    delete models[id];
    const successor = retired[id].successor;
    if (successor && models[successor] && !forwardingRules[id]) {
      forwardingRules[id] = successor;
    }
  }
  return { ...snapshot, models, forwardingRules };
}

/** True when `name` is this model's name, with or without its effort. */
function namedAs(model: ModelQuota, name: string): boolean {
  const label = model.displayName?.trim().toLowerCase();
  const wanted = name.trim().toLowerCase();
  return label !== undefined && (label === wanted || label.startsWith(`${wanted} (`));
}

/**
 * The model a withdrawn one's requests go to: the named successor at the same
 * effort, else the one the Antigravity client lists first, else any of them.
 *
 * A tiered model's name carries no effort — each request picks its own — so
 * its same-effort successor is the successor's tiered model.
 */
function successorFor(
  retired: ModelQuota | undefined,
  successorName: string,
  live: ModelQuota[],
): string | undefined {
  const named = live.filter((model) => namedAs(model, successorName));
  const tiered =
    retired && isTieredModel(retired.modelId)
      ? named.find((model) => isTieredModel(model.modelId))
      : undefined;
  if (tiered) {
    return tiered.modelId;
  }
  const effort = retired?.displayName?.match(/\([^)]*\)\s*$/)?.[0];
  const sameEffort = effort
    ? named.find((model) => model.displayName?.trim().endsWith(effort))
    : undefined;
  if (sameEffort) {
    return sameEffort.modelId;
  }
  const listed = named
    .filter((model) => model.agentOrder !== undefined)
    .sort((a, b) => a.agentOrder! - b.agentOrder!)[0];
  return (listed ?? named[0])?.modelId;
}
