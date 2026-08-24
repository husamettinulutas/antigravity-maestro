import assert from 'node:assert/strict';
import test from 'node:test';

import { displayNameFor, displayNamesFor } from '../upstream/modelNames';

test('model names are built from the id, not the upstream label', () => {
  // The ids the upstream actually serves — several of them come back sharing
  // one stale display name, which is what made the model list unreadable.
  assert.equal(displayNameFor('gemini-3.5-flash-high'), 'Gemini 3.5 Flash (High)');
  assert.equal(displayNameFor('gemini-3.7-flash-tiered'), 'Gemini 3.7 Flash (Tiered)');
  assert.equal(displayNameFor('gemini-3.5-flash-extra-low'), 'Gemini 3.5 Flash (Extra low)');
  assert.equal(displayNameFor('gemini-3-flash-agent'), 'Gemini 3 Flash (Agent)');
  assert.equal(displayNameFor('gemini-3.1-flash-lite'), 'Gemini 3.1 Flash Lite');
  assert.equal(displayNameFor('gemini-3.1-pro-low'), 'Gemini 3.1 Pro (Low)');
  assert.equal(displayNameFor('gemini-3-pro-image'), 'Gemini 3 Pro Image');
  assert.equal(displayNameFor('gpt-oss-120b-medium'), 'GPT-OSS 120B (Medium)');
});

test('a dashed version reads as a version', () => {
  assert.equal(displayNameFor('claude-opus-4-6-thinking'), 'Claude Opus 4.6 (Thinking)');
  assert.equal(displayNameFor('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
  assert.equal(displayNameFor('models/CLAUDE-OPUS-4-6-THINKING'), 'Claude Opus 4.6 (Thinking)');
});

test('an unrecognisable id leaves the upstream name in charge', () => {
  assert.equal(displayNameFor(''), undefined);
  assert.equal(displayNameFor('   '), undefined);
});

test('a label only one model uses is the name that model keeps', () => {
  // The Antigravity client shows these labels, so a unique one is what the user
  // is looking for. A label three ids share names none of them.
  const names = displayNamesFor([
    { modelId: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash High' },
    { modelId: 'gemini-2.5-flash', displayName: 'Gemini 3.1 Flash Lite' },
    { modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 3.1 Flash Lite' },
    { modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' },
    { modelId: 'gemini-3-flash-agent' },
  ]);

  assert.deepEqual(names, {
    'gemini-3.5-flash-high': 'Gemini 3.5 Flash High',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
    'gemini-3-flash-agent': 'Gemini 3 Flash (Agent)',
  });
});

test('a label matching its id is left alone', () => {
  const names = displayNamesFor([
    { modelId: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
  ]);
  assert.equal(names['gemini-3.1-pro-high'], 'Gemini 3.1 Pro (High)');
});

test('a unique label is kept even where it disagrees with its id', () => {
  // The upstream offers `gemini-3-flash-agent` as "Gemini 3.5 Flash (High)" and
  // `gemini-3.5-flash-low` as "(Medium)". Every surface prints the id beside
  // the name, so the label is left to be the name and the id speaks for itself.
  const names = displayNamesFor([
    { modelId: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)' },
    { modelId: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)' },
  ]);
  assert.equal(names['gemini-3-flash-agent'], 'Gemini 3.5 Flash (High)');
  assert.equal(names['gemini-3.5-flash-low'], 'Gemini 3.5 Flash (Medium)');
});

test('a shared label still falls back to the name derived from the id', () => {
  const names = displayNamesFor([
    { modelId: 'gemini-2.5-flash', displayName: 'Gemini 3.1 Flash Lite' },
    { modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' },
  ]);
  assert.equal(names['gemini-2.5-flash'], 'Gemini 2.5 Flash');
  assert.equal(names['gemini-3.1-flash-lite'], 'Gemini 3.1 Flash Lite');
});
