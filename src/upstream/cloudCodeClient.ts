import { GeminiInternalRequest, GeminiRequest, GeminiResponse } from '../protocol/gemini';
import { Config } from '../utils/config';
import { HttpError, readBody, request as httpRequest } from '../utils/http';
import { uuid } from '../utils/ids';
import { Logger } from '../utils/logger';
import { parseSse } from '../utils/sse';
import { modelSpecificHeaders } from './constraints';
import { currentUserAgent } from './userAgent';

const BASE_URLS = [
  'https://cloudcode-pa.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
];

/** Antigravity tags requests so they draw from the Google One AI allowance. */
const CREDIT_TYPES = ['GOOGLE_ONE_AI'];

/**
 * Projects whose header the upstream has rejected, and when. Without this every
 * request pays for a doomed 403 round trip before retrying without the header.
 */
const rejectedProjects = new Map<string, number>();
const PROJECT_REJECTION_TTL_MS = 60 * 60 * 1000;

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
 * The primary host can be rate limited while the fallback is healthy, so
 * without this every request pays a doomed round trip before failing over.
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
}

export interface GenerateParams {
  model: string;
  request: GeminiRequest;
  accessToken: string;
  projectId?: string;
  /** Upstream request category — 'agent' for tool-using coding sessions. */
  requestType?: string;
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

  private async send(path: string, params: GenerateParams) {
    const body = this.buildBody(params);
    const serialized = JSON.stringify(body);
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
      requestId: uuid(),
      request: params.request,
      model: params.model,
      userAgent: currentUserAgent(),
      requestType: params.requestType ?? 'agent',
      enabledCreditTypes: [...CREDIT_TYPES],
    };
    if (params.projectId) {
      body.project = params.projectId;
    }
    return body;
  }

  private buildHeaders(params: GenerateParams, projectHeaderDisabled: boolean) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${params.accessToken}`,
      'content-type': 'application/json',
      'user-agent': currentUserAgent(),
      ...modelSpecificHeaders(params.model),
    };
    if (params.projectId && !projectHeaderDisabled) {
      headers['x-goog-user-project'] = params.projectId;
    }
    return headers;
  }
}

function shouldFailover(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
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
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
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
