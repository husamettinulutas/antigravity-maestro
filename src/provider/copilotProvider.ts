import * as vscode from 'vscode';
import { AccountLease, LeaseContext } from '../accounts/accountLease';
import {
  FunctionDeclaration,
  GeminiContent,
  GeminiPart,
  GeminiRequest,
  GeminiResponse,
  GeminiTool,
  SAFETY_SETTINGS,
  UsageMetadata,
  pruneUndefined,
} from '../protocol/gemini';
import { sanitizeToolSchema } from '../protocol/schema';
import { signatureStore } from '../protocol/signatureStore';
import { CloudCodeClient } from '../upstream/cloudCodeClient';
import { applyGenerationConstraints } from '../upstream/constraints';
import { ModelCatalog } from '../upstream/modelCatalog';
import { prefixedId } from '../utils/ids';
import { Logger } from '../utils/logger';

/** Rough characters-per-token ratio used for the token count estimate. */
const CHARS_PER_TOKEN = 3.7;

/**
 * Exposes the Antigravity models to Copilot Chat's model picker and runs
 * requests in-process — no local gateway involved.
 */
export class AntigravityChatProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /**
   * The name matters: this is the optional member VS Code looks for on the
   * provider. Under any other name the model list is read once, at
   * registration — before any account has finished loading its quota — and
   * never again, so the picker stays empty.
   */
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  /** LanguageModelThinkingPart only exists in recent VS Code builds. */
  private readonly thinkingPartAvailable =
    typeof (vscode as any).LanguageModelThinkingPart === 'function';

  /**
   * Whether the models are offered to VS Code at all. Restoring Copilot to its
   * own providers turns this off — the provider stays registered, it just has
   * nothing to publish.
   */
  private published = true;

  constructor(
    private readonly catalog: ModelCatalog,
    private readonly lease: AccountLease,
    private readonly client: CloudCodeClient,
  ) {}

  /** Ask VS Code to re-read the model list (after sign-in or a quota refresh). */
  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  get isPublishing(): boolean {
    return this.published;
  }

  setPublished(published: boolean): void {
    if (this.published === published) {
      return;
    }
    this.published = published;
    Logger.info(`Copilot models ${published ? 'published' : 'withdrawn'}`);
    this.refresh();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (!this.published) {
      return [];
    }

    return this.catalog
      .listAll()
      .filter((model) => model.family !== 'image')
      .map((model) => ({
        id: model.id,
        name: model.displayName,
        family: 'Antigravity Maestro',
        version: '1.0.0',
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          imageInput: model.supportsImages,
          toolCalling: model.supportsTools,
        },
      }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    let declarations: FunctionDeclaration[] | undefined;

    try {
      await this.lease.run(model.id, async (context) => {
        const request = this.buildRequest(messages, options, context, model);
        declarations = request.tools?.[0]?.functionDeclarations;
        const size = measureRequest(request);
        Logger.info(
          `Copilot request: model=${context.model.id}, account=${context.email}, ` +
            `messages=${request.contents.length}, tools=${declarations?.length ?? 0}, ` +
            `prompt~${size.prompt} (tools ${size.tools}, attachments ${size.attachments})`,
        );

        const stream = await this.client.streamGenerate({
          model: context.model.id,
          request,
          accessToken: context.accessToken,
          projectId: context.projectId,
          accountId: context.accountId,
      accountEmail: context.email,
          signal: abort.signal,
          requestType: 'agent',
        });

        await this.pumpStream(stream, progress, context, token);
      }, abort.signal);
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`Copilot request failed: ${message}`, error);
      logRejectedTool(message, declarations);
      progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ ${message}`));
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const raw = typeof text === 'string' ? text : extractText(text.content);
    return Math.max(1, Math.ceil(raw.length / CHARS_PER_TOKEN));
  }

  // ── Streaming ──────────────────────────────────────────────────────────────

  private async pumpStream(
    stream: AsyncGenerator<GeminiResponse>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    context: LeaseContext,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let emitted = false;
    // Gemini repeats the running totals on nearly every chunk, so only the
    // final figures are recorded — writing each chunk would put the history on
    // disk hundreds of times per answer and redraw the panel with it. The
    // fields are merged rather than the last object taken wholesale: a chunk
    // that omits a counter it reported earlier (thinking tokens stop being
    // mentioned once the thinking is over) would otherwise erase it.
    let usage: UsageMetadata | undefined;

    try {
      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          return;
        }

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          emitted = this.reportPart(part, progress) || emitted;
        }

        if (chunk.usageMetadata) {
          usage = mergeUsage(usage, chunk.usageMetadata);
        }
      }
    } catch (error) {
      // Once output has reached the user, switching accounts would duplicate
      // it — surface the failure instead of letting the lease retry.
      if (emitted) {
        throw new Error(
          `Response interrupted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    } finally {
      // Cancelled and failed requests still spent their tokens.
      Logger.debug('Usage reported by the upstream', usage);
      await this.lease.recordUsage(context, usage);
    }
  }

  /** Report one Gemini part to VS Code. Returns true when something was shown. */
  private reportPart(
    part: GeminiPart,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): boolean {
    if (part.functionCall?.name) {
      // The upstream's own id is kept when it sends one: the Claude models are
      // served by translating this into the Anthropic format, and the id has to
      // match the `tool_use` block the next turn refers back to.
      const callId = part.functionCall.id || prefixedId('call');
      signatureStore.rememberToolCall(callId, part.thoughtSignature);
      progress.report(
        new vscode.LanguageModelToolCallPart(callId, part.functionCall.name, part.functionCall.args ?? {}),
      );
      return true;
    }

    if (typeof part.text !== 'string' || part.text === '') {
      return false;
    }

    if (part.thought) {
      this.reportThinking(part.text, progress);
      return true;
    }

    progress.report(new vscode.LanguageModelTextPart(part.text));
    return true;
  }

  private reportThinking(
    text: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (this.thinkingPartAvailable) {
      progress.report(
        new (vscode as any).LanguageModelThinkingPart(text) as vscode.LanguageModelResponsePart,
      );
      return;
    }
    progress.report(new vscode.LanguageModelTextPart(text));
  }

  // ── Request building ───────────────────────────────────────────────────────

  private buildRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    context: LeaseContext,
    model: vscode.LanguageModelChatInformation,
  ): GeminiRequest {
    const { systemText, contents } = convertMessages(messages);
    const tools = buildTools(options);

    const request: GeminiRequest = {
      contents,
      safetySettings: [...SAFETY_SETTINGS],
      generationConfig: {
        maxOutputTokens: model.maxOutputTokens,
        thinkingConfig: context.model.supportsThinking
          ? { includeThoughts: true, thinkingBudget: context.model.thinkingBudget }
          : undefined,
      },
    };

    if (systemText.trim() !== '') {
      request.systemInstruction = { parts: [{ text: systemText }] };
    }
    if (tools) {
      request.tools = [tools];
      request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    applyGenerationConstraints(request.generationConfig!, context.model.id, {
      maxOutputTokens: context.model.maxOutputTokens,
      thinkingBudget: context.model.thinkingBudget,
    });

    return pruneUndefined(request);
  }
}

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Convert VS Code chat messages into Gemini contents. Exported for tests.
 *
 * VS Code models a conversation as user/assistant messages whose parts carry
 * tool calls and results; Gemini expects alternating user/model contents with
 * functionCall / functionResponse parts, and needs the tool *name* on results,
 * which VS Code only supplies on the original call.
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
  systemText: string;
  contents: GeminiContent[];
} {
  const toolNamesByCallId = collectToolNames(messages);
  const contents: GeminiContent[] = [];
  const systemChunks: string[] = [];

  for (const message of messages) {
    const role = roleOf(message);
    if (role === 'system') {
      systemChunks.push(extractText(message.content));
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const part of asArray(message.content)) {
      const converted = convertPart(part, toolNamesByCallId);
      if (converted) {
        parts.push(converted);
      }
    }

    if (parts.length === 0) {
      continue;
    }

    // Tool results belong to a user turn even when VS Code groups them
    // alongside assistant content.
    const geminiRole: GeminiContent['role'] =
      role === 'assistant' && !parts.some((part) => part.functionResponse) ? 'model' : 'user';

    const previous = contents[contents.length - 1];
    if (previous?.role === geminiRole) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role: geminiRole, parts });
    }
  }

  return { systemText: systemChunks.join('\n\n'), contents };
}

