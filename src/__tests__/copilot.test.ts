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
const { convertMessages, buildTools } = require('../provider/copilotProvider');
const vscode = require('vscode');

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
  assert.deepEqual(contents[1].parts[0].functionCall, { name: 'listDir', args: { path: '.' } });
  assert.equal(contents[2].role, 'user');
  assert.deepEqual(contents[2].parts[0].functionResponse, {
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
