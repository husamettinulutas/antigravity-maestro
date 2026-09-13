import assert from 'node:assert/strict';
import test from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mapWithConcurrency } = require('../utils/concurrency');

test('concurrency: no more than the limit run at once, and order is kept', async () => {
  let inFlight = 0;
  let peak = 0;

  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6, 7],
    3,
    async (item: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item * 10;
    },
  );

  assert.equal(peak, 3);
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
});

test('concurrency: an empty list resolves without running anything', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 3, async () => {
    calls += 1;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});
