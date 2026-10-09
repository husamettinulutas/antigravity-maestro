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
 * Preferred faces for a pool when the upstream has not said which models are
 * current, most wanted first. Whichever member matches the earliest pattern
 * represents the bucket — the newest Claude version among them, so a pool
 * holding Opus 4.6 and 5.5 is named after 5.5 — and anything unmatched falls
 * back to the largest-context model in the pool.
 */
const REPRESENTATIVE_PRIORITY: RegExp[] = [
  /^claude-opus/,
  /^claude-sonnet/,
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

function pickRepresentative<T extends ModelQuota>(members: T[]): T {
  const rank = (model: T) => {
    const index = REPRESENTATIVE_PRIORITY.findIndex((pattern) => pattern.test(model.modelId));
    return index === -1 ? REPRESENTATIVE_PRIORITY.length : index;
  };

  const version = (model: T) => claudeVersion(model.modelId)?.order ?? 0;
  const thinks = (model: T) => (/-thinking$/.test(model.modelId) ? 1 : 0);

  // The Antigravity client's own model list comes first: a model it no longer
  // offers can still be in the quota reading, and naming the Gemini pool after
  // one that cannot be called is what the pinned "3.5 Flash" face did.
  const listed = (model: T) => model.agentOrder ?? Number.MAX_SAFE_INTEGER;

  return [...members].sort(
    (a, b) =>
      listed(a) - listed(b) ||
      rank(a) - rank(b) ||
      version(b) - version(a) ||
      thinks(b) - thinks(a) ||
      (b.maxTokens ?? 0) - (a.maxTokens ?? 0) ||
      (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId),
  )[0];
}

/**
 * `claude-opus-5-5-medium` → 5.5, `claude-sonnet-4-20250514` → 4. A dated
 * snapshot's date is not a minor version, so the minor is one or two digits.
 */
function claudeVersion(modelId: string): { label: string; order: number } | undefined {
  const match = modelId.match(/^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = match[2] === undefined ? undefined : Number(match[2]);
  return {
    label: minor === undefined ? `${major}` : `${major}.${minor}`,
    order: major * 100 + (minor ?? 0),
  };
}

/** Vendor family of a model id: 'claude', 'gemini', 'gpt', or 'other'. */
export function modelFamily(modelId: string): string {
  return FAMILIES.find((family) => family.pattern.test(modelId))?.id ?? 'other';
}

function familyRank(family: string): number {
  const index = FAMILIES.findIndex((candidate) => candidate.id === family);
  return index === -1 ? FAMILIES.length : index;
}
