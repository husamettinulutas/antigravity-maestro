import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

// The module reads settings through `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('../utils/http');

/**
 * A fresh copy of the module (it caches the User-Agent for the session) with
 * the transport answering each feed URL from `reply`.
 */
async function resolveWith(reply: (url: string) => string | Error): Promise<string> {
  const original = http.request;
  http.request = async (url: string) => {
    const result = reply(url);
    if (result instanceof Error) {
      throw result;
    }
    return { status: 200, headers: {}, stream: Readable.from([Buffer.from(result)]) };
  };
  try {
    delete require.cache[require.resolve('../upstream/userAgent')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveUserAgent } = require('../upstream/userAgent');
    return await resolveUserAgent();
  } finally {
    http.request = original;
  }
}

function claimed(userAgent: string): string {
  return /^antigravity\/hub\/(\d+\.\d+\.\d+) \(/.exec(userAgent)?.[1] ?? '';
}

test('user agent: the newest version any feed reports wins', async () => {
  const userAgent = await resolveWith((url) =>
    url.includes('-hub-')
      ? 'Antigravity Hub auto updater is running. Stable Version: 3.1.0. Rolled out to 100%'
      : 'Auto updater is running. Fixed Version: 2.0.6',
  );
  assert.equal(claimed(userAgent), '3.1.0');
});

test('user agent: a stale feed never pulls the version below the floor', async () => {
  // The original feed stopped at 2.0.6, which the endpoints now turn away.
  const userAgent = await resolveWith((url) =>
    url.includes('-hub-') ? new Error('timed out') : 'Auto updater is running. Fixed Version: 2.0.6',
  );
  assert.equal(claimed(userAgent), '2.29.0');
});

test('user agent: with every feed down the fallback is used', async () => {
  const userAgent = await resolveWith(() => new Error('offline'));
  assert.equal(claimed(userAgent), '2.29.0');
});

/**
 * The newest model families are gated on the whole client signature. Served
 * the plain `antigravity/<version> <os>/<arch>` string, the upstream withholds
 * the Gemini 4 tiers from the model list and answers a generate call for one
 * with "Requested entity was not found".
 */
test('user agent: carries the aidev_client product tag and a changelist', async () => {
  const userAgent = await resolveWith(() => new Error('offline'));
  assert.match(
    userAgent,
    /^antigravity\/hub\/2\.29\.0 \(aidev_client; os_type=\w+; arch=\w+; cl=\d+\)$/,
  );
});

test('user agent: the version the client reports is the one it claims', async () => {
  delete require.cache[require.resolve('../upstream/userAgent')];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildUserAgent, currentVersion } = require('../upstream/userAgent');
  // `currentVersion` feeds `x-client-version`, and reads it back out of the
  // User-Agent — the changelist must not be mistaken for it.
  assert.equal(currentVersion(), '2.29.0');
  assert.match(buildUserAgent('3.4.1'), /^antigravity\/hub\/3\.4\.1 \(/);
});
