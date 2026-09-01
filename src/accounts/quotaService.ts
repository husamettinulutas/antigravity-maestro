import { Config } from '../utils/config';
import { HttpError, postJson } from '../utils/http';
import { Logger } from '../utils/logger';
import { displayNamesFor } from '../upstream/modelNames';
import { currentUserAgent } from '../upstream/userAgent';
import { ModelQuota, QuotaGroup, QuotaSnapshot } from './types';

const LOAD_CODE_ASSIST_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
];

const AVAILABLE_MODELS_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

/** Models whose quota is worth showing — everything else is infrastructure noise. */
const TRACKED_MODEL_PREFIX = /^(gemini|claude|gpt|image|imagen)/i;

export interface ProjectContext {
  projectId?: string;
  subscriptionTier?: string;
}

export class QuotaForbiddenError extends Error {
  constructor() {
    super('This account is not allowed to use the Antigravity models (HTTP 403).');
    this.name = 'QuotaForbiddenError';
  }
}

export class QuotaUnauthorizedError extends Error {
  constructor() {
    super('The access token was rejected (HTTP 401).');
    this.name = 'QuotaUnauthorizedError';
  }
}

/**
 * Resolve the account's Cloud Code project and subscription tier.
 * The project id is later sent as `x-goog-user-project` on generate calls.
 */
export async function fetchProjectContext(accessToken: string): Promise<ProjectContext> {
  let lastError: unknown;

  for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const data = await postJson<LoadCodeAssistResponse>(
        endpoint,
        { metadata: { ideType: 'ANTIGRAVITY' } },
        requestOptions(accessToken),
      );
      return {
        projectId: nonEmpty(data.cloudaicompanionProject),
        subscriptionTier: resolveTier(data),
      };
    } catch (error) {
      lastError = error;
      Logger.debug(`loadCodeAssist failed at ${endpoint}`, error);
      // Only 429 is worth retrying against the sandbox host.
      if (!(error instanceof HttpError) || error.status !== 429) {
        break;
      }
    }
  }

  throw lastError ?? new Error('Failed to resolve the account project');
}

/**
 * Fetch per-model quota for an account. Endpoints are tried in order because
 * the sandbox host is less rate limited than production but not always current.
 */
export async function fetchQuota(accessToken: string): Promise<QuotaSnapshot> {
  let context: ProjectContext = {};
  try {
    context = await fetchProjectContext(accessToken);
  } catch (error) {
    Logger.warn('Continuing quota lookup without project context', error);
  }

  const models = await fetchAvailableModels(accessToken, context.projectId);
  const groups = await fetchQuotaSummary(accessToken, context.projectId);

  return {
    fetchedAt: Date.now(),
    models: models.models,
    forwardingRules: models.forwardingRules,
    groups,
    projectId: context.projectId,
    subscriptionTier: context.subscriptionTier,
    isForbidden: false,
  };
}

async function fetchAvailableModels(
  accessToken: string,
  projectId: string | undefined,
): Promise<{ models: Record<string, ModelQuota>; forwardingRules?: Record<string, string> }> {
  let lastError: unknown;

  for (let index = 0; index < AVAILABLE_MODELS_ENDPOINTS.length; index++) {
    const endpoint = AVAILABLE_MODELS_ENDPOINTS[index];
    const hasNext = index + 1 < AVAILABLE_MODELS_ENDPOINTS.length;
    let payload: Record<string, unknown> = projectId ? { project: projectId } : {};
    let retriedWithoutProject = false;

    for (;;) {
      try {
        const data = await postJson<FetchModelsResponse>(
          endpoint,
          payload,
          requestOptions(accessToken),
        );
        return {
          models: toModelQuotas(data.models, data.deprecatedModelIds),
          forwardingRules: toForwardingRules(data.deprecatedModelIds),
        };
      } catch (error) {
        lastError = error;
        const status = error instanceof HttpError ? error.status : 0;

        // A project the user cannot act on still allows the personal quota view.
        if (status === 403 && 'project' in payload && !retriedWithoutProject) {
          Logger.warn('Quota API rejected the project id, retrying without it');
          payload = {};
          retriedWithoutProject = true;
          continue;
        }
        if (status === 403) {
          throw new QuotaForbiddenError();
        }
        if (status === 401) {
          throw new QuotaUnauthorizedError();
        }
        if (hasNext && (status === 429 || status >= 500 || status === 0)) {
          Logger.warn(`Quota API ${endpoint} returned ${status || 'a network error'}, failing over`);
          break;
        }
        throw error;
      }
    }
  }

  throw lastError ?? new Error('Quota lookup failed');
}

async function fetchQuotaSummary(
  accessToken: string,
  projectId: string | undefined,
): Promise<QuotaGroup[] | undefined> {
  const payload = projectId ? { project: projectId } : {};

  for (const endpoint of QUOTA_SUMMARY_ENDPOINTS) {
    try {
      const data = await postJson<QuotaSummaryResponse>(
        endpoint,
        payload,
        requestOptions(accessToken),
      );
      return toQuotaGroups(data);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0;
      // The summary is optional — a hard 4xx means this account has none.
      if (status >= 400 && status < 500 && status !== 429) {
        return undefined;
      }
      Logger.debug(`Quota summary failed at ${endpoint}`, error);
    }
  }

  return undefined;
}

function requestOptions(accessToken: string) {
  return {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'user-agent': currentUserAgent(),
    },
    proxyUrl: Config.upstreamProxyUrl(),
    timeoutMs: 30_000,
  };
}

