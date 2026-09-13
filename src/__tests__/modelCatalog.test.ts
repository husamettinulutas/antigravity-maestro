import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The catalog's imports reach code that reads `vscode`, which only exists in
// the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ModelCatalog } = require('../upstream/modelCatalog');

const OPUS = 'claude-opus-4-6-thinking';

function quota(models: Record<string, number>, isForbidden = false) {
  return {
    fetchedAt: Date.now(),
    isForbidden,
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, percentage]) => [
        modelId,
        { modelId, percentage, resetTime: '' },
      ]),
    ),
  };
}

function catalog(accounts: { id: string; email: string; quota?: unknown }[]) {
  const manager = {
    list: () => accounts,
    get: (id: string) => accounts.find((account) => account.id === id),
    getActive: () => accounts[0],
  };
  return new ModelCatalog(manager as any);
}

test('catalog: an account without a quota reading borrows what the others serve', () => {
  const subject = catalog([
    { id: 'read', email: 'read@example.com', quota: quota({ [OPUS]: 40 }) },
    { id: 'unread', email: 'unread@example.com' },
  ]);

  // Its reading never arrived, so it had no catalog and the rotation passed
  // it over without a word — "every account" came to mean the one that had
  // been read.
  const model = subject.resolve(OPUS, 'unread');
  assert.ok(model);
  assert.equal(model.id, OPUS);
  // Nothing about the other account's quota is mistaken for a reading of
  // this one: unknown, not 40%.
  assert.equal(model.quotaPercent, undefined);
  assert.equal(model.accountEmail, undefined);

  // The account with its own reading keeps it.
  assert.equal(subject.resolve(OPUS, 'read')?.quotaPercent, 40);
});

test('catalog: an account the upstream refused keeps its empty catalog', () => {
  const subject = catalog([
    { id: 'read', email: 'read@example.com', quota: quota({ [OPUS]: 40 }) },
    { id: 'refused', email: 'refused@example.com', quota: quota({}, true) },
  ]);

  assert.equal(subject.resolve(OPUS, 'refused'), undefined);
});

test('catalog: nothing is borrowed when no account has a reading', () => {
  const subject = catalog([
    { id: 'a', email: 'a@example.com' },
    { id: 'b', email: 'b@example.com' },
  ]);

  assert.equal(subject.resolve(OPUS, 'a'), undefined);
});
