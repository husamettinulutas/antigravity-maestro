import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTieredModel,
  resolveThinkingEffort,
  thinkingEffortSchema,
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

test('schema offers Low/Medium/High as a primary picker action', () => {
  const prop = thinkingEffortSchema('medium').properties.thinkingEffort;
  assert.deepEqual(prop.enum, ['low', 'medium', 'high']);
  assert.deepEqual(prop.enumItemLabels, ['Low', 'Medium', 'High']);
  assert.equal(prop.default, 'medium');
  assert.equal(prop.group, 'navigation');
});
