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

const PRIMARY = 'https://cloudcode-pa.googleapis.com/v1internal';
const FALLBACK = 'https://daily-cloudcode-pa.googleapis.com/v1internal';

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

function rateLimited() {
  return new http.HttpError('HTTP 429: quota', 429, '', {});
}

function params() {
  return { model: 'gemini-3-flash-agent', request: {}, accessToken: 'token' };
}

test('endpoints: a rate limited primary is skipped on the next request', async () => {
  resetEndpointHealth();
  const transport = stubTransport((url) => (url.startsWith(PRIMARY) ? rateLimited() : ok()));

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
  const transport = stubTransport(() => rateLimited());

  try {
    const client = new CloudCodeClient();
    await assert.rejects(() => client.generate(params()));
    transport.calls.length = 0;
    await assert.rejects(() => client.generate(params()));

    assert.equal(transport.calls.length, 2);
    assert.equal(
      new Set(transport.calls.map((url: string) => url.split(':gen')[0])).size,
      2,
      'both endpoints are still attempted when neither is healthy',
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
    url.startsWith(PRIMARY) && !primaryHealthy ? rateLimited() : ok(),
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
