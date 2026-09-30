import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The gateway logs through `vscode`, which only exists inside the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GatewayServer } = require('../gateway/server');

const STOP_EMPTY = [
  { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: { promptTokenCount: 900 } },
];
const CUT_OFF = [{ candidates: [{ content: { role: 'model', parts: [] } }] }];

/** A gateway on a free port whose upstream answers each request with the next of `replies`. */
async function gateway(...replies: unknown[][]) {
  const sent: any[] = [];
  const sessions: unknown[] = [];
  const context = {
    accountId: 'account-1',
    email: 'someone@example.com',
    accessToken: 'token',
    model: { id: 'gemini-3-flash', maxInputTokens: 1_000_000, maxOutputTokens: 8192, supportsThinking: false, thinkingBudget: 0 },
  };
  const next = (params: any) => {
    sent.push(params.request);
    return replies.shift() ?? [];
  };
  const server = new GatewayServer({
    apiKey: 'key',
    catalog: { listAll: () => [] },
    lease: {
      run: async (
        _model: string,
        execute: (context: unknown) => Promise<unknown>,
        _signal: unknown,
        session: unknown,
      ) => {
        sessions.push(session);
        return execute(context);
      },
      recordUsage: async () => undefined,
    },
    client: {
      streamGenerate: async (params: any) => {
        const chunks = next(params);
        return (async function* () {
          yield* chunks;
        })();
      },
      // The unary call answers with the chunks merged, as the upstream does.
      generate: async (params: any) => next(params).at(-1) ?? {},
    },
  });
  const port = await server.start(0);

  const post = async (route: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'key', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  return { sent, sessions, post, stop: () => server.stop() };
}

const MESSAGES = { model: 'gemini-3-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

test('gateway: a silent turn reaches Claude Code as a finished one, not a 502 to resend', async () => {
  // Claude Code resends a 5xx up to ten times; each resend was billed for the
  // same silence.
  const { sent, post, stop } = await gateway(STOP_EMPTY, STOP_EMPTY);
  try {
    const { status, text } = await post('/v1/messages', { ...MESSAGES, stream: true });

    assert.equal(status, 200);
    assert.equal(sent.length, 2);
    assert.match(text, /"text_delta","text":"\."/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);
  } finally {
    await stop();
  }
});

test('gateway: the non-streaming answer to a silent turn carries one content block', async () => {
  const { sent, post, stop } = await gateway(STOP_EMPTY, STOP_EMPTY);
  try {
    const { status, text } = await post('/v1/messages', MESSAGES);

    assert.equal(status, 200);
    assert.equal(sent.length, 2);
    const body = JSON.parse(text);
    assert.deepEqual(body.content, [{ type: 'text', text: '.' }]);
    assert.equal(body.stop_reason, 'end_turn');
  } finally {
    await stop();
  }
});

test('gateway: OpenAI clients get an empty completion for a silent turn', async () => {
  const { post, stop } = await gateway(STOP_EMPTY, STOP_EMPTY);
  try {
    const { status, text } = await post('/v1/chat/completions', {
      model: 'gemini-3-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(status, 200);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await stop();
  }
});

test('gateway: a stream cut off twice is still a retryable failure', async () => {
  const { sent, post, stop } = await gateway(CUT_OFF, CUT_OFF);
  try {
    const { status } = await post('/v1/messages', { ...MESSAGES, stream: true });

    assert.equal(status, 502);
    assert.equal(sent.length, 2);
    assert.equal(sent[1], sent[0]);
  } finally {
    await stop();
  }
});

const ANSWER = [{ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'hi' }] } }] }];

test('gateway: the conversation a client names reaches the lease', async () => {
  const { sessions, post, stop } = await gateway(ANSWER, ANSWER, ANSWER);
  try {
    // Claude Code, by header and — for versions without it — by metadata.
    await post('/v1/messages', MESSAGES, { 'x-claude-code-session-id': 'cc-1' });
    await post('/v1/messages', { ...MESSAGES, metadata: { user_id: 'user_x_session_cc-2' } });
    // Codex, by its prompt cache key.
    await post('/v1/responses', { model: 'gemini-3-flash', input: 'hi', prompt_cache_key: 'codex-1' });

    assert.deepEqual(sessions, ['gateway:cc-1', 'gateway:user_x_session_cc-2', 'gateway:codex-1']);
  } finally {
    await stop();
  }
});
