import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The provider imports `vscode`, which only exists inside the extension host.
// Redirect that one specifier to the stub before the module is loaded.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode'
    ? stubPath
    : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  AntigravityChatProvider,
  convertMessages,
  buildTools,
  followsTaskComplete,
  rejectedToolIndex,
  compactTokens,
  windowFill,
} = require('../provider/copilotProvider');
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signatureStore } = require('../protocol/signatureStore');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONTINUE_NUDGE, EmptyResponseError } = require('../upstream/emptyResponse');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StreamBrokenError } = require('../upstream/cloudCodeClient');

const {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} = vscode;

function message(role: number, content: unknown[]) {
  return { role, content, name: undefined } as any;
}

test('copilot: system messages become the system instruction', () => {
  const { systemText, contents } = convertMessages([
    message(LanguageModelChatMessageRole.System, [new LanguageModelTextPart('Be precise.')]),
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('hi')]),
  ]);

  assert.equal(systemText, 'Be precise.');
  assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
});

test('copilot: a tool call and its result become functionCall + functionResponse', () => {
  const { contents } = convertMessages([
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('list files')]),
    message(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart('call_1', 'listDir', { path: '.' }),
    ]),
    // VS Code delivers results on a user turn, keyed only by call id.
    message(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('a.txt')]),
    ]),
  ]);

  assert.equal(contents[1].role, 'model');
  // The id has to survive both directions: for the Claude models the upstream
  // translates these into Anthropic `tool_use` / `tool_result` blocks, and
  // rejects the whole request when the call carries no id.
  assert.deepEqual(contents[1].parts[0].functionCall, {
    id: 'call_1',
    name: 'listDir',
    args: { path: '.' },
  });
  assert.equal(contents[2].role, 'user');
  assert.deepEqual(contents[2].parts[0].functionResponse, {
    id: 'call_1',
    name: 'listDir',
    response: { output: 'a.txt' },
  });
});

test('copilot: consecutive turns with the same speaker are merged', () => {
  const { contents } = convertMessages([
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('one')]),
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('two')]),
  ]);

  // Gemini rejects two user contents in a row.
  assert.equal(contents.length, 1);
  assert.deepEqual(contents[0].parts, [{ text: 'one' }, { text: 'two' }]);
});

test('copilot: images are forwarded as inline data', () => {
  const { contents } = convertMessages([
    message(LanguageModelChatMessageRole.User, [
      { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
    ]),
  ]);

  assert.deepEqual(contents[0].parts[0].inlineData, {
    mimeType: 'image/png',
    data: Buffer.from([1, 2, 3]).toString('base64'),
  });
});

test('copilot: tool declarations are sanitised for Gemini', () => {
  const tools = buildTools({
    tools: [
      {
        name: 'readFile',
        description: 'read a file',
        inputSchema: {
          $schema: 'https://json-schema.org/draft-07/schema',
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1 } },
          required: ['path'],
        },
      },
    ],
  } as any);

  assert.deepEqual(tools.functionDeclarations, [
    {
      name: 'readFile',
      description: 'read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]);
});

test('copilot: no tools means no tool declarations', () => {
  assert.equal(buildTools({ tools: [] } as any), undefined);
});

test('the rejected tool index is read out of an upstream 400', () => {
  // The literal shape of the rejection, quotes and all — a regex that misses it
  // fails silently, and the schema behind the failure stays invisible.
  const message =
    'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":' +
    '"tools.4.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"}}';

  assert.equal(rejectedToolIndex(message), 4);
  assert.equal(rejectedToolIndex('HTTP 429: rate limited'), undefined);
});

// ── Thought signatures across a model switch ──────────────────────────────────

test('copilot: a Gemini tool call is replayed with the signature Gemini issued', () => {
  signatureStore.rememberToolCall('call_sig', 'signature-from-gemini', 'gemini-3.8-flash-tiered');

  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_sig', 'listDir', { path: '.' }),
      ]),
    ],
    'gemini-3.8-flash-tiered',
    true,
  );

  assert.equal(contents[0].parts[0].functionCall.id, 'call_sig');
  assert.equal(contents[0].parts[0].thoughtSignature, 'signature-from-gemini');
});

