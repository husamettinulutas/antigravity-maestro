import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Config } from '../utils/config';
import { Logger } from '../utils/logger';
import { AgentIntegration, ApplyOptions, GatewayEndpoint } from './agentIntegration';
import {
  IntegrationStatus,
  backupOnce,
  expandHome,
  readTextFile,
  tomlEscape,
  writeTextFileAtomic,
} from './shared';

/** Env var Codex reads the gateway key from (referenced by env_key in config.toml). */
export const CODEX_ENV_KEY = 'ANTIGRAVITY_MAESTRO_API_KEY';

/** Provider id owned inside [model_providers.*]. */
const PROVIDER_ID = 'antigravity';

const SNAPSHOT_KEY = 'antigravityMaestro.codexSnapshot';

/** Top-level keys this integration owns while it is applied. */
const MANAGED_TOP_LEVEL_KEYS = [
  'model',
  'model_provider',
  'show_raw_agent_reasoning',
  'model_reasoning_effort',
  'model_reasoning_summary',
] as const;

interface CodexSnapshot {
  configPath: string;
  /** Previous top-level assignments, keyed by name (absent = the key was unset). */
  previousTopLevel: Record<string, string | undefined>;
  /** A pre-existing user-owned [model_providers.antigravity] section, if any. */
  previousProviderSection?: string;
  /**
   * Value of the user-scope env var before the first apply (null = unset).
   * Only recorded on Windows, where apply() persists it.
   */
  previousUserEnvKey?: string | null;
}

/**
 * Wires the Codex CLI and IDE extension to the local gateway through
 * ~/.codex/config.toml.
 *
 * Codex rewrites this file with its own TOML serializer (for example when
 * trusting a folder), which moves comments around — so the managed pieces are
 * located semantically, by section and key name, never by comment markers.
 */
export class CodexIntegration implements AgentIntegration {
  readonly target = 'codex' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  private get codexDir(): string {
    return path.join(os.homedir(), '.codex');
  }

  private configPath(): string {
    const custom = Config.codexConfigPath();
    return custom ? expandHome(custom) : path.join(this.codexDir, 'config.toml');
  }

