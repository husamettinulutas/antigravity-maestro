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
 * How long an account is skipped after the upstream refused it outright.
 *
 * A 403 is not a rate limit and does not lift on its own within a window, so
 * it gets a flat wait rather than the escalating one: long enough that a
 * blocked account stops costing every turn a doomed round trip, short enough
 * that an account the user has just verified is picked back up on its own.
 */
const FORBIDDEN_COOLDOWN_SECONDS = 5 * 60;

/**
 * How long a lapsed cooldown is remembered. The record has to outlive its own
 * expiry, otherwise the strike count is gone by the time the account is next
 * tried and a genuinely exhausted account backs off by the base wait forever.
 */
const STRIKE_MEMORY_MS = 10 * 60_000;

/**
 * Consecutive accounts refused with a rate limit before the limit is read as
 * the client's rather than any one account's.
 *
 * The endpoints also meter the caller as a whole — the production host in
 * particular answers `RESOURCE_EXHAUSTED` regardless of which account signs
 * the request. Treating each of those as a per-account refusal walked the
 * rotation through every signed-in account, spent a doomed request on each,
 * put all of them on cooldown, and reported "every account is unavailable"
 * over a limit no account had earned. Three healthy-looking accounts refused
 * in a row with the same wait is that limit, not three coincidences.
 */
const SHARED_LIMIT_STRIKES = 3;

/** Retry delays this close together are the same window being reported. */
const SHARED_LIMIT_SPREAD_SECONDS = 5;

interface SharedCooldown {
  until: number;
  reason: string;
}

/** One rate limit in the current sweep, for spotting a shared window. */
interface RateLimitStrike {
  modelId: string;
  retryAfterSeconds: number | undefined;
}

/** How the accounts split when nothing could serve a request. */
interface AccountSummary {
  total: number;
  needsReauth: number;
  noCatalog: number;
  coolingDown: number;
  /** Cooling down because the upstream refused the account (403). */
  refused: number;
}

/**
 * Picks the account each request runs on and retries on another one when the
 * chosen account is rate limited or out of quota.
 */
export class AccountLease {
  private readonly cooldowns = new Map<string, Cooldown>();
  /** Windows that apply to the client as a whole, keyed by upstream model id. */
  private readonly sharedCooldowns = new Map<string, SharedCooldown>();
  private roundRobinIndex = 0;

  constructor(
    private readonly accounts: AccountManager,
    private readonly catalog: ModelCatalog,
    private readonly history: QuotaHistory,
  ) {}

  /**
   * Run `execute` against the best available account for `requestedModel`.
   * Rate limited accounts are put on cooldown and the next candidate is tried.
   *
   * When every account runs out mid-request the shortest window is waited out
   * once and the whole selection is retried, because that window is usually
   * seconds long: reporting it straight back is what turned a burst of
   * parallel turns into a failed one.
   */
  async run<T>(
    requestedModel: string,
    execute: (context: LeaseContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    let waited = false;

    for (;;) {
      const candidates = this.orderCandidates(requestedModel);
      if (candidates.length > 0) {
        const outcome = await this.tryCandidates(requestedModel, candidates, execute);
        if (outcome.served) {
          return outcome.result as T;
        }
        lastError = outcome.error ?? lastError;
      }

      // Sending anyway would earn another rate limit and burn more quota, so
      // the wait is taken here or reported to the client — that is what stops
      // a retrying client from hammering an account with no headroom left.
      if (!waited && (await this.waitForRecovery(requestedModel, signal))) {
        waited = true;
        continue;
      }
      break;
    }

    // A rate limit that outlasts the wait is reported as a wait, not as the
    // raw upstream failure: the client gets the seconds to come back in, and
    // the user gets a sentence instead of a 429 stack trace.
    const retryAfter = this.shortestCooldown(requestedModel);
    if (retryAfter !== undefined || lastError === undefined) {
      throw new NoAccountAvailableError(this.explainNoCandidates(requestedModel), retryAfter);
    }
    throw lastError;
  }

  /**
   * Try each candidate in turn. Returns without a result once they have all
   * refused in a way another account could survive; anything else is thrown.
   */
  private async tryCandidates<T>(
    requestedModel: string,
    candidates: AccountMetadata[],
    execute: (context: LeaseContext) => Promise<T>,
  ): Promise<{ served: boolean; result?: T; error?: unknown }> {
    let lastError: unknown;
    const strikes: RateLimitStrike[] = [];

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
        return { served: true, result };
      } catch (error) {
        lastError = error;

        if (error instanceof UpstreamError && error.isRateLimit) {
          this.markCooldown(account.id, model.id, error.retryAfterSeconds, error.message);
          strikes.push({ modelId: model.id, retryAfterSeconds: error.retryAfterSeconds });

          if (looksShared(strikes)) {
            // The rest of the list would only add a doomed request per account
            // to a limit that is not theirs — and, since every request from
            // this install counts against it, push the window further out.
            this.markSharedCooldown(model.id, error.retryAfterSeconds, error.message);
            Logger.warn(
              `${strikes.length} accounts in a row were rate limited on ${model.id} with the ` +
                'same wait; treating it as a limit on this client rather than on the accounts ' +
                `and leaving ${candidates.length - strikes.length} untried`,
            );
            return { served: false, error };
          }

          Logger.warn(`${account.email} is rate limited on ${model.id}; trying another account`);
          continue;
        }
        // A refusal that is about the account breaks the run of identical
        // rate limits — whatever comes after it is a fresh observation.
        strikes.length = 0;
        if (error instanceof UpstreamError && error.isAuthFailure) {
          Logger.warn(`${account.email} was rejected with 401; trying another account`);
          continue;
        }
        if (error instanceof UpstreamError && error.isForbidden) {
          // A 403 is the upstream refusing this account — one that has run out
          // of its allowance for good, or needs verifying — not a bad request,
          // so every other account is still worth trying. Rotating here is
          // what stops a single blocked account from failing the whole
          // session, and the cooldown stops each parallel turn from
          // rediscovering the same refusal.
          this.markCooldown(
            account.id,
            model.id,
            error.retryAfterSeconds ?? FORBIDDEN_COOLDOWN_SECONDS,
            error.message,
          );
          Logger.warn(
            `${account.email} was refused on ${model.id} (403: ${error.message}); ` +
              'trying another account' +
              (error.needsUserAction
                ? ' — this one stays refused until it is verified or added again'
                : ''),
          );
          continue;
        }
        // Anything else (bad request, upstream outage) would fail identically
        // on every account — surface it instead of burning through them.
        throw error;
      }
    }

