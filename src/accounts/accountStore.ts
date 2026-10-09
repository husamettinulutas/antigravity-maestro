import * as vscode from 'vscode';
import { randomToken } from '../utils/ids';
import { AccountMetadata, RetiredModel } from './types';

const ACCOUNTS_KEY = 'antigravityMaestro.accounts';
const ACTIVE_ACCOUNT_KEY = 'antigravityMaestro.activeAccountId';
const REFRESH_TOKEN_PREFIX = 'antigravityMaestro.refresh.';
const RETIRED_MODELS_KEY = 'antigravityMaestro.retiredModels';
const WINDOW_KEY = 'antigravityMaestro.windowKey';
const WINDOW_ACCOUNTS_KEY = 'antigravityMaestro.windowAccounts';

/** A window not heard from in this long is dropped from the routing table. */
const WINDOW_ROUTE_TTL_MS = 30 * 24 * 60 * 60_000;

/** The account a window has chosen, as every window's gateway sees it. */
interface WindowRoute {
  accountId: string;
  /** When the user last picked it by hand; rotation leaves this alone. */
  chosenAt: number;
  seenAt: number;
}

/**
 * Persistence for accounts: metadata in globalState, refresh tokens in
 * SecretStorage so they are encrypted at rest and never land in settings.json.
 *
 * The active account is kept per window, in `windowState`. globalState is
 * shared live between every VS Code window, so with it there a pick in one
 * window moved every other window onto that account too — two projects could
 * not run on two accounts side by side. globalState still holds the account
 * picked last, as the one a window that has never chosen starts on.
 *
 * Each window's choice is also published in globalState under its window key.
 * Claude Code and Codex name their window on every request, and whichever
 * window's gateway they reach serves them from that window's account.
 */
