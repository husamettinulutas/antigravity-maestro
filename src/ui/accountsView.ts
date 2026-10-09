import * as fs from 'fs';
import { displayNamesFor } from '../upstream/modelNames';
import * as path from 'path';
import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import {
  HistoryMeasure,
  HistorySpan,
  QuotaHistory,
  USAGE_RANGES,
  UsageRange,
  TimeWindow,
  UsageTotals,
  hourStart,
  localDayStart,
  timeWindow,
} from '../accounts/quotaHistory';
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

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Days the day-by-day strip is given: a month at least, so "30 days" always
 * has its bars, and a quarter at most, past which a bar per day is too thin
 * to read in a sidebar.
 */
const MIN_STRIP_DAYS = 30;
const MAX_STRIP_DAYS = 90;

/** What "Clear history" offers, in the order it lists them. */
const CLEAR_CHOICES: { span: HistorySpan; label: string; group: string }[] = [
  { span: 'hour', label: 'This hour', group: 'Recent' },
  { span: 'today', label: 'Today', group: 'Recent' },
  { span: 'yesterday', label: 'Yesterday', group: 'Recent' },
  { span: 'week', label: 'Last 7 days', group: 'Recent' },
  { span: 'month', label: 'Last 30 days', group: 'Recent' },
  { span: 'olderThanWeek', label: 'Older than 7 days', group: 'Older' },
  { span: 'olderThanMonth', label: 'Older than 30 days', group: 'Older' },
  { span: 'all', label: 'Everything', group: 'All' },
];

interface ClearItem extends vscode.QuickPickItem {
  span?: HistorySpan;
  /** The window the description measured, so the choice removes exactly that. */
  window?: TimeWindow;
}

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

/**
 * Token spend for every range the Usage tab offers, so switching ranges is
 * instant and needs no round trip. Ranges are cut in the extension host's
 * local time — the same clock "Clear history" uses.
 */
interface UsageView {
  ranges: Record<UsageRange, { from: number | null; rows: UsageTotals[] }>;
  /** One entry per local day, oldest first, ending with today. */
  days: { start: number; requests: number; tokens: number }[];
  /** Hour the oldest kept usage was recorded in, or null when there is none. */
  firstAt: number | null;
  /** True when there is more history than `days` covers. */
  daysTruncated: boolean;
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
  private tick?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accounts: AccountManager,
    private readonly history: QuotaHistory,
  ) {
    this.disposables.push(
      accounts.onDidChange(() => this.schedulePost()),
      history.onDidChange(() => this.schedulePost()),
    );
    this.scheduleTick();
  }

  /**
   * Redraw when the clock crosses an hour or midnight. Usage only pushes on
   * new traffic, so a panel left open overnight would otherwise keep showing
   * yesterday's spend under "Today".
   */
  private scheduleTick(): void {
    const now = Date.now();
    const nextHour = hourStart(now) + 3_600_000;
    const nextDay = localDayStart(now, -1);
    // A second late, so the new hour has unambiguously begun.
    const delay = Math.min(nextHour, nextDay) - now + 1000;
    this.tick = setTimeout(() => {
      if (this.view || this.panel) {
        void this.postState();
      }
      this.scheduleTick();
    }, delay);
    // Never the reason the extension host stays alive.
    this.tick.unref?.();
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
          await this.clearHistory();
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
      usage: this.usageView(),
      history: this.history.series(),
      status,
    };
  }

  private usageView(): UsageView {
    const now = this.history.now();
    const ranges = {} as UsageView['ranges'];
    for (const range of USAGE_RANGES) {
      const window = timeWindow(range, now);
      ranges[range] = {
        from: Number.isFinite(window.from) ? window.from : null,
        rows: this.history.totals(window),
      };
    }

    const firstAt = this.history.firstUsageAt();
    const span =
      firstAt === undefined
        ? 0
        : Math.round((localDayStart(now) - localDayStart(firstAt)) / DAY_MS) + 1;
    const count = Math.min(MAX_STRIP_DAYS, Math.max(MIN_STRIP_DAYS, span));
    const days = this.history.dailyTotals(count, now).map((day) => ({
      start: day.start,
      requests: day.requests,
      tokens: day.inputTokens + day.outputTokens + day.thoughtTokens,
    }));

    return { ranges, days, firstAt: firstAt ?? null, daysTruncated: span > count };
  }

  /**
   * Ask which span to forget, saying what each would remove, then remove it
   * from both the token usage and the quota readings. Everything is the one
   * choice with nothing left to fall back on, so it alone asks again.
   */
  private async clearHistory(): Promise<void> {
    const now = this.history.now();
    const items: ClearItem[] = [];
    let group = '';
    for (const choice of CLEAR_CHOICES) {
      if (choice.group !== group) {
        group = choice.group;
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      }
      const window = timeWindow(choice.span, now);
      items.push({
        label: choice.label,
        description: describeRemoval(this.history.measure(window)),
        span: choice.span,
        window,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Clear history',
      placeHolder: 'Choose how much usage and quota history to forget',
    });
    if (!picked?.span || !picked.window) {
      return;
    }

    // The window the picker described, not one cut again now: a picker left
    // open across midnight would otherwise turn "Yesterday" into the day the
    // user knew as today.
    const window = picked.window;
    if (picked.span === 'all') {
      const confirm = 'Clear everything';
      const answer = await vscode.window.showWarningMessage(
        'Clear all usage and quota history?',
        {
          modal: true,
          detail: `${describeRemoval(this.history.measure(window))}. This cannot be undone.`,
        },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
    }

    await this.history.clearWindow(window);
    vscode.window.setStatusBarMessage(`Antigravity Maestro: cleared history (${picked.label})`, 4000);
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
      .split('{{variablesCssUri}}')
      .join(uri('styles', 'variables.css'))
      .split('{{mainCssUri}}')
      .join(uri('styles', 'main.css'))
      .split('{{cardsCssUri}}')
      .join(uri('styles', 'cards.css'))
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
    if (this.tick) {
      clearTimeout(this.tick);
      this.tick = undefined;
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

/** "Removes 34 requests · 1.2M tokens · 6 quota readings", or that there is nothing to remove. */
function describeRemoval(measure: HistoryMeasure): string {
  const parts: string[] = [];
  if (measure.requests > 0) {
    parts.push(plural(measure.requests, 'request'));
    parts.push(`${formatCompact(measure.tokens)} tokens`);
  }
  if (measure.quotaReadings > 0) {
    parts.push(plural(measure.quotaReadings, 'quota reading'));
  }
  return parts.length > 0 ? `Removes ${parts.join(' · ')}` : 'Nothing recorded in this span';
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** 980 · 34.5k · 1.2M — the same shapes the Usage tab shows. */
function formatCompact(count: number): string {
  if (count < 10_000) {
    return count.toLocaleString();
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
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
