/**
 * Thinking-effort support for the `*-tiered` Gemini Flash models.
 *
 * The upstream serves these as one id whose reasoning depth is chosen by the
 * request, not as separate Low/Medium/High ids. VS Code can show that choice
 * in the model picker when the model declares a `configurationSchema`; the
 * chosen value arrives in `options.modelConfiguration`. The effort becomes a
 * budget through `budgetForEffort`, the same table Claude Code's `--effort`
 * goes through, so both clients think alike at the same effort.
 */

export type ThinkingEffort = 'low' | 'medium' | 'high';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high'];

export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

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
 * `antigravityMaestro.copilot.thinkingEffort` setting, else high.
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
