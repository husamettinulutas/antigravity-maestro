import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { modelFamily } from './quotaPools';
import { QuotaSample, QuotaSnapshot, UsageBucket, UsageSample } from './types';

const QUOTA_SAMPLES_KEY = 'antigravityMaestro.quotaSamples';
const USAGE_BUCKETS_KEY = 'antigravityMaestro.usageHours';
/** Per-request samples written by earlier versions; folded into hours once, then removed. */
const LEGACY_USAGE_SAMPLES_KEY = 'antigravityMaestro.usageSamples';

/** Keep the stored quota readings bounded so globalState stays small. */
const MAX_QUOTA_SAMPLES = 2000;
/** Skip a new quota sample when nothing moved and the last one is this recent. */
const QUOTA_SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Usage is bounded by age, not by count: a count cap drops the oldest days
 * first on a busy week, and a "30 days" view would then quietly under-report.
 * A little over a year keeps "this month last year" answerable.
 */
const USAGE_RETENTION_MS = 400 * DAY_MS;

/**
 * How a bucket is stored: a tuple, not an object. A year of hours across a few
 * accounts and models is tens of thousands of rows, and repeating seven key
 * names in each would more than double what globalState rewrites per request.
 */
type StoredBucket = [
  at: number,
  accountId: string,
  modelId: string,
  requests: number,
  inputTokens: number,
  outputTokens: number,
  thoughtTokens: number,
];

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

/** Token spend over one local calendar day. */
export interface DayTotals {
  /** Local midnight that starts the day, epoch ms. */
  start: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

/** What a span of history holds — said before it is cleared. */
export interface HistoryMeasure {
  requests: number;
  tokens: number;
  quotaReadings: number;
}

/** The spans the Usage tab can show. */
export type UsageRange = 'hour' | 'today' | 'yesterday' | 'week' | 'month' | 'all';

/** The spans "Clear history" can remove: every view range, plus the "older than" ones. */
export type HistorySpan = UsageRange | 'olderThanWeek' | 'olderThanMonth';

export const USAGE_RANGES: readonly UsageRange[] = ['hour', 'today', 'yesterday', 'week', 'month', 'all'];

/** A half-open window [from, to) in epoch ms; either end may be infinite. */
export interface TimeWindow {
  from: number;
  to: number;
}

/**
 * The window a span covers at `now`, in the local time zone.
 *
 * "hour" is the clock hour `now` falls in, not the last 60 minutes: usage is
 * kept per hour, so a rolling 60 minutes could only be guessed at. Days start
 * at local midnight, and "week" / "month" are today plus the 6 / 29 days
 * before it, so their "older than" counterparts are exactly what they leave.
 */
export function timeWindow(span: HistorySpan, now: number): TimeWindow {
  switch (span) {
    case 'hour':
      return { from: hourStart(now), to: Infinity };
    case 'today':
      return { from: localDayStart(now), to: Infinity };
    case 'yesterday':
      return { from: localDayStart(now, 1), to: localDayStart(now) };
    case 'week':
      return { from: localDayStart(now, 6), to: Infinity };
    case 'month':
      return { from: localDayStart(now, 29), to: Infinity };
    case 'olderThanWeek':
      return { from: -Infinity, to: localDayStart(now, 6) };
    case 'olderThanMonth':
      return { from: -Infinity, to: localDayStart(now, 29) };
    case 'all':
      return { from: -Infinity, to: Infinity };
  }
}

/**
 * Start of the local clock hour `at` falls in — the key usage is summed
 * under. Local, not UTC, so local midnight is always a bucket boundary even
 * where the offset has half or quarter hours (India, Nepal, Newfoundland…);
 * in whole-hour zones the two are the same instant. Taking the local minutes
 * off `at`, rather than rebuilding the date from its local fields, keeps the
 * repeated hour of a DST fall-back apart from the hour before it.
 */
export function hourStart(at: number): number {
  const date = new Date(at);
  return at - ((date.getMinutes() * 60 + date.getSeconds()) * 1000 + date.getMilliseconds());
}

/**
 * Local midnight `daysAgo` days before the day `at` falls in. Going through
 * the calendar rather than subtracting 24h keeps it right across DST changes.
 */
export function localDayStart(at: number, daysAgo = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo).getTime();
}

