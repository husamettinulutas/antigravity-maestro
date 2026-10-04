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
  assert.equal(resolveThinkingEffort({ reasoningEffort: 'low' }, 'high'), 'low');
  assert.equal(resolveThinkingEffort(undefined, 'medium'), 'medium');
  assert.equal(resolveThinkingEffort({ reasoningEffort: 'bogus' }, undefined), 'high');
});

test('schema offers Low/Medium/High as a primary picker action', () => {
  // `reasoningEffort` is the one property VS Code carries over to the Copilot
  // CLI harness, as its string enum and default; under another name the CLI
  // showed the model with no effort to pick.
  const prop = thinkingEffortSchema('medium').properties.reasoningEffort;
  assert.deepEqual(prop.enum, ['low', 'medium', 'high']);
  assert.deepEqual(prop.enumItemLabels, ['Low', 'Medium', 'High']);
  assert.equal(prop.default, 'medium');
  assert.equal(prop.group, 'navigation');
});