  /**
   * Expose the gateway key to the extension host process.
   *
   * VS Code inherits the user environment from the moment it launched, so the
   * variable apply() persists is invisible to the Codex extension — which lives
   * in this same host process and passes its environment to the CLI it spawns —
   * until VS Code is restarted. Seeding it here on every activation makes a
   * window reload enough, and keeps the value correct if the key was rotated.
   */
  seedProcessEnv(apiKey: string): void {
    if (process.env[CODEX_ENV_KEY] === apiKey) {
      return;
    }
    process.env[CODEX_ENV_KEY] = apiKey;
    Logger.info(`Exposed ${CODEX_ENV_KEY} to the extension host process`);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(): Promise<IntegrationStatus> {
    const configPath = this.configPath();
    const installed = fs.existsSync(this.codexDir);
    const content = readTextFile(configPath);

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    if (content !== undefined) {
      const providerLine = findTopLevelLine(content, 'model_provider');
      active =
        findProviderSection(content) !== undefined && providerLine?.includes(`"${PROVIDER_ID}"`) === true;

      if (active) {
        modelId = findTopLevelLine(content, 'model')?.match(/=\s*"([^"]+)"/)?.[1];
        detail =
          'Codex labels custom models as "Custom" in its own picker — requests still use the model shown here.';
        if (!process.env[CODEX_ENV_KEY]) {
          detail += ` If Codex reports a missing ${CODEX_ENV_KEY}, reload the VS Code window.`;
        }
      }
    }

    return { target: this.target, installed, active, modelId, configPath, detail };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  async apply(
    modelId: string,
    endpoint: GatewayEndpoint,
    options: ApplyOptions = {},
  ): Promise<IntegrationStatus> {
    const configPath = this.configPath();

    // A previous apply may have targeted another file (the setting changed);
    // un-wire that one first.
    const existingSnapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    if (existingSnapshot && existingSnapshot.configPath !== configPath) {
      await this.restore();
    }

    backupOnce(configPath);
    const existing = readTextFile(configPath);
    await this.snapshotOnce(configPath, existing);

    // 1) Strip what this integration owns: its provider section and the
    //    top-level model selection.
    let content = removeProviderSection(existing ?? '');
    content = stripTopLevelKeys(content);

    // 2) Append a fresh provider section. Codex only speaks the Responses wire
    //    format to custom providers, which the gateway implements.
    const section = [
      `[model_providers.${PROVIDER_ID}]`,
      'name = "Antigravity Maestro"',
      `base_url = "${tomlEscape(`${endpoint.baseUrl}/v1`)}"`,
      `env_key = "${CODEX_ENV_KEY}"`,
      'wire_api = "responses"',
    ].join('\n');
    content =
      content.trim() === '' ? `${section}\n` : `${content.replace(/\n*$/, '\n')}\n${section}\n`;

    // 3) Top-level keys must come before any [section] header, and are only
    //    honoured in the user-level config.
    const reasoningLines =
      options.maxOutputTokens === 0
        ? ''
        : 'show_raw_agent_reasoning = true\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "auto"\n';

    content =
      `model = "${tomlEscape(modelId)}"\n` +
      `model_provider = "${PROVIDER_ID}"\n` +
      reasoningLines +
      (content.startsWith('\n') ? '' : '\n') +
      content;

    writeTextFileAtomic(configPath, content);
    Logger.info(`Codex wired to ${endpoint.baseUrl} (${modelId}) via ${configPath}`);

    // 4) The GUI-launched IDE extension does not inherit shell exports, so on
    //    Windows the key is persisted as a user environment variable.
    let detail: string;
    if (process.platform === 'win32') {
      await persistUserEnv(CODEX_ENV_KEY, endpoint.apiKey);
      detail = `Reload the window once so Codex picks up ${CODEX_ENV_KEY}.`;
    } else {
      detail = `Add to your shell profile: export ${CODEX_ENV_KEY}="${endpoint.apiKey}"`;
    }

    return { target: this.target, installed: true, active: true, modelId, configPath, detail };
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY);
    const configPath = snapshot?.configPath ?? this.configPath();
    const existing = readTextFile(configPath);

    // With neither a snapshot nor our provider section, any model selection in
    // the file belongs to the user — leave it alone.
    if (!snapshot && (existing === undefined || findProviderSection(existing) === undefined)) {
      return this.getStatus();
    }

    if (existing !== undefined) {
      let content = removeProviderSection(existing);
      content = stripTopLevelKeys(content);

      if (snapshot?.previousProviderSection) {
        content = `${content.replace(/\n*$/, '\n')}\n${snapshot.previousProviderSection.replace(/\n*$/, '\n')}`;
      }

      const restoredLines = MANAGED_TOP_LEVEL_KEYS.map(
        (key) => snapshot?.previousTopLevel?.[key],
      ).filter((line): line is string => line !== undefined);

      if (restoredLines.length > 0) {
        content = `${restoredLines.join('\n')}\n${content.startsWith('\n') ? content.slice(1) : content}`;
      }

      writeTextFileAtomic(configPath, content);
      Logger.info(`Codex config restored in ${configPath}`);
    }

    await restoreUserEnv(snapshot?.previousUserEnvKey);
    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }

  private async snapshotOnce(configPath: string, existing: string | undefined): Promise<void> {
    if (this.globalState.get<CodexSnapshot>(SNAPSHOT_KEY)) {
      return;
    }

    const previousTopLevel: Record<string, string | undefined> = {};
    for (const key of MANAGED_TOP_LEVEL_KEYS) {
      previousTopLevel[key] = existing ? findTopLevelLine(existing, key) : undefined;
    }

    const priorSection = existing ? findProviderSection(existing) : undefined;
    await this.globalState.update(SNAPSHOT_KEY, {
      configPath,
      previousTopLevel,
      previousProviderSection:
        existing && priorSection ? existing.slice(priorSection.start, priorSection.end) : undefined,
      previousUserEnvKey: process.platform === 'win32' ? await readUserEnv(CODEX_ENV_KEY) : undefined,
    } satisfies CodexSnapshot);
  }
}

// ── TOML helpers ──────────────────────────────────────────────────────────────

/**
 * Scan the top-level region (everything before the first [section] header),
 * tracking triple-quoted strings so a line that merely looks like a header or
 * assignment inside a string is not misread.
 */