function convertPart(
  part: unknown,
  toolNames: Map<string, string>,
): GeminiPart | undefined {
  if (isToolCallPart(part)) {
    const signature = signatureStore.forToolCall(part.callId);
    return {
      functionCall: {
        // Required: for the Claude models the upstream turns this back into an
        // Anthropic `tool_use` block, which rejects the request without an id.
        id: part.callId,
        name: part.name,
        args: typeof part.input === 'object' && part.input ? (part.input as any) : {},
      },
      thoughtSignature: signature,
    };
  }

  if (isToolResultPart(part)) {
    const name = toolNames.get(part.callId) ?? 'tool';
    const output = extractText(part.content) || '(no output)';
    return { functionResponse: { id: part.callId, name, response: { output } } };
  }

  if (isImagePart(part)) {
    return {
      inlineData: {
        mimeType: part.mimeType,
        data: Buffer.from(part.data).toString('base64'),
      },
    };
  }

  const text = textOfPart(part);
  return text === '' ? undefined : { text };
}

/** callId → tool name, taken from the assistant turns that made the calls. */
function collectToolNames(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of asArray(message.content)) {
      if (isToolCallPart(part)) {
        names.set(part.callId, part.name);
      }
    }
  }
  return names;
}

export function buildTools(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): GeminiTool | undefined {
  const tools = options.tools ?? [];
  if (tools.length === 0) {
    return undefined;
  }

  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema as Record<string, unknown> | undefined),
  }));

  // Two things this answers. Upstream reports a rejected tool schema by index
  // only ("tools.4"), which is useless without the list it indexes into — and
  // the declarations are most of what a turn costs, so they are listed heaviest
  // first, which is the order worth switching them off in.
  Logger.debug(
    'Tool declarations',
    declarations
      .map((declaration, index) => ({
        index,
        name: declaration.name,
        bytes: JSON.stringify(declaration).length,
        parameters: declaration.parameters,
      }))
      .sort((a, b) => b.bytes - a.bytes),
  );

  return { functionDeclarations: declarations };
}

