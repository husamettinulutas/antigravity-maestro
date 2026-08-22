import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import { Logger } from './logger';

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Request body. Strings are sent as-is; objects are JSON-encoded by the caller. */
  body?: string | Buffer;
  timeoutMs?: number;
  /** Optional HTTP(S) proxy URL used to tunnel the request. */
  proxyUrl?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Live stream — read it, or use `readBody` to buffer it. */
  stream: http.IncomingMessage;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly headers: http.IncomingHttpHeaders = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Proxy agent that tunnels HTTPS through an upstream proxy using CONNECT.
 * Node's built-in fetch has no proxy support, and the extension ships zero
 * runtime dependencies, so the tunnel is established by hand here.
 */
class ProxyTunnelAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: true });
  }

  createConnection(
    options: any,
    callback?: (err: Error | null, socket?: any) => void,
  ): undefined {
    const targetHost = options.host as string;
    const targetPort = Number(options.port) || 443;

    const headers: Record<string, string> = { host: `${targetHost}:${targetPort}` };
    if (this.proxy.username || this.proxy.password) {
      const credentials = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }

    const request = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || (this.proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
    });

    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback?.(new Error(`Proxy CONNECT failed with status ${response.statusCode}`));
        return;
      }
      callback?.(null, tls.connect({ socket, servername: targetHost }));
    });
    request.once('error', (err) => callback?.(err));
    request.end();
    return undefined;
  }
}

const proxyAgents = new Map<string, ProxyTunnelAgent>();

function getProxyAgent(proxyUrl: string): https.Agent | undefined {
  if (!proxyUrl) {
    return undefined;
  }
  const cached = proxyAgents.get(proxyUrl);
  if (cached) {
    return cached;
  }
  try {
    const agent = new ProxyTunnelAgent(new URL(proxyUrl));
    proxyAgents.set(proxyUrl, agent);
    return agent;
  } catch {
    Logger.warn(`Ignoring invalid upstream proxy URL: ${proxyUrl}`);
    return undefined;
  }
}

/**
 * Perform an HTTPS request and resolve as soon as response headers arrive, so
 * SSE bodies can be consumed incrementally. Non-2xx responses reject with an
 * HttpError carrying the buffered error body.
 */
export function request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = 120_000, proxyUrl, signal } = options;

  return new Promise<HttpResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const target = new URL(url);
    const requestHeaders: Record<string, string> = { ...headers };
    if (body !== undefined && requestHeaders['content-length'] === undefined) {
      requestHeaders['content-length'] = String(Buffer.byteLength(body));
    }

    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        agent: getProxyAgent(proxyUrl ?? ''),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ status, headers: res.headers, stream: res });
          return;
        }
        readBody(res)
          .then((text) => {
            reject(new HttpError(describeHttpError(status, text), status, text, res.headers));
          })
          .catch(() => {
            reject(new HttpError(`HTTP ${status}`, status, '', res.headers));
          });
      },
    );

    const onAbort = () => {
      req.destroy(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/** Buffer a response stream into a UTF-8 string. */
export function readBody(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

/** Request and parse a JSON response body. */
export async function requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const response = await request(url, options);
  const text = await readBody(response.stream);
  if (text.trim() === '') {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(`Malformed JSON response from ${url}`, response.status, text);
  }
}

/** POST a JSON payload and parse the JSON response. */
export function postJson<T>(
  url: string,
  payload: unknown,
  options: HttpRequestOptions = {},
): Promise<T> {
  return requestJson<T>(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(payload),
  });
}

/** POST url-encoded form data and parse the JSON response. */
export function postForm<T>(
  url: string,
  form: Record<string, string>,
  options: HttpRequestOptions = {},
): Promise<T> {
  return requestJson<T>(url, {
    ...options,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(options.headers ?? {}),
    },
    body: new URLSearchParams(form).toString(),
  });
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

/** Pull the most useful message out of a Google API error body. */
export function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') {
    return `HTTP ${status}`;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const payload = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = payload?.error?.message ?? payload?.error_description ?? payload?.message;
    if (typeof message === 'string' && message.trim() !== '') {
      return `HTTP ${status}: ${message.trim()}`;
    }
  } catch {
    // Fall through to the raw body.
  }
  return `HTTP ${status}: ${trimmed.slice(0, 500)}`;
}
