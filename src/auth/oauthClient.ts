import { Config } from '../utils/config';

/**
 * Credentials for the OAuth client the published build signs in with. Google
 * issues the Cloud Code scopes only to approved clients, so sign-in has to use
 * one of them.
 *
 * The values are injected at build time from `.env` (see `esbuild.js`) and are
 * deliberately absent from this repository. A build made without `.env` simply
 * has no built-in client, and sign-in then requires the `oauth.clientId` and
 * `oauth.clientSecret` settings.
 */
const BUILT_IN_ID = process.env.AGM_OAUTH_CLIENT_ID ?? '';
const BUILT_IN_SECRET = process.env.AGM_OAUTH_CLIENT_SECRET ?? '';

/** Stable across builds — stored on every account to pick its refresh client. */
const BUILT_IN_KEY = 'antigravity_enterprise';

/** Shown whenever sign-in is attempted with no client available at all. */
export const NO_CLIENT_MESSAGE =
  'No OAuth client is configured. Set antigravityMaestro.oauth.clientId and ' +
  'antigravityMaestro.oauth.clientSecret to a Google client approved for the ' +
  'Cloud Code scopes.';

export interface OAuthClient {
  key: string;
  clientId: string;
  clientSecret: string;
}

/** The client baked into this build, or undefined if it was built without one. */
function builtInClient(): OAuthClient | undefined {
  if (BUILT_IN_ID === '' || BUILT_IN_SECRET === '') {
    return undefined;
  }
  return { key: BUILT_IN_KEY, clientId: BUILT_IN_ID, clientSecret: BUILT_IN_SECRET };
}

/** The client from settings, or undefined when the user has not supplied one. */
function customClient(): OAuthClient | undefined {
  const clientId = Config.oauthClientId();
  const clientSecret = Config.oauthClientSecret();
  if (clientId === '' || clientSecret === '') {
    return undefined;
  }
  return { key: 'custom', clientId, clientSecret };
}

/** True when sign-in can proceed without the user configuring a client first. */
export function hasBuiltInClient(): boolean {
  return builtInClient() !== undefined;
}

/** The OAuth client to use for sign-in and token refresh. */
export function getOAuthClient(): OAuthClient {
  const client = customClient() ?? builtInClient();
  if (!client) {
    throw new Error(NO_CLIENT_MESSAGE);
  }
  return client;
}

/**
 * Clients to try when refreshing a token. A refresh token is bound to the
 * client that issued it, so an account created before a settings change still
 * refreshes against the built-in client.
 */
export function getRefreshCandidates(preferredKey?: string): OAuthClient[] {
  const builtIn = builtInClient();
  const custom = customClient();
  const candidates: OAuthClient[] = [];

  // Built-in first when the account was created with it, otherwise as fallback.
  if (preferredKey === BUILT_IN_KEY && builtIn) {
    candidates.push(builtIn);
  }
  if (custom) {
    candidates.push(custom);
  }
  if (builtIn) {
    candidates.push(builtIn);
  }

  if (candidates.length === 0) {
    throw new Error(NO_CLIENT_MESSAGE);
  }

  const seen = new Set<string>();
  return candidates.filter((client) => {
    if (seen.has(client.clientId)) {
      return false;
    }
    seen.add(client.clientId);
    return true;
  });
}

/** OAuth scopes Antigravity requests — Cloud Code access needs all of them. */
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
];
