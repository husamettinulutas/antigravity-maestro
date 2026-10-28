import assert from 'node:assert/strict';
import test from 'node:test';
import { toGeminiRequest } from '../protocol/anthropic/request';
import { toAnthropicResponse } from '../protocol/anthropic/response';
import { AnthropicStreamMapper } from '../protocol/anthropic/stream';
import { GeminiResponse } from '../protocol/gemini';
import { IMAGE_RETOLD } from '../protocol/images';
import { ChatStreamMapper, toChatCompletion } from '../protocol/openai/chatStream';
import { chatToGemini, responsesToGemini } from '../protocol/openai/request';
import { toResponsesResponse } from '../protocol/openai/responsesStream';
import { EmptyResponseWatch } from '../upstream/emptyResponse';

const MODEL = 'gemini-3.1-flash-image';
const SIGNATURE = 'signature-for-the-image';

/** A generated image, distinct per test so signatures never leak between them. */
function imageResponse(data: string, text?: string): GeminiResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            ...(text ? [{ text }] : []),
            { inlineData: { mimeType: 'image/png', data }, thoughtSignature: SIGNATURE },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
  };
}

test('images: a generated image is an answer, not a silence to nudge', () => {
  const watch = new EmptyResponseWatch();
  watch.note(imageResponse('aW1hZ2Ux'));
  assert.equal(watch.sawAnswer, true);
  assert.equal(watch.silence(), undefined);
});

test('images: an image the model drew while reasoning is not the answer', () => {
  const watch = new EmptyResponseWatch();
  watch.note({
    candidates: [
      {
        content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'ZHJhZnQ=' }, thought: true }] },
        finishReason: 'STOP',
      },
    ],
  });
  assert.equal(watch.sawAnswer, false);
});

test('images: chat completions carry the image as markdown', () => {
  const completion = toChatCompletion(imageResponse('aW1hZ2Uy', 'Here it is.'), MODEL);
  const content = completion.choices[0].message.content!;
  assert.match(content, /^Here it is\./);
  assert.ok(content.includes('![image](data:image/png;base64,aW1hZ2Uy)'));

  const mapper = new ChatStreamMapper(MODEL);
  const sse = mapper.push(imageResponse('aW1hZ2Uz'));
  const chunk = JSON.parse(sse.match(/^data: (.+)$/m)![1]);
  assert.ok(chunk.choices[0].delta.content.includes('![image](data:image/png;base64,aW1hZ2Uz)'));
});

test('images: responses and anthropic answers carry the image as markdown', () => {
  const responses = toResponsesResponse(imageResponse('aW1hZ2U0'), MODEL);
  const message = responses.output.find((item) => item.type === 'message')!;
  assert.ok(message.content![0].text.includes('base64,aW1hZ2U0)'));

  const anthropic = toAnthropicResponse(imageResponse('aW1hZ2U1'), MODEL);
  assert.equal(anthropic.content[0].type, 'text');
  assert.ok((anthropic.content[0] as any).text.includes('base64,aW1hZ2U1)'));

  const stream = new AnthropicStreamMapper(MODEL);
  assert.ok(stream.push(imageResponse('aW1hZ2U2')).includes('base64,aW1hZ2U2)'));
});

test('images: a replayed image goes back as the signed image, not as text', () => {
  const content = toChatCompletion(imageResponse('aW1hZ2U3', 'Done.'), MODEL).choices[0].message.content!;
  const request = chatToGemini(
    {
      model: MODEL,
      messages: [
        { role: 'user', content: 'draw a cat' },
        { role: 'assistant', content },
        { role: 'user', content: 'make it blue' },
      ],
    },
    MODEL,
  );

  const parts = request.contents[1].parts;
  assert.deepEqual(parts, [
    { text: 'Done.' },
    { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U3' }, thoughtSignature: SIGNATURE },
  ]);
});

test('images: an image whose signature is gone is retold, never sent as base64 text', () => {
  const markdown = 'Sure.\n\n![image](data:image/png;base64,bmV2ZXJTZWVu)\n\n';

  const chat = chatToGemini(
    { model: MODEL, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: markdown }] },
    MODEL,
  );
  assert.deepEqual(chat.contents[1].parts, [{ text: 'Sure.' }, { text: IMAGE_RETOLD }]);

  const responses = responsesToGemini(
    {
      model: MODEL,
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: markdown }] },
      ],
    },
    MODEL,
  );
  assert.deepEqual(responses.contents[1].parts, [{ text: 'Sure.' }, { text: IMAGE_RETOLD }]);

  const { request: anthropic } = toGeminiRequest(
    {
      model: MODEL,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: markdown }] },
      ],
    },
    MODEL,
  );
  assert.deepEqual(anthropic.contents[1].parts, [{ text: 'Sure.' }, { text: IMAGE_RETOLD }]);
});

test('images: a user pasting image markdown is left alone', () => {
  const markdown = '![x](data:image/png;base64,dXNlcg==)';
  const request = chatToGemini({ model: MODEL, messages: [{ role: 'user', content: markdown }] }, MODEL);
  assert.deepEqual(request.contents[0].parts, [{ text: markdown }]);
});
