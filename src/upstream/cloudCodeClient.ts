import { GeminiInternalRequest, GeminiRequest, GeminiResponse } from '../protocol/gemini';
import { Config } from '../utils/config';
import { HttpError, readBody, request as httpRequest } from '../utils/http';
import { officialRequestId, sessionIdFor } from '../utils/ids';
import { Logger } from '../utils/logger';
import { parseSse } from '../utils/sse';
import { modelSpecificHeaders } from './constraints';
import { bodyUserAgent, clientIdentity, currentUserAgent, currentVersion } from './userAgent';

/**
 * Where a generate call goes, in order.
 *
 * The production host is last on purpose. It meters this traffic far more
 * tightly than the other two: on accounts sitting at full quota it answers the
 * very first request of a session with `RESOURCE_EXHAUSTED`, and no amount of
 * pacing or account rotation gets around it because the limit is not the
 * account's. The sandbox host serves the same models and is what the quota
 * lookups in this extension have always used first — which is why the panel
 * could read 100% for every account while every generate call was refused.
 */
const BASE_URLS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
  'https://cloudcode-pa.googleapis.com/v1internal',
];

/** Project ids the upstream uses as placeholders; never sent as a header. */
const PLACEHOLDER_PROJECTS = new Set(['test-project', 'project-id']);

/** Antigravity tags requests so they draw from the Google One AI allowance. */
const CREDIT_TYPES = ['GOOGLE_ONE_AI'];

/**
 * Projects whose header the upstream has rejected, and when. Without this every
 * request pays for a doomed 403 round trip before retrying without the header.
 */
const rejectedProjects = new Map<string, number>();
const PROJECT_REJECTION_TTL_MS = 60 * 60 * 1000;

/**
 * Projects whose header verdict is still being discovered, keyed to the promise
 * that settles once it is known.
 *
 * The memo above is only written after a 403 comes back, so every request that
 * started before that answer arrived paid its own doomed round trip — and since
 * clients open several turns at once, the first salvo after every activation
 * spent one wasted request per turn against the account's per-minute
 * allowance. The first request to touch a project now probes it and the rest
 * wait for its answer.
 */
const projectProbes = new Map<string, Promise<void>>();

function projectHeaderIsRejected(projectId: string): boolean {
  const at = rejectedProjects.get(projectId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at > PROJECT_REJECTION_TTL_MS) {
    rejectedProjects.delete(projectId);
    return false;
  }
  return true;
}

/**
 * Endpoints that failed while a later one served the same request, and when.
 * The primary host can be down while the fallback is healthy, so without this
 * every request pays a doomed round trip before failing over.
 */
const degradedEndpoints = new Map<string, number>();
const ENDPOINT_DEGRADED_TTL_MS = 5 * 60 * 1000;

function endpointIsDegraded(baseUrl: string): boolean {
  const at = degradedEndpoints.get(baseUrl);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at > ENDPOINT_DEGRADED_TTL_MS) {
    // The TTL doubles as a probe: once it lapses the endpoint is tried first
    // again, so a recovered host is picked back up on its own.
    degradedEndpoints.delete(baseUrl);
    return false;
  }
  return true;
}

/**
 * Endpoints to try, healthy ones first and configured order kept within each
 * group. A degraded endpoint is demoted rather than dropped, so it still
 * serves when everything else is down.
 */
function orderedEndpoints(): string[] {
  const healthy = BASE_URLS.filter((url) => !endpointIsDegraded(url));
  const degraded = BASE_URLS.filter((url) => endpointIsDegraded(url));
  return [...healthy, ...degraded];
}

/** Exposed for tests; the memo is module state that would otherwise leak. */
export function resetEndpointHealth(): void {
  degradedEndpoints.clear();
  gates.clear();
  rejectedProjects.clear();
  projectProbes.clear();
}

