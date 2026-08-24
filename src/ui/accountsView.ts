import * as fs from 'fs';
import { displayNamesFor } from '../upstream/modelNames';
import * as path from 'path';
import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import { QuotaHistory } from '../accounts/quotaHistory';
import { QuotaPool, quotaPools } from '../accounts/quotaPools';
import { AccountMetadata, ModelQuota } from '../accounts/types';
import { Logger } from '../utils/logger';

/**
 * Target id → the commands its row's buttons run. Going through this table,
 * rather than building a command name out of the message, keeps a webview
 * message from addressing arbitrary commands — and lets targets that are not
 * config-file integrations (Copilot) take part with their own verbs.
 */
const AGENT_COMMANDS: Record<string, { apply: string; restore?: string }> = {
  'claude-code': {
    apply: 'antigravityMaestro.claudeCode.apply',
    restore: 'antigravityMaestro.claudeCode.restore',
  },
  codex: {
    apply: 'antigravityMaestro.codex.apply',
    restore: 'antigravityMaestro.codex.restore',
  },
  copilot: {
    apply: 'antigravityMaestro.copilot.setup',
    restore: 'antigravityMaestro.copilot.restore',
  },
  commitMessages: {
    apply: 'antigravityMaestro.commitMessages.apply',
    restore: 'antigravityMaestro.commitMessages.restore',
  },
};

/** Long enough to swallow a burst of changes, short enough to feel immediate. */
const POST_DEBOUNCE_MS = 150;

interface ModelQuotaView extends ModelQuota {
  /** Human readable time until the quota window resets, e.g. "4h 58m". */
  resetsIn?: string;
}

interface AccountView {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  tier?: string;
  isActive: boolean;
  needsReauth: boolean;
  lastError?: string;
  quotaFetchedAt?: number;
  lowestQuota?: number;
  models: ModelQuotaView[];
  pools: QuotaPool<ModelQuotaView>[];
  groups: {
    displayName: string;
    description?: string;
    buckets: { displayName: string; percentage: number; resetsIn?: string }[];
  }[];
}

/** Gateway + agent integration status shown in the panel header. */
export interface ExtraStatus {
  gateway: { running: boolean; url?: string };
  integrations: {
    target: string;
    label: string;
    installed: boolean;
    active: boolean;
    modelId?: string;
    detail?: string;
    /** Overrides the "Use model" button label. */
    applyLabel?: string;
    /** What the row says instead of "using its own defaults". */
    idleText?: string;
    /** False for targets that own no config to put back. */
    restorable?: boolean;
  }[];
}

