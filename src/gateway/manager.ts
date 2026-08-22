import * as vscode from 'vscode';
import { AccountLease } from '../accounts/accountLease';
import { GatewayEndpoint } from '../integrations/agentIntegration';
import { CloudCodeClient } from '../upstream/cloudCodeClient';
import { ModelCatalog } from '../upstream/modelCatalog';
import { Config } from '../utils/config';
import { randomToken } from '../utils/ids';
import { Logger } from '../utils/logger';
import { GatewayServer } from './server';

const API_KEY_SECRET = 'antigravityMaestro.gatewayKey';

/**
 * Owns the gateway's lifecycle: its bearer key, start/stop, and restarts when
 * the configured port changes.
 */
export class GatewayManager implements vscode.Disposable {
  private server: GatewayServer | undefined;
  private apiKey: string | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly lease: AccountLease,
    private readonly client: CloudCodeClient,
    private readonly catalog: ModelCatalog,
  ) {}

  get running(): boolean {
    return this.server?.running === true;
  }

  /** Connection details for agent integrations, once the gateway is up. */
  endpoint(): GatewayEndpoint | undefined {
    if (!this.server?.running || !this.apiKey) {
      return undefined;
    }
    return { baseUrl: this.server.url, apiKey: this.apiKey };
  }

  /** Start the gateway, or return the running one. */
  async start(): Promise<GatewayEndpoint> {
    if (this.server?.running) {
      return this.endpoint()!;
    }

    const apiKey = await this.ensureApiKey();
    const server = new GatewayServer({
      lease: this.lease,
      client: this.client,
      catalog: this.catalog,
      apiKey,
    });

    const preferred = Config.gatewayPort();
    const bound = await listenWithFallback(server, preferred);
    if (bound !== preferred) {
      Logger.warn(`Port ${preferred} was busy; the gateway is on ${bound} instead`);
    }

    this.server = server;
    this.onDidChangeEmitter.fire();
    return this.endpoint()!;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    this.onDidChangeEmitter.fire();
  }

  async restart(): Promise<GatewayEndpoint> {
    await this.stop();
    return this.start();
  }

  /**
   * The gateway's bearer key. Generated once and kept in SecretStorage so the
   * agent configs written on disk stay valid across restarts.
   */
  private async ensureApiKey(): Promise<string> {
    if (this.apiKey) {
      return this.apiKey;
    }
    const stored = await this.secrets.get(API_KEY_SECRET);
    if (stored) {
      this.apiKey = stored;
      return stored;
    }

    const generated = `agm-${randomToken(24)}`;
    await this.secrets.store(API_KEY_SECRET, generated);
    Logger.info('Generated a new local gateway key');
    this.apiKey = generated;
    return generated;
  }

  dispose(): void {
    void this.stop();
    this.onDidChangeEmitter.dispose();
  }
}

/**
 * Bind the preferred port, falling back to the next few and finally to any
 * free port. Another local proxy (Antigravity Manager, an older window) on the
 * same port must not stop the gateway from coming up — agent configs are
 * written from the port that was actually bound.
 */
async function listenWithFallback(server: GatewayServer, preferred: number): Promise<number> {
  const candidates = [preferred, preferred + 1, preferred + 2, preferred + 3, 0];
  let lastError: unknown;

  for (const port of candidates) {
    try {
      return await server.start(port);
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) {
        break;
      }
    }
  }

  throw new Error(
    `Could not start the local gateway: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string })?.code === 'EADDRINUSE';
}
