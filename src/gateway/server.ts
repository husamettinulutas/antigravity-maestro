import * as http from 'http';
import { AccountLease, LeaseContext, NoAccountAvailableError } from '../accounts/accountLease';
import { AnthropicStreamMapper } from '../protocol/anthropic/stream';
import { toGeminiRequest } from '../protocol/anthropic/request';
import { toAnthropicResponse } from '../protocol/anthropic/response';
import { AnthropicRequest } from '../protocol/anthropic/types';
import { GeminiRequest, GeminiResponse, UsageMetadata } from '../protocol/gemini';
import { ChatStreamMapper, toChatCompletion } from '../protocol/openai/chatStream';
import { chatToGemini, responsesToGemini } from '../protocol/openai/request';
import { ResponsesStreamMapper, toResponsesResponse } from '../protocol/openai/responsesStream';
import { ChatCompletionsRequest, ResponsesRequest } from '../protocol/openai/types';
import { CloudCodeClient, UpstreamError } from '../upstream/cloudCodeClient';
import { applyGenerationConstraints } from '../upstream/constraints';
import { EmptyResponseError, EmptyResponseWatch } from '../upstream/emptyResponse';
import { ModelCatalog } from '../upstream/modelCatalog';
import { Logger } from '../utils/logger';

/** Refuse request bodies larger than this — a runaway client would exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** What a client is told to wait when every account was refused upstream. */
const FORBIDDEN_RETRY_AFTER_SECONDS = 60;
/** Rough characters-per-token ratio for count_tokens. */
const CHARS_PER_TOKEN = 3.7;

/** Minimal contract the protocol stream mappers satisfy. */
interface StreamMapper {
  start?(): string;
  push(chunk: GeminiResponse): string;
  finish(): string;
  error(message: string): string;
  usage(): UsageMetadata;
}

export interface GatewayDeps {
  lease: AccountLease;
  client: CloudCodeClient;
  catalog: ModelCatalog;
  /** Bearer key clients must present. */
  apiKey: string;
}

/**
 * Local HTTP gateway that speaks the Anthropic and OpenAI protocols on
 * 127.0.0.1 and forwards to the Antigravity models using the leased Google
 * account. Claude Code and Codex are pointed at it.
 */
