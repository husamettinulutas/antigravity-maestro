import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaPools } from '../accounts/quotaPools';
import { ModelQuota } from '../accounts/types';

const CLAUDE_RESET = '2026-08-22T03:17:00Z';
const GEMINI_RESET = '2026-08-22T03:12:00Z';
const GPT_RESET = '2026-08-22T03:10:00Z';

function model(modelId: string, percentage: number, resetTime: string): ModelQuota {
  return { modelId, displayName: modelId, percentage, resetTime };
}

/** A trimmed copy of what one account actually reports. */
const MODELS: ModelQuota[] = [
  model('claude-opus-4-6-thinking', 82, CLAUDE_RESET),
  model('claude-sonnet-4-6', 82, CLAUDE_RESET),
  model('gemini-3-flash-agent', 97, GEMINI_RESET),
  model('gemini-2.5-pro', 97, GEMINI_RESET),
  model('gemini-3.6-flash-high', 97, GEMINI_RESET),
  model('gpt-oss-120b-medium', 82, GPT_RESET),
];

test('quota pools: models sharing a reset window collapse into one entry', () => {
  const pools = quotaPools(MODELS);

  assert.deepEqual(
    pools.map((pool) => [pool.model.modelId, pool.model.percentage, pool.memberCount]),
    [
      ['claude-opus-4-6-thinking', 82, 2],
      ['gpt-oss-120b-medium', 82, 1],
      ['gemini-3-flash-agent', 97, 3],
    ],
  );
});

test('quota pools: equal percentages on different windows stay apart', () => {
  const pools = quotaPools([
    model('claude-opus-4-6-thinking', 82, CLAUDE_RESET),
    model('gpt-oss-120b-medium', 82, GPT_RESET),
  ]);

  assert.equal(pools.length, 2);
});

test('quota pools: models without a reset time are never merged', () => {
  const pools = quotaPools([model('a-model', 50, ''), model('b-model', 50, '')]);

  assert.equal(pools.length, 2);
});

test('quota pools: a fresh account still shows every family separately', () => {
  // Nothing used yet: one window, one percentage, every model at 100%. Keyed on
  // the window alone these would collapse into a single row.
  const untouched = '2026-08-29T00:00:00Z';
  const pools = quotaPools([
    model('claude-opus-4-6-thinking', 100, untouched),
    model('claude-sonnet-4-6', 100, untouched),
    model('gemini-3-flash-agent', 100, untouched),
    model('gpt-oss-120b-medium', 100, untouched),
  ]);

  assert.deepEqual(
    pools.map((pool) => pool.model.modelId),
    ['claude-opus-4-6-thinking', 'gemini-3-flash-agent', 'gpt-oss-120b-medium'],
  );
});

test('quota pools: the newest Claude version fronts the pool', () => {
  const pools = quotaPools([
    model('claude-opus-4-6-thinking', 100, CLAUDE_RESET),
    model('claude-opus-5-5-high', 100, CLAUDE_RESET),
    model('claude-sonnet-5-5-medium', 100, CLAUDE_RESET),
  ]);

  assert.equal(pools.length, 1);
  assert.equal(pools[0].model.modelId, 'claude-opus-5-5-high');
});

test("quota pools: the model the Antigravity client lists first fronts the pool", () => {
  const listed = (modelId: string, agentOrder?: number): ModelQuota => ({
    ...model(modelId, 100, GEMINI_RESET),
    agentOrder,
  });
  const pools = quotaPools([
    // Still reported with a quota, but the client stopped offering it.
    listed('gemini-3-flash-agent'),
    listed('gemini-3.1-pro-low', 3),
    listed('gemini-3.8-flash-tiered', 0),
    listed('gemini-3.7-flash-tiered', 1),
  ]);

  assert.equal(pools.length, 1);
  assert.equal(pools[0].model.modelId, 'gemini-3.8-flash-tiered');
});
