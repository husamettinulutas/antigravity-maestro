import { CatalogModel, ModelCatalog } from '../upstream/modelCatalog';
import { UpstreamError } from '../upstream/cloudCodeClient';
import { UsageMetadata } from '../protocol/gemini';
import { Config } from '../utils/config';
import { Logger } from '../utils/logger';
import { AccountManager } from './accountManager';
import { QuotaHistory } from './quotaHistory';
import { AccountMetadata } from './types';

export interface LeaseContext {
  accountId: string;
  email: string;
  accessToken: string;
  projectId?: string;
  /** The model this account will actually serve. */
  model: CatalogModel;
}

export class NoAccountAvailableError extends Error {
  constructor(
    message: string,
    /** Seconds the client should wait before asking again, when known. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'NoAccountAvailableError';
  }
}

interface Cooldown {
  until: number;
  reason: string;
  /** Rate limits in a row, so repeated failures back off further each time. */
  strikes: number;
}

/** First backoff when the upstream gives no `retry-after`. */
const BASE_COOLDOWN_MS = 30_000;

/**
 * How long a lapsed cooldown is remembered. The record has to outlive its own
 * expiry, otherwise the strike count is gone by the time the account is next
 * tried and a genuinely exhausted account backs off by the base wait forever.
 */
const STRIKE_MEMORY_MS = 10 * 60_000;

/**
 * Picks the account each request runs on and retries on another one when the
 * chosen account is rate limited or out of quota.
 */
export class AccountLease {
  private readonly cooldowns = new Map<string, Cooldown>();
  private roundRobinIndex = 0;

  constructor(
    private readonly accounts: AccountManager,
    private readonly catalog: ModelCatalog,
    private readonly history: QuotaHistory,
  ) {}

  /**
   * Run `execute` against the best available account for `requestedModel`.
   * Rate limited accounts are put on cooldown and the next candidate is tried.
   */
  async run<T>(
    requestedModel: string,
    execute: (context: LeaseContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let candidates = this.orderCandidates(requestedModel);
    if (candidates.length === 0 && (await this.waitForRecovery(requestedModel, signal))) {
      candidates = this.orderCandidates(requestedModel);
    }
    if (candidates.length === 0) {
      // Sending anyway would earn another rate limit and burn more quota, so
      // the wait is reported instead — that is what stops a retrying client
      // from hammering an account that is already out of headroom.
      throw new NoAccountAvailableError(
        this.explainNoCandidates(requestedModel),
        this.shortestCooldown(requestedModel),
      );
    }

    let lastError: unknown;

    for (const account of candidates) {
      const model = this.catalog.resolve(requestedModel, account.id);
      if (!model) {
        Logger.debug(`${account.email} has no model matching '${requestedModel}'`);
        continue;
      }
      if (this.cooldownSeconds(account.id, model.id) > 0) {
        // A request that started alongside this one may have rate limited the
        // account since the candidates were ordered. Claude Code opens several
        // turns at once, so without this re-check a single exhausted window is
        // reported once per parallel turn and backs the account off that many
        // times over.
        continue;
      }

      try {
        const accessToken = await this.accounts.getAccessToken(account.id);
        const result = await execute({
          accountId: account.id,
          email: account.email,
          accessToken,
          projectId: account.projectId,
          model,
        });

        this.clearCooldown(account.id, model.id);
        await this.promoteIfRotated(account);
        return result;
      } catch (error) {
        lastError = error;

        if (error instanceof UpstreamError && error.isRateLimit) {
          this.markCooldown(account.id, model.id, error.retryAfterSeconds, error.message);
          Logger.warn(`${account.email} is rate limited on ${model.id}; trying another account`);
          continue;
        }
        if (error instanceof UpstreamError && error.isAuthFailure) {
          Logger.warn(`${account.email} was rejected with 401; trying another account`);
          continue;
        }
        // Anything else (bad request, upstream outage) would fail identically
        // on every account — surface it instead of burning through them.
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new NoAccountAvailableError(
      this.explainNoCandidates(requestedModel),
      this.shortestCooldown(requestedModel),
    );
  }

  /** Record the token spend of a completed request. */
  async recordUsage(context: LeaseContext, usage: UsageMetadata | undefined): Promise<void> {
    if (!usage) {
      return;
    }
    await this.history.recordUsage({
      at: Date.now(),
      accountId: context.accountId,
      modelId: context.model.id,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      thoughtTokens: usage.thoughtsTokenCount,
    });
  }

  /** Put an account's model on cooldown so it is skipped until it recovers. */
  markCooldown(
    accountId: string,
    modelId: string,
    retryAfterSeconds: number | undefined,
    reason: string,
  ): void {
    const key = cooldownKey(accountId, modelId);
    const existing = this.cooldowns.get(key);
    const now = Date.now();
    const capMs = Math.max(BASE_COOLDOWN_MS, Config.rotationCooldownMinutes() * 60_000);

    // Parallel requests all learn about the same exhausted window at the same
    // moment, so a limit that lands while the account is *already* cooling down
    // is that one window being reported again — not a fresh offence. Counting
    // it turned one burst of three turns into a four-minute lockout over a
    // sixty-second window.
    const strikes =
      existing === undefined || now - existing.until > STRIKE_MEMORY_MS
        ? 1
        : existing.until > now
          ? existing.strikes
          : existing.strikes + 1;

    // Without a `retry-after` the wait doubles per consecutive rate limit, so a
    // one-off blip costs 30s while a genuinely exhausted account backs off to
    // the configured maximum.
    const durationMs = retryAfterSeconds
      ? retryAfterSeconds * 1000
      : Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), capMs);
    // A concurrent report must never shorten a wait already in force.
    const until = Math.max(now + durationMs, existing?.until ?? 0);
    this.cooldowns.set(key, { until, reason, strikes });
  }

  /** Remaining cooldown in seconds, or 0 when the account is usable. */
  cooldownSeconds(accountId: string, modelId: string): number {
    const key = cooldownKey(accountId, modelId);
    const cooldown = this.cooldowns.get(key);
    if (!cooldown) {
      return 0;
    }
    const remainingMs = cooldown.until - Date.now();
    if (remainingMs <= 0) {
      // The lapsed record is kept for its strike count — dropping it here is
      // what stopped the backoff from ever escalating on a repeat offender.
      if (-remainingMs > STRIKE_MEMORY_MS) {
        this.cooldowns.delete(key);
      }
      return 0;
    }
    return Math.ceil(remainingMs / 1000);
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  /** Forget an account's rate-limit history once it serves a request again. */
  private clearCooldown(accountId: string, modelId: string): void {
    this.cooldowns.delete(cooldownKey(accountId, modelId));
  }

  /**
   * Hold a request until a cooling-down account comes back, when the wait is
   * short enough to be worth it.
   *
   * A rate-limit window is usually a minute or less, and reporting it straight
   * back turned it into a visible failure: the client retried at once, found
   * the same cooldown, and the user saw a run of errors for what was really a
   * short pause. Returns true when it is worth re-ordering the candidates.
   */
  private async waitForRecovery(
    requestedModel: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const budgetSeconds = Config.rotationMaxWaitSeconds();
    const wait = this.shortestCooldown(requestedModel);
    if (budgetSeconds <= 0 || wait === undefined || wait > budgetSeconds || signal?.aborted) {
      return false;
    }

    // Everything queued behind one window would otherwise resume in lockstep
    // and exhaust it again on the first tick, so the resumes are spread out.
    const delayMs = wait * 1000 + Math.floor(Math.random() * 1000);
    Logger.info(`Every account is cooling down on '${requestedModel}'; waiting ${wait}s`);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, delayMs);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      }
      signal?.addEventListener('abort', finish, { once: true });
    });