test('copilot: a tool call with no signature is retold as text, not sent bare', () => {
  // Exactly what an extension reload leaves behind: the call is in the
  // conversation, the signature that came with it is not. Sent as a bare
  // functionCall the upstream answers "Function call is missing a
  // thought_signature" and the whole turn fails.
  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_lost', 'manage_todo_list', { op: 'write' }),
      ]),
      message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('call_lost', [new LanguageModelTextPart('done')]),
      ]),
    ],
    'gemini-3.8-flash-tiered',
    true,
  );

  assert.equal(contents[0].parts[0].functionCall, undefined);
  assert.equal(contents[0].parts[0].text, '[tool call] manage_todo_list({"op":"write"})');
  // The result has to follow the call: a functionResponse with no functionCall
  // ahead of it is rejected just as hard.
  assert.equal(contents[1].parts[0].functionResponse, undefined);
  assert.equal(contents[1].parts[0].text, '[tool result] manage_todo_list: done');
});

test('copilot: a signature from another family is not replayed', () => {
  // The failure this fixes: a session that ran on Gemini, switched to Claude
  // partway, and went back. The Claude turns carry signatures Gemini never
  // issued, and replaying them fails the request.
  signatureStore.rememberToolCall('call_claude', 'signature-from-claude', 'claude-opus-4-6-thinking');

  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_claude', 'listDir', { path: '.' }),
      ]),
    ],
    'gemini-3.8-flash-tiered',
    true,
  );

  assert.equal(contents[0].parts[0].functionCall, undefined);
  assert.equal(contents[0].parts[0].text, '[tool call] listDir({"path":"."})');

  // …and the same call going the other way keeps its own signature.
  const back = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_claude', 'listDir', { path: '.' }),
      ]),
    ],
    'claude-opus-4-6-thinking',
    true,
  );
  assert.equal(back.contents[0].parts[0].thoughtSignature, 'signature-from-claude');
});

test('copilot: a model that does not think keeps its unsigned tool calls', () => {
  // Gemini only demands a signature when it is thinking. Retelling calls as
  // text for a non-thinking model would break tool use for no reason.
  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_plain', 'listDir', { path: '.' }),
      ]),
    ],
    'gemini-2.5-flash-lite',
    false,
  );

  assert.deepEqual(contents[0].parts[0].functionCall, {
    id: 'call_plain',
    name: 'listDir',
    args: { path: '.' },
  });
});

test('copilot: the calls after the first in a parallel batch keep their tool shape', () => {
  // Gemini signs only the first call of a step; the others never carry a
  // signature, and only the first is checked. They used to be retold as text
  // in every turn, even with the step's signature in the store.
  signatureStore.rememberToolCall('call_p1', 'signature-for-the-step', 'gemini-3-pro-high');

  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_p1', 'read_file', { path: 'a.ts' }),
        new LanguageModelToolCallPart('call_p2', 'read_file', { path: 'b.ts' }),
      ]),
      message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('call_p1', [new LanguageModelTextPart('A')]),
      ]),
      message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('call_p2', [new LanguageModelTextPart('B')]),
      ]),
    ],
    'gemini-3-pro-high',
    true,
  );

  assert.equal(contents[0].parts[0].thoughtSignature, 'signature-for-the-step');
  assert.equal(contents[0].parts[1].functionCall.id, 'call_p2');
  assert.equal(contents[0].parts[1].thoughtSignature, undefined);
  assert.deepEqual(
    contents[1].parts.map((part: any) => part.functionResponse?.id),
    ['call_p1', 'call_p2'],
  );
});

