import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../utils/logger';

/** Markers delimiting the config block this extension owns. */
export const MANAGED_BLOCK_BEGIN =
  '# --- BEGIN ANTIGRAVITY MAESTRO (auto-generated, do not edit) ---';
export const MANAGED_BLOCK_END = '# --- END ANTIGRAVITY MAESTRO ---';

const BACKUP_SUFFIX = '.antigravity-maestro-backup';
const TEMP_SUFFIX = '.antigravity-maestro-tmp';

export type AgentTarget = 'claude-code' | 'codex';

export interface IntegrationStatus {
  target: AgentTarget;
  /** Whether the agent appears to be installed on this machine. */
  installed: boolean;
  /** Whether it is currently wired to this extension's gateway. */
  active: boolean;
  modelId?: string;
  configPath?: string;
  detail?: string;
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(filePath: string): string {
  return filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/** Read a UTF-8 text file, returning undefined when it does not exist. */
export function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Read and parse JSON. Returns undefined when missing; throws on invalid JSON. */
export function readJsonFile<T = any>(filePath: string): T | undefined {
  const raw = readTextFile(filePath);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

/** Write via a temp sibling + rename, so a crash cannot truncate the original. */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}${TEMP_SUFFIX}`);
  fs.writeFileSync(temp, content, 'utf-8');
  fs.renameSync(temp, filePath);
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Copy a config file once, before the first write. The backup is never
 * overwritten, so the pristine pre-extension state stays recoverable.
 */
export function backupOnce(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    Logger.info(`Created backup: ${backupPath}`);
  }
  return backupPath;
}

export function backupPathFor(filePath: string): string {
  return `${filePath}${BACKUP_SUFFIX}`;
}

/**
 * Replace (or append) the managed block inside a text config file.
 * Everything outside the markers is preserved byte for byte.
 */
export function upsertManagedBlock(existing: string | undefined, blockBody: string): string {
  const block = `${MANAGED_BLOCK_BEGIN}\n${blockBody.trim()}\n${MANAGED_BLOCK_END}`;
  if (existing === undefined || existing.trim() === '') {
    return `${block}\n`;
  }

  const stripped = removeManagedBlock(existing);
  const separator = stripped.endsWith('\n') ? '' : '\n';
  return `${stripped}${separator}\n${block}\n`;
}

/** Remove the managed block, leaving user content untouched. */
export function removeManagedBlock(existing: string): string {
  const begin = existing.indexOf(MANAGED_BLOCK_BEGIN);
  if (begin === -1) {
    return existing;
  }

  const endMarker = existing.indexOf(MANAGED_BLOCK_END, begin);
  if (endMarker === -1) {
    // Truncating to EOF could delete content appended after the block, so
    // refuse rather than guess.
    throw new Error(
      'The Antigravity Maestro block is malformed (its end marker is missing). ' +
        'Fix the file by hand or restore it from the .antigravity-maestro-backup copy.',
    );
  }

  const end = endMarker + MANAGED_BLOCK_END.length;
  let before = existing.slice(0, begin).replace(/\n+$/, '\n');
  if (before === '\n') {
    before = '';
  }
  let after = existing.slice(end).replace(/^\n+/, '');
  if (after !== '') {
    after = (before === '' ? '' : '\n') + after;
  }
  return before + after;
}

export function hasManagedBlock(content: string | undefined): boolean {
  return content !== undefined && content.includes(MANAGED_BLOCK_BEGIN);
}

/** Escape a value for a double-quoted TOML string. */
export function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
