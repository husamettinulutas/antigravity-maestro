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
  constructor(message: string) {
    super(message);
    this.name = 'NoAccountAvailableError';
  }
}

interface Cooldown {
  until: number;
  reason: string;
}

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
  ): Promise<T> {
    const candidates = this.orderCandidates(requestedModel);
    if (candidates.length === 0) {
      throw new NoAccountAvailableError(this.explainNoCandidates());
    }

    let lastError: unknown;

    for (const account of candidates) {
      const model = this.catalog.resolve(requestedModel, account.id);
      if (!model) {
        Logger.debug(`${account.email} has no model matching '${requestedModel}'`);
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
    throw new NoAccountAvailableError(this.explainNoCandidates());
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
    const fallbackMs = Config.rotationCooldownMinutes() * 60_000;
    const durationMs = retryAfterSeconds ? retryAfterSeconds * 1000 : fallbackMs;
    this.cooldowns.set(cooldownKey(accountId, modelId), {
      until: Date.now() + durationMs,
      reason,
    });
  }

  /** Remaining cooldown in seconds, or 0 when the account is usable. */
  cooldownSeconds(accountId: string, modelId: string): number {
    const cooldown = this.cooldowns.get(cooldownKey(accountId, modelId));
    if (!cooldown) {
      return 0;
    }
    if (cooldown.until <= Date.now()) {
      this.cooldowns.delete(cooldownKey(accountId, modelId));
      return 0;
    }
    return Math.ceil((cooldown.until - Date.now()) / 1000);
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
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
      // No rotation was asked for, so the upstream error is the honest answer.
      return active ? [active] : [];
    }

    const usable = this.accounts
      .list()
      .filter((account) => !account.needsReauth)
      .filter((account) => {
        const model = this.catalog.resolve(requestedModel, account.id);
        return model ? this.cooldownSeconds(account.id, model.id) === 0 : false;
      });

    if (usable.length === 0) {
      return active ? [active] : [];
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

  private explainNoCandidates(): string {
    const all = this.accounts.list();
    if (all.length === 0) {
      return 'No Google account has been added yet — run "Antigravity Maestro: Add Google Account".';
    }
    if (all.every((account) => account.needsReauth)) {
      return 'Every account needs to sign in again.';
    }
    return 'No account currently has quota for this model. Refresh quotas or wait for the reset.';
  }
}

function cooldownKey(accountId: string, modelId: string): string {
  return `${accountId}::${modelId}`;
}
