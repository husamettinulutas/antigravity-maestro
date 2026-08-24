import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The lease reads settings through `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountLease, NoAccountAvailableError } = require('../accounts/accountLease');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UpstreamError } = require('../upstream/cloudCodeClient');

const MODEL = { id: 'claude-opus-4-6-thinking' };

function lease(emails: string[]) {
  const list = emails.map((email, index) => ({ id: `a${index}`, email }));
  const accounts = {
    list: () => list,
    getActive: () => list[0],
    get: (id: string) => list.find((account) => account.id === id),
    getAccessToken: async () => 'token',
    setActive: async () => undefined,
  };
  const catalog = { resolve: () => MODEL };
  const history = { recordUsage: async () => undefined };
  return new AccountLease(accounts as any, catalog as any, history as any);
}

function rateLimited() {
  return new UpstreamError('HTTP 429: quota', 429, '');
}

test('lease: a rate limit is retried on the next account, then gives up', async () => {
  const subject = lease(['a@example.com', 'b@example.com']);
  const tried: string[] = [];

  await assert.rejects(
    subject.run('claude-opus-4-6-thinking', async (context: { email: string }) => {
      tried.push(context.email);
      throw rateLimited();
    }),
    (error: unknown) => error instanceof UpstreamError,
  );

  assert.deepEqual(tried, ['a@example.com', 'b@example.com']);
});

test('lease: once every account is cooling down nothing is sent upstream', async () => {
  const subject = lease(['a@example.com', 'b@example.com']);

  await assert.rejects(
    subject.run('claude-opus-4-6-thinking', async () => {
      throw rateLimited();
    }),
  );

  // A retrying client must not push the exhausted accounts into another 429 —
  // that is what turned a single prompt into a request storm.
  let calls = 0;
  await assert.rejects(
    subject.run('claude-opus-4-6-thinking', async () => {
      calls += 1;
      throw rateLimited();
    }),
    (error: unknown) => {
      assert.ok(error instanceof NoAccountAvailableError);
      assert.ok((error as { retryAfterSeconds?: number }).retryAfterSeconds! > 0);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('lease: the cooldown doubles while the rate limits keep coming', () => {
  const subject = lease(['a@example.com']);

  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  const first = subject.cooldownSeconds('a0', MODEL.id);
  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  const second = subject.cooldownSeconds('a0', MODEL.id);

  assert.ok(first > 0 && first <= 30);
  assert.ok(second > first);
});

test('lease: a successful request clears the account it ran on', async () => {
  const subject = lease(['a@example.com']);

  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  assert.ok(subject.cooldownSeconds('a0', MODEL.id) > 0);

  // A cooling-down account is skipped, so it takes a reset to try again.
  subject.clearCooldowns();
  await subject.run('claude-opus-4-6-thinking', async () => 'ok');
  assert.equal(subject.cooldownSeconds('a0', MODEL.id), 0);
});
