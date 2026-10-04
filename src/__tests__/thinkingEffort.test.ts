import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetForTier,
  isTieredModel,
  resolveThinkingEffort,
  thinkingEffortSchema,
  withoutSplitEffortModels,
} from '../upstream/thinkingEffort';

test('only -tiered ids are tiered', () => {
  assert.equal(isTieredModel('gemini-3.8-flash-tiered'), true);
  assert.equal(isTieredModel('models/Gemini-3.6-Flash-Tiered'), true);
  assert.equal(isTieredModel('gemini-3.6-flash-low'), false);
});

test('picker choice wins over the setting, which wins over the default', () => {
  assert.equal(resolveThinkingEffort({ thinkingEffort: 'low' }, 'high'), 'low');
  assert.equal(resolveThinkingEffort(undefined, 'medium'), 'medium');
  assert.equal(resolveThinkingEffort({ thinkingEffort: 'bogus' }, undefined), 'high');
});

test('tier budgets follow the upstream tiers and never exceed the ceiling', () => {
  assert.equal(budgetForTier('low', 10_000), 1000);
  assert.equal(budgetForTier('medium', 10_000), 4000);
  assert.equal(budgetForTier('high', 10_000), 10_000);
  assert.equal(budgetForTier('medium', 2000), 2000);
});

test('schema offers Low/Medium/High as a primary picker action', () => {
  const prop = thinkingEffortSchema('medium').properties.thinkingEffort;
  assert.deepEqual(prop.enum, ['low', 'medium', 'high']);
  assert.deepEqual(prop.enumItemLabels, ['Low', 'Medium', 'High']);
  assert.equal(prop.default, 'medium');
  assert.equal(prop.group, 'navigation');
});

test('split effort variants are hidden only where a tiered model replaces them', () => {
  const list = [
    { id: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
    { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
  ];
  assert.deepEqual(
    withoutSplitEffortModels(list).map((model) => model.id),
    ['gemini-3.8-flash-tiered', 'gemini-3.5-flash-low', 'gemini-3.1-pro-high', 'claude-opus-4-6-thinking'],
  );
});