/**
 * Requests allowed to be waiting for upstream acceptance at once, per account.
 *
 * Both hosts meter an account by requests per minute, and Claude Code opens
 * several turns at once (the main turn plus its haiku-class background calls),
 * so an unthrottled salvo spends the whole allowance in one second and drops
 * every account into cooldown together. Copilot Chat never hit this because it
 * only ever has a single turn in flight.
 *
 * The slot is held only until the upstream accepts the request, not for the
 * life of the stream, so this paces request *starts* without serialising
 * parallel answers.
 */
interface Gate {
  active: number;
  waiting: (() => void)[];
}

const gates = new Map<string, Gate>();

async function acquireSlot(accountId: string | undefined): Promise<() => void> {
  const limit = Config.maxConcurrentRequestsPerAccount();
  if (!accountId || limit <= 0) {
    return () => undefined;
  }

  let gate = gates.get(accountId);
  if (!gate) {
    gate = { active: 0, waiting: [] };
    gates.set(accountId, gate);
  }
  const held = gate;

  if (held.active >= limit) {
    // The slot is handed over on release rather than re-counted here, so two
    // waiters resuming in the same tick cannot both slip past the limit.
    await new Promise<void>((resolve) => held.waiting.push(resolve));
  } else {
    held.active += 1;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = held.waiting.shift();
    if (next) {
      next();
      return;
    }
    held.active -= 1;
    if (held.active <= 0 && held.waiting.length === 0) {
      gates.delete(accountId);
    }
  };
}

export interface GenerateParams {
  model: string;
  request: GeminiRequest;
  accessToken: string;
  projectId?: string;
  /** Upstream request category — 'agent' for tool-using coding sessions. */
  requestType?: string;
  /** Whose rate limit this request draws on; used to pace concurrent starts. */
  accountId?: string;
  /** The signed-in address, which decides how the client identifies itself. */
  accountEmail?: string;
  signal?: AbortSignal;
}

/** An error returned by the Cloud Code endpoints, classified for retry logic. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  /** True when another account (or waiting) could succeed. */
  get isRateLimit(): boolean {
    return (
      this.status === 429 ||
      /resource_exhausted|quota|rate limit/i.test(`${this.message} ${this.body}`)
    );
  }

  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

/**
 * Talks to Antigravity's Cloud Code endpoints. It owns transport concerns only:
 * endpoint failover, the project header downgrade, and unwrapping the SSE
 * envelope. Account selection and protocol translation live elsewhere.
 */
export class CloudCodeClient {
  /** Non-streaming generate. */
  async generate(params: GenerateParams): Promise<GeminiResponse> {
    const response = await this.send(':generateContent', params);
    const text = await readBody(response.stream);
    const payload = parseJson(text);
    // The internal endpoint wraps its result; the public shape is bare.
    return (payload?.response ?? payload ?? {}) as GeminiResponse;
  }

  /**
   * Streaming generate. Resolves once the upstream accepted the request, so a
   * rate limit surfaces before any output is produced and can trigger a
   * different account.
   */
  async streamGenerate(params: GenerateParams): Promise<AsyncGenerator<GeminiResponse>> {
    const response = await this.send(':streamGenerateContent?alt=sse', params);

    async function* iterate(): AsyncGenerator<GeminiResponse> {
      for await (const event of parseSse(response.stream)) {
        const data = event.data.trim();
        if (data === '' || data === '[DONE]') {
          continue;
        }
        const payload = parseJson(data);
        if (!payload) {
          Logger.warn(`Skipping unparsable upstream chunk: ${data.slice(0, 200)}`);
          continue;
        }
        yield (payload.response ?? payload) as GeminiResponse;
      }
    }

    return iterate();
  }

  /** Pace the request against the account's allowance, then dispatch it. */
  private async send(path: string, params: GenerateParams) {
    const release = await acquireSlot(params.accountId);
    try {
      return await this.dispatch(path, params);
    } finally {
      release();
    }
  }

