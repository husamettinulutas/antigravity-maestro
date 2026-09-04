import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

// The client reads settings through `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('../utils/http');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CloudCodeClient, resetEndpointHealth } = require('../upstream/cloudCodeClient');

// Order matters: production is deliberately last, because it refuses this
// traffic outright while the other two serve it.
const PRIMARY = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal';
const FALLBACK = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const PRODUCTION = 'https://cloudcode-pa.googleapis.com/v1internal';
const ENDPOINT_COUNT = 3;

/**
 * Swap the transport for one that records every URL called and answers from
 * `reply`. Returns the call log plus a restore hook.
 */
function stubTransport(reply: (url: string) => unknown) {
  const calls: string[] = [];
  const original = http.request;
  http.request = async (url: string) => {
    calls.push(url);
    const result = reply(url);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { calls, restore: () => (http.request = original) };
}

/** A response whose body reads as an empty Gemini payload. */
function ok() {
  return { status: 200, headers: {}, stream: Readable.from([Buffer.from('{}')]) };
}

function rateLimited(body = '') {
  return new http.HttpError('HTTP 429: quota', 429, body, {});
}

function unavailable() {
  return new http.HttpError('HTTP 503: backend unavailable', 503, '', {});
}

function params(extra: Record<string, unknown> = {}) {
  return { model: 'gemini-3-flash-agent', request: {}, accessToken: 'token', ...extra };
}

test('endpoints: production is the last resort, not the first choice', async () => {
  resetEndpointHealth();
  const transport = stubTransport(() => ok());

  try {
    await new CloudCodeClient().generate(params());

    // Production answers a full-quota account's first request of the session
    // with RESOURCE_EXHAUSTED, so it must never be the host tried first.
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].startsWith(PRIMARY), `went to ${transport.calls[0]}`);
    assert.ok(!transport.calls[0].startsWith(PRODUCTION));
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});

test('endpoints: the request identifies itself the way the real client does', async () => {
  resetEndpointHealth();
  const original = http.request;
  let sent: { headers: Record<string, string>; body: any } | undefined;

  http.request = async (_url: string, options: { headers: Record<string, string>; body: string }) => {
    sent = { headers: options.headers, body: JSON.parse(options.body) };
    return ok();
  };

  try {
    await new CloudCodeClient().generate(
      params({
        projectId: 'real-project',
        accountId: 'account-1',
        accountEmail: 'someone@gmail.com',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          systemInstruction: { parts: [{ text: 'be brief' }] },
          tools: [{ functionDeclarations: [] }],
        },
      }),
    );

    // An unrecognised caller is metered far more tightly than a real install.
    assert.equal(sent!.headers['x-client-name'], 'antigravity');
    assert.match(sent!.headers['x-client-version'], /^\d+\.\d+\.\d+$/);
    assert.ok(sent!.headers['x-machine-id']);
    assert.ok(sent!.headers['x-vscode-sessionid']);
    assert.equal(sent!.headers['x-goog-user-project'], 'real-project');

    // A bare product token in the body, not the versioned header string.
    assert.equal(sent!.body.userAgent, 'antigravity');
    assert.match(sent!.body.requestId, /^agent\/\d+\/[0-9a-f]{8}$/);
    assert.equal(sent!.body.requestType, 'agent');
    assert.deepEqual(sent!.body.enabledCreditTypes, ['GOOGLE_ONE_AI']);
    // The FNV-1a value the official client derives for this account id, checked
    // against an independent implementation of the same hash.
    assert.equal(sent!.body.request.sessionId, '-1148610531117454540');

    // The turn-by-turn part comes last so the cached prefix stays put.
    const keys = Object.keys(sent!.body.request);
    assert.equal(keys[keys.length - 1], 'contents');
    assert.ok(keys.indexOf('systemInstruction') < keys.indexOf('contents'));
    assert.ok(keys.indexOf('tools') < keys.indexOf('contents'));
    assert.deepEqual(sent!.body.request.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: a managed account identifies as jetski', async () => {
  resetEndpointHealth();
  const original = http.request;
  let body: any;
  http.request = async (_url: string, options: { body: string }) => {
    body = JSON.parse(options.body);
    return ok();
  };

  try {
    await new CloudCodeClient().generate(params({ accountEmail: 'someone@company.com' }));
    assert.equal(body.userAgent, 'jetski');
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: a placeholder project is never sent as a header', async () => {
  resetEndpointHealth();
  const original = http.request;
  let headers: Record<string, string> = {};
  http.request = async (_url: string, options: { headers: Record<string, string> }) => {
    headers = options.headers;
    return ok();
  };

  try {
    await new CloudCodeClient().generate(params({ projectId: 'test-project' }));
    assert.equal(headers['x-goog-user-project'], undefined);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: a rate limit stays on its own host', async () => {
  resetEndpointHealth();
  const transport = stubTransport(() => rateLimited());

  try {
    const client = new CloudCodeClient();
    await assert.rejects(() => client.generate(params()));

    // Both hosts meter the same account, so failing over is a guaranteed
    // second 429 that doubles the load exactly when there is none left to
    // spend. Rotating to another account is the fallback, not the other host.
    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].startsWith(PRIMARY));

    // And a rate limit must not brand the endpoint unhealthy for everyone
    // else — the next request still goes to the configured first host.
    transport.calls.length = 0;
    await assert.rejects(() => client.generate(params()));
    assert.ok(transport.calls[0].startsWith(PRIMARY));
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});

test('endpoints: the retry delay is read out of the error body', async () => {
  resetEndpointHealth();
  // The Cloud Code endpoints answer with RetryInfo and no `retry-after`.
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'Resource has been exhausted (e.g. check quota).',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' }],
    },
  });
  const transport = stubTransport(() => rateLimited(body));

  try {
    const client = new CloudCodeClient();
    await assert.rejects(
      () => client.generate(params()),
      (error: { retryAfterSeconds?: number }) => {
        assert.equal(error.retryAfterSeconds, 27);
        return true;
      },
    );
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});

