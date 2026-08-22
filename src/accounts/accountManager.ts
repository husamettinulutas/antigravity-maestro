import * as vscode from 'vscode';
import { randomToken } from '../utils/ids';
import { Logger } from '../utils/logger';
import { Config } from '../utils/config';
import { buildAuthUrl, exchangeCode, getUserInfo, refreshAccessToken } from '../auth/googleAuth';
import { startLoopbackServer } from '../auth/loopbackServer';
import { AccountStore } from './accountStore';
import { fetchQuota, QuotaForbiddenError, QuotaUnauthorizedError } from './quotaService';
import { QuotaHistory } from './quotaHistory';
import { AccessToken, AccountMetadata } from './types';

/** Refresh an access token this long before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export class AccountManager implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever accounts, the active account, or quota data change. */
  readonly onDidChange = this.onDidChangeEmitter.event;

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

  /** The account requests use by default. Falls back to the first usable one. */
  getActive(): AccountMetadata | undefined {
    const activeId = this.store.getActiveId();
    if (activeId) {
      return this.store.get(activeId);
    }
    return this.list().find((account) => !account.needsReauth) ?? this.list()[0];
  }

  async setActive(accountId: string): Promise<void> {
    await this.store.setActiveId(accountId);
    this.onDidChangeEmitter.fire();
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
      const snapshot = await fetchQuota(accessToken);

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

  /** Refresh every account's quota, in parallel but tolerating failures. */
  async refreshAllQuotas(): Promise<void> {
    await Promise.all(this.list().map((account) => this.refreshQuota(account.id)));
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
  }
}