test('copilot: a step whose first call lost its signature is retold whole', () => {
  // Sending the rest as calls would make the second one the step's first —
  // unsigned, and refused.
  const { contents } = convertMessages(
    [
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('call_q1', 'read_file', { path: 'a.ts' }),
        new LanguageModelToolCallPart('call_q2', 'read_file', { path: 'b.ts' }),
      ]),
      message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('call_q1', [new LanguageModelTextPart('A')]),
        new LanguageModelToolResultPart('call_q2', [new LanguageModelTextPart('B')]),
      ]),
    ],
    'gemini-3-pro-high',
    true,
  );

  assert.ok(contents[0].parts.every((part: any) => part.functionCall === undefined));
  assert.ok(contents[1].parts.every((part: any) => part.functionResponse === undefined));
});

test('copilot: earlier reasoning and blank text are not replayed as things the model said', () => {
  const { contents } = convertMessages([
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('hi')]),
    message(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelThinkingPart('The user said hi.'),
      new LanguageModelTextPart('\n'),
      new LanguageModelTextPart('Hello!'),
    ]),
  ]);

  assert.deepEqual(contents[1], { role: 'model', parts: [{ text: 'Hello!' }] });
});

test('copilot: task_complete is left out of the history', () => {
  // Left in, every autopilot turn ended on a tool result, and the next prompt
  // was merged in right after it — the shape that teaches Claude to answer
  // with nothing. Without it, the turn ends on the model's own summary.
  const { contents } = convertMessages([
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('fix it')]),
    message(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelTextPart('Fixed the bug.'),
      new LanguageModelToolCallPart('call_done', 'task_complete', { summary: 'Fixed the bug.' }),
    ]),
    message(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart('call_done', [new LanguageModelTextPart('Fixed the bug.')]),
    ]),
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('now add a test')]),
  ]);

  assert.deepEqual(contents, [
    { role: 'user', parts: [{ text: 'fix it' }] },
    { role: 'model', parts: [{ text: 'Fixed the bug.' }] },
    { role: 'user', parts: [{ text: 'now add a test' }] },
  ]);
});

test('copilot: the request autopilot sends after task_complete is recognised', () => {
  const autopilot = { tools: [{ name: 'read_file' }, { name: 'task_complete' }] };
  const done = [
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('fix it')]),
    message(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelTextPart('Fixed.'),
      new LanguageModelToolCallPart('call_done', 'task_complete', {}),
    ]),
    message(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart('call_done', [new LanguageModelTextPart('All done!')]),
    ]),
  ];
  assert.equal(followsTaskComplete(done, autopilot), true);

  // Outside autopilot the tool is not offered, and nothing is assumed.
  assert.equal(followsTaskComplete(done, { tools: [{ name: 'read_file' }] }), false);
  // A new prompt after it is an ordinary request.
  assert.equal(
    followsTaskComplete(
      [...done, message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('and docs?')])],
      autopilot,
    ),
    false,
  );
  // A result from another tool alongside it may need an answer.
  const mixed = [
    message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('fix it')]),
    message(LanguageModelChatMessageRole.Assistant, [
      new LanguageModelToolCallPart('call_edit', 'edit_file', {}),
      new LanguageModelToolCallPart('call_done2', 'task_complete', {}),
    ]),
    message(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart('call_edit', [new LanguageModelTextPart('error: no such file')]),
    ]),
    message(LanguageModelChatMessageRole.User, [
      new LanguageModelToolResultPart('call_done2', [new LanguageModelTextPart('All done!')]),
    ]),
  ];
  assert.equal(followsTaskComplete(mixed, autopilot), false);
});

// ── Ending a turn that brought no answer ──────────────────────────────────────

const STOP_EMPTY = [
  { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: { promptTokenCount: 900 } },
];

/**
 * A provider wired to a scripted upstream: each entry of `streams` is what one
 * request gets back — its chunks, or an error thrown before the first one.
 * Records what was sent, what Copilot Chat was shown, and the conversation
 * each request was leased for.
 */
