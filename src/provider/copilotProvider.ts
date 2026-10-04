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
import { signatureFamilyOf, signatureStore } from '../protocol/signatureStore';
import { CloudCodeClient, StreamBrokenError } from '../upstream/cloudCodeClient';
import { applyGenerationConstraints, budgetForEffort } from '../upstream/constraints';
import {
  EmptyResponseError,
  EmptyResponseWatch,
  Silence,
  describeSilence,
  describeTail,
  overlongPrompt,
  retryAfter,
} from '../upstream/emptyResponse';
import { ModelCatalog } from '../upstream/modelCatalog';
import {
  isTieredModel,
  resolveThinkingEffort,
  thinkingEffortSchema,
} from '../upstream/thinkingEffort';
import { Config } from '../utils/config';
import { prefixedId } from '../utils/ids';
import { Logger } from '../utils/logger';

/** Rough characters-per-token ratio used for the token count estimate. */
const CHARS_PER_TOKEN = 3.7;

/**
 * What one attached image is counted as. Its bytes say nothing useful — the
 * base64 of a screenshot would read as tens of thousands of tokens — and the
 * models charge a bounded amount per image: Gemini 3 about 1,100 at its default
 * resolution, Claude up to about 1,600.
 */
const IMAGE_TOKENS = 1_600;

/**
 * The tool Copilot Chat's autopilot gives the model to say the task is done.
 * It is a control signal for Copilot's loop, not work: its result is the
 * model's own summary handed back to it.
 */
const TASK_COMPLETE_TOOL = 'task_complete';

/**
 * What a turn that ends with nothing to show reports to Copilot Chat.
 *
 * Copilot counts a response as a success only when it carries text or a tool
 * call; anything else is "Sorry, no response was returned", and a thrown error
 * is "Sorry, your request failed" — and in autopilot both are sent again,
 * identically, three times over. A line break is text, so the turn succeeds,
 * yet it renders as nothing and is dropped from later prompts, and autopilot's
 * own rules still apply: it stops after `task_complete`, and nudges the model
 * itself if the task is not marked done.
 */
