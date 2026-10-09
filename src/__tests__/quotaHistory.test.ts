import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// Day boundaries are local time. Pin a zone with no daylight saving so the
// same instants land on the same days on every machine that runs this.
process.env.TZ = 'Europe/Istanbul';

// The history imports `vscode`, which only exists inside the extension host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { QuotaHistory, timeWindow } = require('../accounts/quotaHistory');

const USAGE_KEY = 'antigravityMaestro.usageHours';
const LEGACY_KEY = 'antigravityMaestro.usageSamples';
const QUOTA_KEY = 'antigravityMaestro.quotaSamples';

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      // Like VS Code: writing undefined removes the key.
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
    keys: () => [...values.keys()],
  };
}

/** Local wall-clock time on 9 October 2026 (or `day`), as epoch ms. */
function at(hour: number, minute = 0, day = 9): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

function usage(when: number, input: number, output: number, extra: Record<string, unknown> = {}) {
  return { at: when, accountId: 'a', modelId: 'claude', inputTokens: input, outputTokens: output, ...extra };
}

function tokens(rows: { inputTokens: number; outputTokens: number; thoughtTokens: number }[]): number {
  return rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens + row.thoughtTokens, 0);
}

test('requests within one hour add up in a single bucket', async () => {
  const now = at(10, 50);
  const history = new QuotaHistory(memento(), () => now);

  await history.recordUsage(usage(at(10, 5), 100, 10, { thoughtTokens: 5 }));
  await history.recordUsage(usage(at(10, 45), 200, 20));

  const buckets = history.usageBuckets();
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0], {
    at: at(10),
    accountId: 'a',
    modelId: 'claude',
    requests: 2,
    inputTokens: 300,
    outputTokens: 30,
    thoughtTokens: 5,
  });
});

test('a new hour, account or model starts its own bucket', async () => {
  const now = at(12);
  const history = new QuotaHistory(memento(), () => now);

  await history.recordUsage(usage(at(10, 59), 100, 10));
  await history.recordUsage(usage(at(11, 0), 100, 10));
  await history.recordUsage(usage(at(11, 1), 100, 10, { accountId: 'b' }));
  await history.recordUsage(usage(at(11, 2), 100, 10, { modelId: 'gemini' }));

  assert.equal(history.usageBuckets().length, 4);
  assert.deepEqual(
    history.usageBuckets().map((bucket: { at: number }) => bucket.at),
    [at(10), at(11), at(11), at(11)],
  );
});

test('a response that reports no tokens records nothing', async () => {
  const history = new QuotaHistory(memento(), () => at(10));
  await history.recordUsage(usage(at(10), 0, 0));
  assert.equal(history.usageBuckets().length, 0);
});

test('per-request samples from an earlier version fold into hours and the old key goes', async () => {
  const state = memento({
    [LEGACY_KEY]: [
      usage(at(9, 10), 100, 10),
      usage(at(9, 50), 50, 5, { thoughtTokens: 7 }),
      usage(at(10, 15), 10, 1),
    ],
  });
  const history = new QuotaHistory(state, () => at(11));

  const buckets = history.usageBuckets();
  assert.deepEqual(
    buckets.map((bucket: { at: number; requests: number; inputTokens: number; thoughtTokens: number }) => [
      bucket.at,
      bucket.requests,
      bucket.inputTokens,
      bucket.thoughtTokens,
    ]),
    [
      [at(9), 2, 150, 7],
      [at(10), 1, 10, 0],
    ],
  );
  assert.equal(state.get(LEGACY_KEY), undefined);
  assert.equal((state.get(USAGE_KEY) as unknown[]).length, 2);

  // Reading again must not fold the same samples in a second time.
  assert.equal(history.totals()[0].requests, 3);
});