test('endpoints: only a set number of requests start on an account at once', async () => {
  resetEndpointHealth();
  let inFlight = 0;
  let peak = 0;
  const settle: (() => void)[] = [];

  const original = http.request;
  http.request = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => settle.push(resolve));
    inFlight -= 1;
    return ok();
  };

  try {
    const client = new CloudCodeClient();
    const calls = Array.from({ length: 8 }, () =>
      client.generate(params({ accountId: 'account-1' })),
    );

    // Let the first wave reach the transport, then release everything.
    await new Promise((resolve) => setImmediate(resolve));
    const drain = setInterval(() => settle.shift()?.(), 0);
    await Promise.all(calls);
    clearInterval(drain);

    // The default cap is 3; an unpaced burst would have put all eight on the
    // wire at once and spent the account's per-minute allowance in one salvo.
    assert.equal(peak, 3, `expected at most 3 concurrent starts, saw ${peak}`);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: only one request pays to discover the project header verdict', async () => {
  resetEndpointHealth();
  const original = http.request;
  let forbidden = 0;

  // The upstream refuses every request that still carries the project header.
  http.request = async (_url: string, options: { headers: Record<string, string> }) => {
    if (options.headers['x-goog-user-project'] !== undefined) {
      forbidden += 1;
      throw new http.HttpError('HTTP 403: project not allowed', 403, '', {});
    }
    return ok();
  };

  try {
    const client = new CloudCodeClient();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        client.generate(params({ projectId: 'project-1', accountId: 'account-1' })),
      ),
    );

    // Without the shared probe each of the four turns spends its own 403 round
    // trip against the account's per-minute allowance before backing off to
    // the plain request.
    assert.equal(forbidden, 1, `expected a single 403, saw ${forbidden}`);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: the header verdict survives a rate limit on the retry', async () => {
  resetEndpointHealth();
  const original = http.request;
  let forbidden = 0;

  // The header is genuinely refused, and the request sent without it then runs
  // into the account's rate limit — the shape a spent account produces.
  http.request = async (_url: string, options: { headers: Record<string, string> }) => {
    if (options.headers['x-goog-user-project'] !== undefined) {
      forbidden += 1;
      throw new http.HttpError('HTTP 403: project not allowed', 403, '', {});
    }
    throw rateLimited();
  };

  try {
    const client = new CloudCodeClient();
    await assert.rejects(client.generate(params({ projectId: 'project-1' })));
    await assert.rejects(client.generate(params({ projectId: 'project-1' })));

    // Getting past the permission check and being metered is proof enough that
    // the header was the problem, so the second request must not pay for the
    // same doomed round trip again.
    assert.equal(forbidden, 1, `expected a single 403, saw ${forbidden}`);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: a 403 about the account is not blamed on the project header', async () => {
  resetEndpointHealth();
  const original = http.request;
  const sentHeaders: (string | undefined)[] = [];

  http.request = async (_url: string, options: { headers: Record<string, string> }) => {
    sentHeaders.push(options.headers['x-goog-user-project']);
    throw new http.HttpError('HTTP 403: Verify your account to continue.', 403, '', {});
  };

  try {
    const client = new CloudCodeClient();
    await assert.rejects(client.generate(params({ projectId: 'project-1' })), (error: any) => {
      assert.equal(error.status, 403);
      assert.equal(error.isForbidden, true);
      assert.equal(error.needsUserAction, true);
      return true;
    });

    // Retrying without the header answers identically, so the round trip is
    // not spent; the caller rotates to another account instead.
    assert.deepEqual(sentHeaders, ['project-1']);

    // And the verdict is not remembered: an account-level refusal used to
    // strip the header off every later request for that project for an hour,
    // which is how one exhausted account took the rest down with it.
    await assert.rejects(client.generate(params({ projectId: 'project-1' })));
    assert.deepEqual(sentHeaders, ['project-1', 'project-1']);
  } finally {
    http.request = original;
    resetEndpointHealth();
  }
});

