import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The store imports `vscode`, which only exists inside the extension host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountStore } = require('../accounts/accountStore');

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    keys: () => [...values.keys()],
  };
}

const accounts = [
  { id: 'a', email: 'a@example.com' },
  { id: 'b', email: 'b@example.com' },
  { id: 'c', email: 'c@example.com' },
];

test('accounts can be dragged into a new order', () => {
  const state = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const store = new AccountStore(state, {});

  return store.reorder(['c', 'a', 'b']).then(() => {
    assert.deepEqual(
      store.list().map((account: { id: string }) => account.id),
      ['c', 'a', 'b'],
    );
  });
});

test('an account missing from the dragged order is kept, not dropped', async () => {
  // An account added (or removed) while the panel was being dragged around
  // must not disappear because the webview's list was a moment out of date.
  const state = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const store = new AccountStore(state, {});

  await store.reorder(['c', 'ghost']);

  assert.deepEqual(
    store.list().map((account: { id: string }) => account.id),
    ['c', 'a', 'b'],
  );
});
