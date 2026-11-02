import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

// The logger reads `vscode`, which only exists in the host.
const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recoverLeakedCalls, recoverLeakedCallsIn } = require('../upstream/leakedCalls');

/** What the model answered in #14, cut into the chunks a stream brings it in. */
const LEAKED = [
  'Hello! How can I help you today?\n\ncal',
  'l:default_api:rename_chatashions\n{\n"automatic": true,\n',
  '"title": "General Greeting"\n}\n</call:default_api:rename_chatashions>',
];

function text(value: string, finishReason?: string) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: value }] }, ...(finishReason ? { finishReason } : {}) }],
  };
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function partsOf(tools: string[], chunks: any[]): Promise<any[]> {
  const parts: any[] = [];
  for await (const chunk of recoverLeakedCalls(tools, from(chunks))) {
    parts.push(...(chunk.candidates?.[0]?.content?.parts ?? []));
  }
  return parts;
}

function shownText(parts: any[]): string {
  return parts.map((part) => part.text ?? '').join('');
}

test('leaked call: Gemini call syntax written as text becomes the tool call', async () => {
  const parts = await partsOf(
    ['read_file', 'rename_chat'],
    LEAKED.map((value, index) => text(value, index === LEAKED.length - 1 ? 'STOP' : undefined)),
  );

  assert.equal(shownText(parts), 'Hello! How can I help you today?\n\n');
  assert.deepEqual(
    parts.filter((part) => part.functionCall).map((part) => part.functionCall),
    [{ name: 'rename_chat', args: { automatic: true, title: 'General Greeting' } }],
  );
  assert.ok(!JSON.stringify(parts).includes('default_api'));
});

test('leaked call: recovered even when the stream ends without a finishing chunk', async () => {
  const parts = await partsOf(['rename_chat'], LEAKED.map((value) => text(value)));
  assert.equal(parts.at(-1).functionCall.name, 'rename_chat');
});

test("leaked call: Gemini's own argument form is read too", async () => {
  const parts = await partsOf(
    ['run_in_terminal'],
    [text('call:default_api:run_in_terminal{command:<ctrl46>ls -la<ctrl46>,isBackground:false}', 'STOP')],
  );
  assert.deepEqual(parts, [
    { functionCall: { name: 'run_in_terminal', args: { command: 'ls -la', isBackground: false } } },
  ]);
});

test('leaked call: a tool the request never declared stays text', async () => {
  const parts = await partsOf(['read_file'], LEAKED.map((value) => text(value)));
  assert.equal(shownText(parts), LEAKED.join(''));
  assert.ok(parts.every((part) => !part.functionCall));
});

test('leaked call: an ordinary answer passes through unchanged, word for word', async () => {
  const chunks = ['The call: ', 'default is fine; ', 'recall that.'];
  const parts = await partsOf(['read_file'], chunks.map((value, i) => text(value, i === 2 ? 'STOP' : undefined)));
  assert.equal(shownText(parts), chunks.join(''));
});

test('leaked call: nothing is held when the request declares no tools', async () => {
  const chunks = [text('cal'), text('l:default_api:x{}')];
  const out: any[] = [];
  for await (const chunk of recoverLeakedCalls([], from(chunks))) {
    out.push(chunk);
  }
  assert.deepEqual(out, chunks);
});

test('leaked call: a whole response is recovered as well', () => {
  const response = recoverLeakedCallsIn(['rename_chat'], text(LEAKED.join(''), 'STOP'));
  const parts = response.candidates[0].content.parts;
  assert.equal(parts.at(-1).functionCall.name, 'rename_chat');
  assert.equal(response.candidates[0].finishReason, 'STOP');
});
