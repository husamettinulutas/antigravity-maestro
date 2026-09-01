import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The service reads settings through `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('../utils/http');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchQuota } = require('../accounts/quotaService');

function model(quota: number) {
  return { quotaInfo: { remainingFraction: quota, resetTime: '2026-09-01T12:00:00Z' } };
}

/** Answer every quota call from one canned fetchAvailableModels response. */
function stubUpstream(models: Record<string, unknown>) {
  const original = http.postJson;
  http.postJson = async (url: string) => {
    if (url.includes('loadCodeAssist')) {
      return { cloudaicompanionProject: 'project-1' };
    }
    if (url.includes('fetchAvailableModels')) {
      return models;
    }
    return {};
  };
  return () => {
    http.postJson = original;
  };
}

test('quota: a model the upstream retired is dropped from the snapshot', async () => {
  const restore = stubUpstream({
    models: {
      'gemini-3-flash-agent': model(0.97),
      'gemini-3.7-flash-tiered': model(0.97),
    },
    deprecatedModelIds: { 'gemini-3-flash-agent': { newModelId: 'gemini-3.7-flash-tiered' } },
  });

  try {
    const snapshot = await fetchQuota('token');
    assert.deepEqual(Object.keys(snapshot.models), ['gemini-3.7-flash-tiered']);
    // The rename is still recorded even though the dead id is gone.
    assert.deepEqual(snapshot.forwardingRules, {
      'gemini-3-flash-agent': 'gemini-3.7-flash-tiered',
    });
  } finally {
    restore();
  }
});

test('quota: a retirement with no replacement still drops the model', async () => {
  const restore = stubUpstream({
    models: { 'gemini-2.5-flash': model(0.5), 'gemini-3.7-flash-tiered': model(0.9) },
    deprecatedModelIds: { 'gemini-2.5-flash': {} },
  });

  try {
    const snapshot = await fetchQuota('token');
    assert.deepEqual(Object.keys(snapshot.models), ['gemini-3.7-flash-tiered']);
    assert.equal(snapshot.forwardingRules, undefined);
  } finally {
    restore();
  }
});

test('quota: live models survive when nothing is retired', async () => {
  const restore = stubUpstream({
    models: { 'gemini-3.7-flash-tiered': model(0.9), 'claude-sonnet-4-6': model(0.8) },
  });

  try {
    const snapshot = await fetchQuota('token');
    assert.deepEqual(Object.keys(snapshot.models).sort(), [
      'claude-sonnet-4-6',
      'gemini-3.7-flash-tiered',
    ]);
  } finally {
    restore();
  }
});
