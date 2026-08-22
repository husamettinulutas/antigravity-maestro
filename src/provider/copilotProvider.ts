import * as vscode from 'vscode';
import { AccountLease, LeaseContext } from '../accounts/accountLease';
import {
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

    try {
      await this.lease.run(model.id, async (context) => {
        const request = this.buildRequest(messages, options, context, model);
        Logger.info(
          `Copilot request: model=${context.model.id}, account=${context.email}, messages=${request.contents.length}`,
        );

        const stream = await this.client.streamGenerate({
          model: context.model.id,
          request,
          accessToken: context.accessToken,
          projectId: context.projectId,
          signal: abort.signal,
          requestType: 'agent',
        });

        await this.pumpStream(stream, progress, context, token);
      });
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`Copilot request failed: ${message}`, error);
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
    // Gemini repeats the running totals on nearly every chunk, so the last one
    // seen is the whole request. Recording each of them instead would write the
    // history to disk hundreds of times per answer and redraw the panel with it.
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
          usage = chunk.usageMetadata;
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
      await this.lease.recordUsage(context, usage);
    }
  }

  /** Report one Gemini part to VS Code. Returns true when something was shown. */
  private reportPart(
    part: GeminiPart,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): boolean {
    if (part.functionCall?.name) {
      const callId = `call_${Math.random().toString(36).slice(2, 12)}`;
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
        name: part.name,
        args: typeof part.input === 'object' && part.input ? (part.input as any) : {},
      },
      thoughtSignature: signature,
    };
  }

  if (isToolResultPart(part)) {
    const name = toolNames.get(part.callId) ?? 'tool';
    const output = extractText(part.content) || '(no output)';
    return { functionResponse: { name, response: { output } } };
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

  return {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.inputSchema as Record<string, unknown> | undefined),
    })),
  };
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