    return !signal?.aborted;
  }

  /** Shortest wait across every account that could serve the model. */
  private shortestCooldown(requestedModel: string): number | undefined {
    const waits = this.accounts
      .list()
      .filter((account) => !account.needsReauth)
      .map((account) => {
        const model = this.catalog.resolve(requestedModel, account.id);
        return model ? this.cooldownSeconds(account.id, model.id) : 0;
      })
      .filter((seconds) => seconds > 0);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /**
   * The accounts to try, in order. The active account always goes first while
   * it can serve the model — rotation is a fallback for when it cannot, not a
   * load balancer that overrides the user's choice.
   */
  private orderCandidates(requestedModel: string): AccountMetadata[] {
    const active = this.accounts.getActive();
    const strategy = Config.rotationStrategy();

    if (strategy === 'manual') {
      // No rotation was asked for, so it is this account or nothing — but a
      // cooling-down account is still skipped rather than re-hammered.
      return active && this.isUsable(active, requestedModel) ? [active] : [];
    }

    const usable = this.accounts
      .list()
      .filter((account) => this.isUsable(account, requestedModel));

    if (usable.length === 0) {
      return [];
    }

    const fallbacks = usable.filter((account) => account.id !== active?.id);
    const ordered =
      strategy === 'highest-quota-first'
        ? [...fallbacks].sort(
            (a, b) => this.quotaOf(b, requestedModel) - this.quotaOf(a, requestedModel),
          )
        : this.rotate(fallbacks);

    const activeIsUsable = active !== undefined && usable.some((a) => a.id === active.id);
    return activeIsUsable ? [active!, ...ordered] : ordered;
  }

  /** True when the account can serve the model right now. */
  private isUsable(account: AccountMetadata, requestedModel: string): boolean {
    if (account.needsReauth) {
      return false;
    }
    const model = this.catalog.resolve(requestedModel, account.id);
    return model ? this.cooldownSeconds(account.id, model.id) === 0 : false;
  }

  private rotate(accounts: AccountMetadata[]): AccountMetadata[] {
    if (accounts.length <= 1) {
      return accounts;
    }
    const offset = this.roundRobinIndex % accounts.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % accounts.length;
    return [...accounts.slice(offset), ...accounts.slice(0, offset)];
  }

  private quotaOf(account: AccountMetadata, requestedModel: string): number {
    const model = this.catalog.resolve(requestedModel, account.id);
    return model?.quotaPercent ?? 0;
  }

  /** Make a rotated-to account the active one so the UI matches reality. */
  private async promoteIfRotated(account: AccountMetadata): Promise<void> {
    if (Config.rotationStrategy() === 'manual') {
      return;
    }
    const active = this.accounts.getActive();
    if (active?.id !== account.id) {
      Logger.info(`Switched active account to ${account.email}`);
      await this.accounts.setActive(account.id);
    }
  }

  private explainNoCandidates(requestedModel: string): string {
    const all = this.accounts.list();
    if (all.length === 0) {
      return 'No Google account has been added yet — run "Antigravity Maestro: Add Google Account".';
    }
    if (all.every((account) => account.needsReauth)) {
      return 'Every account needs to sign in again.';
    }
    const wait = this.shortestCooldown(requestedModel);
    if (wait !== undefined) {
      return `Every account is rate limited on this model. Try again in ${wait}s.`;
    }
    return 'No account currently has quota for this model. Refresh quotas or wait for the reset.';
  }
}

function cooldownKey(accountId: string, modelId: string): string {
  return `${accountId}::${modelId}`;
}