function scanTopLevel(content: string): {
  lines: { text: string; inString: boolean }[];
  restStart: number;
} {
  const lines: { text: string; inString: boolean }[] = [];
  let inTriple: '"""' | "'''" | null = null;
  let offset = 0;

  for (const line of content.split('\n')) {
    const startedInString = inTriple !== null;

    if (inTriple) {
      if (line.includes(inTriple)) {
        inTriple = null;
      }
    } else {
      if (/^\s*\[[^[\]]*\]\s*(#.*)?$/.test(line)) {
        return { lines, restStart: offset };
      }
      for (const quote of ['"""', "'''"] as const) {
        const first = line.indexOf(quote);
        if (first !== -1 && line.indexOf(quote, first + quote.length) === -1) {
          inTriple = quote;
          break;
        }
      }
    }

    lines.push({ text: line, inString: startedInString || inTriple !== null });
    offset += line.length + 1;
  }

  return { lines, restStart: content.length };
}

function findTopLevelLine(content: string, key: string): string | undefined {
  const { lines } = scanTopLevel(content);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  return lines.find((line) => !line.inString && pattern.test(line.text))?.text;
}

function stripTopLevelKeys(content: string): string {
  const { lines, restStart } = scanTopLevel(content);
  const pattern = new RegExp(`^\\s*(${MANAGED_TOP_LEVEL_KEYS.join('|')})\\s*=`);
  const kept = lines
    .filter((line) => line.inString || !pattern.test(line.text))
    .map((line) => line.text);

  const rest = content.slice(restStart);
  const top = kept.join('\n');
  if (rest === '') {
    return top;
  }
  return top === '' ? rest : `${top}\n${rest}`;
}

/** Locate our provider section: its header through the next unrelated header. */
function findProviderSection(content: string): { start: number; end: number } | undefined {
  let offset = 0;
  let start = -1;
  let end = content.length;

  for (const line of content.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(#.*)?$/)?.[1]?.trim();
    if (start === -1) {
      if (header === `model_providers.${PROVIDER_ID}` || header === `model_providers."${PROVIDER_ID}"`) {
        start = offset;
      }
    } else if (header !== undefined && !header.startsWith(`model_providers.${PROVIDER_ID}.`)) {
      end = offset;
      break;
    }
    offset += line.length + 1;
  }

  return start === -1 ? undefined : { start, end: Math.min(end, content.length) };
}

function removeProviderSection(content: string): string {
  const range = findProviderSection(content);
  if (!range) {
    return content;
  }
  let before = content.slice(0, range.start).replace(/\n+$/, '\n');
  if (before === '\n') {
    before = '';
  }
  let after = content.slice(range.end).replace(/^\n+/, '');
  if (after !== '') {
    after = (before === '' ? '' : '\n') + after;
  }
  return before + after;
}

// ── Windows user environment ──────────────────────────────────────────────────

/**
 * Persist a user-scope environment variable. PowerShell is used instead of
 * setx, which truncates values over 1024 characters.
 */
function persistUserEnv(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const escaped = value.replace(/'/g, "''");
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Environment]::SetEnvironmentVariable('${name}', '${escaped}', 'User')`,
      ],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to persist ${name}: ${stderr || error.message}`));
          return;
        }
        // Also expose it to processes spawned from this extension host.
        process.env[name] = value;
        resolve();
      },
    );
  });
}

function readUserEnv(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
      ],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          Logger.warn(`Could not read the ${name} user variable; assuming it was unset`);
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value === '' ? null : value);
      },
    );
  });
}

/**
 * Put the user variable back the way it was — deleted when this extension
 * created it. Leaving a live gateway key behind would be a credential leak.
 */
async function restoreUserEnv(previous: string | null | undefined): Promise<void> {
  if (process.platform !== 'win32' || previous === undefined) {
    return;
  }

  try {
    if (previous === null) {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `[Environment]::SetEnvironmentVariable('${CODEX_ENV_KEY}', $null, 'User')`,
          ],
          { windowsHide: true },
          (error, _stdout, stderr) =>
            error ? reject(new Error(stderr || error.message)) : resolve(),
        );
      });
      delete process.env[CODEX_ENV_KEY];
      Logger.info(`Removed the ${CODEX_ENV_KEY} user environment variable`);
    } else {
      await persistUserEnv(CODEX_ENV_KEY, previous);
    }
  } catch (error) {
    // The config file is what actually routes Codex and it is already clean;
    // a leftover variable is not worth failing the restore over.
    Logger.warn(`Failed to restore the ${CODEX_ENV_KEY} user variable`, error);
  }
}
