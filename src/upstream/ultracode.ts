import {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
} from '../protocol/anthropic/types';
import { GeminiRequest } from '../protocol/gemini';

/**
 * Claude Code's ultracode mode, for the models served here.
 *
 * Ultracode asks the model to orchestrate every substantive task with the
 * Workflow tool. Claude Code says so only as text in meta user messages — a
 * full reminder when it turns on, a sparse one now and then after that, one
 * when it turns off, and a one-turn note when the user typed the keyword.
 * Claude reads those and acts on them. Gemini and GPT-OSS weigh text buried in
 * user turns far below the system instruction, the sparse reminder is easy to
 * miss, and the Workflow tool's own description says to run only on an
 * explicit opt-in — so they could explain ultracode when asked but never
 * started a workflow on their own. The state is read back from the
 * conversation here and restated as a system directive.
 *
 * `session`: the conversation's latest on/off reminder says on.
 * `turn`: the user typed the keyword in the current human turn.
 */
export type UltracodeState = 'session' | 'turn';

type MarkerKind = 'on' | 'off' | 'keyword';

/**
 * The reminders' opening sentences, as Claude Code 2.1.295 writes them. The
 * dash may be an em dash or a plain hyphen, and spacing may vary. Each has to
 * start a line inside a `<system-reminder>`, so a user who quotes one in a
 * sentence — or a file that contains one — does not switch anything.
 */
