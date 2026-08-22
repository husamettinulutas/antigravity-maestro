import { AgentTarget, IntegrationStatus } from './shared';

/** Where the agent should send its requests, and how to authenticate. */
export interface GatewayEndpoint {
  /** Base URL of the local gateway, e.g. http://127.0.0.1:8045 */
  baseUrl: string;
  /** Bearer key the gateway expects. */
  apiKey: string;
}

/** Model metadata so each agent's config can match the model's real limits. */
export interface ApplyOptions {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** A cheaper model for background/utility work, when the user picked one. */
  smallFastModelId?: string;
}

/**
 * Contract for wiring an external coding agent to the local gateway.
 * Implementations edit that agent's own config files, always after taking a
 * one-time backup, and can put everything back with `restore`.
 */
export interface AgentIntegration {
  readonly target: AgentTarget;

  /** Detect installation and whether this extension's config is applied. */
  getStatus(): Promise<IntegrationStatus>;

  /** Point the agent at the gateway using the given model. */
  apply(
    modelId: string,
    endpoint: GatewayEndpoint,
    options?: ApplyOptions,
  ): Promise<IntegrationStatus>;

  /** Undo `apply`, returning the agent to its own defaults. */
  restore(): Promise<IntegrationStatus>;
}