/**
 * Upstream names a rejected tool by index only ("tools.4.custom.input_schema"),
 * which is useless without the list it indexes into — so the declaration it
 * points at is dumped next to the failure, rather than only at `debug` level on
 * a run that has to be set up in advance to reproduce the same error.
 */
/**
 * Keep the highest figure reported for each counter. The totals only grow
 * within a response, so the largest value seen is the final one — and a counter
 * missing from a later chunk keeps the value it had.
 */
function mergeUsage(
  current: UsageMetadata | undefined,
  incoming: UsageMetadata,
): UsageMetadata {
  if (!current) {
    return { ...incoming };
  }

  const merged: UsageMetadata = { ...current };
  for (const [key, value] of Object.entries(incoming) as [keyof UsageMetadata, unknown][]) {
    if (typeof value !== 'number') {
      continue;
    }
    const held = merged[key];
    merged[key] = typeof held === 'number' ? Math.max(held, value) : value;
  }
  return merged;
}

/**
 * Rough sizes of what a request is made of, so a turn that costs far more than
 * the question suggests can be traced to the part that carries it — an attached
 * file, the tool declarations, or the conversation itself. Character counts,
 * not tokens: the upstream reports the tokens, this says where they came from.
 */
function measureRequest(request: GeminiRequest): {
  prompt: string;
  tools: string;
  attachments: string;
} {
  const tools = request.tools ? JSON.stringify(request.tools).length : 0;
  const system = request.systemInstruction ? JSON.stringify(request.systemInstruction).length : 0;
  const contents = JSON.stringify(request.contents).length;

  // Inline data is base64, so it dwarfs the text around it and is worth its own
  // number rather than being buried in the conversation total.
  let attachments = 0;
  for (const content of request.contents) {
    for (const part of content.parts ?? []) {
      const data = (part as { inlineData?: { data?: string } }).inlineData?.data;
      if (typeof data === 'string') {
        attachments += data.length;
      }
    }
  }

  return {
    prompt: kilobytes(system + contents + tools),
    tools: kilobytes(tools),
    attachments: kilobytes(attachments),
  };
}

