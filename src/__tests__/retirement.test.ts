import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The client and the account manager read `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { retirementNotice } = require('../upstream/retirement');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ModelRetiredError, screenForRetirement } = require('../upstream/cloudCodeClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountManager } = require('../accounts/accountManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountLease } = require('../accounts/accountLease');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ModelCatalog } = require('../upstream/modelCatalog');

/** What the upstream actually answered for `gemini-3-flash-agent`. */
const NOTICE =
  'Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.';

function text(value: string, thought = false) {
  return { candidates: [{ content: { role: 'model', parts: [{ text: value, thought }] } }] };
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

test('retirement: the notice is read, with the model it names instead', () => {
  assert.deepEqual(retirementNotice(NOTICE), {
    retiredName: 'Gemini 3.5 Flash',
    successorName: 'Gemini 3.7 Flash',
    text: NOTICE,
  });
  assert.equal(retirementNotice('Gemini 2 is no longer available.')?.successorName, undefined);
});

test('retirement: an answer that only mentions the phrase is not a notice', () => {
  assert.equal(
    retirementNotice(`The docs say "${NOTICE}" — so here is how to migrate your config.`),
    undefined,
  );
  assert.equal(retirementNotice(`${NOTICE}\n\nAnyway, here is the fix:`), undefined);
});

test('retirement: a stream that is only the notice is thrown, with nothing shown', async () => {
  const shown: unknown[] = [];
  await assert.rejects(
    (async () => {
      for await (const chunk of screenForRetirement(
        'gemini-3-flash-agent',
        from([text('Gemini 3.5 Flash is no longer'), text(NOTICE.slice(29))]),
      )) {
        shown.push(chunk);
      }
    })(),
    (error: unknown) => {
      assert.ok(error instanceof ModelRetiredError);
      assert.equal((error as any).modelId, 'gemini-3-flash-agent');
      assert.equal((error as any).successorName, 'Gemini 3.7 Flash');
      return true;
    },
  );
  assert.deepEqual(shown, []);
});

test('retirement: an ordinary answer passes through whole and in order', async () => {
  const long = 'x'.repeat(200);
  const chunks = [text('Hello'), text(' there. '), text(long), text('done')];
  assert.deepEqual(await collect(screenForRetirement('m', from(chunks))), chunks);

  // Reasoning first is never a notice, so nothing is held at all.
  const thinking = [text('planning', true), text('Hi')];
  assert.deepEqual(await collect(screenForRetirement('m', from(thinking))), thinking);

  // A short answer is held to its end, then delivered.
  assert.deepEqual(await collect(screenForRetirement('m', from([text('Hi!')]))), [text('Hi!')]);
});

/** Two accounts as the upstream reports them: 3.5 Flash still listed beside 3.7. */
function manager() {
  const reading = (extra: Record<string, string> = {}) => {
    const names: Record<string, string> = {
      'gemini-3-flash-agent': 'Gemini 3.5 Flash (High)',
      'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Medium)',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
      'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-tiered': 'Gemini 3.7 Flash (Tiered)',
      ...extra,
    };
    return {
      fetchedAt: Date.now(),
      models: Object.fromEntries(
        Object.entries(names).map(([modelId, displayName]) => [
          modelId,
          { modelId, displayName, percentage: 100, resetTime: '' },
        ]),
      ),
    };
  };

  let accounts: any[] = [
    { id: 'a0', email: 'a@example.com', quota: reading() },
    { id: 'a1', email: 'b@example.com', quota: reading() },
  ];
  let retired: Record<string, unknown> = {};
  const store = {
    list: () => accounts,
    get: (id: string) => accounts.find((account) => account.id === id),
    getActiveId: () => 'a0',
    patch: async (id: string, changes: object) => {
      accounts = accounts.map((account) => (account.id === id ? { ...account, ...changes } : account));
    },
    retiredModels: () => retired,
    setRetiredModels: async (value: Record<string, unknown>) => {
      retired = value;
    },
  };
  const subject = new AccountManager(store as any, { recordQuota: async () => undefined } as any);
  subject.getAccessToken = async () => 'token';
  return { subject, accounts: () => accounts, retired: () => retired };
}

test('retirement: every effort of the named model is withdrawn, each to the same effort', async () => {
  const { subject, accounts, retired } = manager();

  const successor = await subject.retireModel('gemini-3-flash-agent', 'Gemini 3.5 Flash', 'Gemini 3.7 Flash');

  assert.equal(successor, 'gemini-3.7-flash-high');
  for (const account of accounts()) {
    const ids = Object.keys(account.quota.models);
    assert.ok(!ids.includes('gemini-3-flash-agent'));
    assert.ok(!ids.includes('gemini-3.5-flash-low'));
    // A different model that only shares the prefix stays.
    assert.ok(ids.includes('gemini-3.5-flash-lite'));
    assert.deepEqual(account.quota.forwardingRules, {
      'gemini-3-flash-agent': 'gemini-3.7-flash-high',
      'gemini-3.5-flash-low': 'gemini-3.7-flash-medium',
    });
  }
  // Kept, so the next quota reading drops them again.
  assert.deepEqual(Object.keys(retired()).sort(), ['gemini-3-flash-agent', 'gemini-3.5-flash-low']);
});

test('retirement: the request is sent again to the successor, once', async () => {
  const { subject } = manager();
  const catalog = new ModelCatalog(subject);
  const lease = new AccountLease(subject, catalog, { recordUsage: async () => undefined } as any);
  const tried: string[] = [];

  const answer = await lease.run('gemini-3-flash-agent', async (context: any) => {
    tried.push(context.model.id);
    if (context.model.id === 'gemini-3-flash-agent') {
      throw new ModelRetiredError(context.model.id, 'Gemini 3.5 Flash', 'Gemini 3.7 Flash', NOTICE);
    }
    return 'answered';
  });

  assert.equal(answer, 'answered');
  // Not tried on the second account: the model is gone for everyone.
  assert.deepEqual(tried, ['gemini-3-flash-agent', 'gemini-3.7-flash-high']);
  assert.equal(catalog.listAll().some((model: any) => model.id === 'gemini-3-flash-agent'), false);
});
