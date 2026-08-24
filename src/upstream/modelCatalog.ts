import { AccountManager } from '../accounts/accountManager';
import { AccountMetadata, ModelQuota } from '../accounts/types';
import { displayNamesFor } from './modelNames';

export type ModelFamily = 'gemini' | 'claude' | 'gpt' | 'image';

export interface CatalogModel {
  /** Upstream model id — written verbatim into every request. */
  id: string;
  displayName: string;
  family: ModelFamily;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** 0 when the model does not think. */
  thinkingBudget: number;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  /** Remaining quota on the account this catalog was built from. */
  quotaPercent?: number;
  /** Which account that quota belongs to — the entries merge across accounts. */
  accountEmail?: string;
  resetTime?: string;
}

/**
 * Per-model output and thinking limits, mirroring what the Antigravity client
 * sends. The upstream rejects requests whose budget exceeds these.
 */
const MODEL_SPECS: Record<string, { maxOutputTokens: number; thinkingBudget: number }> = {
  'gemini-3.5-flash-high': { maxOutputTokens: 65536, thinkingBudget: 10000 },
  'gemini-3.5-flash-medium': { maxOutputTokens: 65536, thinkingBudget: 4000 },
  'gemini-3.5-flash-low': { maxOutputTokens: 65536, thinkingBudget: 1000 },
  'gemini-3.5-flash-extra-low': { maxOutputTokens: 65536, thinkingBudget: 1000 },
  'gemini-3-flash': { maxOutputTokens: 65536, thinkingBudget: 32768 },
  'gemini-3.1-pro-low': { maxOutputTokens: 65536, thinkingBudget: 32768 },
  'gemini-3.1-pro-high': { maxOutputTokens: 65536, thinkingBudget: 32768 },
  'gemini-3-pro-image': { maxOutputTokens: 65536, thinkingBudget: 24576 },
  'claude-sonnet-4-6-thinking': { maxOutputTokens: 64000, thinkingBudget: 32768 },
  'claude-opus-4-6-thinking': { maxOutputTokens: 64000, thinkingBudget: 24576 },
  'gpt-oss-120b-medium': { maxOutputTokens: 32768, thinkingBudget: 0 },
};

const DEFAULT_MAX_OUTPUT_TOKENS = 65535;
const DEFAULT_THINKING_BUDGET = 24576;

/**
 * Names other agents ask for that have no upstream equivalent. Claude Code and
 * Codex send their own model ids for background tasks even after being pointed
 * at explicit ones, so requests still need somewhere sensible to land.
 */
const FALLBACK_ALIASES: Record<string, string> = {
  'claude-3-5-haiku': 'gemini-3.5-flash-low',
  'claude-haiku-4-5': 'gemini-3.5-flash-low',
  'claude-3-haiku': 'gemini-3.5-flash-low',
  'internal-background-task': 'gemini-3.5-flash-low',
  'gpt-5-codex': 'gpt-oss-120b-medium',
  'gpt-4o-mini': 'gemini-3.5-flash-low',
  'gpt-4o': 'gemini-3-flash',
};

/**
 * The models an account can actually call, derived from its live quota data.
 * Model ids are never rewritten: what the upstream reports is what agents get.
 */
export class ModelCatalog {
  constructor(private readonly accounts: AccountManager) {}

  /** Models for one account (defaults to the active one), best quota first. */
  list(accountId?: string): CatalogModel[] {
    const account = accountId ? this.accounts.get(accountId) : this.accounts.getActive();
    if (!account) {
      return [];
    }
    return buildModels(account);
  }

  /** Every model any signed-in account can serve, de-duplicated by id. */
  listAll(): CatalogModel[] {
    const merged = new Map<string, CatalogModel>();
    for (const account of this.accounts.list()) {
      for (const model of buildModels(account)) {
        const existing = merged.get(model.id);
        // Keep the entry with the most remaining quota — it is the one a
        // request would be routed to.
        if (!existing || (model.quotaPercent ?? 0) > (existing.quotaPercent ?? 0)) {
          merged.set(model.id, model);
        }
      }
    }
    return [...merged.values()].sort(compareModels);
  }