function harness(...streams: unknown[]) {
  const sent: any[] = [];
  const shown: any[] = [];
  const sessions: unknown[] = [];
  const context = {
    accountId: 'account-1',
    email: 'someone@example.com',
    accessToken: 'token',
    projectId: 'project',
    model: {
      id: 'gemini-3-flash',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 8192,
      supportsThinking: false,
      thinkingBudget: 0,
    },
  };
  const lease = {
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
  };
  const client = {
    streamGenerate: async (params: any) => {
      sent.push(params.request);
      const next = streams.shift() ?? [];
      return (async function* () {
        if (next instanceof Error) {
          throw next;
        }
        yield* next as unknown[];
      })();
    },
  };
  const provider = new AntigravityChatProvider({}, lease, client);

  const run = (messages: unknown[], options: Record<string, unknown> = {}) =>
    provider.provideLanguageModelChatResponse(
      { id: 'gemini-3-flash', maxInputTokens: 1_000_000, maxOutputTokens: 8192 },
      messages,
      options,
      { report: (part: unknown) => shown.push(part) },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    );
  return { sent, shown, sessions, run, provider };
}

/** The text Copilot Chat was shown, leaving out thinking and data parts. */
function texts(shown: unknown[]): string[] {
  return shown
    .filter((part): part is { value: string } => part instanceof LanguageModelTextPart)
    .map((part) => part.value);
}

const AFTER_TOOL = [
  message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('fix it')]),
  message(LanguageModelChatMessageRole.Assistant, [new LanguageModelToolCallPart('call_e', 'edit_file', {})]),
  message(LanguageModelChatMessageRole.User, [
    new LanguageModelToolResultPart('call_e', [new LanguageModelTextPart('ok')]),
  ]),
];

test('turn end: a model with nothing to say ends the turn instead of failing it', async () => {
  // The reported bug: an empty STOP was thrown, Copilot's autopilot resent it
  // three times, and each attempt was asked twice — eight billed requests
  // ending in "Sorry, your request failed".
  const { sent, shown, run } = harness(STOP_EMPTY, STOP_EMPTY);

  await run(AFTER_TOOL);

  assert.equal(sent.length, 2);
  // Asked once more — with a nudge, because the same request gets the same
  // decision.
  assert.equal(sent[1].contents.at(-1).parts.at(-1).text, CONTINUE_NUDGE);
  // Then settled as a finished turn: text Copilot counts, that shows nothing.
  assert.deepEqual(texts(shown), ['\n']);
});

test('turn end: the nudge gets the answer the silence was hiding', async () => {
  const { sent, shown, run } = harness(STOP_EMPTY, [
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'All fixed.' }] } }] },
  ]);

  await run(AFTER_TOOL);

  assert.equal(sent.length, 2);
  assert.deepEqual(texts(shown), ['All fixed.']);
});

test('turn end: after task_complete the model is not asked again at all', async () => {
  const { sent, shown, run } = harness();

  await run(
    [
      message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('fix it')]),
      message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelTextPart('Fixed.'),
        new LanguageModelToolCallPart('call_done', 'task_complete', {}),
      ]),
      message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('call_done', [new LanguageModelTextPart('All done!')]),
      ]),
    ],
    { tools: [{ name: 'task_complete', description: '', inputSchema: {} }] },
  );

  assert.equal(sent.length, 0);
  assert.deepEqual(texts(shown), ['\n']);
});

test('turn end: reasoning with no answer still counts as a turn for Copilot', async () => {
  // Copilot ignores thinking when it decides whether anything came back.
  const { sent, shown, run } = harness([
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Done here.', thought: true }] } }] },
  ]);

  await run(AFTER_TOOL);

  assert.equal(sent.length, 1);
  assert.ok(shown[0] instanceof LanguageModelThinkingPart);
  assert.equal(texts(shown).at(-1), '\n');
});

test('turn end: a refusal is explained in the answer, not thrown into a retry loop', async () => {
  const { sent, shown, run } = harness([
    { candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [] } }] },
  ]);

  await run(AFTER_TOOL);

  assert.equal(sent.length, 1);
  assert.match(texts(shown)[0], /^⚠️ Antigravity returned no response \(finish reason: SAFETY\)/);
});

