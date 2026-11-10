import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Config } from '../utils/config';
import { readBody, request } from '../utils/http';
import { uuid } from '../utils/ids';
import { Logger } from '../utils/logger';

/**
 * Used when the real Antigravity version cannot be discovered, and the floor
 * for whatever the feeds report: the endpoints turn away clients that claim an
 * old version ("This version of Antigravity is no longer supported").
 */
const FALLBACK_VERSION = '2.29.0';
/**
 * Antigravity's update feeds. The first is the one the desktop app polls
 * today; the second is the original feed, which stopped moving at 2.0.6.
 */
const VERSION_FEED_URLS = [
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app',
  'https://antigravity-auto-updater-974169037036.us-central1.run.app',
];
const VERSION_REGEX = /\d+\.\d+\.\d+/g;

/**
 * The changelist of the Antigravity build this client claims to be.
 *
 * The endpoints gate the newest model families on the whole client signature,
 * not just the version: a User-Agent without the `aidev_client` product tag
 * and a `cl=` stamp is served the older catalogue and answers a generate call
 * for Gemini 4 with "Requested entity was not found". Verified against a live
 * Ultra account: without it the model list holds 23 models and no Gemini 4;
 * with it, 29, including the Argon and Carbon tiers.
 *
 * It is calibrated by hand rather than discovered, because no feed reports it.
 */
const OFFICIAL_HUB_CL = '1008300195';

let cachedUserAgent: string | undefined;
let pending: Promise<string> | undefined;

/**
 * The Cloud Code endpoints reject clients that do not identify as Antigravity,
 * so every upstream request carries this User-Agent.
 */
export function buildUserAgent(version: string): string {
  return (
    `antigravity/hub/${version} (aidev_client; ` +
    `os_type=${platformTag()}; arch=${archTag()}; cl=${OFFICIAL_HUB_CL})`
  );
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

/** The Antigravity version this session claims, for `x-client-version`. */
export function currentVersion(): string {
  return VERSION_REGEX_SINGLE.exec(currentUserAgent())?.[0] ?? FALLBACK_VERSION;
}

const VERSION_REGEX_SINGLE = /\d+\.\d+\.\d+/;

/**
 * Client identity headers. When an `accountId` is given each account gets
 * its own stable values so concurrent use is not correlated upstream.
 */
export function clientIdentity(accountId?: string): { machineId: string; sessionId: string } {
  if (accountId) {
    return {
      machineId: accountMachineId(accountId),
      sessionId: accountSessionId(accountId),
    };
  }
  return {
    machineId: fallbackTo(() => vscode.env.machineId, stableMachineId),
    sessionId: fallbackTo(() => vscode.env.sessionId, () => launchSessionId),
  };
}

function accountMachineId(accountId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`antigravity-machine:${accountId}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

const accountSessionIds = new Map<string, string>();

function accountSessionId(accountId: string): string {
  let id = accountSessionIds.get(accountId);
  if (!id) {
    id = uuid();
    accountSessionIds.set(accountId, id);
  }
  return id;
}

const launchSessionId = uuid();
let cachedMachineId: string | undefined;

/** Used only when the host does not expose `env.machineId`. */
function stableMachineId(): string {
  cachedMachineId ??= uuid();
  return cachedMachineId;
}

function fallbackTo(read: () => string | undefined, fallback: () => string): string {
  try {
    const value = read();
    return value && value.trim() !== '' ? value : fallback();
  } catch {
    return fallback();
  }
}

/**
 * The `userAgent` the request body carries — a bare product token, not the
 * versioned string the HTTP header uses. Consumer accounts report as
 * `antigravity`; everything else is a managed account, which the endpoints
 * expect to see identify as `jetski`.
 */
export function bodyUserAgent(email: string | undefined): string {
  if (!email) {
    return 'antigravity';
  }
  const consumer = /@(gmail|googlemail)\.com$/i.test(email.trim());
  return consumer ? 'antigravity' : 'jetski';
}

async function discoverVersion(): Promise<string> {
  const reported = await Promise.all(VERSION_FEED_URLS.map(fetchFeedVersion));
  return highestSemver([FALLBACK_VERSION, ...reported].join(' ')) ?? FALLBACK_VERSION;
}

async function fetchFeedVersion(url: string): Promise<string> {
  try {
    const response = await request(url, {
      timeoutMs: 2500,
      headers: { 'user-agent': buildUserAgent(FALLBACK_VERSION) },
      proxyUrl: Config.upstreamProxyUrl(),
    });
    return highestSemver(await readBody(response.stream)) ?? '';
  } catch (error) {
    Logger.debug(`Antigravity version feed ${url} unavailable`, error);
    return '';
  }
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
