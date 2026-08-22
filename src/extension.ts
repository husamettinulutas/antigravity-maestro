import * as vscode from 'vscode';
import { AccountLease } from './accounts/accountLease';
import { AccountManager } from './accounts/accountManager';
import { AccountStore } from './accounts/accountStore';
import { QuotaHistory } from './accounts/quotaHistory';
import { AccountMetadata } from './accounts/types';
import { GatewayManager } from './gateway/manager';
import { AgentIntegration } from './integrations/agentIntegration';
import { ClaudeCodeIntegration } from './integrations/claudeCode';
import { CodexIntegration } from './integrations/codex';
import { AgentTarget } from './integrations/shared';
import { AntigravityChatProvider } from './provider/copilotProvider';
import { AccountsViewProvider } from './ui/accountsView';
import { AccountStatusBar } from './ui/statusBar';
import { CloudCodeClient } from './upstream/cloudCodeClient';
import { CatalogModel, ModelCatalog } from './upstream/modelCatalog';
import { resolveUserAgent } from './upstream/userAgent';
import { Config } from './utils/config';
import { Logger } from './utils/logger';

/** Must match the `languageModelChatProviders` vendor in package.json. */
const CHAT_PROVIDER_VENDOR = 'antigravity-maestro';

/** Whether the models are offered to Copilot; false once the user restores it. */
const COPILOT_PUBLISH_KEY = 'antigravityMaestro.copilotPublish';

/**
 * Set when this extension was the one that changed
 * `chat.byokUtilityModelDefault`, so restoring only undoes our own edit.
 */
const COPILOT_UTILITY_KEY = 'antigravityMaestro.copilotUtilityDefaultSet';

/**
 * Copilot's small utility model — what "Generate Commit Message" and the other
 * background chores run on. Overriding it is what stops those chores from
 * spending Copilot credits.
 */
const UTILITY_SMALL_SETTING = 'chat.utilitySmallModel';

/** The value we wrote there, so restoring only undoes our own edit. */
const UTILITY_SMALL_KEY = 'antigravityMaestro.copilotUtilitySmallModel';