    return { served: false, error: lastError };
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

  /**
   * Put a model on cooldown for every account at once, because the limit that
   * came back was the client's rather than the account's.
   */
  markSharedCooldown(modelId: string, retryAfterSeconds: number | undefined, reason: string): void {
    const now = Date.now();
    const durationMs = retryAfterSeconds ? retryAfterSeconds * 1000 : BASE_COOLDOWN_MS;
    const existing = this.sharedCooldowns.get(modelId);
    this.sharedCooldowns.set(modelId, {
      until: Math.max(now + durationMs, existing?.until ?? 0),
      reason: `this client, not one account, is rate limited: ${reason}`,
    });
  }

  /**
   * Remaining cooldown in seconds, or 0 when the account is usable. Covers both
   * the account's own window and one the whole client is inside.
   */
  cooldownSeconds(accountId: string, modelId: string): number {
    return Math.max(
      this.accountCooldownSeconds(accountId, modelId),
      this.sharedCooldownSeconds(modelId),
    );
  }

  private accountCooldownSeconds(accountId: string, modelId: string): number {
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

  private sharedCooldownSeconds(modelId: string): number {
    const cooldown = this.sharedCooldowns.get(modelId);
    if (!cooldown) {
      return 0;
    }
    const remainingMs = cooldown.until - Date.now();
    if (remainingMs <= 0) {
      this.sharedCooldowns.delete(modelId);
      return 0;
    }
    return Math.ceil(remainingMs / 1000);
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
    this.sharedCooldowns.clear();
  }

  /** Forget an account's rate-limit history once it serves a request again. */
  private clearCooldown(accountId: string, modelId: string): void {
    this.cooldowns.delete(cooldownKey(accountId, modelId));
    // Being served proves the model is not walled off for the whole client.
    this.sharedCooldowns.delete(modelId);
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

  /** Why the soonest-recovering account is unavailable, when it is known. */
  private reasonFor(requestedModel: string): string | undefined {
    let soonest: { until: number; reason: string } | undefined;
    const now = Date.now();
    for (const account of this.accounts.list()) {
      if (account.needsReauth) {
        continue;
      }
      const model = this.catalog.resolve(requestedModel, account.id);
      if (!model) {
        continue;
      }
      // A window on the whole client explains every account at once, so it is
      // reported ahead of the account's own — which, for the accounts that
      // were tried before it was recognised, describes the same refusal.
      const own = this.cooldowns.get(cooldownKey(account.id, model.id));
      const shared = this.sharedCooldowns.get(model.id);
      const effective: { until: number; reason: string } | undefined =
        shared && shared.until > now ? shared : own && own.until > now ? own : undefined;
      if (effective && (!soonest || effective.until < soonest.until)) {
        soonest = effective;
      }
    }
    return soonest?.reason;
  }

  /** How the accounts split for a model — what the error message reports. */
  private summarize(requestedModel: string): AccountSummary {
    const summary: AccountSummary = {
      total: 0,
      needsReauth: 0,
      noCatalog: 0,
      coolingDown: 0,
      refused: 0,
    };
    for (const account of this.accounts.list()) {
      summary.total += 1;
      if (account.needsReauth) {
        summary.needsReauth += 1;
        continue;
      }
      const model = this.catalog.resolve(requestedModel, account.id);
      if (!model) {
        summary.noCatalog += 1;
        continue;
      }
      if (this.cooldownSeconds(account.id, model.id) === 0) {
        continue;
      }
      // "Verify your account to continue" is the account holder's to fix, and
      // lumping it in with rate limits sent the user to wait out a window
      // that was never going to close.
      const own = this.cooldowns.get(cooldownKey(account.id, model.id));
      if (own && own.until > Date.now() && /HTTP 403/.test(own.reason)) {
        summary.refused += 1;
      } else {
        summary.coolingDown += 1;
      }
    }
    return summary;
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
    const candidates = activeIsUsable ? [active!, ...ordered] : ordered;

    // An account whose quota for this model already reads empty goes last,
    // however it was ordered. Starting on one spends a doomed request and
    // earns a rate limit before the rotation has even begun, and the active
    // account — always tried first — is the usual victim: it is the one the
    // user just watched run out. They are demoted rather than dropped, because
    // a stale or missing reading must never be what leaves a request with
    // nowhere to go.
    const spent = candidates.filter((account) => !this.hasHeadroom(account, requestedModel));
    return spent.length === 0
      ? candidates
      : [...candidates.filter((account) => this.hasHeadroom(account, requestedModel)), ...spent];
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

  /** False only when the account's quota for this model is known to be spent. */
  private hasHeadroom(account: AccountMetadata, requestedModel: string): boolean {
    const percent = this.catalog.resolve(requestedModel, account.id)?.quotaPercent;
    return percent === undefined || percent > 0;
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
    // "Every account" used to hide how many accounts were actually in the
    // running: one whose quota was never fetched has no catalog and is passed
    // over silently, so a single rate-limited account read as twelve. The
    // split is spelled out so the user — and the log — can see which it was.
    const breakdown = describeAccounts(this.summarize(requestedModel));
    const wait = this.shortestCooldown(requestedModel);
    if (wait !== undefined) {
      // The reason is carried through because a cooldown is no longer always a
      // rate limit: an account the upstream refused outright cools down too,
      // and reporting that as "rate limited" sent the user looking at quotas
      // that were never the problem.
      const reason = this.reasonFor(requestedModel);
      return reason
        ? `Every account is unavailable for this model (${reason}). Try again in ${wait}s. ${breakdown}`
        : `Every account is rate limited on this model. Try again in ${wait}s. ${breakdown}`;
    }
    return `No account currently has quota for this model. Refresh quotas or wait for the reset. ${breakdown}`;
  }
}

function cooldownKey(accountId: string, modelId: string): string {
  return `${accountId}::${modelId}`;
}

/**
 * True when the run of rate limits reads as one window rather than several.
 *
 * Accounts run out independently, so their windows end at different times;
 * a limit on the client comes back with the same wait for each. Delays that
 * disagree are kept as per-account refusals, so a spent account does not stop
 * the rotation from reaching a fresh one.
 */
function looksShared(strikes: RateLimitStrike[]): boolean {
  if (strikes.length < SHARED_LIMIT_STRIKES) {
    return false;
  }
  const recent = strikes.slice(-SHARED_LIMIT_STRIKES);
  const modelId = recent[0].modelId;
  if (recent.some((strike) => strike.modelId !== modelId)) {
    return false;
  }
  const delays = recent.map((strike) => strike.retryAfterSeconds);
  if (delays.every((delay) => delay === undefined)) {
    return true;
  }
  if (delays.some((delay) => delay === undefined)) {
    return false;
  }
  const known = delays as number[];
  return Math.max(...known) - Math.min(...known) <= SHARED_LIMIT_SPREAD_SECONDS;
}

/** `[12 accounts: 2 cooling down, 9 without quota data, 1 needs sign-in]` */
function describeAccounts(summary: AccountSummary): string {
  const parts: string[] = [];
  if (summary.coolingDown > 0) {
    parts.push(`${summary.coolingDown} cooling down`);
  }
  if (summary.refused > 0) {
    parts.push(`${summary.refused} refused by Google (verify the account)`);
  }
  if (summary.noCatalog > 0) {
    parts.push(`${summary.noCatalog} without quota data`);
  }
  if (summary.needsReauth > 0) {
    parts.push(`${summary.needsReauth} need${summary.needsReauth === 1 ? 's' : ''} sign-in`);
  }
  const noun = summary.total === 1 ? 'account' : 'accounts';
  return parts.length > 0
    ? `[${summary.total} ${noun}: ${parts.join(', ')}]`
    : `[${summary.total} ${noun}]`;
}
