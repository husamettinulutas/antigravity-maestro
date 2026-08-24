import * as vscode from 'vscode';
import { AccountMetadata } from './types';

const ACCOUNTS_KEY = 'antigravityMaestro.accounts';
const ACTIVE_ACCOUNT_KEY = 'antigravityMaestro.activeAccountId';
const REFRESH_TOKEN_PREFIX = 'antigravityMaestro.refresh.';

/**
 * Persistence for accounts: metadata in globalState, refresh tokens in
 * SecretStorage so they are encrypted at rest and never land in settings.json.
 */
export class AccountStore {
  constructor(
    private readonly globalState: vscode.Memento,
    private readonly secrets: vscode.SecretStorage,
  ) {}

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

    if (this.getActiveId() === accountId) {
      await this.setActiveId(accounts[0]?.id);
    }
  }

  getActiveId(): string | undefined {
    const active = this.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
    // A stale id (account removed elsewhere) should behave like "no selection".
    return active && this.get(active) ? active : undefined;
  }

  async setActiveId(accountId: string | undefined): Promise<void> {
    await this.globalState.update(ACTIVE_ACCOUNT_KEY, accountId);
  }

  getRefreshToken(accountId: string): Thenable<string | undefined> {
    return this.secrets.get(REFRESH_TOKEN_PREFIX + accountId);
  }

  setRefreshToken(accountId: string, token: string): Thenable<void> {
    return this.secrets.store(REFRESH_TOKEN_PREFIX + accountId, token);
  }
}
