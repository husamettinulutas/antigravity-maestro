import { Config } from '../utils/config';
import { HttpError, postForm, requestJson } from '../utils/http';
import { Logger } from '../utils/logger';
import { getOAuthClient, getRefreshCandidates, OAUTH_SCOPES } from './oauthClient';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  /** Which OAuth client produced this token — needed to refresh it later. */
  oauthClientKey: string;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
}

/** Build the Google consent URL for the given loopback redirect. */
export function buildAuthUrl(redirectUri: string, state: string): string {
  const client = getOAuthClient();
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    // Without an explicit consent prompt Google omits the refresh token for
    // accounts that have granted these scopes before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Exchange an authorization code for an access + refresh token pair. */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const client = getOAuthClient();
  const response = await postForm<Omit<TokenResponse, 'oauthClientKey'>>(
    TOKEN_URL,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    },
    { proxyUrl: Config.upstreamProxyUrl(), timeoutMs: 30_000 },
  );

  return { ...response, oauthClientKey: client.key };
}

/**
 * Refresh an access token. Each candidate client is tried in turn, because a
 * refresh token only works with the client that issued it.
 */
export async function refreshAccessToken(
  refreshToken: string,
  preferredClientKey?: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const candidates = getRefreshCandidates(preferredClientKey);
  const failures: string[] = [];

  for (const client of candidates) {
    try {
      const response = await postForm<Omit<TokenResponse, 'oauthClientKey'>>(
        TOKEN_URL,
        {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        },
        { proxyUrl: Config.upstreamProxyUrl(), timeoutMs: 30_000, signal },
      );
      return { ...response, oauthClientKey: client.key };
    } catch (error) {
      if (!isClientMismatch(error) || candidates.length === 1) {
        throw error;
      }
      failures.push(`${client.key}: ${error instanceof Error ? error.message : String(error)}`);
      Logger.warn(`Token refresh rejected by OAuth client '${client.key}', trying the next one`);
    }
  }

  throw new Error(`Token refresh failed for every OAuth client (${failures.join(' | ')})`);
}

/** Fetch the signed-in user's profile (email is the account's display identity). */
export async function getUserInfo(
  accessToken: string,
  signal?: AbortSignal,
): Promise<GoogleUserInfo> {
  const info = await requestJson<GoogleUserInfo>(USER_INFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    proxyUrl: Config.upstreamProxyUrl(),
    timeoutMs: 30_000,
    signal,
  });

  if (!info?.email) {
    throw new Error('Google returned a profile without an email address');
  }
  return info;
}

/** True when the failure looks like "this token belongs to another client". */
function isClientMismatch(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    return false;
  }
  const body = error.body.toLowerCase();
  return (
    error.status === 400 ||
    error.status === 401 ||
    body.includes('unauthorized_client') ||
    body.includes('invalid_client') ||
    body.includes('invalid_grant')
  );
}