const AGENT_LABELS: Record<AgentTarget, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export function activate(context: vscode.ExtensionContext): void {
  Logger.init();
  Logger.info('Antigravity Maestro activating…');

  // Resolving the Antigravity version early keeps the first upstream call fast.
  void resolveUserAgent();

  const history = new QuotaHistory(context.globalState);
  const store = new AccountStore(context.globalState, context.secrets);
  const accounts = new AccountManager(store, history);

  const catalog = new ModelCatalog(accounts);
  const client = new CloudCodeClient();
  const lease = new AccountLease(accounts, catalog, history);
  const gateway = new GatewayManager(context.secrets, lease, client, catalog);

  const claudeCode = new ClaudeCodeIntegration(context.globalState);
  const codex = new CodexIntegration(context.globalState);
  const integrations: AgentIntegration[] = [claudeCode, codex];

  const chatProvider = new AntigravityChatProvider(catalog, lease, client);
  chatProvider.setPublished(context.globalState.get<boolean>(COPILOT_PUBLISH_KEY) !== false);
  const accountsView = new AccountsViewProvider(context.extensionUri, accounts, history);
  const statusBar = new AccountStatusBar(accounts);

  accountsView.setStatusProvider(async () => {
    // Copilot is not a config-file integration: the models are published to
    // VS Code in-process, so the row reports how many are on offer and its
    // button walks the user to the picker.
    const available = catalog.listAll().filter((model) => model.family !== 'image').length;
    const publishing = chatProvider.isPublishing;
    const copilotRow = {
      target: 'copilot',
      label: 'Copilot Chat',
      installed: true,
      active: publishing && available > 0,
      modelId: `${available} models`,
      applyLabel: 'Set up',
      idleText: publishing ? 'no models published yet' : 'using its own defaults',
      detail: 'Pick them under Manage Models → Antigravity Maestro in the chat model picker.',
    };

    // Commit messages and Copilot's other background chores run on their own
    // model, billed to Copilot unless it is pointed somewhere else. That is a
    // separate choice from which model answers in chat, so it gets its own row.
    const utilityOverride = readUtilitySmallModel();
    const utilityModel = utilityOverride
      ? catalog.listAll().find((model) => model.id === utilityOverride.id)
      : undefined;
    const utilityRow = {
      target: 'commitMessages',
      label: 'Commit messages',
      installed: true,
      active: utilityOverride !== undefined,
      modelId: utilityModel?.displayName ?? utilityOverride?.id,
      applyLabel: utilityOverride ? 'Change model' : 'Use model',
      idleText: 'billed to Copilot',
      detail:
        'The model behind "Generate Commit Message" and Copilot\'s other background tasks.',
    };

    return {
      gateway: gateway.running
        ? { running: true, url: gateway.endpoint()!.baseUrl }
        : { running: false },
      integrations: [
        copilotRow,
        utilityRow,
        ...(await Promise.all(
          integrations.map(async (integration) => {
            const status = await integration.getStatus();
            return { ...status, label: AGENT_LABELS[integration.target] };
          }),
        )),
      ],
    };
  });

  /**
   * Codex reads its key from the environment, and VS Code only picks up new
   * user variables when it is started fresh. Seeding the host process on every
   * activation means a window reload is enough after wiring Codex up.
   */
  const seedCodexEnv = async (): Promise<void> => {
    const endpoint = gateway.endpoint();
    if (!endpoint) {
      return;
    }
    const status = await codex.getStatus();
    if (status.active) {
      codex.seedProcessEnv(endpoint.apiKey);
    }
  };

  context.subscriptions.push(
    history,
    accounts,
    gateway,
    accountsView,
    statusBar,
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, accountsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.lm.registerLanguageModelChatProvider(CHAT_PROVIDER_VENDOR, chatProvider),
    // Copilot re-reads the model list whenever accounts or quotas change.
    accounts.onDidChange(() => chatProvider.refresh()),
    gateway.onDidChange(() => {
      void accountsView.postState();
      void seedCodexEnv();
    }),
  );

  registerCommands(context, {
    accounts,
    accountsView,
    catalog,
    chatProvider,
    gateway,
    claudeCode,
    codex,
    integrations,
  });

  accounts.startAutoRefresh();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('antigravityMaestro.quota.autoRefreshMinutes')) {
        accounts.startAutoRefresh();
      }
      if (event.affectsConfiguration(UTILITY_SMALL_SETTING)) {
        void accountsView.postState();
      }
      if (event.affectsConfiguration('antigravityMaestro.gateway.port') && gateway.running) {
        Logger.info('Gateway port changed — restarting');
        await gateway.restart();
        vscode.window.showInformationMessage(
          'Antigravity Maestro: gateway restarted. Re-apply the model in Claude Code / Codex so they use the new port.',
        );
      }
    }),
  );

  if (Config.gatewayAutoStart()) {
    gateway
      .start()
      .then(() => seedCodexEnv())
      .catch((error) => {
        Logger.error('Gateway failed to start', error);
        vscode.window.showWarningMessage(`Antigravity Maestro: ${describe(error)}`);
      });
  }

  if (accounts.list().length > 0) {
    void accounts.refreshAllQuotas();
  }

  Logger.info('Antigravity Maestro activated');
}

interface CommandDeps {
  accounts: AccountManager;
  accountsView: AccountsViewProvider;
  catalog: ModelCatalog;
  chatProvider: AntigravityChatProvider;
  gateway: GatewayManager;
  claudeCode: ClaudeCodeIntegration;
  codex: CodexIntegration;
  integrations: AgentIntegration[];
}