/**
 * Rolling history of quota readings and token spend, used by the stats view.
 * Everything lives in globalState — it is diagnostic data, not credentials.
 *
 * Usage is summed per local clock hour, so a window is matched by the hour a
 * bucket starts and every day boundary falls between buckets.
 */
export class QuotaHistory {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** `clock` is injectable so tests can pin "now" across day boundaries. */
  constructor(
    private readonly globalState: vscode.Memento,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The current time, as this history sees it. */
  now(): number {
    return this.clock();
  }

  quotaSamples(accountId?: string): QuotaSample[] {
    const samples = this.globalState.get<QuotaSample[]>(QUOTA_SAMPLES_KEY, []);
    return accountId ? samples.filter((sample) => sample.accountId === accountId) : samples;
  }

  usageBuckets(accountId?: string): UsageBucket[] {
    const buckets = this.storedBuckets().map(toBucket);
    return accountId ? buckets.filter((bucket) => bucket.accountId === accountId) : buckets;
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

  /** Add the token spend reported by one upstream response to its hour. */
  async recordUsage(sample: UsageSample): Promise<void> {
    if (sample.inputTokens === 0 && sample.outputTokens === 0) {
      return;
    }
    const cutoff = hourStart(this.clock()) - USAGE_RETENTION_MS;
    const rows = this.storedBuckets().filter((row) => row[0] >= cutoff);
    const at = hourStart(sample.at);
    // The hour being added to is almost always the newest, so look from the end.
    const index = findLastIndex(
      rows,
      (row) => row[0] === at && row[1] === sample.accountId && row[2] === sample.modelId,
    );
    const previous: StoredBucket =
      index >= 0 ? rows[index] : [at, sample.accountId, sample.modelId, 0, 0, 0, 0];
    const next: StoredBucket = [
      at,
      sample.accountId,
      sample.modelId,
      previous[3] + 1,
      previous[4] + sample.inputTokens,
      previous[5] + sample.outputTokens,
      previous[6] + (sample.thoughtTokens ?? 0),
    ];
    if (index >= 0) {
      rows[index] = next;
    } else {
      rows.push(next);
    }

    await this.globalState.update(USAGE_BUCKETS_KEY, rows);
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

  /** Aggregate token spend per account + model within a window (default: all of it), largest first. */
  totals(window: TimeWindow = timeWindow('all', 0)): UsageTotals[] {
    const merged = new Map<string, UsageTotals>();

    for (const row of this.storedBuckets()) {
      if (!within(row[0], window)) {
        continue;
      }
      const key = `${row[1]}\u0000${row[2]}`;
      const total = merged.get(key) ?? {
        accountId: row[1],
        modelId: row[2],
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
      };
      total.requests += row[3];
      total.inputTokens += row[4];
      total.outputTokens += row[5];
      total.thoughtTokens += row[6];
      merged.set(key, total);
    }

    return [...merged.values()].sort((a, b) => tokensOf(b) - tokensOf(a));
  }

  /** Token spend per local day for the last `days` days, oldest first, ending with today. */
  dailyTotals(days: number, now = this.clock()): DayTotals[] {
    const out: DayTotals[] = [];
    for (let back = days - 1; back >= 0; back--) {
      out.push({ start: localDayStart(now, back), requests: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0 });
    }
    const byStart = new Map(out.map((day) => [day.start, day]));

    for (const row of this.storedBuckets()) {
      const day = byStart.get(localDayStart(row[0]));
      if (!day) {
        continue;
      }
      day.requests += row[3];
      day.inputTokens += row[4];
      day.outputTokens += row[5];
      day.thoughtTokens += row[6];
    }
    return out;
  }

  /** When the oldest usage still kept was recorded, or undefined when there is none. */
  firstUsageAt(): number | undefined {
    let first: number | undefined;
    for (const row of this.storedBuckets()) {
      if (first === undefined || row[0] < first) {
        first = row[0];
      }
    }
    return first;
  }

  /** What clearing a window would remove. */
  measure(window: TimeWindow): HistoryMeasure {
    const measure: HistoryMeasure = { requests: 0, tokens: 0, quotaReadings: 0 };
    for (const row of this.storedBuckets()) {
      if (within(row[0], window)) {
        measure.requests += row[3];
        measure.tokens += row[4] + row[5] + row[6];
      }
    }
    measure.quotaReadings = this.quotaSamples().filter((sample) => within(sample.at, window)).length;
    return measure;
  }

  /** Forget usage and quota readings recorded within a window; the rest stays. */
  async clearWindow(window: TimeWindow): Promise<void> {
    await this.globalState.update(
      USAGE_BUCKETS_KEY,
      this.storedBuckets().filter((row) => !within(row[0], window)),
    );
    await this.globalState.update(
      QUOTA_SAMPLES_KEY,
      this.quotaSamples().filter((sample) => !within(sample.at, window)),
    );
    this.onDidChangeEmitter.fire();
  }

  async clear(): Promise<void> {
    await this.clearWindow(timeWindow('all', 0));
  }

  /** Drop every sample belonging to a removed account. */
  async forget(accountId: string): Promise<void> {
    await this.globalState.update(
      QUOTA_SAMPLES_KEY,
      this.quotaSamples().filter((sample) => sample.accountId !== accountId),
    );
    await this.globalState.update(
      USAGE_BUCKETS_KEY,
      this.storedBuckets().filter((row) => row[1] !== accountId),
    );
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  /**
   * The stored hours, first folding in any per-request samples an earlier
   * version left behind so nobody's history is lost on update.
   */
  private storedBuckets(): StoredBucket[] {
    const stored = this.globalState.get<StoredBucket[]>(USAGE_BUCKETS_KEY, []);
    const legacy = this.globalState.get<UsageSample[]>(LEGACY_USAGE_SAMPLES_KEY);
    if (legacy === undefined) {
      return stored;
    }

    const merged = foldSamples(stored, legacy);
    // Both writes are issued together, before anything else can read: a read
    // landing between them would otherwise fold the same samples in twice.
    Promise.all([
      this.globalState.update(USAGE_BUCKETS_KEY, merged),
      this.globalState.update(LEGACY_USAGE_SAMPLES_KEY, undefined),
    ]).catch((error) => Logger.warn('Could not move usage history to hourly totals', error));
    return merged;
  }
}

/** Add per-request samples into hourly buckets, oldest hour first. */
function foldSamples(stored: StoredBucket[], samples: UsageSample[]): StoredBucket[] {
  const byKey = new Map<string, StoredBucket>();
  const add = (row: StoredBucket) => {
    const key = `${row[0]}\u0000${row[1]}\u0000${row[2]}`;
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing
        ? [row[0], row[1], row[2], existing[3] + row[3], existing[4] + row[4], existing[5] + row[5], existing[6] + row[6]]
        : row,
    );
  };

  stored.forEach(add);
  for (const sample of Array.isArray(samples) ? samples : []) {
    add([
      hourStart(sample.at),
      sample.accountId,
      sample.modelId,
      1,
      sample.inputTokens ?? 0,
      sample.outputTokens ?? 0,
      sample.thoughtTokens ?? 0,
    ]);
  }
  return [...byKey.values()].sort((a, b) => a[0] - b[0]);
}

function toBucket(row: StoredBucket): UsageBucket {
  return {
    at: row[0],
    accountId: row[1],
    modelId: row[2],
    requests: row[3],
    inputTokens: row[4],
    outputTokens: row[5],
    thoughtTokens: row[6],
  };
}

function tokensOf(total: UsageTotals): number {
  return total.inputTokens + total.outputTokens + total.thoughtTokens;
}

function within(at: number, window: TimeWindow): boolean {
  return at >= window.from && at < window.to;
}

function trim<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  const index = findLastIndex(items, predicate);
  return index >= 0 ? items[index] : undefined;
}