test('migration also happens on the first write, adding to what was there', async () => {
  const state = memento({ [LEGACY_KEY]: [usage(at(10, 5), 100, 10)] });
  const history = new QuotaHistory(state, () => at(10, 30));

  await history.recordUsage(usage(at(10, 30), 100, 10));

  assert.equal(state.get(LEGACY_KEY), undefined);
  const [bucket] = history.usageBuckets();
  assert.equal(bucket.requests, 2);
  assert.equal(bucket.inputTokens, 200);
});

test('ranges split today from yesterday at local midnight', async () => {
  const now = at(10, 30);
  const history = new QuotaHistory(memento(), () => now);

  await history.recordUsage(usage(at(23, 50, 8), 1000, 0)); // yesterday, last hour
  await history.recordUsage(usage(at(0, 10), 200, 0)); // today, first hour
  await history.recordUsage(usage(at(9, 59), 30, 0)); // today, previous hour
  await history.recordUsage(usage(at(10, 5), 4, 0)); // this hour
  await history.recordUsage(usage(at(12, 0, 3), 50000, 0)); // six days ago
  await history.recordUsage(usage(at(12, 0, 2), 600000, 0)); // seven days ago

  const total = (span: string) => tokens(history.totals(timeWindow(span, now)));
  assert.equal(total('hour'), 4);
  assert.equal(total('today'), 234);
  assert.equal(total('yesterday'), 1000);
  assert.equal(total('week'), 51234);
  assert.equal(total('month'), 651234);
  assert.equal(total('all'), 651234);
  assert.equal(total('olderThanWeek'), 600000);
});

test('day totals give one entry per local day, ending today', async () => {
  const now = at(10, 30);
  const history = new QuotaHistory(memento(), () => now);
  await history.recordUsage(usage(at(23, 50, 8), 1000, 0));
  await history.recordUsage(usage(at(0, 10), 200, 0));
  await history.recordUsage(usage(at(9, 0), 30, 5));

  const days = history.dailyTotals(3);
  assert.deepEqual(
    days.map((day: { start: number; requests: number; inputTokens: number; outputTokens: number }) => [
      day.start,
      day.requests,
      day.inputTokens + day.outputTokens,
    ]),
    [
      [at(0, 0, 7), 0, 0],
      [at(0, 0, 8), 1, 1000],
      [at(0, 0, 9), 2, 235],
    ],
  );
  assert.equal(history.firstUsageAt(), at(23, 0, 8));
});

test('clearing yesterday removes its usage and quota readings and keeps the rest', async () => {
  const now = at(10, 30);
  const state = memento({
    [QUOTA_KEY]: [
      { at: at(22, 0, 8), accountId: 'a', modelId: 'claude', percentage: 80 },
      { at: at(8, 0), accountId: 'a', modelId: 'claude', percentage: 60 },
    ],
  });
  const history = new QuotaHistory(state, () => now);
  await history.recordUsage(usage(at(23, 50, 8), 1000, 0));
  await history.recordUsage(usage(at(9, 0), 30, 0));

  const window = timeWindow('yesterday', now);
  assert.deepEqual(history.measure(window), { requests: 1, tokens: 1000, quotaReadings: 1 });

  await history.clearWindow(window);

  assert.equal(tokens(history.totals()), 30);
  assert.deepEqual(
    history.quotaSamples().map((sample: { percentage: number }) => sample.percentage),
    [60],
  );
  assert.deepEqual(history.measure(window), { requests: 0, tokens: 0, quotaReadings: 0 });
});

test('clearing older than 7 days keeps the last week whole', async () => {
  const now = at(10, 30);
  const state = memento({
    [QUOTA_KEY]: [
      { at: at(12, 0, 1), accountId: 'a', modelId: 'claude', percentage: 10 },
      { at: at(0, 0, 3), accountId: 'a', modelId: 'claude', percentage: 20 },
    ],
  });
  const history = new QuotaHistory(state, () => now);
  await history.recordUsage(usage(at(23, 0, 2), 7, 0)); // just over a week
  await history.recordUsage(usage(at(0, 30, 3), 3, 0)); // first hour of the week

  await history.clearWindow(timeWindow('olderThanWeek', now));

  assert.equal(tokens(history.totals()), 3);
  assert.deepEqual(
    history.quotaSamples().map((sample: { percentage: number }) => sample.percentage),
    [20],
  );
});