function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { accounts, accountsView, catalog, chatProvider, gateway, claudeCode, codex, integrations } =
    deps;

  const register = (command: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: any[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          Logger.error(`${command} failed: ${describe(error)}`, error);
          vscode.window.showErrorMessage(`Antigravity Maestro: ${describe(error)}`);
          return undefined;
        }
      }),
    );
  };

  // ── Accounts ───────────────────────────────────────────────────────────────

  register('antigravityMaestro.openAccounts', () => accountsView.openAsPanel());

  register('antigravityMaestro.showLogs', () => Logger.show());

  register('antigravityMaestro.addAccount', async () => {
    const account = await accounts.addAccount();
    if (account) {
      vscode.window.showInformationMessage(`Signed in as ${account.email}`);
    }
  });

  register('antigravityMaestro.refreshQuotas', async () => {
    if (accounts.list().length === 0) {
      vscode.window.showInformationMessage('Add a Google account first.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Refreshing Antigravity quotas…' },
      () => accounts.refreshAllQuotas(),
    );
  });

  register('antigravityMaestro.switchAccount', async () => {
    const account = await pickAccount(accounts, 'Select the account to use for new requests');
    if (account) {
      await accounts.setActive(account.id);
      vscode.window.showInformationMessage(`Antigravity Maestro is now using ${account.email}`);
    }
  });

  register('antigravityMaestro.removeAccount', async (accountId?: string) => {
    const account = accountId
      ? accounts.get(accountId)
      : await pickAccount(accounts, 'Select the account to remove');
    if (!account) {
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Remove ${account.email}?`,
      { modal: true, detail: 'Its stored credentials and usage history will be deleted.' },
      'Remove',
    );
    if (confirmed === 'Remove') {
      await accounts.removeAccount(account.id);
    }
  });

  // ── Gateway ────────────────────────────────────────────────────────────────

  register('antigravityMaestro.restartGateway', async () => {
    const endpoint = await gateway.restart();
    vscode.window.showInformationMessage(`Antigravity Maestro gateway running at ${endpoint.baseUrl}`);
  });

  register('antigravityMaestro.copyGatewayInfo', async () => {
    const endpoint = gateway.endpoint() ?? (await gateway.start());
    await vscode.env.clipboard.writeText(`${endpoint.baseUrl}\n${endpoint.apiKey}`);
    vscode.window.showInformationMessage(
      `Copied the gateway URL and key to the clipboard (${endpoint.baseUrl}).`,
    );
  });

  // ── Agent integrations ─────────────────────────────────────────────────────

  register('antigravityMaestro.claudeCode.apply', () =>
    applyToAgent(claudeCode, 'Claude Code', deps),
  );
  register('antigravityMaestro.claudeCode.restore', () =>
    restoreAgent(claudeCode, 'Claude Code', accountsView),
  );
  register('antigravityMaestro.claudeCode.forceRestore', async () => {
    await claudeCode.forceRestore();
    void accountsView.postState();
    await promptReload('Claude Code force-restored from backup.', 'Claude Code');
  });
  register('antigravityMaestro.copilot.setup', () =>
    setUpCopilot(catalog, chatProvider, context, accountsView),
  );
  register('antigravityMaestro.copilot.restore', () =>
    restoreCopilot(chatProvider, context, accountsView),
  );
  register('antigravityMaestro.commitMessages.apply', () =>
    applyUtilityModel(catalog, context, accountsView),
  );
  register('antigravityMaestro.commitMessages.restore', () =>
    restoreUtilityModel(context, accountsView),
  );
  register('antigravityMaestro.codex.apply', () => applyToAgent(codex, 'Codex', deps));
  register('antigravityMaestro.codex.restore', () => restoreAgent(codex, 'Codex', accountsView));

  register('antigravityMaestro.showStatus', async () => {
    const lines: string[] = [];
    const active = accounts.getActive();
    lines.push(active ? `Account: ${active.email}` : 'Account: none');
    lines.push(gateway.running ? `Gateway: ${gateway.endpoint()!.baseUrl}` : 'Gateway: stopped');
    lines.push(`Models: ${catalog.listAll().length}`);

    for (const integration of integrations) {
      const status = await integration.getStatus();
      const state = !status.installed
        ? 'not detected'
        : status.active
          ? `using ${status.modelId ?? 'an unknown model'}`
          : 'using its own defaults';
      lines.push(`${AGENT_LABELS[integration.target]}: ${state}`);
    }

    vscode.window.showInformationMessage(`Antigravity Maestro — ${lines.join(' · ')}`);
  });
}

/**
 * Walk the user to Copilot's model picker.
 *
 * Nothing has to be written anywhere — the models are already registered with
 * VS Code — but two things get in the way: the picker only lists a provider's
 * models once the account quota has loaded, and Copilot refuses to run its
 * utility tasks on a bring-your-own model unless told to.
 */
async function setUpCopilot(
  catalog: ModelCatalog,
  chatProvider: AntigravityChatProvider,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const available = catalog.listAll().filter((model) => model.family !== 'image');
  if (available.length === 0) {
    vscode.window.showWarningMessage(
      'No models to publish yet — add a Google account and let its quota load first.',
    );
    return;
  }

  chatProvider.setPublished(true);
  await context.globalState.update(COPILOT_PUBLISH_KEY, true);

  const utilityChanged = await ensureByokUtilityDefault(context);
  await vscode.commands.executeCommand('workbench.action.chat.openModelPicker');
  void accountsView.postState();

  const note = utilityChanged
    ? ' Copilot was also set to run its utility tasks on the model you pick (chat.byokUtilityModelDefault).'
    : '';
  vscode.window.showInformationMessage(
    `${available.length} Antigravity models are published to VS Code. In the model picker choose ` +
      `Manage Models → Antigravity Maestro, then tick the ones you want.${note}`,
  );
}

/**
 * Take the models back out of Copilot. The provider stays registered — that is
 * how VS Code learns the list is now empty — and the one global setting this
 * extension may have written is put back.
 */
async function restoreCopilot(
  chatProvider: AntigravityChatProvider,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  chatProvider.setPublished(false);
  await context.globalState.update(COPILOT_PUBLISH_KEY, false);
  await restoreByokUtilityDefault(context);
  void accountsView.postState();

  vscode.window.showInformationMessage(
    'Copilot Chat restored to its own models. Any Antigravity model still pinned in the picker ' +
      'will disappear on its next refresh.',
  );
}

/**
 * Point "Generate Commit Message" — and Copilot's other background chores — at
 * one of our models.
 *
 * `chat.byokUtilityModelDefault: mainAgent` only redirects them once Copilot has
 * seen a BYOK model answer in chat, so a commit message asked for before that
 * still goes to Copilot and fails on a spent quota. Naming the model outright
 * skips that: Copilot resolves `${vendor}/${id}` through `lm.selectChatModels`
 * before it considers anything else.
 */
async function applyUtilityModel(
  catalog: ModelCatalog,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const model = await pickModel(
    catalog,
    'Select the model to write commit messages and run Copilot background tasks',
  );
  if (!model) {
    return;
  }

  const value = `${CHAT_PROVIDER_VENDOR}/${model.id}`;
  await vscode.workspace
    .getConfiguration()
    .update(UTILITY_SMALL_SETTING, value, vscode.ConfigurationTarget.Global);
  await context.globalState.update(UTILITY_SMALL_KEY, value);
  Logger.info(`Set '${UTILITY_SMALL_SETTING}' to '${value}'`);
  void accountsView.postState();

  vscode.window.showInformationMessage(
    `Commit messages now use ${model.displayName}. Copilot's own credits are no longer spent on them.`,
  );
}

/** Undo {@link applyUtilityModel}, and only that. */
async function restoreUtilityModel(
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const ours = context.globalState.get<string>(UTILITY_SMALL_KEY);
  const current = config.inspect<string>(UTILITY_SMALL_SETTING)?.globalValue;

  // Left alone if the user has since pointed it somewhere of their own.
  if (current !== undefined && current === ours) {
    await config.update(UTILITY_SMALL_SETTING, undefined, vscode.ConfigurationTarget.Global);
    Logger.info(`Cleared '${UTILITY_SMALL_SETTING}'`);
  }
  await context.globalState.update(UTILITY_SMALL_KEY, undefined);
  void accountsView.postState();

  vscode.window.showInformationMessage(
    'Commit messages are back on Copilot’s own model, and are billed to Copilot again.',
  );
}

/** The model `chat.utilitySmallModel` names, when it names one of ours. */
function readUtilitySmallModel(): { id: string } | undefined {
  const value = vscode.workspace.getConfiguration().get<string>(UTILITY_SMALL_SETTING);
  if (typeof value !== 'string') {
    return undefined;
  }
  const separator = value.indexOf('/');
  if (separator <= 0 || value.slice(0, separator) !== CHAT_PROVIDER_VENDOR) {
    return undefined;
  }
  const id = value.slice(separator + 1);
  return id === '' ? undefined : { id };
}

/**
 * Copilot defaults its utility tasks (title generation and the like) to a
 * Copilot-hosted model, and fails with "no utility model is configured" when
 * the only models available are someone else's. Point it at the main model
 * instead — but never overrule a choice the user already made.
 */
async function ensureByokUtilityDefault(context: vscode.ExtensionContext): Promise<boolean> {
  try {
    const config = vscode.workspace.getConfiguration();
    const inspected = config.inspect<string>('chat.byokUtilityModelDefault');
    const chosen =
      inspected?.globalValue ?? inspected?.workspaceValue ?? inspected?.workspaceFolderValue;
    if (chosen !== undefined) {
      return false;
    }

    await config.update('chat.byokUtilityModelDefault', 'mainAgent', vscode.ConfigurationTarget.Global);
    await context.globalState.update(COPILOT_UTILITY_KEY, true);
    Logger.info("Set 'chat.byokUtilityModelDefault' to 'mainAgent'");
    return true;
  } catch (error) {
    Logger.warn('Could not set chat.byokUtilityModelDefault', error);
    return false;
  }
}

/** Undo {@link ensureByokUtilityDefault}, and only that. */
async function restoreByokUtilityDefault(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(COPILOT_UTILITY_KEY) !== true) {
    return;
  }

  try {
    const config = vscode.workspace.getConfiguration();
    // Left untouched if the user has since picked their own value.
    if (config.inspect<string>('chat.byokUtilityModelDefault')?.globalValue === 'mainAgent') {
      await config.update('chat.byokUtilityModelDefault', undefined, vscode.ConfigurationTarget.Global);
      Logger.info("Cleared 'chat.byokUtilityModelDefault'");
    }
  } catch (error) {
    Logger.warn('Could not clear chat.byokUtilityModelDefault', error);
  } finally {
    await context.globalState.update(COPILOT_UTILITY_KEY, undefined);
  }
}

