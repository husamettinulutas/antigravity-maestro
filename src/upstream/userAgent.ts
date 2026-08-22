import { Config } from '../utils/config';
import { readBody, request } from '../utils/http';
import { Logger } from '../utils/logger';

/** Used when the real Antigravity version cannot be discovered. */
const FALLBACK_VERSION = '2.0.3';
const VERSION_FEED_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const VERSION_REGEX = /\d+\.\d+\.\d+/g;

let cachedUserAgent: string | undefined;
let pending: Promise<string> | undefined;

/**
 * The Cloud Code endpoints reject clients that do not identify as Antigravity,
 * so every upstream request carries this User-Agent.
 */
export function buildUserAgent(version: string): string {
  return `antigravity/${version} ${platformTag()}/${archTag()}`;
}

/** Resolve (and cache) the User-Agent for this session. */
export async function resolveUserAgent(): Promise<string> {
  if (cachedUserAgent) {
    return cachedUserAgent;
  }
  if (pending) {
    return pending;
  }

  pending = discoverVersion()
    .then((version) => {
      cachedUserAgent = buildUserAgent(version);
      Logger.info(`Upstream User-Agent: ${cachedUserAgent}`);
      return cachedUserAgent;
    })
    .finally(() => {
      pending = undefined;
    });

  return pending;
}

/** Synchronous best effort — used before the async lookup has finished. */
export function currentUserAgent(): string {
  return cachedUserAgent ?? buildUserAgent(FALLBACK_VERSION);
}

async function discoverVersion(): Promise<string> {
  try {
    const response = await request(VERSION_FEED_URL, {
      timeoutMs: 2500,
      headers: { 'user-agent': buildUserAgent(FALLBACK_VERSION) },
      proxyUrl: Config.upstreamProxyUrl(),
    });
    const payload = await readBody(response.stream);
    const discovered = highestSemver(payload);
    if (discovered && compareSemver(discovered, FALLBACK_VERSION) > 0) {
      return discovered;
    }
  } catch (error) {
    Logger.debug('Antigravity version feed unavailable, using fallback version', error);
  }
  return FALLBACK_VERSION;
}

function highestSemver(text: string): string | null {
  const matches = text.match(VERSION_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches.reduce((best, candidate) => (compareSemver(candidate, best) > 0 ? candidate : best));
}

function compareSemver(left: string, right: string): number {
  const l = left.split('.').map(Number);
  const r = right.split('.').map(Number);
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const diff = (l[i] ?? 0) - (r[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function platformTag(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

function archTag(): string {
  if (process.arch === 'x64') {
    return 'amd64';
  }
  if (process.arch === 'arm64') {
    return 'arm64';
  }
  return process.arch;
}
