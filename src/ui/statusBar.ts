import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import { QuotaPool, headlinePools, poolLabel, quotaPools } from '../accounts/quotaPools';
import { AccountMetadata } from '../accounts/types';

/** How many pool readings fit in the status bar before it crowds its neighbours. */
const MAX_STATUS_POOLS = 2;

/** Status bar entry showing the active account and what is left in each quota pool. */
export class AccountStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly accounts: AccountManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60);
    this.item.name = 'Antigravity Maestro';
    this.item.command = 'antigravityMaestro.switchAccount';
    this.subscription = accounts.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  private render(): void {
    const active = this.accounts.getActive();
    if (!active) {
      this.item.text = '$(account) Antigravity: sign in';
      this.item.tooltip = 'No Google account added yet — click to add one.';
      this.item.command = 'antigravityMaestro.addAccount';
      this.item.backgroundColor = undefined;
      return;
    }

    this.item.command = 'antigravityMaestro.switchAccount';

    if (active.needsReauth) {
      this.item.text = `$(warning) ${shortEmail(active.email)}`;
      this.item.tooltip = `${active.email} needs to sign in again.\n${active.lastError ?? ''}`.trim();
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    const models = Object.values(active.quota?.models ?? {});
    const pools = quotaPools(models);
    const lowest = pools[0]?.model.percentage;
    this.item.backgroundColor =
      lowest !== undefined && lowest <= 5
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

    // One reading per vendor family — "Opus 82% · Gemini 97%" — beats a single
    // lowest number that never says which model it is about.
    const headline = headlinePools(models)
      .slice(0, MAX_STATUS_POOLS)
      .map((pool) => `${poolLabel(pool.model)} ${pool.model.percentage}%`)
      .join(' · ');

    this.item.text = headline
      ? `$(account) ${shortEmail(active.email)} · ${headline}`
      : `$(account) ${shortEmail(active.email)}`;
    this.item.tooltip = buildTooltip(active, this.accounts.list().length, pools);
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

function buildTooltip(
  account: AccountMetadata,
  total: number,
  pools: QuotaPool[],
): vscode.MarkdownString {
  // The status bar only has room for the headline families, so every pool is
  // spelled out here, named by the model that represents it.
  const quotaLines = pools
    .map((pool) => {
      const name = pool.model.displayName ?? pool.model.modelId;
      const shared = pool.memberCount > 1 ? ` (+${pool.memberCount - 1} more)` : '';
      return `- ${name}${shared}: ${pool.model.percentage}%`;
    })
    .join('\n');

  const lines = [
    `**${account.email}**`,
    account.subscriptionTier ? `Tier: ${account.subscriptionTier}` : undefined,
    quotaLines === '' ? undefined : quotaLines,
    `${total} account${total === 1 ? '' : 's'} configured`,
    account.quota
      ? `Quota updated ${new Date(account.quota.fetchedAt).toLocaleTimeString()}`
      : 'Quota not fetched yet',
    '',
    'Click to switch the active account.',
  ].filter((line): line is string => line !== undefined);

  return new vscode.MarkdownString(lines.join('\n\n'));
}

function shortEmail(email: string): string {
  const [local] = email.split('@');
  return local.length > 18 ? `${local.slice(0, 17)}…` : local;
}