/** Pick a model, wire it into the agent, and report what happened. */
async function applyToAgent(
  integration: AgentIntegration,
  label: string,
  deps: CommandDeps,
): Promise<void> {
  const model = await pickModel(deps.catalog, `Select the model ${label} should use`);
  if (!model) {
    return;
  }

  const endpoint = deps.gateway.endpoint() ?? (await deps.gateway.start());
  const smallFast = Config.claudeCodeSmallFastModel();

  const status = await integration.apply(model.id, endpoint, {
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    smallFastModelId: smallFast || undefined,
  });

  void deps.accountsView.postState();
  await promptReload(
    `${label} now uses ${model.displayName} through Antigravity Maestro. ${status.detail ?? ''}`.trim(),
    label,
  );
}

async function restoreAgent(
  integration: AgentIntegration,
  label: string,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const status = await integration.restore();
  void accountsView.postState();
  await promptReload(`${label} restored to its own defaults. ${status.detail ?? ''}`.trim(), label);
}

/**
 * Both agents read their wiring once, at start-up: Claude Code from the
 * environment block VS Code hands its terminal, Codex from a process variable.
 * Neither notices a file that was rewritten underneath it, so the change only
 * lands on the next window — offer that reload rather than leaving the user to
 * work out why nothing moved.
 *
 * `antigravityMaestro.reloadOnModelChange` decides whether that is an offer
 * ('prompt'), automatic ('auto'), or left alone ('never').
 */