export class GatewayServer {
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly deps: GatewayDeps) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get apiKey(): string {
    return this.deps.apiKey;
  }

  async start(port: number): Promise<number> {
    if (this.server) {
      return this.port;
    }

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        Logger.error('Gateway handler crashed', error);
        if (!res.headersSent) {
          sendJson(res, 500, errorBody('api_error', describe(error)));
        } else {
          res.end();
        }
      });
    });
    // Agent sessions idle between turns; the default 5s timeout would cut them.
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.port = (server.address() as { port: number }).port;
    Logger.info(`Gateway listening on ${this.url}`);
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    Logger.info('Gateway stopped');
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      sendJson(res, 200, { status: 'ok', models: this.deps.catalog.listAll().length });
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, errorBody('authentication_error', 'Invalid or missing API key'));
      return;
    }

    switch (route) {
      case 'GET /v1/models':
        sendJson(res, 200, this.listModels());
        return;
      case 'POST /v1/messages':
        await this.handleAnthropicMessages(req, res);
        return;
      case 'POST /v1/messages/count_tokens':
        await this.handleCountTokens(req, res);
        return;
      case 'POST /v1/responses':
        await this.handleResponses(req, res);
        return;
      case 'POST /v1/chat/completions':
        await this.handleChatCompletions(req, res);
        return;
      default:
        sendJson(res, 404, errorBody('not_found_error', `No route for ${route}`));
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const bearer = header(req, 'authorization')?.replace(/^Bearer\s+/i, '');
    const apiKeyHeader = header(req, 'x-api-key');
    return bearer === this.deps.apiKey || apiKeyHeader === this.deps.apiKey;
  }

  private listModels() {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: this.deps.catalog.listAll().map((model) => ({
        id: model.id,
        object: 'model',
        created,
        owned_by: 'antigravity',
        display_name: model.displayName,
        context_window: model.maxInputTokens,
        max_output_tokens: model.maxOutputTokens,
      })),
    };
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────

  private async handleAnthropicMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<AnthropicRequest>(req);
    if (!body?.model || !Array.isArray(body.messages)) {
      sendJson(res, 400, errorBody('invalid_request_error', 'model and messages are required'));
      return;
    }

    const abort = abortOnClose(res);

    try {
      await this.deps.lease.run(body.model, async (context) => {
        const request = this.prepareAnthropicRequest(body, context);
        Logger.info(
          `Anthropic request: requested=${body.model}, model=${context.model.id}, account=${context.email}, stream=${body.stream === true}`,
        );

        if (body.stream) {
          await this.pipeStream(res, request, context, abort.signal, () => {
            const mapper = new AnthropicStreamMapper(context.model.id);
            return {
              start: () => mapper.start(),
              push: (chunk) => mapper.push(chunk),
              finish: () => mapper.finish(),
              error: (message) => mapper.error(message),
              usage: () => mapper.usageMetadata(),
            };
          });
          return;
        }

        const response = await this.deps.client.generate({
          model: context.model.id,
          request,
          accessToken: context.accessToken,
          projectId: context.projectId,
          accountId: context.accountId,
      accountEmail: context.email,
          signal: abort.signal,
        });
        await this.deps.lease.recordUsage(context, response.usageMetadata);
        this.rejectEmpty(response, context);
        sendJson(res, 200, toAnthropicResponse(response, context.model.id));
      }, abort.signal);
    } catch (error) {
      this.reportFailure(res, error);
    }
  }

  /**
   * Build the Gemini request for one account. The client's own thinking budget
   * is honoured where the model allows it, then clamped to the model's limits.
   */
  private prepareAnthropicRequest(body: AnthropicRequest, context: LeaseContext): GeminiRequest {
    const { request, requestedThinkingBudget } = toGeminiRequest(body);

    request.generationConfig = request.generationConfig ?? {};
    if (context.model.supportsThinking) {
      request.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget:
          requestedThinkingBudget !== undefined && requestedThinkingBudget >= 0
            ? requestedThinkingBudget
            : context.model.thinkingBudget,
      };
    } else {
      delete request.generationConfig.thinkingConfig;
    }

    applyGenerationConstraints(request.generationConfig, context.model.id, {
      maxOutputTokens: context.model.maxOutputTokens,
      thinkingBudget: context.model.thinkingBudget,
    });
    return request;
  }

  private async handleCountTokens(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<AnthropicRequest>(req);
    const text = JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.system ?? '');
    sendJson(res, 200, { input_tokens: Math.ceil(text.length / CHARS_PER_TOKEN) });
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────────

  /** Responses API — the wire format Codex uses for custom providers. */
  private async handleResponses(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<ResponsesRequest>(req);
    if (!body?.model) {
      sendJson(res, 400, errorBody('invalid_request_error', 'model is required'));
      return;
    }

    const abort = abortOnClose(res);

    try {
      await this.deps.lease.run(body.model, async (context) => {
        const request = this.tuneRequest(responsesToGemini(body), context);
        Logger.info(
          `Responses request: requested=${body.model}, model=${context.model.id}, account=${context.email}, stream=${body.stream === true}`,
        );

        if (body.stream) {
          await this.pipeStream(res, request, context, abort.signal, () => {
            const mapper = new ResponsesStreamMapper(context.model.id);
            return {
              start: () => mapper.start(),
              push: (chunk) => mapper.push(chunk),
              finish: () => mapper.finish(),
              error: (message) => mapper.error(message),
              usage: () => mapper.usageMetadata(),
            };
          });
          return;
        }

        const response = await this.deps.client.generate({
          model: context.model.id,
          request,
          accessToken: context.accessToken,
          projectId: context.projectId,
          accountId: context.accountId,
      accountEmail: context.email,
          signal: abort.signal,
        });
        await this.deps.lease.recordUsage(context, response.usageMetadata);
        this.rejectEmpty(response, context);
        sendJson(res, 200, toResponsesResponse(response, context.model.id));
      }, abort.signal);
    } catch (error) {
      this.reportFailure(res, error);
    }
  }

  /** Chat Completions, for generic OpenAI-compatible clients. */
  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<ChatCompletionsRequest>(req);
    if (!body?.model || !Array.isArray(body.messages)) {
      sendJson(res, 400, errorBody('invalid_request_error', 'model and messages are required'));
      return;
    }

    const abort = abortOnClose(res);
    const includeUsage = body.stream_options?.include_usage === true;

    try {
      await this.deps.lease.run(body.model, async (context) => {
        const request = this.tuneRequest(chatToGemini(body), context);
        Logger.info(
          `Chat request: requested=${body.model}, model=${context.model.id}, account=${context.email}, stream=${body.stream === true}`,
        );

        if (body.stream) {
          await this.pipeStream(res, request, context, abort.signal, () => {
            const mapper = new ChatStreamMapper(context.model.id);
            return {
              push: (chunk) => mapper.push(chunk),
              finish: () => mapper.finish(includeUsage),
              error: (message) => mapper.error(message),
              usage: () => mapper.usageMetadata(),
            };
          });
          return;
        }

        const response = await this.deps.client.generate({
          model: context.model.id,
          request,
          accessToken: context.accessToken,
          projectId: context.projectId,
          accountId: context.accountId,
      accountEmail: context.email,
          signal: abort.signal,
        });
        await this.deps.lease.recordUsage(context, response.usageMetadata);
        this.rejectEmpty(response, context);
        sendJson(res, 200, toChatCompletion(response, context.model.id));
      }, abort.signal);
    } catch (error) {
      this.reportFailure(res, error);
    }
  }

  /** Apply the account's model limits to a converted request. */
  private tuneRequest(request: GeminiRequest, context: LeaseContext): GeminiRequest {
    request.generationConfig = request.generationConfig ?? {};
    if (context.model.supportsThinking) {
      request.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: context.model.thinkingBudget,
      };
    } else {
      delete request.generationConfig.thinkingConfig;
    }

    applyGenerationConstraints(request.generationConfig, context.model.id, {
      maxOutputTokens: context.model.maxOutputTokens,
      thinkingBudget: context.model.thinkingBudget,
    });
    return request;
  }

  /**
   * Fail a non-streaming answer that came back without content, rather than
   * handing the client an assistant turn with nothing in it. The usage is
   * already recorded — the tokens were spent either way.
   */
  private rejectEmpty(response: GeminiResponse, context: LeaseContext): void {
    const watch = new EmptyResponseWatch();
    watch.note(response);
    const empty = watch.failure();
    if (empty) {
      Logger.warn(`Empty response from ${context.email} on ${context.model.id}: ${empty.message}`);
      throw empty;
    }
  }

  // ── Streaming ──────────────────────────────────────────────────────────────

  /**
   * Shared SSE pump.
   *
   * Nothing is written to the client until the upstream produces content. The
   * headers used to go out as soon as the upstream accepted the request, which
   * meant a failure arriving *inside* the stream — a rate limit reported after
   * the 200, or a stream that closed without a word in it — could only be
   * turned into an SSE `error` event on a response that had already committed
   * to succeeding. Holding them back keeps that failure an ordinary one: it
   * propagates out of here, the lease tries the next account, and only a
   * refusal every account shares reaches the client.
   */
  private async pipeStream(
    res: http.ServerResponse,
    request: GeminiRequest,
    context: LeaseContext,
    signal: AbortSignal,
    createMapper: () => StreamMapper,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const mapper = createMapper();
      try {
        await this.pumpOnce(res, request, context, signal, mapper);
        return;
      } catch (error) {
        // An empty stream is worth one more ask on the same account — nothing
        // has reached the client, so the second answer cannot duplicate the
        // first. A deliberate silence (blocked prompt, safety stop) is not.
        const worthRetrying =
          attempt === 0 &&
          error instanceof EmptyResponseError &&
          error.retryable &&
          !res.headersSent &&
          !signal.aborted;
        if (!worthRetrying) {
          throw error;
        }
        Logger.warn(
          `${context.email} returned an empty response on ${context.model.id}; asking once more`,
        );
      }
    }
  }

  /** One upstream stream, mapped to the client's wire format. */
  private async pumpOnce(
    res: http.ServerResponse,
    request: GeminiRequest,
    context: LeaseContext,
    signal: AbortSignal,
    mapper: StreamMapper,
  ): Promise<void> {
    const stream = await this.deps.client.streamGenerate({
      model: context.model.id,
      request,
      accessToken: context.accessToken,
      projectId: context.projectId,
      accountId: context.accountId,
      accountEmail: context.email,
      signal,
    });

    const watch = new EmptyResponseWatch();
    let opened = false;
    /** Open the response on the first bytes that are worth sending. */
    const write = (events: string) => {
      if (events === '') {
        return;
      }
      if (!opened) {
        opened = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const opening = mapper.start?.();
        if (opening) {
          res.write(opening);
        }
      }
      res.write(events);
    };

    let usageRecorded = false;
    try {
      for await (const chunk of stream) {
        watch.note(chunk);
        write(mapper.push(chunk));
      }

      const empty = watch.failure();
      if (empty) {
        // Report it before the usage is recorded and the response committed,
        // so a retry or another account can still serve this turn.
        Logger.warn(`Empty response from ${context.email} on ${context.model.id}: ${empty.message}`);
        await this.deps.lease.recordUsage(context, mapper.usage());
        usageRecorded = true;
        throw empty;
      }

      write(mapper.finish());
    } catch (error) {
      if (!opened) {
        // Nothing has been sent: let the caller decide, with the full range of
        // responses — another account, a retry, or a proper status code.
        if (!usageRecorded) {
          await this.deps.lease.recordUsage(context, mapper.usage());
        }
        throw error;
      }
      Logger.error('Stream failed mid-response', error);
      res.write(mapper.error(describe(error)));
    }

    if (!usageRecorded) {
      await this.deps.lease.recordUsage(context, mapper.usage());
    }
    res.end();
  }

  // ── Errors ─────────────────────────────────────────────────────────────────

  private reportFailure(res: http.ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error instanceof NoAccountAvailableError) {
      Logger.warn(`No account available: ${error.message}`);
      sendJson(res, 503, errorBody('overloaded_error', error.message), {
        ...retryAfterHeader(error.retryAfterSeconds),
      });
      return;
    }
    if (error instanceof UpstreamError) {
      // An upstream 401/403 is about the Google account, not about the key the
      // caller presented to this gateway. Passing the status through told
      // Claude Code and Codex that their *own* credentials had been rejected,
      // and they signed themselves out over an account that had merely run out
      // or needed verifying. It is reported as an upstream failure instead.
      if (error.isAuthFailure || error.isForbidden) {
        Logger.warn(`Upstream refused every account (${error.status}): ${error.message}`);
        sendJson(
          res,
          503,
          errorBody('overloaded_error', `Antigravity refused the request: ${error.message}`),
          retryAfterHeader(error.retryAfterSeconds ?? FORBIDDEN_RETRY_AFTER_SECONDS),
        );
        return;
      }
      const status = error.isRateLimit ? 429 : (error.status ?? 502);
      Logger.warn(`Upstream error ${status}: ${error.message}`);
      sendJson(res, status, errorBody(errorTypeFor(status), error.message), {
        // A malformed request fails the same way however often it is sent, so
        // the client is told outright not to retry it.
        ...(isRetryable(status) ? retryAfterHeader(error.retryAfterSeconds) : { 'x-should-retry': 'false' }),
      });
      return;
    }

    if (error instanceof EmptyResponseError) {
      // Two different answers. A stream that arrived empty is a blip worth one
      // more attempt, so it goes back as a retryable 502 with the reason in
      // it. A prompt the upstream refused to answer would come back empty
      // however often it is sent, and the client is told so outright —
      // without that, the agents retry until they run out and print their own
      // "no response was returned", which is where this whole failure used to
      // end up with nothing to explain it.
      Logger.warn(`Empty upstream response: ${error.message}`);
      if (error.retryable) {
        sendJson(res, 502, errorBody('api_error', error.message), retryAfterHeader(1));
      } else {
        sendJson(res, 400, errorBody('invalid_request_error', error.message), {
          'x-should-retry': 'false',
        });
      }
      return;
    }

    Logger.error('Gateway request failed', error);
    sendJson(res, 500, errorBody('api_error', describe(error)));
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Abort the upstream request when the client hangs up. */
function abortOnClose(res: http.ServerResponse): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });
  return controller;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (text.trim() === '') {
    return undefined;
  }
  return JSON.parse(text) as T;
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Statuses an Anthropic- or OpenAI-compatible client is right to retry. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The error type clients use to decide whether a request is worth repeating. */
function errorTypeFor(status: number): string {
  if (status === 429) {
    return 'rate_limit_error';
  }
  if (status === 401 || status === 403) {
    return 'authentication_error';
  }
  if (status === 404) {
    return 'not_found_error';
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request_error';
  }
  return 'api_error';
}

function retryAfterHeader(seconds: number | undefined): Record<string, string> {
  return seconds && seconds > 0 ? { 'retry-after': String(Math.ceil(seconds)) } : {};
}

export function errorBody(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
