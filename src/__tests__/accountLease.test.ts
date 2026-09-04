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
const { testSettings } = require('./stubs/vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountLease, NoAccountAvailableError } = require('../accounts/accountLease');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UpstreamError } = require('../upstream/cloudCodeClient');

const MODEL = { id: 'claude-opus-4-6-thinking' };

/** Pin how long a run may wait, so a test never sleeps off a real window. */
function maxWait(seconds: number): void {
  testSettings['rotation.maxWaitSeconds'] = seconds;
}

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

/** Wind a cooldown back so it reads as lapsed without waiting for the clock. */
function expireCooldown(subject: any, accountId: string, modelId: string): void {
  const record = subject.cooldowns.get(`${accountId}::${modelId}`);
  record.until = Date.now() - 1_000;
}

test('lease: a rate limit is retried on the next account, then gives up', async () => {
  maxWait(0);
  const subject = lease(['a@example.com', 'b@example.com']);
  const tried: string[] = [];

  await assert.rejects(
    subject.run('claude-opus-4-6-thinking', async (context: { email: string }) => {
      tried.push(context.email);
      throw rateLimited();
    }),
    (error: unknown) => {
      // The window every account is inside is reported as a wait rather than
      // as the raw 429: the client gets the seconds to come back in, and the
      // user gets a sentence instead of a stack trace.
      assert.ok(error instanceof NoAccountAvailableError);
      assert.ok((error as { retryAfterSeconds?: number }).retryAfterSeconds! > 0);
      return true;
    },
  );

  assert.deepEqual(tried, ['a@example.com', 'b@example.com']);
});

test('lease: a window that closes mid-request is waited out, not failed', async () => {
  maxWait(5);
  const subject = lease(['a@example.com', 'b@example.com']);
  let attempts = 0;

  // Both accounts are inside the same one-second window, which is the shape a
  // burst of parallel turns produces. Reporting it back the moment the last
  // candidate refused is what turned a one-second pause into a failed turn.
  const result = await subject.run('claude-opus-4-6-thinking', async () => {
    attempts += 1;
    if (attempts <= 2) {
      throw new UpstreamError('HTTP 429: quota', 429, '', 1);
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('lease: an account with no quota left is tried last, not first', async () => {
  maxWait(0);
  const list = [
    { id: 'a0', email: 'spent@example.com' },
    { id: 'a1', email: 'fresh@example.com' },
  ];
  const quotas: Record<string, number> = { a0: 0, a1: 80 };
  const accounts = {
    list: () => list,
    // The account the user just watched run out is still the active one.
    getActive: () => list[0],
    get: (id: string) => list.find((account) => account.id === id),
    getAccessToken: async () => 'token',
    setActive: async () => undefined,
  };
  const catalog = {
    resolve: (_model: string, accountId: string) => ({ ...MODEL, quotaPercent: quotas[accountId] }),
  };
  const subject = new AccountLease(accounts as any, catalog as any, {
    recordUsage: async () => undefined,
  } as any);

  const tried: string[] = [];
  await subject.run('claude-opus-4-6-thinking', async (context: { email: string }) => {
    tried.push(context.email);
    return 'ok';
  });

  // Starting on the spent account spends a doomed request and earns a rate
  // limit before the rotation has even begun.
  assert.deepEqual(tried, ['fresh@example.com']);
});

test('lease: an account the upstream refuses is rotated past, not fatal', async () => {
  maxWait(0);
  const subject = lease(['a@example.com', 'b@example.com']);
  const tried: string[] = [];

  // "Verify your account to continue" is answered per account: the first one
  // being blocked says nothing about the second. Failing the whole request
  // here is what stopped the rotation dead and made Claude Code believe its
  // own credentials had been rejected.
  const result = await subject.run(
    'claude-opus-4-6-thinking',
    async (context: { email: string }) => {
      tried.push(context.email);
      if (context.email === 'a@example.com') {
        throw new UpstreamError('HTTP 403: Verify your account to continue.', 403, '');
      }
      return 'served';
    },
  );

  assert.equal(result, 'served');
  assert.deepEqual(tried, ['a@example.com', 'b@example.com']);
  // And the refused account is skipped outright next time rather than costing
  // every following turn another doomed round trip.
  assert.ok(subject.cooldownSeconds('a0', MODEL.id) > 0);
});

test('lease: once every account is cooling down nothing is sent upstream', async () => {
  maxWait(0);
  const subject = lease(['a@example.com', 'b@example.com']);

  await assert.rejects(
    // A minute is longer than the request is willing to wait inline, so the
    // wait is handed back to the client rather than slept off here.
    subject.run('claude-opus-4-6-thinking', async () => {
      throw new UpstreamError('HTTP 429: quota', 429, '', 60);
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

test('lease: parallel requests do not stack the cooldown for one window', () => {
  const subject = lease(['a@example.com']);

  // Claude Code opens several turns at once, so one exhausted window arrives
  // as several rate limits within the same instant. Counting each of them was
  // what turned a 60s window into a multi-minute lockout.
  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  const first = subject.cooldownSeconds('a0', MODEL.id);
  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  const afterBurst = subject.cooldownSeconds('a0', MODEL.id);

  assert.ok(first > 0 && first <= 30);
  assert.equal(afterBurst, first);
});

test('lease: a limit that arrives after the cooldown lapsed backs off further', () => {
  const subject = lease(['a@example.com']);

  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  const first = subject.cooldownSeconds('a0', MODEL.id);

  // Stand in for the wait elapsing: the record has to survive its own expiry,
  // otherwise the strike count is gone and a spent account never backs off.
  expireCooldown(subject, 'a0', MODEL.id);
  assert.equal(subject.cooldownSeconds('a0', MODEL.id), 0);

  subject.markCooldown('a0', MODEL.id, undefined, 'quota');
  assert.ok(subject.cooldownSeconds('a0', MODEL.id) > first);
});

test('lease: the upstream retry delay wins over the doubling heuristic', () => {
  const subject = lease(['a@example.com']);

  subject.markCooldown('a0', MODEL.id, 7, 'quota');

  const wait = subject.cooldownSeconds('a0', MODEL.id);
  assert.ok(wait > 0 && wait <= 7, `expected the reported 7s wait, got ${wait}`);
});

test('lease: a short cooldown is waited out instead of failing the request', async () => {
  maxWait(15);
  const subject = lease(['a@example.com']);
  subject.markCooldown('a0', MODEL.id, 1, 'quota');

  // The window is a second, so reporting it back would surface a one-second
  // pause to the user as a hard error and invite an immediate retry storm.
  const result = await subject.run('claude-opus-4-6-thinking', async () => 'ok');
  assert.equal(result, 'ok');
});

test('lease: waiting is abandoned once the client hangs up', async () => {
  maxWait(15);
  const subject = lease(['a@example.com']);
  subject.markCooldown('a0', MODEL.id, 5, 'quota');

  const controller = new AbortController();
  controller.abort();

  let calls = 0;
  await assert.rejects(
    subject.run(
      'claude-opus-4-6-thinking',
      async () => {
        calls += 1;
        return 'ok';
      },
      controller.signal,
    ),
    (error: unknown) => error instanceof NoAccountAvailableError,
  );
  assert.equal(calls, 0);
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
