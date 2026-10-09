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

test('each window keeps its own active account', async () => {
  // globalState is shared live between VS Code windows; a pick in one window
  // must not move another window that already chose its own account.
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const first = new AccountStore(shared, {}, memento());
  const second = new AccountStore(shared, {}, memento());

  await first.setActiveId('a');
  await second.claimActiveId();
  await first.claimActiveId();
  await second.setActiveId('b');

  assert.equal(first.getActiveId(), 'a');
  assert.equal(second.getActiveId(), 'b');
});

test('a window that never chose starts on the account picked last', async () => {
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  await new AccountStore(shared, {}, memento()).setActiveId('c');

  assert.equal(new AccountStore(shared, {}, memento()).getActiveId(), 'c');
});

test('rotation moves only its own window, not the default for new ones', async () => {
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const window = new AccountStore(shared, {}, memento());
  await window.setActiveId('a');
  await window.setActiveId('b', false);

  assert.equal(window.getActiveId(), 'b');
  assert.equal(new AccountStore(shared, {}, memento()).getActiveId(), 'a');
});

test('removing the active account moves the window to the first one left', async () => {
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const store = new AccountStore(shared, { delete: async () => undefined }, memento());
  await store.setActiveId('b');

  await store.remove('b');

  assert.equal(store.getActiveId(), 'a');
});

test("another window's request reads the account that window published", async () => {
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const first = new AccountStore(shared, {}, memento());
  const second = new AccountStore(shared, {}, memento());

  await first.setActiveId('a');
  await second.setActiveId('c');

  assert.notEqual(first.windowKey, second.windowKey);
  assert.equal(first.getActiveId(second.windowKey), 'c');
  assert.equal(second.getActiveId(first.windowKey), 'a');
  // A window that never published is served like this one.
  assert.equal(first.getActiveId('w-unknown'), 'a');
});

test("rotating another window's request moves only that window", async () => {
  const shared = memento({ 'antigravityMaestro.accounts': [...accounts] });
  const first = new AccountStore(shared, {}, memento());
  const second = new AccountStore(shared, {}, memento());
  await first.setActiveId('a');
  await second.setActiveId('c');
  const chosen = second.chosenAt();

  await first.setActiveId('b', false, second.windowKey);

  assert.equal(second.getActiveId(), 'c', 'its own window state is its own');
  assert.equal(first.getActiveId(second.windowKey), 'b');
  assert.equal(first.getActiveId(), 'a');
  assert.equal(second.chosenAt(), chosen, 'a rotation is not a pick by hand');
});

test('a window keeps its key across restarts', () => {
  const windowState = memento();
  const shared = memento();

  assert.equal(new AccountStore(shared, {}, windowState).windowKey, new AccountStore(shared, {}, windowState).windowKey);
});