const MARKERS: { kind: MarkerKind; pattern: RegExp }[] = [
  { kind: 'on', pattern: /^Ultracode\s+is\s+on\s*[:—–-]/i },
  { kind: 'on', pattern: /^Ultracode\s+is\s+still\s+on\s*[:—–-]/i },
  { kind: 'off', pattern: /^Ultracode\s+is\s+off\s*[:—–-]/i },
  {
    kind: 'keyword',
    pattern: /^The\s+user\s+included\s+the\s+keyword\s+["'“”]?ultracode\b/i,
  },
];

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
const FENCE = /^\s*(```|~~~)/;
const INTERRUPTED = '[Request interrupted by user';
const NO_TOOLS = /\bRespond with TEXT ONLY\b|\bDo NOT call any tools\b/i;

/**
 * The ultracode state of a request: `session` when the last on/still-on/off
 * reminder in the conversation is on, else `turn` when the keyword note sits
 * in the current human turn, else `undefined`.
 *
 * The current human turn starts at the last user message the user wrote
 * something in outside the agentic loop, and runs to the end — so the
 * tool_result requests that follow keep the turn's state, text Claude Code
 * adds among them does not end it, and the next prompt the user types does.
 */
export function ultracodeState(messages: AnthropicMessage[]): UltracodeState | undefined {
  const found = messages.map((message) => (message.role === 'user' ? markersIn(message) : []));

  let session = false;
  for (const kinds of found) {
    for (const kind of kinds) {
      if (kind === 'on' || kind === 'off') {
        session = kind === 'on';
      }
    }
  }
  if (session) {
    return 'session';
  }

  const start = currentTurnStart(messages);
  return found.slice(start).some((kinds) => kinds.includes('keyword')) ? 'turn' : undefined;
}

/**
 * The ultracode state to act on for a Claude Code request, or `undefined`.
 *
 * Only a request that can run a workflow is told to: the subagents a workflow
 * starts are not given the Workflow tool, and telling them to orchestrate
 * would have them try to start workflows of their own.
 *
 * Claude Code also forks the main conversation for side requests — compaction,
 * prompt suggestions, /btw, titles — with the same tools and history, and its
 * own request as the last message. Compaction says not to call tools, denies
 * every call, and has one turn: a model told to orchestrate there would spend
 * it on a Workflow call and write no summary. Such a request is not told.
 */
export function ultracodeFor(body: AnthropicRequest): UltracodeState | undefined {
  if (!declaresTool(body, 'Workflow') || forbidsTools(body.messages)) {
    return undefined;
  }
  return ultracodeState(body.messages);
}

/**
 * Restate ultracode as a directive, at the end of the system instruction —
 * after the client's own prompt, so the cached prefix stays the same, as
 * `noteEffort` does with the effort.
 */
export function noteUltracode(
  request: GeminiRequest,
  body: AnthropicRequest,
  state: UltracodeState | undefined,
): void {
  if (!state) {
    return;
  }
  // Depends only on what stays the same through a session: a directive that
  // changed mid-session would throw away the cached tools and conversation,
  // which come after the system instruction.
  const directive = ultracodeDirective(state, declaresTool(body, 'Skill'));
  request.systemInstruction = {
    parts: [...(request.systemInstruction?.parts ?? []), { text: directive }],
  };
}

/** The ultracode state, for the per-request log line. */
export function describeUltracode(state: UltracodeState | undefined): string {
  return `ultracode=${state ?? '-'}`;
}

/**
 * The directive itself: short and firm, written for the model.
 *
 * The Workflow tool's description already counts ultracode as the explicit
 * opt-in it asks for, "a system-reminder confirms it". In a session that
 * reminder comes only every few turns, and in a keyword turn it falls further
 * back with every tool result — so the directive says it is that confirmation.
 */
function ultracodeDirective(state: UltracodeState, canLoadReference: boolean): string {
  const scope =
    state === 'session'
      ? 'Ultracode is on for this session: it is the user\'s standing opt-in to multi-agent orchestration.'
      : 'Ultracode is on for this turn: the user opted this turn into multi-agent orchestration with the keyword "ultracode", ' +
        'and that holds until the user\'s next message, including the tool results that follow.';
  const reference = canLoadReference
    ? ' Before writing your first workflow script, load the workflow authoring reference with the Skill tool (skill: "workflow-authoring"), unless it is already in this conversation.'
    : '';
  const confirmation =
    state === 'session'
      ? ' This instruction is the confirmation the Workflow tool description asks for: ultracode stays on for this session even when no ultracode reminder appears in the latest messages.'
      : ' This instruction is the confirmation the Workflow tool description asks for, even when the keyword reminder is several messages back.';
  return (
    `${scope} On every substantive task the user gives you, plan and run a workflow with the Workflow tool on your own initiative — ` +
    'do not ask first, and do not wait to be told.' +
    reference +
    ' Work solo only on conversational turns or trivial mechanical edits.' +
    ' If the latest message is a system request such as a summary, a suggestion or a title, or it says not to call tools, follow that message and do not call Workflow.' +
    confirmation
  );
}

// ── Reading the conversation ──────────────────────────────────────────────────

/** The ultracode reminders in one user message, in order. */
function markersIn(message: AnthropicMessage): MarkerKind[] {
  const kinds: MarkerKind[] = [];
  for (const text of textsOf(message.content)) {
    if (!text.includes('<system-reminder>')) {
      continue;
    }
    for (const match of text.matchAll(REMINDER)) {
      kinds.push(...markersInReminder(match[1]));
    }
  }
  return kinds;
}

/** Markers that open a line of a reminder, outside any fenced code block. */
function markersInReminder(body: string): MarkerKind[] {
  const kinds: MarkerKind[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const trimmed = line.trimStart();
    const marker = MARKERS.find(({ pattern }) => pattern.test(trimmed));
    if (marker) {
      kinds.push(marker.kind);
    }
  }
  return kinds;
}

/**
 * Every piece of text in a message's content. Reminders also ride inside
 * tool results, where Claude Code attaches them mid-turn.
 */
function textsOf(content: string | AnthropicContentBlock[] | undefined): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_result') {
      texts.push(...textsOf(block.content as string | AnthropicContentBlock[] | undefined));
    }
  }
  return texts;
}

/**
 * Where the current human turn starts: the last user message that opens one.
 * A meta-only user message right before it (one Claude Code did not merge
 * into the prompt) belongs to the same turn. With no human turn found, the
 * whole conversation is one turn.
 */
function currentTurnStart(messages: AnthropicMessage[]): number {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (opensHumanTurn(messages, i)) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return 0;
  }
  while (start > 0 && messages[start - 1].role === 'user' && !hasToolResult(messages[start - 1])) {
    start--;
  }
  return start;
}

/** True when a user message is the user starting a new turn. */
function opensHumanTurn(messages: AnthropicMessage[], index: number): boolean {
  const message = messages[index];
  return message.role === 'user' && hasHumanText(message) && !continuesLoop(messages, index);
}

/**
 * True when a user message carries on the agentic loop rather than starting a
 * turn: it holds a tool result, or the assistant's last message before it
 * called a tool. Claude Code adds text of its own there without a reminder
 * around it — a skill's body after "Launching skill: workflow-authoring", a
 * task notification — and that is not the user typing. An interrupt ends the
 * loop: what the user types after it is a new turn.
 */
function continuesLoop(messages: AnthropicMessage[], index: number): boolean {
  if (wasInterrupted(messages[index])) {
    return false;
  }
  if (hasToolResult(messages[index])) {
    return true;
  }
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant') {
      return callsTool(message);
    }
    if (wasInterrupted(message)) {
      return false;
    }
  }
  return false;
}

/**
 * True when a user message holds something the user wrote: text outside the
 * reminders, or an image they pasted — not just a tool result and the
 * reminders Claude Code attached to it.
 */
function hasHumanText(message: AnthropicMessage): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    return isHuman(content);
  }
  return blocksOf(message).some(
    (block) =>
      block.type === 'image' ||
      (block.type === 'text' && typeof block.text === 'string' && isHuman(block.text)),
  );
}

function isHuman(text: string): boolean {
  return humanPart(text) !== '';
}

/** A text with Claude Code's reminders taken out. */
function humanPart(text: string): string {
  return text.replace(REMINDER, '').trim();
}

/** Claude Code's marker for the user pressing Esc mid-turn. */
function wasInterrupted(message: AnthropicMessage): boolean {
  return message.role === 'user' && userTexts(message).some((text) => text.startsWith(INTERRUPTED));
}

/**
 * True when the request's last message says not to call tools — Claude Code's
 * compaction prompt does ("Respond with TEXT ONLY. Do NOT call any tools."),
 * and so may a user who wants a plain answer.
 */
function forbidsTools(messages: AnthropicMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last?.role === 'user' && userTexts(last).some((text) => NO_TOOLS.test(text));
}

/** The text of a user message's own blocks, reminders taken out. */
function userTexts(message: AnthropicMessage): string[] {
  if (typeof message.content === 'string') {
    return [humanPart(message.content)];
  }
  return blocksOf(message).flatMap((block) =>
    block.type === 'text' && typeof block.text === 'string' ? [humanPart(block.text)] : [],
  );
}

function hasToolResult(message: AnthropicMessage): boolean {
  return blocksOf(message).some((block) => block.type === 'tool_result');
}

function callsTool(message: AnthropicMessage): boolean {
  return blocksOf(message).some((block) => block.type === 'tool_use');
}

/** A message's content blocks; content that is missing or not a list has none. */
function blocksOf(message: AnthropicMessage): AnthropicContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

function declaresTool(body: AnthropicRequest, name: string): boolean {
  return Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === name);
}
