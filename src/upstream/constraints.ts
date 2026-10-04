import { GenerationConfig } from '../protocol/gemini';

export interface ModelLimits {
  maxOutputTokens: number;
  thinkingBudget: number;
}

/**
 * Clamp a request's generation config to what the model actually accepts.
 *
 * The Cloud Code endpoints reject requests whose thinking budget exceeds the
 * model's own limit, or whose max output tokens leave no room for the thinking
 * budget, so both are normalised here rather than trusting the caller.
 */
export function applyGenerationConstraints(
  config: GenerationConfig,
  modelId: string,
  limits: ModelLimits,
): void {
  const outputCap = Math.max(1, limits.maxOutputTokens);
  const normalizedModel = modelId.replace(/^models\//i, '').trim().toLowerCase();
  const thinking = config.thinkingConfig;

  // Opus 4.6 rejects the generic thinking defaults; this is the exact
  // combination the Antigravity client sends for it.
  if (normalizedModel === 'claude-opus-4-6-thinking' && thinking) {
    thinking.includeThoughts = true;
    thinking.thinkingBudget = Math.min(24_576, limits.thinkingBudget, outputCap - 1);
    delete thinking.thinkingLevel;
    config.maxOutputTokens = Math.min(57_344, outputCap);
    delete config.stopSequences;
    return;
  }

  if (thinking) {
    if (!normalizedModel.includes('claude') && typeof thinking.thinkingLevel === 'string') {
      const converted = budgetForThinkingLevel(thinking.thinkingLevel);
      if (converted !== undefined) {
        thinking.thinkingBudget = converted;
      }
      delete thinking.thinkingLevel;
    }

    if (typeof thinking.thinkingBudget === 'number' && thinking.thinkingBudget < 0) {
      // -1 means "let the model decide" upstream, which these endpoints reject.
      thinking.thinkingBudget = Math.min(limits.thinkingBudget, 24_576);
    }

    if (typeof thinking.thinkingBudget === 'number' && Number.isFinite(thinking.thinkingBudget)) {
      thinking.thinkingBudget = Math.max(
        0,
        Math.min(Math.floor(thinking.thinkingBudget), outputCap - 1, limits.thinkingBudget),
      );

      // Output tokens must leave room for the thoughts plus a real answer.
      if (
        config.maxOutputTokens === undefined ||
        config.maxOutputTokens <= thinking.thinkingBudget
      ) {
        const overhead = config.maxOutputTokens === undefined ? 32_768 : 8_192;
        config.maxOutputTokens = Math.min(outputCap, thinking.thinkingBudget + overhead);
      }
    }

    if (thinking.thinkingBudget === 0) {
      delete config.thinkingConfig;
    }
  }

  if (typeof config.maxOutputTokens === 'number' && Number.isFinite(config.maxOutputTokens)) {
    config.maxOutputTokens = Math.min(Math.floor(config.maxOutputTokens), outputCap);
  }
}

/**
 * The thinking budget for a client that asks for an effort rather than a
 * number — Claude Code sends `output_config.effort` with adaptive thinking,
 * Codex sends `reasoning.effort`, and Copilot's picker a Thinking Effort.
 *
 * `ceiling` is the model's own budget, and no effort goes past it: the top
 * efforts get all of it, the lower ones a share, so a low-effort title or
 * quick question stops paying for ten thousand tokens of reasoning. Gemini's
 * shares follow the upstream's own Flash tiers (1k / 4k / 10k).
 *
 * Codex can ask for less than low (`minimal`, `none`), and gets low's share:
 * a budget of 0 drops the thinking config, and the model then thinks as much
 * as it likes.
 */
export function budgetForEffort(
  effort: string | undefined,
  modelId: string,
  ceiling: number,
): number {
  const claude = modelId.toLowerCase().includes('claude');
  const share: Record<string, number> = claude
    ? { low: 4096, medium: 8192, high: 16_384, xhigh: 24_576 }
    : { low: 1024, medium: 4096 };
  const level = effort?.trim().toLowerCase();
  const key = level === 'minimal' || level === 'none' ? 'low' : level;
  const budget = key && Object.hasOwn(share, key) ? share[key] : undefined;
  return budget === undefined ? ceiling : Math.min(budget, ceiling);
}

function budgetForThinkingLevel(level: string): number | undefined {
  switch (level.trim().toUpperCase()) {
    case 'NONE':
      return 0;
    case 'LOW':
      return 4096;
    case 'MEDIUM':
      return 8192;
    case 'HIGH':
      return 24576;
    default:
      return undefined;
  }
}

/** Headers the upstream expects for particular model families. */
export function modelSpecificHeaders(modelId: string): Record<string, string> {
  if (modelId.toLowerCase().includes('claude')) {
    return {
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    };
  }
  return {};
}