function kilobytes(characters: number): string {
  return `${Math.round(characters / 1024)}KB`;
}

/** The tool index in a rejection like `tools.4.custom.input_schema: …`. */
export function rejectedToolIndex(message: string): number | undefined {
  const match = /tools\.(\d+)\./.exec(message);
  return match ? Number(match[1]) : undefined;
}

export function logRejectedTool(
  message: string,
  declarations: readonly FunctionDeclaration[] | undefined,
): void {
  const index = rejectedToolIndex(message);
  if (index === undefined) {
    return;
  }

  const sent = declarations ?? [];
  Logger.error(
    `Upstream rejected tool ${index}; ${sent.length} declarations were sent` +
      (sent.length > 0 ? `: ${sent.map((entry, at) => `${at}:${entry.name}`).join(', ')}` : ''),
  );

  const declaration = sent[index];
  if (!declaration) {
    // The rejected tool is not one this extension sent, so whatever schema the
    // 400 is about was added past this point.
    return;
  }

  Logger.error(
    `Rejected tool ${index} (${declaration.name}) schema: ${JSON.stringify(declaration.parameters)}`,
  );
}

// ── Part type guards (duck-typed: classes vary across VS Code versions) ───────

function isToolCallPart(part: any): part is vscode.LanguageModelToolCallPart {
  return !!part && typeof part === 'object' && 'callId' in part && 'name' in part && 'input' in part;
}

function isToolResultPart(part: any): part is vscode.LanguageModelToolResultPart {
  return !!part && typeof part === 'object' && 'callId' in part && 'content' in part && !('name' in part);
}

function isImagePart(part: any): part is { data: Uint8Array; mimeType: string } {
  return (
    !!part &&
    typeof part === 'object' &&
    'data' in part &&
    typeof part.mimeType === 'string' &&
    part.mimeType.startsWith('image/')
  );
}

function roleOf(message: vscode.LanguageModelChatRequestMessage): 'user' | 'assistant' | 'system' {
  const role = message.role as unknown;
  const systemEnum = (vscode.LanguageModelChatMessageRole as any).System;
  if ((systemEnum !== undefined && role === systemEnum) || role === 'system' || role === 0) {
    return 'system';
  }
  if (role === vscode.LanguageModelChatMessageRole.Assistant || role === 'assistant' || role === 2) {
    return 'assistant';
  }
  return 'user';
}

function asArray(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return content;
  }
  return content === undefined || content === null ? [] : [content];
}

function textOfPart(part: any): string {
  if (typeof part === 'string') {
    return part;
  }
  if (part && typeof part === 'object' && typeof part.value === 'string') {
    return part.value;
  }
  return '';
}

function extractText(content: unknown): string {
  return asArray(content)
    .map((part) => {
      if (isToolResultPart(part)) {
        return extractText((part as any).content);
      }
      return textOfPart(part);
    })
    .join('');
}