export class AccountStore {
  /** Names this window — this workspace — to the gateways of every window. */
  readonly windowKey: string;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
    private readonly windowState: vscode.Memento = globalState,
  ) {
    const stored = windowState.get<string>(WINDOW_KEY);
    this.windowKey = stored ?? `w-${randomToken(12)}`;
    if (!stored) {
      void windowState.update(WINDOW_KEY, this.windowKey);
    }
  }

  list(): AccountMetadata[] {
    return this.globalState.get<AccountMetadata[]>(ACCOUNTS_KEY, []);
  }

  get(accountId: string): AccountMetadata | undefined {
    return this.list().find((account) => account.id === accountId);
  }

  /** Insert or replace an account, keeping list order stable for existing ids. */
  async upsert(account: AccountMetadata): Promise<void> {
    const accounts = this.list();
    const index = accounts.findIndex((existing) => existing.id === account.id);
    if (index >= 0) {
      accounts[index] = account;
    } else {
      accounts.push(account);
    }
    await this.globalState.update(ACCOUNTS_KEY, accounts);
  }

  /** Apply a partial update to one account. No-op when the account is gone. */
  async patch(accountId: string, changes: Partial<AccountMetadata>): Promise<void> {
    const account = this.get(accountId);
    if (!account) {
      return;
    }
    await this.upsert({ ...account, ...changes });
  }

  /**
   * Put the accounts in the given order. Ids that are not in the list keep
   * their relative order at the end, so an account added while the panel was
   * being dragged around is never dropped.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    const accounts = this.list();
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const moved = orderedIds
      .map((id) => byId.get(id))
      .filter((account): account is AccountMetadata => account !== undefined);
    const movedIds = new Set(moved.map((account) => account.id));
    const rest = accounts.filter((account) => !movedIds.has(account.id));

    await this.globalState.update(ACCOUNTS_KEY, [...moved, ...rest]);
  }

  async remove(accountId: string): Promise<void> {
    const accounts = this.list().filter((account) => account.id !== accountId);
    await this.globalState.update(ACCOUNTS_KEY, accounts);
    await this.secrets.delete(REFRESH_TOKEN_PREFIX + accountId);

    // Read raw: the account is already off the list, so getActiveId() would
    // no longer name it.
    for (const state of new Set([this.windowState, this.globalState])) {
      if (state.get<string>(ACTIVE_ACCOUNT_KEY) === accountId) {
        await state.update(ACTIVE_ACCOUNT_KEY, accounts[0]?.id);
      }
    }
    await this.route(this.windowKey, this.getActiveId(), false);
  }

  /**
   * The active account of `window` — this one when it is left out. Another
   * window that has published no choice is served like this one.
   */
  getActiveId(window?: string): string | undefined {
    if (window !== undefined && window !== this.windowKey) {
      return this.known(this.routes()[window]?.accountId) ?? this.getActiveId();
    }
    return (
      this.known(this.windowState.get<string>(ACTIVE_ACCOUNT_KEY)) ??
      this.known(this.globalState.get<string>(ACTIVE_ACCOUNT_KEY))
    );
  }

  /**
   * Make `accountId` the active account of `window` — this one when it is
   * left out. `byUser` marks a pick by hand, not a rotation: it also becomes
   * the account new windows start on.
   */
  async setActiveId(accountId: string | undefined, byUser = true, window?: string): Promise<void> {
    const target = window ?? this.windowKey;
    if (target === this.windowKey) {
      await this.windowState.update(ACTIVE_ACCOUNT_KEY, accountId);
      if (byUser && this.windowState !== this.globalState) {
        await this.globalState.update(ACTIVE_ACCOUNT_KEY, accountId);
      }
    }
    await this.route(target, accountId, byUser);
  }

  /** When the user last picked `window`'s account by hand. */
  chosenAt(window?: string): number | undefined {
    return this.routes()[window ?? this.windowKey]?.chosenAt;
  }

  /**
   * Settle this window on the account it would use now, and publish it. Until
   * it has one of its own it follows the shared default, which a pick in
   * another window moves.
   */
  async claimActiveId(): Promise<void> {
    const active = this.getActiveId();
    if (active && !this.known(this.windowState.get<string>(ACTIVE_ACCOUNT_KEY))) {
      await this.windowState.update(ACTIVE_ACCOUNT_KEY, active);
    }
    await this.route(this.windowKey, active, false);
  }

  private routes(): Record<string, WindowRoute> {
    return this.globalState.get<Record<string, WindowRoute>>(WINDOW_ACCOUNTS_KEY, {});
  }

  /** Publish `window`'s account, dropping windows long gone. */
  private async route(window: string, accountId: string | undefined, byUser: boolean): Promise<void> {
    const now = Date.now();
    const routes: Record<string, WindowRoute> = {};
    for (const [key, route] of Object.entries(this.routes())) {
      if (now - route.seenAt < WINDOW_ROUTE_TTL_MS) {
        routes[key] = route;
      }
    }
    if (accountId === undefined) {
      delete routes[window];
    } else {
      routes[window] = {
        accountId,
        chosenAt: byUser ? now : (routes[window]?.chosenAt ?? 0),
        seenAt: now,
      };
    }
    await this.globalState.update(WINDOW_ACCOUNTS_KEY, routes);
  }

  /** The id, while it still names an account; a stale one reads as no selection. */
  private known(accountId: string | undefined): string | undefined {
    return accountId && this.get(accountId) ? accountId : undefined;
  }

  /** Models the upstream has said are withdrawn, by upstream id. */
  retiredModels(): Record<string, RetiredModel> {
    return this.globalState.get<Record<string, RetiredModel>>(RETIRED_MODELS_KEY, {});
  }

  async setRetiredModels(retired: Record<string, RetiredModel>): Promise<void> {
    await this.globalState.update(RETIRED_MODELS_KEY, retired);
  }

  getRefreshToken(accountId: string): Thenable<string | undefined> {
    return this.secrets.get(REFRESH_TOKEN_PREFIX + accountId);
  }

  setRefreshToken(accountId: string, token: string): Thenable<void> {
    return this.secrets.store(REFRESH_TOKEN_PREFIX + accountId, token);
  }
}