test('clearing everything empties both histories', async () => {
  const now = at(10);
  const state = memento({
    [QUOTA_KEY]: [{ at: at(9), accountId: 'a', modelId: 'claude', percentage: 50 }],
  });
  const history = new QuotaHistory(state, () => now);
  await history.recordUsage(usage(at(9), 5, 5));

  await history.clear();

  assert.equal(history.usageBuckets().length, 0);
  assert.equal(history.quotaSamples().length, 0);
  assert.equal(history.firstUsageAt(), undefined);
});

test('hours older than the retention window are dropped on the next write', async () => {
  let now = at(10, 0, 1);
  const history = new QuotaHistory(memento(), () => now);
  await history.recordUsage(usage(now, 1, 0));

  // 399 days later the hour is still kept…
  now = now + 399 * 24 * 3_600_000;
  await history.recordUsage(usage(now, 2, 0));
  assert.equal(history.usageBuckets().length, 2);

  // …and gone once it is more than 400 days old.
  now = now + 2 * 24 * 3_600_000;
  await history.recordUsage(usage(now, 4, 0));
  assert.deepEqual(
    history.usageBuckets().map((bucket: { inputTokens: number }) => bucket.inputTokens),
    [2, 4],
  );
});

test('forgetting an account drops its usage hours', async () => {
  const history = new QuotaHistory(memento(), () => at(10));
  await history.recordUsage(usage(at(9), 5, 0));
  await history.recordUsage(usage(at(9), 7, 0, { accountId: 'b' }));

  await history.forget('a');

  assert.deepEqual(
    history.usageBuckets().map((bucket: { accountId: string }) => bucket.accountId),
    ['b'],
  );
});

/** Run `body` with the process in another time zone, then put Istanbul back. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  process.env.TZ = zone;
  try {
    await body();
  } finally {
    process.env.TZ = 'Europe/Istanbul';
  }
}

test('hours follow the local clock where the offset has half hours', async () => {
  // India is UTC+5:30: a UTC hour would run from 23:30 to 00:30 local and
  // carry the first half hour of the day into the day before.
  await inZone('Asia/Kolkata', async () => {
    const now = new Date(2026, 9, 26, 0, 30).getTime();
    const history = new QuotaHistory(memento(), () => now);
    await history.recordUsage(usage(new Date(2026, 9, 25, 23, 50).getTime(), 1000, 0));
    await history.recordUsage(usage(new Date(2026, 9, 26, 0, 10).getTime(), 20, 0));

    const total = (span: string) => tokens(history.totals(timeWindow(span, now)));
    assert.equal(total('hour'), 20);
    assert.equal(total('today'), 20);
    assert.equal(total('yesterday'), 1000);
    assert.deepEqual(
      history.usageBuckets().map((bucket: { at: number }) => new Date(bucket.at).getMinutes()),
      [0, 0],
    );
  });
});

test('the hour repeated when clocks go back keeps its own bucket', async () => {
  // Berlin leaves summer time at 03:00 on 25 October 2026, living 02:00 to
  // 03:00 twice. Each pass is its own hour, an hour apart.
  await inZone('Europe/Berlin', async () => {
    const firstPass = Date.UTC(2026, 9, 25, 0, 30); // 02:30 summer time
    const secondPass = Date.UTC(2026, 9, 25, 1, 30); // 02:30 winter time
    const history = new QuotaHistory(memento(), () => secondPass);
    await history.recordUsage(usage(firstPass, 1, 0));
    await history.recordUsage(usage(secondPass, 2, 0));

    assert.deepEqual(
      history.usageBuckets().map((bucket: { at: number }) => bucket.at),
      [Date.UTC(2026, 9, 25, 0), Date.UTC(2026, 9, 25, 1)],
    );
    assert.equal(tokens(history.totals(timeWindow('hour', secondPass))), 2);
  });
});