const NOTHING_TO_ADD = '\n';

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

    const models = this.catalog.listAll().filter((model) => model.family !== 'image');
    // The largest window on offer, so a model can say it is the smaller one.
    const widest = Math.max(0, ...models.map((model) => model.maxInputTokens));
    const onActive = new Set(this.catalog.list().map((model) => model.id));
    const effortSchema = thinkingEffortSchema(
      resolveThinkingEffort(undefined, Config.copilotThinkingEffort()),
    );

    return models.map((model) => ({
      id: model.id,
      name: model.displayName,
      family: 'Antigravity Maestro',
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      // The window is in the picker because switching to a smaller one is what
      // makes Copilot Chat compact the conversation — an expensive turn the
      // user never asked for, and one they could only discover afterwards.
      detail: `${compactTokens(model.maxInputTokens)} context`,
      tooltip: tooltipFor(model, widest, onActive.has(model.id)),
      capabilities: {
        imageInput: model.supportsImages,
        toolCalling: model.supportsTools,
      },
      // `*-tiered` models get a Low/Medium/High choice right in the picker.
      // `configurationSchema` belongs to VS Code's proposed chatProvider API,
      // and the host passes it through without the extension enabling the
      // proposal; hosts that do not know it ignore the field, and the setting
      // decides. Enabling the proposal in package.json is what would break:
      // vsce refuses to publish an extension that declares one, and VS Code
      // logs an error for it on every start.
      ...(isTieredModel(model.id) && model.supportsThinking
        ? { configurationSchema: effortSchema }
        : {}),
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (followsTaskComplete(messages, options)) {
      // Autopilot always sends one more request after the model calls
      // task_complete, carrying only that call's result — the model's own
      // summary, which the tool tells it not to restate. The model rightly
      // answers with nothing, and that answer was billed as a full-context
      // request. Ending the turn here is the answer it would have given.
      Logger.info(
        `Copilot request after task_complete on ${model.id}; ending the turn without asking again`,
      );
      progress.report(new vscode.LanguageModelTextPart(NOTHING_TO_ADD));
      return;
    }

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    let declarations: FunctionDeclaration[] | undefined;

    try {
      await this.lease.run(model.id, async (context) => {
        const request = this.buildRequest(messages, options, context, model);
        declarations = request.tools?.[0]?.functionDeclarations;
        const size = measureRequest(request);
        // The share of the window a prompt fills is the one number that
        // explains a compaction after the fact: Copilot Chat rewrites the
        // conversation when it stops fitting, and until this was logged there
        // was no way to tell that turn from an ordinary one.
        const fill = windowFill(size.characters, context.model.maxInputTokens);
        Logger.info(
          `Copilot request: model=${context.model.id}, account=${context.email}, ` +
            `messages=${request.contents.length}, tools=${declarations?.length ?? 0}, ` +
            `prompt~${size.prompt} (tools ${size.tools}, attachments ${size.attachments})` +
            (fill ? `, ~${fill.tokens} of ${fill.window} context (${fill.percent}%)` : ''),
        );
        if (fill && fill.percent >= 80) {
          Logger.warn(
            `Prompt fills ${fill.percent}% of ${context.model.id}'s ${fill.window} context; ` +
              'Copilot Chat compacts the conversation once it no longer fits',
          );
        }

        const overflow = overlongPrompt(size.characters, context.model);
        if (overflow) {
          throw new Error(overflow);
        }

        await this.runTurn(request, context, progress, token, abort.signal);
      }, abort.signal, conversationOf(options));
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`Copilot request failed: ${message}`, error);
      logRejectedTool(message, declarations);
      // No warning text before the throw: Copilot already prints the reason,
      // and text streamed ahead of a failure is never cleared — autopilot's
      // retries stacked one warning line per attempt, and after a reload the
      // text could come back in the history as something the model had said.
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  /**
   * Copilot Chat budgets every prompt with this, and compacts the conversation
   * once the budget runs out — so a count that runs low is a compaction that
   * comes too late, and a prompt past the model's limit, which the upstream
   * bills and answers with nothing. Tool-call arguments used to count for
   * nothing, though in an agent session they are much of the prompt: every
   * file an edit tool wrote travels in them.
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const size = typeof text === 'string' ? { characters: text.length, images: 0 } : measureParts(text.content);
    return Math.max(1, Math.ceil(size.characters / CHARS_PER_TOKEN) + size.images * IMAGE_TOKENS);
  }

  // ── Streaming ──────────────────────────────────────────────────────────────

  /**
   * Run one turn against the leased account, and settle a turn that brought
   * no answer instead of failing it.
   *
   * Copilot Chat sends a failed request again — in autopilot three times,
   * identically — and each attempt is billed in full. So a silence is only an
   * error when asking again could change it: a stream cut off before it
   * finished. A model that ended its turn with nothing to say is nudged once
   * with a continuation prompt, since the identical request would only get the
   * same decision, and then its turn ends. A refusal is explained in the
   * answer, where it ends the turn instead of starting a round of retries.
   *
   * Asking again is safe because nothing but reasoning reached the user, and it
   * stays on the same account: a silence says nothing about an account's
   * standing.
   */
  private async runTurn(
    request: GeminiRequest,
    context: LeaseContext,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    signal: AbortSignal,
  ): Promise<void> {
    let current = request;
    for (let attempt = 0; ; attempt++) {
      const stream = await this.client.streamGenerate({
        model: context.model.id,
        request: current,
        accessToken: context.accessToken,
        projectId: context.projectId,
        accountId: context.accountId,
        accountEmail: context.email,
        signal,
        requestType: 'agent',
      });

      let silence: Silence | undefined;
      try {
        silence = await this.pumpStream(stream, progress, context, token);
      } catch (error) {
        // A stream that broke off before anything reached the user is asked
        // again once, unchanged: nothing was decided, and nothing can be
        // shown twice. Once output has gone out it arrives here as
        // "Response interrupted" instead, and is not retried.
        if (attempt === 0 && error instanceof StreamBrokenError && !token.isCancellationRequested) {
          Logger.warn(`${context.email} on ${context.model.id}: ${error.message} Asking once more.`);
          continue;
        }
        throw error;
      }
      if (!silence || token.isCancellationRequested) {
        return;
      }

      Logger.warn(
        `${context.email} on ${context.model.id}: ${describeSilence(silence)}; ` +
          `the request ended with ${describeTail(current)}`,
      );

      const again = attempt === 0 ? retryAfter(silence, current) : undefined;
      if (again) {
        Logger.info(
          again === current ? 'Asking once more, unchanged' : 'Asking once more, with a nudge to continue',
        );
        current = again;
        continue;
      }

      settleSilence(silence, progress);
      return;
    }
  }

  /**
   * Stream one upstream response into Copilot Chat. Returns why it carried no
   * answer, or `undefined` when it did (or the user cancelled).
   */
  private async pumpStream(
    stream: AsyncGenerator<GeminiResponse>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    context: LeaseContext,
    token: vscode.CancellationToken,
  ): Promise<Silence | undefined> {
    let emitted = false;
    const watch = new EmptyResponseWatch();
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
          return undefined;
        }

        watch.note(chunk);

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (this.reportPart(part, progress, context.model.id)) {
            emitted = true;
          }
        }

        if (chunk.usageMetadata) {
          usage = mergeUsage(usage, chunk.usageMetadata);
        }
      }

      if (token.isCancellationRequested) {
        return undefined;
      }
      reportUsage(progress, usage);
      return watch.silence(context.model);
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
    model: string,
  ): boolean {
    if (part.functionCall?.name) {
      // The upstream's own id is kept when it sends one: the Claude models are
      // served by translating this into the Anthropic format, and the id has to
      // match the `tool_use` block the next turn refers back to.
      const callId = part.functionCall.id || prefixedId('call');
      signatureStore.rememberToolCall(callId, part.thoughtSignature, model);
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
    const { systemText, contents } = convertMessages(
      messages,
      context.model.id,
      context.model.supportsThinking,
    );
    const tools = buildTools(options);

    let thinkingBudget = context.model.thinkingBudget;
    if (isTieredModel(context.model.id) && context.model.supportsThinking) {
      const effort = resolveThinkingEffort(
        (options as { modelConfiguration?: { [key: string]: any } }).modelConfiguration,
        Config.copilotThinkingEffort(),
      );
      thinkingBudget = budgetForEffort(effort, context.model.id, context.model.thinkingBudget);
      Logger.info(`Thinking effort for ${context.model.id}: ${effort} (budget ${thinkingBudget})`);
    }

    const request: GeminiRequest = {
      contents,
      safetySettings: [...SAFETY_SETTINGS],
      generationConfig: {
        maxOutputTokens: model.maxOutputTokens,
        thinkingConfig: context.model.supportsThinking
          ? { includeThoughts: true, thinkingBudget }
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
      thinkingBudget,
    });

    return pruneUndefined(request);
  }
}

