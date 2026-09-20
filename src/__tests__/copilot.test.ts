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
  convertMessages,
  buildTools,
  rejectedToolIndex,
  compactTokens,
  windowFill,
} = require('../provider/copilotProvider');
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signatureStore } = require('../protocol/signatureStore');

const { LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart } =
  vscode;

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
