import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicMessage, AnthropicRequest } from '../protocol/anthropic/types';
import { GeminiRequest } from '../protocol/gemini';
import { describeUltracode, noteUltracode, ultracodeFor, ultracodeState } from '../upstream/ultracode';

// The reminders as Claude Code 2.1.295 writes them.
const ON =
  'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. ' +
  'Use the Workflow tool on every substantive task; token cost is not a constraint. See the **Ultracode** ' +
  'section and quality patterns in the workflow authoring reference. Solo only on conversational/trivial turns.';
const STILL_ON =
  'Ultracode is still on — use the Workflow tool; see the Ultracode section of the workflow authoring reference.';
const OFF = "Ultracode is off — the Workflow tool's standard opt-in rule applies again.";
const KEYWORD =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — ' +
  'use the Workflow tool to fulfill the request.';

const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;

/** A user prompt, with the reminders Claude Code attached to it. */
function prompt(text: string, ...reminders: string[]): AnthropicMessage {
  return {
    role: 'user',
    content: [...reminders.map((r) => ({ type: 'text', text: reminder(r) })), { type: 'text', text }],
  };
}

function toolCall(id: string): AnthropicMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] };
}

/** The agentic loop's continuation: a tool result, with any reminders beside it. */
function toolResult(id: string, ...reminders: string[]): AnthropicMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: 'file contents' },
      ...reminders.map((r) => ({ type: 'text', text: reminder(r) })),
    ],
  };
}

const answer = (text: string): AnthropicMessage => ({ role: 'assistant', content: text });

const SKILL_BODY = 'Base directory for this skill: /home/u/skills/workflow-authoring\n\n# Workflow authoring\n...';

function skillCall(id: string): AnthropicMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'workflow-authoring' } }] };
}

/** What Claude Code sends back for a Skill call: a short result, then the skill's body as text. */
function skillLoaded(id: string): AnthropicMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content: 'Launching skill: workflow-authoring' },
      { type: 'text', text: SKILL_BODY },
    ],
  };
}

test('ultracode: the full reminder turns it on for the session', () => {
  assert.equal(ultracodeState([prompt('build the thing', ON)]), 'session');
});

test('ultracode: the dash and spacing may vary', () => {
  assert.equal(ultracodeState([prompt('go', 'Ultracode  is still on - use the Workflow tool.')]), 'session');
  assert.equal(
    ultracodeState([prompt('go', ON), answer('ok'), prompt('next', 'Ultracode is off - standard rule.')]),
    undefined,
  );
});

test('ultracode: the sparse reminder keeps it on in later turns', () => {
  const messages = [
    prompt('first', ON),
    answer('done'),
    prompt('second'),
    answer('done'),
    prompt('third', STILL_ON),
  ];
  assert.equal(ultracodeState(messages), 'session');
  // Turns without any reminder stay on: the last on/off reminder decides.
  assert.equal(ultracodeState([...messages, answer('done'), prompt('fourth')]), 'session');
});

test('ultracode: off after on turns it off, on after off turns it back on', () => {
  const off = [prompt('first', ON), answer('done'), prompt('second', OFF)];
  assert.equal(ultracodeState(off), undefined);
  assert.equal(ultracodeState([...off, answer('done'), prompt('third', ON)]), 'session');
});

test('ultracode: reminders inside tool results count', () => {
  const messages: AnthropicMessage[] = [
    prompt('go'),
    toolCall('t1'),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `result\n${reminder(ON)}` }] },
  ];
  assert.equal(ultracodeState(messages), 'session');
});

test('ultracode: the keyword holds for its turn, through the tool results, and not the next', () => {
  const turn = [prompt('earlier'), answer('ok'), prompt('ultracode: refactor the parser', KEYWORD)];
  assert.equal(ultracodeState(turn), 'turn');

  const loop = [...turn, toolCall('t1'), toolResult('t1'), toolCall('t2'), toolResult('t2')];
  assert.equal(ultracodeState(loop), 'turn');

  assert.equal(ultracodeState([...loop, answer('done'), prompt('thanks, now rename it')]), undefined);
});

