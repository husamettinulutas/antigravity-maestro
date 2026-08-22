/** Remaining quota for one upstream model, as reported by fetchAvailableModels. */
export interface ModelQuota {
  modelId: string;
  displayName?: string;
  /** Remaining quota, 0–100. */
  percentage: number;
  /** ISO timestamp when the quota window resets, or '' when unknown. */
  resetTime: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  recommended?: boolean;
}

/** One rolling window (e.g. 5-hour or weekly) from retrieveUserQuotaSummary. */
export interface QuotaBucket {
  bucketId: string;
  window: string;
  remainingFraction: number;
  resetTime: string;
  displayName?: string;
  description?: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSnapshot {
  fetchedAt: number;
  models: Record<string, ModelQuota>;
  /** Cloud Code project resolved alongside the quota, if any. */
  projectId?: string;
  groups?: QuotaGroup[];
  /** Upstream renames: old model id → replacement model id. */
  forwardingRules?: Record<string, string>;
  subscriptionTier?: string;
  isForbidden?: boolean;
}

/** Everything about an account except its refresh token, which lives in SecretStorage. */
export interface AccountMetadata {
  /** Google user id — stable across re-authentication. */
  id: string;
  email: string;
  name?: string;
  picture?: string;
  /** Which OAuth client issued the refresh token. */
  oauthClientKey: string;
  /** cloudaicompanionProject, sent as the x-goog-user-project header. */
  projectId?: string;
  subscriptionTier?: string;
  addedAt: number;
  /** Set when the refresh token stopped working — the account needs a new sign-in. */
  needsReauth?: boolean;
  lastError?: string;
  quota?: QuotaSnapshot;
}

/** A cached access token with its expiry. */
export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** Token spend recorded for one upstream request. */
export interface UsageSample {
  at: number;
  accountId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
}

/** A quota reading kept for the history chart. */
export interface QuotaSample {
  at: number;
  accountId: string;
  modelId: string;
  percentage: number;
}
