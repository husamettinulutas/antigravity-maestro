import { ModelQuota } from './types';

/**
 * One distinct quota pool, fronted by a single model.
 *
 * Antigravity meters whole model families against one bucket, so twenty rows
 * all move together. Folding them to one entry per bucket is what makes a
 * quota readable in the panel and short enough for the status bar.
 */
export interface QuotaPool<T extends ModelQuota = ModelQuota> {
  /** Model shown as the face of the pool. */
  model: T;
  /** Models drawing from this pool, the representative included. */
  memberCount: number;
}

/**
 * Preferred faces for a pool, most wanted first. Whichever member matches the
 * earliest pattern represents the bucket; anything unmatched falls back to the
 * largest-context model in the pool.
 */
const REPRESENTATIVE_PRIORITY: RegExp[] = [
  /^claude-opus-.*thinking$/,
  /^claude-opus/,
  /^claude-sonnet-.*thinking$/,
  /^claude-sonnet/,
  /^gemini-3-flash-agent$/,
  /^gemini-3(\.\d+)?-pro/,
  /^gemini-3(\.\d+)?-flash/,
  /^gemini/,
  /^gpt-oss/,
];

/** Vendor families, in the order a user cares about them. */
const FAMILIES: { id: string; pattern: RegExp }[] = [
  { id: 'claude', pattern: /^claude/ },
  { id: 'gemini', pattern: /^gemini/ },
  { id: 'gpt', pattern: /^gpt/ },
];

/**
 * Fold models that share a vendor, a reset window and a remaining percentage
 * into one pool each — that combination is the bucket's fingerprint. Models
 * without a reset timestamp cannot be matched up, so they stay on their own.
 *
 * The vendor belongs in the key even though it is not part of the bucket: on a
 * fresh account every model reads 100% on the same window, and merging Claude
 * into Gemini would hide a whole family from the panel.
 *
 * Pools come back tightest-quota-first.
 */
export function quotaPools<T extends ModelQuota>(models: T[]): QuotaPool<T>[] {
  const pools = new Map<string, T[]>();

  for (const model of models) {
    const key = model.resetTime
      ? `${modelFamily(model.modelId)}|${model.resetTime}|${model.percentage}`
      : `model:${model.modelId}`;
    const members = pools.get(key);
    if (members) {
      members.push(model);
    } else {
      pools.set(key, [model]);
    }
  }

  return [...pools.values()]
    .map((members) => ({ model: pickRepresentative(members), memberCount: members.length }))
    .sort(
      (a, b) =>
        a.model.percentage - b.model.percentage ||
        familyRank(modelFamily(a.model.modelId)) - familyRank(modelFamily(b.model.modelId)),
    );
}

/**
 * The tightest pool of each vendor family, in family order — what a glance at
 * the status bar should answer: how much Claude and how much Gemini is left.
 */
export function headlinePools<T extends ModelQuota>(models: T[]): QuotaPool<T>[] {
  const tightest = new Map<string, QuotaPool<T>>();

  for (const pool of quotaPools(models)) {
    const family = modelFamily(pool.model.modelId);
    const current = tightest.get(family);
    if (!current || pool.model.percentage < current.model.percentage) {
      tightest.set(family, pool);
    }
  }

  return [...tightest.entries()]
    .sort(([a], [b]) => familyRank(a) - familyRank(b))
    .map(([, pool]) => pool);
}

/** Short name for a pool, e.g. "Opus", "Gemini", "GPT-OSS". */
export function poolLabel(model: ModelQuota): string {
  const tier = model.modelId.match(/^claude-(opus|sonnet|haiku)/);
  if (tier) {
    return tier[1].charAt(0).toUpperCase() + tier[1].slice(1);
  }
  if (/^gemini/.test(model.modelId)) {
    return 'Gemini';
  }
  if (/^gpt-oss/.test(model.modelId)) {
    return 'GPT-OSS';
  }
  return (model.displayName ?? model.modelId).split(/[\s-]/)[0];
}

function pickRepresentative<T extends ModelQuota>(members: T[]): T {
  const rank = (model: T) => {
    const index = REPRESENTATIVE_PRIORITY.findIndex((pattern) => pattern.test(model.modelId));
    return index === -1 ? REPRESENTATIVE_PRIORITY.length : index;
  };

  return [...members].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.maxTokens ?? 0) - (a.maxTokens ?? 0) ||
      (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId),
  )[0];
}

function modelFamily(modelId: string): string {
  return FAMILIES.find((family) => family.pattern.test(modelId))?.id ?? 'other';
}

function familyRank(family: string): number {
  const index = FAMILIES.findIndex((candidate) => candidate.id === family);
  return index === -1 ? FAMILIES.length : index;
}
