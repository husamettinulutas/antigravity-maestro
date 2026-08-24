import * as vscode from 'vscode';
import { modelFamily } from './quotaPools';
import { QuotaSample, QuotaSnapshot, UsageSample } from './types';

const QUOTA_SAMPLES_KEY = 'antigravityMaestro.quotaSamples';
const USAGE_SAMPLES_KEY = 'antigravityMaestro.usageSamples';

/** Keep the stored history bounded so globalState stays small. */
const MAX_QUOTA_SAMPLES = 2000;
const MAX_USAGE_SAMPLES = 2000;
/** Skip a new quota sample when nothing moved and the last one is this recent. */
const QUOTA_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** One reading in an account's timeline. */
export interface TrendPoint {
  at: number;
  /** Lowest remaining quota across every model at that moment. */
  min: number;
  /** The same, per vendor family — one number per family hides the others. */
  byFamily: Record<string, number>;
}

export interface UsageTotals {
  accountId: string;
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Thinking tokens, which a thinking model bills as output on top of it. */
  thoughtTokens: number;
}

/**
 * Rolling history of quota readings and token spend, used by the stats view.
 * Everything lives in globalState — it is diagnostic data, not credentials.
 */
export class QuotaHistory {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly globalState: vscode.Memento) {}

  quotaSamples(accountId?: string): QuotaSample[] {
    const samples = this.globalState.get<QuotaSample[]>(QUOTA_SAMPLES_KEY, []);
    return accountId ? samples.filter((sample) => sample.accountId === accountId) : samples;
  }

  usageSamples(accountId?: string): UsageSample[] {
    const samples = this.globalState.get<UsageSample[]>(USAGE_SAMPLES_KEY, []);
    return accountId ? samples.filter((sample) => sample.accountId === accountId) : samples;
  }

  /** Record a quota reading per model, skipping unchanged back-to-back samples. */
  async recordQuota(accountId: string, snapshot: QuotaSnapshot): Promise<void> {
    const existing = this.globalState.get<QuotaSample[]>(QUOTA_SAMPLES_KEY, []);
    const additions: QuotaSample[] = [];

    for (const model of Object.values(snapshot.models)) {
      const previous = findLast(
        existing,
        (sample) => sample.accountId === accountId && sample.modelId === model.modelId,
      );
      const unchanged = previous?.percentage === model.percentage;
      const recent = previous && snapshot.fetchedAt - previous.at < QUOTA_SAMPLE_MIN_INTERVAL_MS;
      if (unchanged && recent) {
        continue;
      }
      additions.push({
        at: snapshot.fetchedAt,
        accountId,
        modelId: model.modelId,
        percentage: model.percentage,
      });
    }

    if (additions.length === 0) {
      return;
    }

    await this.globalState.update(
      QUOTA_SAMPLES_KEY,
      trim([...existing, ...additions], MAX_QUOTA_SAMPLES),
    );
    this.onDidChangeEmitter.fire();
  }

  /** Record the token spend reported by one upstream response. */
  async recordUsage(sample: UsageSample): Promise<void> {
    if (sample.inputTokens === 0 && sample.outputTokens === 0) {
      return;
    }
    const existing = this.globalState.get<UsageSample[]>(USAGE_SAMPLES_KEY, []);
    await this.globalState.update(
      USAGE_SAMPLES_KEY,
      trim([...existing, sample], MAX_USAGE_SAMPLES),
    );
    this.onDidChangeEmitter.fire();
  }

  /**
   * Per-account quota timeline: one point per refresh, holding the lowest
   * remaining quota across that account's models at that moment — and the same
   * per vendor family, because a single lowest number reads as the whole
   * account being spent when it is usually one family that is.
   */
  series(limitPerAccount = 40): { accountId: string; points: TrendPoint[] }[] {
    const byAccount = new Map<string, Map<number, Record<string, number>>>();

    for (const sample of this.quotaSamples()) {
      const points = byAccount.get(sample.accountId) ?? new Map<number, Record<string, number>>();
      const families = points.get(sample.at) ?? {};
      const family = modelFamily(sample.modelId);
      const existing = families[family];
      families[family] = existing === undefined ? sample.percentage : Math.min(existing, sample.percentage);
      points.set(sample.at, families);
      byAccount.set(sample.accountId, points);
    }

    return [...byAccount.entries()].map(([accountId, points]) => ({
      accountId,
      points: [...points.entries()]
        .map(([at, byFamily]) => ({ at, min: Math.min(...Object.values(byFamily)), byFamily }))
        .sort((a, b) => a.at - b.at)
        .slice(-limitPerAccount),
    }));
  }

  /** Aggregate token spend per account + model, newest activity first. */
  totals(sinceMs?: number): UsageTotals[] {
    const cutoff = sinceMs ?? 0;
    const buckets = new Map<string, UsageTotals>();

    for (const sample of this.usageSamples()) {
      if (sample.at < cutoff) {
        continue;
      }
      const key = `${sample.accountId}::${sample.modelId}`;
      const bucket = buckets.get(key) ?? {
        accountId: sample.accountId,
        modelId: sample.modelId,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
      };
      bucket.requests += 1;
      bucket.inputTokens += sample.inputTokens;
      bucket.outputTokens += sample.outputTokens;
      bucket.thoughtTokens += sample.thoughtTokens ?? 0;
      buckets.set(key, bucket);
    }

    return [...buckets.values()].sort(
      (a, b) =>
        b.inputTokens + b.outputTokens + b.thoughtTokens -
        (a.inputTokens + a.outputTokens + a.thoughtTokens),
    );
  }

  async clear(): Promise<void> {
    await this.globalState.update(QUOTA_SAMPLES_KEY, []);
    await this.globalState.update(USAGE_SAMPLES_KEY, []);
    this.onDidChangeEmitter.fire();
  }

  /** Drop every sample belonging to a removed account. */
  async forget(accountId: string): Promise<void> {
    await this.globalState.update(
      QUOTA_SAMPLES_KEY,
      this.quotaSamples().filter((sample) => sample.accountId !== accountId),
    );
    await this.globalState.update(
      USAGE_SAMPLES_KEY,
      this.usageSamples().filter((sample) => sample.accountId !== accountId),
    );
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function trim<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return undefined;
}
