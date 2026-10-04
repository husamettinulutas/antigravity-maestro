import type { CatalogModel } from './modelCatalog';

/**
 * Thinking-effort support for the `*-tiered` Gemini Flash models.
 *
 * The upstream serves these as one id whose reasoning depth is chosen by the
 * request, not as separate Low/Medium/High ids. VS Code can show that choice
 * in the model picker when the model declares a `configurationSchema`; the
 * chosen value arrives in `options.modelConfiguration`.
 */

export type ThinkingEffort = 'low' | 'medium' | 'high';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high'];

export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

/** The upstream's own Flash tiers (1k / 4k / 10k). High takes the whole budget. */
const TIER_BUDGETS: Record<Exclude<ThinkingEffort, 'high'>, number> = {
  low: 1000,
  medium: 4000,
};

export function isTieredModel(modelId: string): boolean {
  return modelId.trim().replace(/^models\//i, '').toLowerCase().endsWith('-tiered');
}

export function parseThinkingEffort(value: unknown): ThinkingEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return (THINKING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingEffort)
    : undefined;
}

/**
 * The effort to run a request with: what the picker chose, else the
 * `antigravityMaestro.thinkingEffort` setting, else high.
 */
export function resolveThinkingEffort(
  modelConfiguration: { readonly [key: string]: any } | undefined,
  settingValue?: unknown,
): ThinkingEffort {
  return (
    parseThinkingEffort(modelConfiguration?.thinkingEffort) ??
    parseThinkingEffort(settingValue) ??
    DEFAULT_THINKING_EFFORT
  );
}

/** No effort goes past the model's own budget. */
export function budgetForTier(effort: ThinkingEffort, ceiling: number): number {
  return effort === 'high' ? ceiling : Math.min(TIER_BUDGETS[effort], ceiling);
}

/** Schema for the picker: a "Thinking Effort" choice shown as a primary action. */
export function thinkingEffortSchema(defaultEffort: ThinkingEffort) {
  return {
    properties: {
      thinkingEffort: {
        type: 'string',
        title: 'Thinking Effort',
        description: 'How much the model reasons before answering.',
        enum: [...THINKING_EFFORTS],
        enumItemLabels: ['Low', 'Medium', 'High'],
        default: defaultEffort,
        group: 'navigation',
      },
    },
  };
}

const SPLIT_NAME = /^(.*\S)\s+\((high|medium|low|extra low|minimal)\)$/i;

/**
 * Drop the models that are one effort level of a model that already has a
 * Thinking Effort control — `Gemini 3.8 Flash (High)` next to
 * `Gemini 3.8 Flash`, whose picker offers High itself.
 *
 * A model is only hidden when a tiered model of the same name exists, so
 * nothing disappears without a replacement (Gemini Pro, Claude, ... stay).
 * The ids stay usable: only the list is shorter.
 */
export function withoutSplitEffortModels<T extends Pick<CatalogModel, 'id' | 'displayName'>>(
  models: readonly T[],
): T[] {
  const tieredNames = new Set(
    models.filter((model) => isTieredModel(model.id)).map((model) => model.displayName.toLowerCase()),
  );
  return models.filter((model) => {
    if (isTieredModel(model.id)) {
      return true;
    }
    const base = SPLIT_NAME.exec(model.displayName)?.[1];
    return !(base && tieredNames.has(base.toLowerCase()));
  });
}