  private async dispatch(path: string, params: GenerateParams) {
    const body = this.buildBody(params);
    const serialized = JSON.stringify(body);

    // Claim the probe before the first await, so exactly one request per
    // project goes looking and the others read the answer it brings back.
    const projectId = params.projectId;
    let endProbe: (() => void) | undefined;
    if (projectId !== undefined && !projectHeaderIsRejected(projectId)) {
      const running = projectProbes.get(projectId);
      if (running) {
        await running;
      } else {
        projectProbes.set(
          projectId,
          new Promise<void>((resolve) => {
            endProbe = () => {
              projectProbes.delete(projectId);
              resolve();
            };
          }),
        );
      }
    }

    try {
      return await this.attempt(path, params, serialized, endProbe);
    } finally {
      // Settles on the response headers, not the end of the stream: by then the
      // verdict is in, and a request that failed for some other reason simply
      // leaves the next one to probe again.
      endProbe?.();
    }
  }

  private async attempt(
    path: string,
    params: GenerateParams,
    serialized: string,
    endProbe: (() => void) | undefined,
  ) {
    let projectHeaderDisabled =
      params.projectId !== undefined && projectHeaderIsRejected(params.projectId);
    let lastError: unknown;

    // Two passes: the second one runs only when the project header was the
    // reason for a 403.
    for (let attempt = 0; attempt < 2; attempt++) {
      let justDisabledProjectHeader = false;

      // Re-read each pass: a 403 retry should still skip a host that just
      // proved to be degraded.
      const endpoints = orderedEndpoints();

      for (let index = 0; index < endpoints.length; index++) {
        const baseUrl = endpoints[index];
        const url = `${baseUrl}${path}`;
        try {
          const response = await httpRequest(url, {
            method: 'POST',
            headers: this.buildHeaders(params, projectHeaderDisabled),
            body: serialized,
            timeoutMs: Config.requestTimeoutMs(),
            proxyUrl: Config.upstreamProxyUrl(),
            signal: params.signal,
          });
          // Serving a request clears any doubt about this host.
          degradedEndpoints.delete(baseUrl);
          return response;
        } catch (error) {
          lastError = error;

          if (
            !projectHeaderDisabled &&
            error instanceof HttpError &&
            error.status === 403 &&
            params.projectId
          ) {
            Logger.warn('Upstream rejected the project header; retrying without it');
            rejectedProjects.set(params.projectId, Date.now());
            // The verdict is in — anything queued behind the probe can go now.
            endProbe?.();
            projectHeaderDisabled = true;
            justDisabledProjectHeader = true;
            break;
          }

          const hasNextEndpoint = index + 1 < endpoints.length;
          if (!hasNextEndpoint || !shouldFailover(error)) {
            throw toUpstreamError(error);
          }
          // Only demote when a later endpoint can still be tried — a failure
          // with nowhere left to fail over says nothing about this host.
          if (!degradedEndpoints.has(baseUrl)) {
            Logger.warn(
              `Upstream ${url} failed (${describe(error)}); preferring the next endpoint for ` +
                `${ENDPOINT_DEGRADED_TTL_MS / 60_000}m`,
            );
          }
          degradedEndpoints.set(baseUrl, Date.now());
        }
      }

      // The second pass exists only to redo the call without the header the
      // upstream just rejected; anything else is already final.
      if (!justDisabledProjectHeader) {
        break;
      }
    }

    throw toUpstreamError(lastError);
  }

  private buildBody(params: GenerateParams): GeminiInternalRequest {
    const body: GeminiInternalRequest = {
      requestId: officialRequestId(),
      request: orderForCaching(params.request, params.accountId),
      model: params.model,
      // A bare product token, not the versioned header string.
      userAgent: bodyUserAgent(params.accountEmail),
      requestType: params.requestType ?? 'agent',
      enabledCreditTypes: [...CREDIT_TYPES],
    };
    if (params.projectId) {
      body.project = params.projectId;
    }
    return body;
  }