async function promptReload(message: string, label: string): Promise<void> {
  const behavior = Config.reloadOnModelChange();
  if (behavior === 'never') {
    vscode.window.showInformationMessage(message);
    return;
  }

  if (behavior === 'auto') {
    vscode.window.showInformationMessage(message);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `${message} Reload VS Code so ${label} picks up the change.`,
    'Reload Window',
    'Later',
  );
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function pickModel(
  catalog: ModelCatalog,
  placeHolder: string,
): Promise<CatalogModel | undefined> {
  const models = catalog.listAll().filter((model) => model.supportsTools);
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      'No models available yet — add a Google account and refresh quotas first.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.displayName,
      description: model.id,
      detail: `${model.quotaPercent ?? 0}% quota left · ${Math.round(model.maxInputTokens / 1000)}K context · ${model.supportsThinking ? 'thinking' : 'no thinking'}`,
      model,
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true },
  );

  return picked?.model;
}

async function pickAccount(
  accounts: AccountManager,
  placeHolder: string,
): Promise<AccountMetadata | undefined> {
  const all = accounts.list();
  if (all.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No Google account has been added yet.',
      'Add account',
    );
    if (choice === 'Add account') {
      return accounts.addAccount();
    }
    return undefined;
  }

  const activeId = accounts.getActive()?.id;
  const picked = await vscode.window.showQuickPick(
    all.map((account) => ({
      label: `${account.id === activeId ? '$(check) ' : ''}${account.email}`,
      description: account.subscriptionTier,
      detail: describeAccount(account),
      account,
    })),
    { placeHolder, matchOnDetail: true },
  );

  return picked?.account;
}

function describeAccount(account: AccountMetadata): string {
  if (account.needsReauth) {
    return 'Needs to sign in again';
  }
  const models = Object.values(account.quota?.models ?? {});
  if (models.length === 0) {
    return 'Quota not loaded yet';
  }
  const lowest = Math.min(...models.map((model) => model.percentage));
  return `${models.length} models · lowest quota ${lowest}%`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {
  Logger.info('Antigravity Maestro deactivating');
  Logger.dispose();
}
