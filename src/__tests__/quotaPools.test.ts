import assert from 'node:assert/strict';
import test from 'node:test';
import { headlinePools, poolLabel, quotaPools } from '../accounts/quotaPools';
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

test('headline pools: one reading per vendor family, tightest first', () => {
  const headline = headlinePools(MODELS).map(
    (pool) => `${poolLabel(pool.model)} ${pool.model.percentage}%`,
  );

  assert.deepEqual(headline, ['Opus 82%', 'Gemini 97%', 'GPT-OSS 82%']);
  assert.deepEqual(headline.slice(0, 2), ['Opus 82%', 'Gemini 97%']);
});