  private buildHeaders(params: GenerateParams, projectHeaderDisabled: boolean) {
    const identity = clientIdentity();
    const headers: Record<string, string> = {
      authorization: `Bearer ${params.accessToken}`,
      'content-type': 'application/json',
      'user-agent': currentUserAgent(),
      // What a real Antigravity install reports about itself. Without these the
      // endpoints treat the caller as an unrecognised client.
      'x-client-name': 'antigravity',
      'x-client-version': currentVersion(),
      'x-machine-id': identity.machineId,
      'x-vscode-sessionid': identity.sessionId,
      ...modelSpecificHeaders(params.model),
    };
    if (params.projectId && !projectHeaderDisabled && !PLACEHOLDER_PROJECTS.has(params.projectId)) {
      headers['x-goog-user-project'] = params.projectId;
    }
    return headers;
  }
}

/**
 * Re-emit the request with its stable fields first and the conversation last.
 *
 * Upstream prompt caching matches on a byte prefix, so anything that moves
 * between turns has to come after everything that does not — otherwise each
 * turn produces a fresh prefix and pays full price for a system prompt and a
 * tool list that never changed. Key order is the only thing this changes.
 */
function orderForCaching(request: GeminiRequest, accountId: string | undefined): GeminiRequest {
  const { contents, ...stable } = request;
  const ordered: GeminiRequest = {
    ...(stable.systemInstruction ? { systemInstruction: stable.systemInstruction } : {}),
    ...(stable.tools ? { tools: stable.tools } : {}),
    ...(stable.toolConfig ? { toolConfig: stable.toolConfig } : {}),
    ...(stable.generationConfig ? { generationConfig: stable.generationConfig } : {}),
    ...(stable.safetySettings ? { safetySettings: stable.safetySettings } : {}),
    // Ties the turns of one conversation together upstream; stable per account.
    ...(accountId ? { sessionId: sessionIdFor(accountId) } : {}),
    contents: contents ?? [],
  } as GeminiRequest;

  // Anything the mappers add that is not named above still has to survive.
  const carry = ordered as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(stable)) {
    if (!(key in carry)) {
      carry[key] = value;
    }
  }
  return ordered;
}

function shouldFailover(error: unknown): boolean {
  if (error instanceof HttpError) {
    // Deliberately not 429: both hosts meter the same account, so failing over
    // is a guaranteed second rate limit that doubles the pressure exactly when
    // the account has none left — and it demoted a perfectly healthy endpoint
    // for five minutes over a condition that was never the endpoint's fault.
    // Rotating to another account is the real fallback for a rate limit.
    return error.status >= 500;
  }
  // Network-level failures are worth retrying against the other host.
  return true;
}

function toUpstreamError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) {
    return error;
  }
  if (error instanceof HttpError) {
    return new UpstreamError(error.message, error.status, error.body, retryAfterOf(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UpstreamError(message, undefined, '');
}

function retryAfterOf(error: HttpError): number | undefined {
  const header = error.headers['retry-after'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds)) {
      return seconds;
    }
  }
  return retryDelayOf(error.body);
}

/**
 * The wait Google actually asks for. These endpoints answer a 429 with a
 * `google.rpc.RetryInfo` detail (`"retryDelay": "27s"`) and no `retry-after`
 * header, so without reading the body every rate limit fell back to a blind
 * doubling that locked a healthy account out for minutes over a window that
 * had already reopened.
 */
function retryDelayOf(body: string): number | undefined {
  const text = body.trim();
  if (text === '' || !text.includes('retryDelay')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    const payload = Array.isArray(parsed) ? parsed[0] : parsed;
    const details = payload?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        const seconds = parseDuration(detail?.retryDelay);
        if (seconds !== undefined) {
          return seconds;
        }
      }
    }
  } catch {
    // Fall through to the raw scan — a truncated body still carries the delay.
  }

  const match = /"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s?"?/.exec(text);
  return match ? parseDuration(`${match[1]}s`) : undefined;
}

/** Seconds in a protobuf duration string like `"27s"` or `"1.5s"`. */
function parseDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const seconds = Number.parseFloat(value.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function describe(error: unknown): string {
  if (error instanceof HttpError) {
    return `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