test('ultracode: loading the workflow reference does not end a keyword turn', () => {
  const turn = [prompt('earlier'), answer('ok'), prompt('ultracode: refactor the parser', KEYWORD), skillCall('s1')];
  // Claude Code sends the skill's body as plain text, beside the tool result
  // or in a message of its own after it.
  assert.equal(ultracodeState([...turn, skillLoaded('s1')]), 'turn');
  assert.equal(
    ultracodeState([
      ...turn,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: workflow-authoring' }] },
      { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    ]),
    'turn',
  );
  assert.equal(ultracodeState([...turn, skillLoaded('s1'), toolCall('t1'), toolResult('t1')]), 'turn');
});

test('ultracode: text Claude Code adds mid-loop does not end a keyword turn', () => {
  const messages: AnthropicMessage[] = [
    prompt('ultracode: refactor the parser', KEYWORD),
    toolCall('t1'),
    toolResult('t1'),
    { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' },
  ];
  assert.equal(ultracodeState(messages), 'turn');
});

test('ultracode: what the user types after an interrupt is a new turn', () => {
  const interrupted: AnthropicMessage[] = [
    prompt('ultracode: refactor the parser', KEYWORD),
    toolCall('t1'),
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: "The user doesn't want to proceed.", is_error: true },
        { type: 'text', text: '[Request interrupted by user for tool use]' },
      ],
    },
  ];
  assert.equal(ultracodeState([...interrupted, prompt('just rename it instead')]), undefined);
  assert.equal(ultracodeState([...interrupted, prompt('ultracode: rename it instead', KEYWORD)]), 'turn');
});

test('ultracode: a message with no content does not crash', () => {
  const messages = [prompt('hi'), answer('ok'), { role: 'user', content: null } as unknown as AnthropicMessage];
  assert.equal(ultracodeFor(body(messages)), undefined);
});

test('ultracode: a keyword reminder sent as its own message still belongs to the turn', () => {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: reminder(KEYWORD) },
    { role: 'user', content: 'ultracode: refactor the parser' },
  ];
  assert.equal(ultracodeState(messages), 'turn');
});

test('ultracode: a session that is on wins over the keyword', () => {
  assert.equal(ultracodeState([prompt('ultracode go', ON, KEYWORD)]), 'session');
});

test('ultracode: the user mentioning it is not a reminder', () => {
  const quoted = [
    { role: 'user' as const, content: 'What does "Ultracode is on: optimize for the most exhaustive" mean?' },
    { role: 'user' as const, content: `Ultracode is on: is that a mode?` },
    { role: 'user' as const, content: `Look at this:\n\`\`\`\n${ON}\n${KEYWORD}\n\`\`\`` },
  ];
  for (const message of quoted) {
    assert.equal(ultracodeState([message]), undefined, String(message.content));
  }
  // Quoted mid-line or in a code block inside a reminder — a file Claude Code
  // attached, say — does not count either.
  assert.equal(ultracodeState([prompt('hi', `File notes: ${ON}`)]), undefined);
  assert.equal(ultracodeState([prompt('hi', `\`\`\`\n${ON}\n\`\`\``)]), undefined);
});

test('ultracode: an assistant quoting the reminder does not turn it on', () => {
  assert.equal(ultracodeState([prompt('explain'), answer(reminder(ON))]), undefined);
});

// ── The directive ─────────────────────────────────────────────────────────────

const TOOLS = [{ name: 'Workflow' }, { name: 'Skill' }, { name: 'Read' }];

function body(messages: AnthropicMessage[], tools = TOOLS): AnthropicRequest {
  return { model: 'gemini-3-flash', messages, tools };
}

function noted(request: AnthropicRequest): string[] {
  const gemini: GeminiRequest = { contents: [], systemInstruction: { parts: [{ text: 'Client prompt.' }] } };
  noteUltracode(gemini, request, ultracodeFor(request));
  return gemini.systemInstruction!.parts.map((part) => part.text);
}

test('ultracode: the directive goes last, after the untouched client prompt', () => {
  const parts = noted(body([prompt('go', ON)]));
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'Client prompt.');
  assert.match(parts[1], /Ultracode is on for this session/);
  assert.match(parts[1], /Workflow tool on your own initiative/);
  assert.match(parts[1], /Skill tool \(skill: "workflow-authoring"\)/);
  // Ultracode is the opt-in the tool's description asks for; the directive
  // stands in for the reminder that only comes every few turns.
  assert.match(parts[1], /the confirmation the Workflow tool description asks for/);
  assert.match(parts[1], /even when no ultracode reminder appears/);
  assert.doesNotMatch(parts[1], /overrides/);
});

test("ultracode: a keyword turn's directive says it is for this turn", () => {
  const parts = noted(body([prompt('ultracode go', KEYWORD)]));
  assert.match(parts[1], /on for this turn/);
  assert.match(parts[1], /including the tool results that follow/);
});

test('ultracode: no Workflow tool, no directive — workflow subagents never orchestrate', () => {
  const request = body([prompt('go', ON)], [{ name: 'Read' }]);
  assert.equal(ultracodeFor(request), undefined);
  assert.deepEqual(noted(request), ['Client prompt.']);
  assert.deepEqual(noted({ model: 'm', messages: [prompt('go', ON)] }), ['Client prompt.']);
});