test('turn end: a stream cut off twice is still a failure worth retrying', async () => {
  const cutOff = [{ candidates: [{ content: { role: 'model', parts: [] } }] }];
  const { sent, shown, run } = harness(cutOff, cutOff);

  await assert.rejects(run(AFTER_TOOL), (error: unknown) => {
    assert.ok(error instanceof EmptyResponseError);
    assert.equal((error as any).retryable, true);
    return true;
  });
  // Re-sent unchanged: nothing was decided, the stream just never finished.
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0]);
  // And no warning text ahead of the failure: Copilot prints the reason.
  assert.equal(texts(shown).length, 0);
});

test('turn end: a stream that broke off before any output is asked once more', async () => {
  const { sent, shown, run } = harness(
    new StreamBrokenError("Antigravity's stream broke off (aborted)."),
    [{ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Done.' }] } }] }],
  );

  await run(AFTER_TOOL);

  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0]);
  assert.deepEqual(texts(shown), ['Done.']);
});

// ── What Copilot Chat is told about size ──────────────────────────────────────

test('usage: the upstream token count reaches Copilot Chat', async () => {
  // Copilot's context indicator and its background compaction both read this;
  // without it they ran on zeros.
  const { shown, run } = harness([
    {
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Done.' }] } }],
      usageMetadata: {
        promptTokenCount: 90_000,
        candidatesTokenCount: 12,
        thoughtsTokenCount: 500,
        cachedContentTokenCount: 60_000,
      },
    },
  ]);

  await run(AFTER_TOOL);

  const reports = shown.filter((part) => part instanceof LanguageModelDataPart);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].mimeType, 'usage');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(reports[0].data)), {
    prompt_tokens: 90_000,
    completion_tokens: 12,
    total_tokens: 90_012,
    prompt_tokens_details: { cached_tokens: 60_000 },
  });
});

test('token count: tool-call arguments and images count; reasoning does not', async () => {
  const { provider } = harness();
  const count = (content: unknown[]) =>
    provider.provideTokenCount(
      { id: 'gemini-3-flash' },
      message(LanguageModelChatMessageRole.Assistant, content),
      {},
    );

  // A file written by an edit tool travels in its arguments, which used to
  // count for nothing.
  const edit = await count([
    new LanguageModelToolCallPart('call_w', 'create_file', { content: 'x'.repeat(37_000) }),
  ]);
  assert.ok(edit >= 10_000, `counted ${edit}`);

  // An image costs what the model charges for it, not what its base64 weighs.
  assert.equal(await count([new LanguageModelDataPart(new Uint8Array(500_000), 'image/png')]), 1_600);

  // Reasoning is never sent back, so it costs nothing.
  assert.equal(await count([new LanguageModelThinkingPart('x'.repeat(37_000))]), 1);
});

test('session: the chat a request belongs to reaches the lease', async () => {
  const { sessions, run } = harness([
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'hi' }] } }] },
  ]);

  await run(AFTER_TOOL, { modelOptions: { _conversationId: 'chat-1' } });

  assert.deepEqual(sessions, ['copilot:chat-1']);
});

// ── The context window in the picker ──────────────────────────────────────────

test('picker: a window is labelled the way the models are usually quoted', () => {
  assert.equal(compactTokens(200_000), '200K');
  assert.equal(compactTokens(1_048_576), '1M');
  assert.equal(compactTokens(128_000), '128K');
  assert.equal(compactTokens(900), '900');
});

test('picker: a prompt is measured against the window it has to fit', () => {
  // 370k characters is ~100k tokens at the ratio the estimate uses: half of a
  // 200k window, and a twentieth of a 1M one. The same conversation, two
  // models — which is the whole of what a switch changes.
  const claude = windowFill(370_000, 200_000);
  assert.equal(claude?.percent, 50);
  assert.equal(claude?.window, '200K');
  assert.equal(claude?.tokens, '100K');

  assert.equal(windowFill(370_000, 1_048_576)?.percent, 10);
  // A model that publishes no window cannot be measured against one.
  assert.equal(windowFill(370_000, 0), undefined);
});