test('endpoints: an unhealthy primary is skipped on the next request', async () => {
  resetEndpointHealth();
  const transport = stubTransport((url) => (url.startsWith(PRIMARY) ? unavailable() : ok()));

  try {
    const client = new CloudCodeClient();
    await client.generate(params());
    await client.generate(params());

    // First request pays the failover; the second must go straight to the
    // healthy host instead of repeating the doomed round trip.
    assert.equal(transport.calls.length, 3);
    assert.ok(transport.calls[0].startsWith(PRIMARY));
    assert.ok(transport.calls[1].startsWith(FALLBACK));
    assert.ok(transport.calls[2].startsWith(FALLBACK));
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});

test('endpoints: a degraded host is demoted, not dropped', async () => {
  resetEndpointHealth();
  // Everything is down, so the request must still try both hosts and fail.
  const transport = stubTransport(() => unavailable());

  try {
    const client = new CloudCodeClient();
    await assert.rejects(() => client.generate(params()));
    transport.calls.length = 0;
    await assert.rejects(() => client.generate(params()));

    assert.equal(transport.calls.length, ENDPOINT_COUNT);
    assert.equal(
      new Set(transport.calls.map((url: string) => url.split(':gen')[0])).size,
      ENDPOINT_COUNT,
      'every endpoint is still attempted when none is healthy',
    );
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});

test('endpoints: serving a request restores the primary', async () => {
  resetEndpointHealth();
  let primaryHealthy = false;
  const transport = stubTransport((url) =>
    url.startsWith(PRIMARY) && !primaryHealthy ? unavailable() : ok(),
  );

  try {
    const client = new CloudCodeClient();
    await client.generate(params());

    primaryHealthy = true;
    resetEndpointHealth(); // stands in for the TTL lapsing
    transport.calls.length = 0;
    await client.generate(params());

    assert.equal(transport.calls.length, 1);
    assert.ok(transport.calls[0].startsWith(PRIMARY), 'a recovered host is used first again');
  } finally {
    transport.restore();
    resetEndpointHealth();
  }
});