/**
 * The Accounts panel: sign-in, per-model quota bars, account switching and
 * token usage stats. Rendered both as a sidebar view and as a full editor tab.
 */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'antigravity-maestro-accounts';

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private statusProvider?: () => Promise<ExtraStatus>;
  private readonly disposables: vscode.Disposable[] = [];
  private pending?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accounts: AccountManager,
    private readonly history: QuotaHistory,
  ) {
    this.disposables.push(
      accounts.onDidChange(() => this.schedulePost()),
      history.onDidChange(() => this.schedulePost()),
    );
  }

  /**
   * Coalesce bursts of changes into one redraw.
   *
   * Refreshing every account fires once per account, and a request in flight
   * fires again as its usage lands — repainting the panel for each of them
   * makes it flicker while saying nothing new.
   */
  private schedulePost(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.postState();
    }, POST_DEBOUNCE_MS);
  }

  /** Supplies gateway + agent integration status for the panel header. */
  setStatusProvider(provider: () => Promise<ExtraStatus>): void {
    this.statusProvider = provider;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.configure(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Open (or focus) the panel version, which has room for the stats table. */
  openAsPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'antigravityMaestro.accountsPanel',
      'Antigravity Maestro',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');
    this.configure(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private configure(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage((message) => this.handleMessage(message));
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
          await this.postState();
          break;
        case 'applyAgent':
        case 'restoreAgent': {
          const commands = AGENT_COMMANDS[message.agent];
          const command =
            message.type === 'applyAgent' ? commands?.apply : commands?.restore;
          if (!command) {
            Logger.warn(`Ignoring ${message.type} for unknown agent: ${message.agent}`);
            break;
          }
          await vscode.commands.executeCommand(command);
          break;
        }
        case 'restartGateway':
          await vscode.commands.executeCommand('antigravityMaestro.restartGateway');
          await this.postState();
          break;
        case 'copyGatewayInfo':
          await vscode.commands.executeCommand('antigravityMaestro.copyGatewayInfo');
          break;
        case 'addAccount':
          await vscode.commands.executeCommand('antigravityMaestro.addAccount');
          break;
        case 'refreshAll':
          await this.accounts.refreshAllQuotas();
          break;
        case 'refreshAccount':
          await this.accounts.refreshQuota(message.accountId);
          break;
        case 'reorderAccounts':
          await this.accounts.reorder(message.accountIds ?? []);
          break;
        case 'setActive':
          await this.accounts.setActive(message.accountId);
          break;
        case 'removeAccount':
          await vscode.commands.executeCommand(
            'antigravityMaestro.removeAccount',
            message.accountId,
          );
          break;
        case 'reauth':
          await vscode.commands.executeCommand('antigravityMaestro.addAccount');
          break;
        case 'clearHistory':
          await this.history.clear();
          break;
        case 'openLogs':
          Logger.show();
          break;
        default:
          Logger.debug(`Unhandled webview message: ${JSON.stringify(message)}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Antigravity Maestro: ${detail}`);
    }
  }

  /** Push the whole view model; the webview re-renders from it. */
  async postState(): Promise<void> {
    const state = await this.buildState();
    this.view?.webview.postMessage({ type: 'state', state });
    this.panel?.webview.postMessage({ type: 'state', state });
  }

  private async buildState() {
    const activeId = this.accounts.getActive()?.id;
    let status: ExtraStatus | undefined;
    try {
      status = await this.statusProvider?.();
    } catch (error) {
      Logger.warn('Could not read integration status', error);
    }

    return {
      accounts: this.accounts.list().map((account) => toAccountView(account, activeId)),
      activeId,
      usage: this.history.totals(),
      history: this.history.series(),
      status,
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...segments: string[]) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', ...segments))
        .toString();

    const html = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'webview', 'index.html'),
      'utf-8',
    );

    return html
      .split('{{cspSource}}')
      .join(webview.cspSource)
      .split('{{mainCssUri}}')
      .join(uri('styles', 'main.css'))
      .split('{{appJsUri}}')
      .join(uri('scripts', 'app.js'))
      .split('{{logoUri}}')
      .join(
        webview
          .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.svg'))
          .toString(),
      );
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.disposables.forEach((disposable) => disposable.dispose());
    this.panel?.dispose();
  }
}

function toAccountView(account: AccountMetadata, activeId: string | undefined): AccountView {
  const quotas = Object.values(account.quota?.models ?? {});
  const names = displayNamesFor(quotas);
  const models = quotas
    .map((model) => ({
      ...model,
      displayName: names[model.modelId],
      resetsIn: formatResetsIn(model.resetTime),
    }))
    .sort((a, b) => (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId));

  return {
    id: account.id,
    email: account.email,
    name: account.name,
    picture: account.picture,
    tier: account.subscriptionTier,
    isActive: account.id === activeId,
    needsReauth: account.needsReauth === true,
    lastError: account.lastError,
    quotaFetchedAt: account.quota?.fetchedAt,
    lowestQuota: models.length > 0 ? Math.min(...models.map((m) => m.percentage)) : undefined,
    models,
    pools: quotaPools(models),
    groups: (account.quota?.groups ?? []).map((group) => ({
      displayName: group.displayName,
      description: group.description,
      buckets: group.buckets.map((bucket) => ({
        displayName: shortBucketName(bucket.displayName ?? bucket.window ?? bucket.bucketId),
        percentage: Math.floor(bucket.remainingFraction * 100),
        resetsIn: formatResetsIn(bucket.resetTime),
      })),
    })),
  };
}

/** "Weekly Limit Remaining" → "Weekly": the chip already shows what is left. */
function shortBucketName(name: string): string {
  const short = name
    .replace(/\s*remaining\s*$/i, '')
    .replace(/\s*limit\s*$/i, '')
    .trim();
  return short === '' ? name : short;
}

/**
 * Countdown to a reset. Long windows (the weekly bucket) read in days, and
 * switch to hours once under a day so the last stretch stays precise.
 */
function formatResetsIn(resetTime: string): string | undefined {
  if (!resetTime) {
    return undefined;
  }
  const target = Date.parse(resetTime);
  if (Number.isNaN(target)) {
    return undefined;
  }

  const remainingMinutes = Math.max(0, Math.round((target - Date.now()) / 60_000));
  if (remainingMinutes >= 24 * 60) {
    const days = Math.floor(remainingMinutes / (24 * 60));
    const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