/**
 * End a turn that brought no answer in the way that stops Copilot Chat from
 * asking again for nothing.
 *
 * Copilot retries every failure the same way whatever its cause, so only a
 * stream that was cut off is thrown — asking again is the remedy there. A model
 * that finished with nothing to say gets an empty line, which Copilot counts
 * as a finished turn. A refusal is explained in the answer instead of thrown:
 * each retry of it would be billed for the same refusal, and in autopilot an
 * answer ends the run where a failure would start three more attempts.
 */
function settleSilence(
  silence: Silence,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
  switch (silence.kind) {
    case 'finished':
      progress.report(new vscode.LanguageModelTextPart(NOTHING_TO_ADD));
      return;
    case 'refused':
    case 'brokenCall':
      progress.report(new vscode.LanguageModelTextPart(`⚠️ ${silence.message}`));
      return;
    case 'cutOff':
      throw new EmptyResponseError(silence.message, true);
  }
}

/**
 * Hand Copilot Chat the upstream's own token counts for a response.
 *
 * Copilot reads a `usage` data part for its context-window indicator and for
 * deciding when to compact a conversation in the background. Without one both
 * ran on zeros — the indicator read empty, and compaction had only the
 * character estimate to go on. The count is the prompt the upstream actually
 * saw, cached tokens included, and the answer that will be part of the next
 * one; reasoning is left out, because it is not sent back.
 */
function reportUsage(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: UsageMetadata | undefined,
): void {
  const DataPart = (vscode as any).LanguageModelDataPart;
  if (!usage?.promptTokenCount || typeof DataPart !== 'function') {
    return;
  }

  const prompt = usage.promptTokenCount;
  const completion = usage.candidatesTokenCount ?? 0;
  const payload = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount ?? 0 },
  };
  progress.report(
    new DataPart(new TextEncoder().encode(JSON.stringify(payload)), 'usage') as vscode.LanguageModelResponsePart,
  );
}

/**
 * The conversation a request belongs to, as Copilot Chat names it: the chat
 * session, which stays the same across every turn, compactions included.
 */
function conversationOf(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
  const id = (options as { modelOptions?: { _conversationId?: unknown } }).modelOptions?._conversationId;
  return typeof id === 'string' && id !== '' ? `copilot:${id}` : undefined;
}

/**
 * True when a request exists only to let the model speak after it called
 * `task_complete`.
 *
 * Copilot Chat's autopilot never stops on the round that calls the tool: it
 * runs the tool, sends one more request ending in its result, and stops once
 * that round comes back without tool calls. The result is the model's own
 * summary, and the tool's description tells it not to restate it — so the
 * right answer is nothing, and it was the answer every time. Exported for tests.
 *
 * Only a request whose trailing tool results all answer `task_complete`
 * qualifies; a result from any other tool next to it may need a response.
 */