test('ultracode: the Skill step is left out without a Skill tool', () => {
  assert.doesNotMatch(noted(body([prompt('go', ON)], [{ name: 'Workflow' }]))[1], /Skill tool/);
});

test('ultracode: the directive stays the same once the reference is loaded, so the cache holds', () => {
  const before = noted(body([prompt('go', ON)]));
  const after = noted(body([prompt('go', ON), skillCall('s1'), skillLoaded('s1')]));
  assert.deepEqual(after, before);
});

test('ultracode: a side request that forbids tools is not told to orchestrate', () => {
  // Claude Code's compaction fork: the session's tools and history, then its own prompt.
  const compaction: AnthropicMessage[] = [
    prompt('build the thing', ON),
    answer('done'),
    {
      role: 'user',
      content:
        'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
        'Your task is to create a detailed summary of the conversation so far.',
    },
  ];
  assert.equal(ultracodeState(compaction), 'session');
  assert.equal(ultracodeFor(body(compaction)), undefined);
  assert.deepEqual(noted(body(compaction)), ['Client prompt.']);
});

test('ultracode: the directive tells the model to leave side requests alone', () => {
  assert.match(noted(body([prompt('go', ON)]))[1], /system request such as a summary.*do not call Workflow/);
});

test('ultracode: plain user text mentioning ultracode adds nothing', () => {
  assert.deepEqual(noted(body([{ role: 'user', content: 'Can you explain what ultracode does?' }])), [
    'Client prompt.',
  ]);
});

test('ultracode: the log line names the state', () => {
  assert.equal(describeUltracode('session'), 'ultracode=session');
  assert.equal(describeUltracode('turn'), 'ultracode=turn');
  assert.equal(describeUltracode(undefined), 'ultracode=-');
});

// ── Claude Code 2.1.295: meta text in `system` messages ───────────────────────

/** A meta message as 2.1.295 sends it: bare text, no `<system-reminder>`, after the prompt. */
const meta = (...lines: string[]): AnthropicMessage => ({ role: 'system', content: lines.join('\n\n') });

const ENVIRONMENT = '# Environment\nYou have been invoked in the following environment:\n - Platform: win32';
const TOTAL = '<total_tokens>15000000 tokens left</total_tokens>';

test('ultracode: a system message turns it on for the session, as 2.1.295 sends it', () => {
  // The first request of a session with ultracode on: the prompt, then one
  // system message carrying the environment and the reminder.
  const first: AnthropicMessage[] = [prompt('projeyi inceler misin?'), meta(ENVIRONMENT, TOTAL, ON, "Today's date is 2026-10-09.")];
  assert.equal(ultracodeFor(body(first)), 'session');
  assert.match(noted(body(first))[1], /Ultracode is on for this session/);

  // Later turns carry it in the history, behind newer system messages.
  const later = [...first, answer('ok'), prompt('ikinci tur'), meta(TOTAL)];
  assert.equal(ultracodeFor(body(later)), 'session');
  assert.equal(ultracodeFor(body([...later, answer('ok'), prompt('next'), meta(OFF)])), undefined);
});

test('ultracode: a keyword note in a system message holds for its turn', () => {
  const turn: AnthropicMessage[] = [prompt('ultracode analiz et'), meta(ENVIRONMENT, KEYWORD)];
  assert.equal(ultracodeState(turn), 'turn');
  const looped = [...turn, toolCall('t1'), toolResult('t1'), meta(TOTAL)];
  assert.equal(ultracodeState(looped), 'turn');
  assert.equal(ultracodeState([...looped, answer('done'), prompt('thanks'), meta(TOTAL)]), undefined);
});

test('ultracode: a system message before the prompt belongs to its turn', () => {
  assert.equal(ultracodeState([answer('hi'), meta(KEYWORD), prompt('ultracode go')]), 'turn');
});

test('ultracode: a quoted or fenced reminder in a system message does not count', () => {
  assert.equal(ultracodeState([prompt('hi'), meta(`Notes: ${ON}`)]), undefined);
  assert.equal(ultracodeState([prompt('hi'), meta('```', ON, '```')]), undefined);
});

test('ultracode: a compaction prompt followed by a system message is still not told to orchestrate', () => {
  const compaction: AnthropicMessage[] = [
    prompt('build the thing'),
    meta(ON),
    answer('done'),
    { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nSummarize.' },
    meta(TOTAL),
  ];
  assert.equal(ultracodeState(compaction), 'session');
  assert.equal(ultracodeFor(body(compaction)), undefined);
});

test('ultracode: an earlier turn that forbade tools does not silence a later one', () => {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: 'Do NOT call any tools, just answer.' },
    meta(ON),
    answer('ok'),
    prompt('now build it'),
    meta(TOTAL),
  ];
  assert.equal(ultracodeFor(body(messages)), 'session');
});