/**
 * The models the account can call, dropping the ones the upstream reports as
 * deprecated. A retired model keeps its quota entry for a while and still
 * looks live, but generating with it returns a "no longer available" notice
 * instead of an answer — so it is dropped here, at the single point every
 * model list is built from, rather than being offered and then failing.
 */
function toModelQuotas(
  models: FetchModelsResponse['models'],
  deprecated: FetchModelsResponse['deprecatedModelIds'],
): Record<string, ModelQuota> {
  const result: Record<string, ModelQuota> = {};
  const retired = new Set(Object.keys(deprecated ?? {}));
  const dropped: string[] = [];

  for (const [modelId, info] of Object.entries(models ?? {})) {
    if (!TRACKED_MODEL_PREFIX.test(modelId) || !info?.quotaInfo) {
      continue;
    }
    if (retired.has(modelId)) {
      dropped.push(modelId);
      continue;
    }
    result[modelId] = {
      modelId,
      displayName: info.displayName,
      percentage: Math.floor((info.quotaInfo.remainingFraction ?? 0) * 100),
      resetTime: info.quotaInfo.resetTime ?? '',
      supportsImages: info.supportsImages,
      supportsThinking: info.supportsThinking,
      thinkingBudget: info.thinkingBudget,
      maxTokens: info.maxTokens,
      maxOutputTokens: info.maxOutputTokens,
      recommended: info.recommended,
    };
  }

  const names = displayNamesFor(Object.values(result));
  for (const quota of Object.values(result)) {
    quota.displayName = names[quota.modelId];
  }

  // What the upstream called each model against what it is shown as — the only
  // way to tell a model the account cannot serve from one that is listed under
  // a name you were not looking for.
  Logger.debug(
    'Models offered',
    Object.values(result).map((quota) => ({
      id: quota.modelId,
      upstream: models?.[quota.modelId]?.displayName,
      shown: quota.displayName,
      percent: quota.percentage,
    })),
  );

  // Logged whole, not just what was dropped: an id the upstream retires
  // without listing here is the case this filter cannot catch, and comparing
  // the two lists is how that gets spotted.
  if (retired.size > 0) {
    Logger.debug(
      'Models retired upstream',
      [...retired].map((modelId) => ({
        id: modelId,
        replacedBy: deprecated?.[modelId]?.newModelId ?? null,
        wasListed: dropped.includes(modelId),
      })),
    );
  }

  return result;
}

function toForwardingRules(
  deprecated: FetchModelsResponse['deprecatedModelIds'],
): Record<string, string> | undefined {
  const rules: Record<string, string> = {};
  for (const [oldId, info] of Object.entries(deprecated ?? {})) {
    if (info?.newModelId) {
      rules[oldId] = info.newModelId;
    }
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

function toQuotaGroups(data: QuotaSummaryResponse): QuotaGroup[] | undefined {
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    return undefined;
  }

  return data.groups.map((group) => ({
    displayName: group.displayName ?? '',
    description: group.description,
    buckets: (group.buckets ?? []).map((bucket) => ({
      bucketId: bucket.bucketId ?? '',
      window: bucket.window ?? '',
      remainingFraction: bucket.remainingFraction ?? 0,
      resetTime: bucket.resetTime ?? '',
      displayName: bucket.displayName,
      description: bucket.description,
    })),
  }));
}

/**
 * Pick the tier label to show. A paid tier wins; otherwise the current tier,
 * unless the account is ineligible for it, in which case the allowed tier is
 * shown as restricted.
 */
function resolveTier(payload: LoadCodeAssistResponse): string | undefined {
  const paid = nonEmpty(payload.paidTier?.name) ?? nonEmpty(payload.paidTier?.id);
  if (paid) {
    return paid;
  }

  const ineligible = (payload.ineligibleTiers?.length ?? 0) > 0;
  if (!ineligible) {
    const current = nonEmpty(payload.currentTier?.name) ?? nonEmpty(payload.currentTier?.id);
    if (current) {
      return current;
    }
  }

  const allowed = payload.allowedTiers?.find((tier) => tier.is_default) ?? payload.allowedTiers?.[0];
  const allowedName = nonEmpty(allowed?.name) ?? nonEmpty(allowed?.id);
  if (!allowedName) {
    return undefined;
  }
  return ineligible ? `${allowedName} (Restricted)` : allowedName;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// --- Upstream response shapes -------------------------------------------------

interface TierRaw {
  id?: string;
  name?: string;
  is_default?: boolean;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: TierRaw;
  paidTier?: TierRaw;
  allowedTiers?: TierRaw[];
  ineligibleTiers?: { reasonCode?: string }[];
}

interface FetchModelsResponse {
  models?: Record<
    string,
    {
      quotaInfo?: { remainingFraction?: number; resetTime?: string };
      displayName?: string;
      supportsImages?: boolean;
      supportsThinking?: boolean;
      thinkingBudget?: number;
      recommended?: boolean;
      maxTokens?: number;
      maxOutputTokens?: number;
    }
  >;
  deprecatedModelIds?: Record<string, { newModelId?: string }>;
}

interface QuotaSummaryResponse {
  groups?: {
    displayName?: string;
    description?: string;
    buckets?: {
      bucketId?: string;
      window?: string;
      remainingFraction?: number;
      resetTime?: string;
      displayName?: string;
      description?: string;
    }[];
  }[];
}
