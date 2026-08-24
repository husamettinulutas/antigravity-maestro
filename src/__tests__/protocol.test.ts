import assert from 'node:assert/strict';
import test from 'node:test';
import { toGeminiRequest } from '../protocol/anthropic/request';
import { AnthropicStreamMapper } from '../protocol/anthropic/stream';
import { responsesToGemini } from '../protocol/openai/request';
import { sanitizeToolSchema } from '../protocol/schema';
import { applyGenerationConstraints } from '../upstream/constraints';
import { parseSse } from '../utils/sse';

/** Parse the SSE text a mapper produced into {event, data} pairs. */
function parseEvents(sse: string): { event: string; data: any }[] {
  return sse
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)![1];
      const data = JSON.parse(block.match(/^data: (.+)$/m)![1]);
      return { event, data };
    });
}

test('anthropic request: system prompt becomes systemInstruction', () => {
  const { request } = toGeminiRequest({
    model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: 'Be brief.' }],
    messages: [{ role: 'user', content: 'Hi' }],
  });

  assert.deepEqual(request.systemInstruction, { parts: [{ text: 'Be brief.' }] });
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: 'Hi' }] }]);
});

test('anthropic request: tool results are named from the call that made them', () => {
  const { request } = toGeminiRequest({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }],
      },
    ],
  });

  const [, model, toolTurn] = request.contents;
  assert.equal(model.role, 'model');
  assert.deepEqual(model.parts[0].functionCall, { name: 'bash', args: { cmd: 'ls' } });
  assert.equal(toolTurn.role, 'user');
  assert.deepEqual(toolTurn.parts[0].functionResponse, {
    name: 'bash',
    response: { output: 'a.txt' },
  });
});

test('anthropic request: an unsigned thinking block degrades to plain text', () => {
  const { request } = toGeminiRequest({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'unsigned reasoning' },
          { type: 'thinking', thinking: 'signed reasoning', signature: 'sig-1234567890' },
        ],
      },
    ],
  });

  const parts = request.contents[1].parts;
  // The upstream rejects a replayed thought with no signature, so only the
  // signed one keeps `thought: true`.
  assert.equal(parts[0].thought, undefined);
  assert.equal(parts[0].text, 'unsigned reasoning');
  assert.equal(parts[1].thought, true);
  assert.equal(parts[1].thoughtSignature, 'sig-1234567890');
});

test('anthropic stream: text then a tool call produces a valid event sequence', () => {
  const mapper = new AnthropicStreamMapper('claude-sonnet-4-6-thinking');
  let sse = mapper.start();
  sse += mapper.push({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] });
  sse += mapper.push({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' } } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
  });
  sse += mapper.finish();

  const events = parseEvents(sse).map((entry) => entry.event);
  assert.deepEqual(events, [
    'message_start',
    'ping',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const parsed = parseEvents(sse);
  const toolStart = parsed[5].data;
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.name, 'bash');
  assert.equal(parsed[6].data.delta.partial_json, '{"cmd":"ls"}');
  // A turn that ends in a tool call must report tool_use, not end_turn.
  assert.equal(parsed[8].data.delta.stop_reason, 'tool_use');
  assert.equal(parsed[8].data.usage.output_tokens, 4);
});

test('anthropic stream: blocks are indexed sequentially', () => {
  const mapper = new AnthropicStreamMapper('gemini-3-flash');
  mapper.start();
  const sse =
    mapper.push({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'thought', thought: true, thoughtSignature: 'sig-1234567890' }] } },
      ],
    }) + mapper.push({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }] });

  const events = parseEvents(sse);
  const indexes = events.map((entry) => entry.data.index);
  assert.deepEqual(indexes, [0, 0, 0, 0, 1, 1]);
  assert.equal(events[0].data.content_block.type, 'thinking');
  assert.equal(events[2].data.delta.type, 'signature_delta');
  assert.equal(events[4].data.content_block.type, 'text');
});

test('responses request: function_call output is paired with its call', () => {
  const request = responsesToGemini({
    model: 'gpt-oss-120b-medium',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
      { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ],
  });

  assert.deepEqual(request.systemInstruction, { parts: [{ text: 'You are Codex.' }] });
  assert.deepEqual(request.contents[1].parts[0].functionCall, {
    name: 'shell',
    args: { cmd: 'ls' },
  });
  assert.deepEqual(request.contents[2].parts[0].functionResponse, {
    name: 'shell',
    response: { output: 'a.txt' },
  });
});

test('tool schemas drop keywords the upstream rejects', () => {
  const sanitized = sanitizeToolSchema({
    $schema: 'https://json-schema.org/draft-07/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, description: 'file path' },
      mode: { oneOf: [{ type: 'string' }], type: 'string' },
    },
    required: ['path'],
  });

  assert.deepEqual(sanitized, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path' },
      mode: { type: 'string' },
    },
    required: ['path'],
  });
});