export function followsTaskComplete(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: { tools?: readonly { name: string }[] },
): boolean {
  // The tool is only offered in autopilot, and only there does the loop work
  // this way.
  if (!options.tools?.some((tool) => tool.name === TASK_COMPLETE_TOOL)) {
    return false;
  }

  const names = collectToolNames(messages);
  let answered = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const parts = asArray(message.content);
    if (roleOf(message) !== 'user' || parts.length === 0 || !parts.every(isToolResultPart)) {
      break;
    }
    for (const part of parts) {
      if (names.get((part as vscode.LanguageModelToolResultPart).callId) !== TASK_COMPLETE_TOOL) {
        return false;
      }
      answered += 1;
    }
  }
  return answered > 0;
}

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Convert VS Code chat messages into Gemini contents. Exported for tests.
 *
 * VS Code models a conversation as user/assistant messages whose parts carry
 * tool calls and results; Gemini expects alternating user/model contents with
 * functionCall / functionResponse parts, and needs the tool *name* on results,
 * which VS Code only supplies on the original call.
 *
 * `model` is the model the contents are being built for: it decides which
 * stored thought signatures may be replayed, and which calls have to be
 * retold as text because no signature for them survives.
 */
export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  model = 'gemini',
  requiresSignature = false,
): {
  systemText: string;
  contents: GeminiContent[];
} {
  const toolNamesByCallId = collectToolNames(messages);
  const unsigned = unsignedCallIds(messages, model, requiresSignature);
  const contents: GeminiContent[] = [];
  const systemChunks: string[] = [];

  if (unsigned.size > 0) {
    Logger.debug(
      `Retelling ${unsigned.size} unsigned tool call(s) as text for ${model}`,
      [...unsigned],
    );
  }

  for (const message of messages) {
    const role = roleOf(message);
    if (role === 'system') {
      systemChunks.push(extractText(message.content));
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const part of asArray(message.content)) {
      const converted = convertPart(part, toolNamesByCallId, model, unsigned);
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
  model: string,
  unsigned: ReadonlySet<string>,
): GeminiPart | undefined {
  // Copilot hands the model's earlier reasoning back as thinking parts. They
  // carry no signature, so they cannot go back as thoughts, and sent as text
  // they would read as things the model said to the user.
  if (isThinkingPart(part)) {
    return undefined;
  }

  // task_complete is autopilot's signal to stop, and its result is the model's
  // own summary handed back. Left in, it ends every autopilot turn on a tool
  // result, so the next prompt follows a tool result instead of the model's
  // closing words — the shape that teaches Claude to answer with nothing.
  if (isToolCallPart(part) && part.name === TASK_COMPLETE_TOOL) {
    return undefined;
  }
  if (isToolResultPart(part) && toolNames.get(part.callId) === TASK_COMPLETE_TOOL) {
    return undefined;
  }

  if (isToolCallPart(part)) {
    const args = typeof part.input === 'object' && part.input ? (part.input as any) : {};
    if (unsigned.has(part.callId)) {
      return { text: `[tool call] ${part.name}(${JSON.stringify(args)})` };
    }
    return {
      functionCall: {
        // Required: for the Claude models the upstream turns this back into an
        // Anthropic `tool_use` block, which rejects the request without an id.
        id: part.callId,
        name: part.name,
        args,
      },
      thoughtSignature: signatureStore.forToolCall(part.callId, model),
    };
  }

  if (isToolResultPart(part)) {
    const name = toolNames.get(part.callId) ?? 'tool';
    const output = extractText(part.content) || '(no output)';
    // The call it answers was retold as text, and a functionResponse with no
    // functionCall before it is rejected just as hard as the bare call was.
    if (unsigned.has(part.callId)) {
      return { text: `[tool result] ${name}: ${output}` };
    }
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
  // Whitespace alone says nothing, and the Claude models reject a text block
  // without any — a line break that ended a silent turn must not come back.
  return text.trim() === '' ? undefined : { text };
}

/**
 * The tool calls that cannot be replayed to `model` as tool calls.
 *
 * Gemini 3 rejects the whole request — HTTP 400, "Function call is missing a
 * thought_signature" — when a replayed `functionCall` carries no signature it
 * issued. That happens for reasons the conversation cannot undo: the turn was
 * made by a different model family before the user switched, the extension was
 * reloaded and the in-memory store went with it, or the signature aged out.
 *
 * Dropping those calls would orphan their results and lose what the assistant
 * did; sending them bare fails the turn. So they are retold as text, which
 * keeps the history readable and the request valid. The set is computed in one
 * pass up front because a call and its result are converted separately and the
 * two decisions have to agree.
 *
 * The decision is made per step — one assistant turn — not per call. Gemini
 * signs only the first call of a step; the others in a parallel batch never
 * carry a signature, and only the first is checked. Judging each call on its
 * own retold every parallel call after the first as text, in every turn, even
 * with its signature safely in the store.
 *
 * Only Gemini needs this. The Claude and GPT models are served by translating
 * the request back out of the Gemini shape, and an unsigned tool call survives
 * that translation.
 */
function unsignedCallIds(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  model: string,
  requiresSignature: boolean,
): ReadonlySet<string> {
  const unsigned = new Set<string>();
  if (!requiresSignature || signatureFamilyOf(model) !== 'gemini') {
    return unsigned;
  }

  for (const message of messages) {
    // task_complete calls are dropped from the history (see `convertPart`), so
    // the step's first call is the first of the ones that remain.
    const calls = asArray(message.content).filter(
      (part): part is vscode.LanguageModelToolCallPart =>
        isToolCallPart(part) && part.name !== TASK_COMPLETE_TOOL,
    );
    if (calls.length > 0 && !signatureStore.forToolCall(calls[0].callId, model)) {
      for (const call of calls) {
        unsigned.add(call.callId);
      }
    }
  }
  return unsigned;
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
  /** The prompt in characters, for the limit check the log line cannot do. */
  characters: number;
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
    characters: system + contents + tools,
  };
}

function kilobytes(characters: number): string {
  return `${Math.round(characters / 1024)}KB`;
}

/**
 * How much of a model's context window a prompt takes up, by the same rough
 * ratio the token count estimate uses. `undefined` when the model publishes no
 * window to measure against.
 */
export function windowFill(
  characters: number,
  maxInputTokens: number,
): { tokens: string; window: string; percent: number } | undefined {
  if (!(maxInputTokens > 0)) {
    return undefined;
  }
  const tokens = Math.ceil(characters / CHARS_PER_TOKEN);
  return {
    tokens: compactTokens(tokens),
    window: compactTokens(maxInputTokens),
    percent: Math.round((tokens / maxInputTokens) * 100),
  };
}

/** A token count as the picker shows it: `200K`, `1M`. */
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_048_576;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}

/**
 * What hovering a model in the picker says.
 *
 * The note about compaction is only on the models it can happen to. Copilot
 * Chat rewrites a conversation that no longer fits the chosen model — the
 * "Compacting conversation…" turn — and that turn is charged to the account
 * like any other, so a switch from a 1M-token model to a 200K one can cost
 * more than the answer that prompted it. Knowing which way the switch goes is
 * the whole of the defence, and nothing in the picker used to say.
 */
function tooltipFor(
  model: {
    displayName: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    accountEmail?: string;
  },
  widest: number,
  onActive: boolean,
): string {
  const sizes =
    `${compactTokens(model.maxInputTokens)} context, up to ` +
    `${compactTokens(model.maxOutputTokens)} output`;
  const warning =
    model.maxInputTokens < widest
      ? ' — switching to it from a larger-context model makes Copilot compact the ' +
        'conversation first, which costs a turn of its own'
      : '';
  // The list is every account's models together, so one the active account
  // does not have says where its requests will go.
  const elsewhere =
    !onActive && model.accountEmail
      ? ` · not on the active account; requests go to ${model.accountEmail}`
      : '';
  return `${model.displayName} · ${sizes}${warning}${elsewhere}`;
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

/** LanguageModelThinkingPart only exists in recent VS Code builds. */
function isThinkingPart(part: unknown): boolean {
  const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
  return typeof ThinkingPart === 'function' && part instanceof ThinkingPart;
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

/**
 * What a message's parts will cost once converted: the characters of the text,
 * tool calls and tool results that go upstream, and the images, counted apart.
 * Reasoning is left out because it is never sent back (see `convertPart`).
 */
function measureParts(content: unknown): { characters: number; images: number } {
  let characters = 0;
  let images = 0;
  for (const part of asArray(content)) {
    if (isThinkingPart(part)) {
      continue;
    }
    if (isToolCallPart(part)) {
      characters += part.name.length + JSON.stringify(part.input ?? {}).length;
      continue;
    }
    if (isToolResultPart(part)) {
      const inner = measureParts((part as any).content);
      characters += inner.characters;
      images += inner.images;
      continue;
    }
    if (isImagePart(part)) {
      images += 1;
      continue;
    }
    characters += textOfPart(part).length;
  }
  return { characters, images };
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