  get(modelId: string, accountId?: string): CatalogModel | undefined {
    return this.list(accountId).find((model) => model.id === modelId);
  }

  /**
   * Map a requested model id onto one this account can serve.
   * Exact ids win; otherwise a documented fallback, otherwise the best
   * available model of the same family.
   */
  resolve(requestedId: string, accountId?: string): CatalogModel | undefined {
    const models = this.list(accountId);
    if (models.length === 0) {
      return undefined;
    }

    const normalized = normalizeId(requestedId);
    const exact = models.find((model) => normalizeId(model.id) === normalized);
    if (exact) {
      return exact;
    }

    const aliased = FALLBACK_ALIASES[normalized];
    if (aliased) {
      const target = models.find((model) => model.id === aliased);
      if (target) {
        return target;
      }
    }

    const family = familyOf(normalized);
    const sameFamily = models.filter((model) => model.family === family && model.supportsTools);
    if (sameFamily.length > 0) {
      return sameFamily.sort(compareModels)[0];
    }

    return models.filter((model) => model.supportsTools).sort(compareModels)[0];
  }

  /** Output/thinking limits for a model id, even when it is not in the catalog. */
  limitsFor(modelId: string, accountId?: string): { maxOutputTokens: number; thinkingBudget: number } {
    const model = this.get(modelId, accountId);
    if (model) {
      return { maxOutputTokens: model.maxOutputTokens, thinkingBudget: model.thinkingBudget };
    }
    const spec = MODEL_SPECS[normalizeId(modelId)];
    return {
      maxOutputTokens: spec?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      thinkingBudget: spec?.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
    };
  }
}

function buildModels(account: AccountMetadata): CatalogModel[] {
  const quotas = Object.values(account.quota?.models ?? {});
  const names = displayNamesFor(quotas);
  return quotas
    .map((quota) => toCatalogModel(quota, account.email, names[quota.modelId]))
    .sort(compareModels);
}

function toCatalogModel(quota: ModelQuota, accountEmail: string, name: string): CatalogModel {
  const id = quota.modelId;
  const spec = MODEL_SPECS[normalizeId(id)];
  const family = familyOf(id);

  return {
    id,
    displayName: name,
    family,
    maxInputTokens: quota.maxTokens && quota.maxTokens > 0 ? quota.maxTokens : defaultContext(family),
    maxOutputTokens:
      quota.maxOutputTokens && quota.maxOutputTokens > 0
        ? quota.maxOutputTokens
        : (spec?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    thinkingBudget: resolveThinkingBudget(quota, spec),
    supportsThinking: quota.supportsThinking ?? (spec ? spec.thinkingBudget > 0 : false),
    supportsImages: quota.supportsImages ?? false,
    // Image generation models reject tool declarations outright.
    supportsTools: family !== 'image',
    quotaPercent: quota.percentage,
    accountEmail,
    resetTime: quota.resetTime || undefined,
  };
}

function resolveThinkingBudget(
  quota: ModelQuota,
  spec: { thinkingBudget: number } | undefined,
): number {
  if (quota.supportsThinking === false) {
    return 0;
  }
  if (typeof quota.thinkingBudget === 'number' && quota.thinkingBudget >= 0) {
    return quota.thinkingBudget;
  }
  return spec?.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
}

function defaultContext(family: ModelFamily): number {
  return family === 'claude' ? 200_000 : 1_048_576;
}

export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (id.includes('image') || id.includes('imagen')) {
    return 'image';
  }
  if (id.startsWith('claude')) {
    return 'claude';
  }
  if (id.startsWith('gpt')) {
    return 'gpt';
  }
  return 'gemini';
}

function normalizeId(modelId: string): string {
  return modelId.trim().replace(/^models\//i, '').toLowerCase();
}

/** Highest remaining quota first, then alphabetical for a stable list. */
function compareModels(a: CatalogModel, b: CatalogModel): number {
  const quotaDiff = (b.quotaPercent ?? 0) - (a.quotaPercent ?? 0);
  if (quotaDiff !== 0) {
    return quotaDiff;
  }
  return a.displayName.localeCompare(b.displayName);
}