test('tool schemas drop annotations the upstream has never heard of', () => {
  // What Copilot actually sends: JSON Schema annotations Gemini rejects, one of
  // which is enough to fail the whole request.
  const sanitized = sanitizeToolSchema({
    type: 'object',
    $comment: 'internal note',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'], enumDescriptions: ['first', 'second'] },
      paths: { type: 'array', items: { type: 'string', $comment: 'a path' } },
      limit: { type: ['integer', 'null'], minimum: 1 },
    },
  });

  assert.deepEqual(sanitized, {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'] },
      paths: { type: 'array', items: { type: 'string' } },
      // The null half of the union is dropped outright: carrying it as
      // `nullable` is OpenAPI, not JSON Schema, and Anthropic rejects the tool
      // over it once the upstream converts the declaration for Claude.
      limit: { type: 'integer', minimum: 1 },
    },
  });
});

test('tool schemas stay valid JSON Schema draft 2020-12', () => {
  // Everything here is accepted somewhere in Gemini's dialect and rejected by
  // Anthropic's `input_schema` validation, which is what a Claude request via
  // the Cloud Code endpoints ends up going through.
  const sanitized = sanitizeToolSchema({
    type: 'OBJECT',
    propertyOrdering: ['path'],
    properties: {
      path: { type: 'STRING', nullable: true },
      depth: { type: 'integer', minimum: '1', maximum: 10 },
      kind: { type: 'timestamp' },
      tags: { type: 'array' },
      mode: { type: 'string', enum: [] },
      note: { type: 'string', description: { text: 'not a string' } },
    },
    required: ['path', 'missing'],
  });

  assert.deepEqual(sanitized, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      depth: { type: 'integer', maximum: 10 },
      // `kind` is gone: an unknown type name is not forwarded, and nothing in
      // the node says what it should have been.
      // Gemini rejects an array without `items`, so one is supplied.
      tags: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['path'],
  });
});

test('a union collapses onto the node instead of leaving it untyped', () => {
  // `edit_notebook_file`, the declaration Copilot sends that the upstream
  // rejected: `newCode` is a union, so the node itself has no type, and an
  // untyped node reaches Anthropic as TYPE_UNSPECIFIED and fails the tool.
  const sanitized = sanitizeToolSchema({
    type: 'object',
    properties: {
      newCode: {
        anyOf: [
          { type: 'string', description: 'The code for the cell' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      cellId: { description: 'Id of the cell', oneOf: [{ type: 'string' }] },
      unknowable: { description: 'no type, no shape' },
    },
    required: ['newCode', 'unknowable'],
  });

  assert.deepEqual(sanitized, {
    type: 'object',
    properties: {
      newCode: { type: 'string', description: 'The code for the cell' },
      // The member brought no description of its own, so the node's is kept.
      cellId: { type: 'string', description: 'Id of the cell' },
    },
    required: ['newCode'],
  });
});

test('tool schemas drop required names whose property did not survive', () => {
  const sanitized = sanitizeToolSchema({
    type: 'object',
    properties: { anything: true },
    required: ['anything'],
  });

  assert.deepEqual(sanitized, { type: 'object', properties: {} });
});

test('tool schemas keep properties whose names collide with keywords', () => {
  const sanitized = sanitizeToolSchema({
    type: 'object',
    properties: {
      default: { type: 'string' },
      $comment: { type: 'string' },
      format: { type: 'string' },
    },
  });

  assert.deepEqual(Object.keys(sanitized.properties as object), ['default', '$comment', 'format']);
});

test('generation constraints keep room for the answer after thinking', () => {
  const config = { maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 5000 } };
  applyGenerationConstraints(config, 'gemini-3-flash', {
    maxOutputTokens: 65536,
    thinkingBudget: 32768,
  });

  // maxOutputTokens must exceed the thinking budget or the model has no room
  // left to answer.
  assert.ok(config.maxOutputTokens > config.thinkingConfig.thinkingBudget);
  assert.equal(config.thinkingConfig.thinkingBudget, 5000);
  assert.equal(config.maxOutputTokens, 13192);
});

test('generation constraints clamp a budget above the model limit', () => {
  const config = { thinkingConfig: { thinkingBudget: -1 } };
  applyGenerationConstraints(config, 'gemini-3.5-flash-low', {
    maxOutputTokens: 65536,
    thinkingBudget: 1000,
  });

  assert.equal(config.thinkingConfig.thinkingBudget, 1000);
});

test('SSE parsing survives events split across chunks', async () => {
  // The upstream splits payloads at arbitrary byte boundaries, so the parser
  // must hold incomplete tails until the rest arrives.
  const chunks = ['data: {"a":', '1}\n\ndata: {"b":2}\n', '\ndata: [DONE]\n\n'];
  const stream = (async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  })();

  const seen: string[] = [];
  for await (const event of parseSse(stream as any)) {
    seen.push(event.data);
  }

  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '[DONE]']);
});
