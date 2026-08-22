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
  backupPathFor,
  readJsonFile,
  writeJsonFileAtomic,
} from './shared';

/** globalState key holding the pre-apply snapshot used by restore(). */
const SNAPSHOT_KEY = 'antigravityMaestro.claudeCodeSnapshot';

/** The env vars this integration owns inside Claude Code's settings file. */
const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
] as const;

interface ClaudeSettings {
  env?: Record<string, string>;
  model?: unknown;
  [key: string]: unknown;
}

interface ClaudeSnapshot {
  settingsPath: string;
  /** Previous values of the managed keys; undefined means the key was absent. */
  previousEnv: Record<string, string | undefined>;
  previousVsCodeEnvVars: unknown;
  previousDisableLoginPrompt: unknown;
  /** Claude Code's own top-level "model", which shadows ANTHROPIC_MODEL. */
  previousTopLevelModel: unknown;
}

/**
 * Points Claude Code (CLI and VS Code extension) at the local gateway by
 * writing the ANTHROPIC_* env block into its settings file.
 */
export class ClaudeCodeIntegration implements AgentIntegration {
  readonly target = 'claude-code' as const;

  constructor(private readonly globalState: vscode.Memento) {}

  private get claudeDir(): string {
    return path.join(os.homedir(), '.claude');
  }

  private settingsPath(): string {
    if (Config.claudeCodeSettingsScope() === 'project') {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (workspace) {
        // settings.local.json is gitignored by Claude Code — safe for a key.
        return path.join(workspace.uri.fsPath, '.claude', 'settings.local.json');
      }
      Logger.warn('claudeCode.settingsScope is "project" but no folder is open; using user scope');
    }
    return path.join(this.claudeDir, 'settings.json');
  }

  async getStatus(): Promise<IntegrationStatus> {
    const settingsPath = this.settingsPath();
    const installed =
      fs.existsSync(this.claudeDir) || fs.existsSync(path.join(os.homedir(), '.claude.json'));

    let active = false;
    let modelId: string | undefined;
    let detail: string | undefined;

    try {
      const settings = readJsonFile<ClaudeSettings>(settingsPath);
      const env = settings?.env;
      if (env?.ANTHROPIC_BASE_URL?.includes('127.0.0.1')) {
        active = true;
        modelId = env.ANTHROPIC_MODEL;
      }
      if (active && typeof settings?.model === 'string' && settings.model.trim() !== '') {
        // Claude Code's /model picker writes this key and it wins over the
        // env var, so surface it rather than reporting a stale model.
        modelId = settings.model;
        detail = `Claude Code's own "model" setting ("${settings.model}") overrides the model applied here.`;
      }
    } catch (error) {
      detail = `Could not read ${settingsPath}: ${describe(error)}`;
    }

    return { target: this.target, installed, active, modelId, configPath: settingsPath, detail };
  }

  async apply(
    modelId: string,
    endpoint: GatewayEndpoint,
    options: ApplyOptions = {},
  ): Promise<IntegrationStatus> {
    const settingsPath = this.settingsPath();

    // A previous apply may have targeted the other scope; un-wire it first so
    // two settings files are never wired at once.
    const existing = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (existing && existing.settingsPath !== settingsPath) {
      await this.restore();
    }

    backupOnce(settingsPath);

    let settings: ClaudeSettings;
    try {
      settings = readJsonFile<ClaudeSettings>(settingsPath) ?? {};
    } catch (error) {
      throw new Error(
        `${settingsPath} contains invalid JSON — fix or delete it first (${describe(error)})`,
      );
    }

    const env: Record<string, string> = { ...(settings.env ?? {}) };
    await this.snapshotOnce(settingsPath, env, settings);

    env.ANTHROPIC_BASE_URL = endpoint.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = endpoint.apiKey;
    // Must be present but empty, otherwise Claude Code falls back to x-api-key
    // auth against api.anthropic.com.
    env.ANTHROPIC_API_KEY = '';
    env.ANTHROPIC_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = options.smallFastModelId || modelId;
    env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
    // Claude Code's experimental betas attach Anthropic-only message ids that
    // the gateway cannot honour.
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';

    if (options.maxInputTokens && options.maxInputTokens > 0) {
      // Claude Code assumes a 200k window; declaring the real one makes
      // auto-compaction fire at the right point.
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(options.maxInputTokens);
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
        Math.min(Math.max(Math.floor(options.maxInputTokens * 0.8), 50_000), 1_000_000),
      );
    } else {
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(
      Math.min(options.maxOutputTokens && options.maxOutputTokens > 0 ? options.maxOutputTokens : 32_000, 32_000),
    );

    settings.env = env;
    // Remove the top-level model so ANTHROPIC_MODEL is what takes effect; the
    // snapshot keeps the original for restore().
    delete settings.model;
    writeJsonFileAtomic(settingsPath, settings);
    Logger.info(`Claude Code wired to ${endpoint.baseUrl} (${modelId}) via ${settingsPath}`);

    const detail = await this.updateVsCodeSettings(endpoint);
    return {
      target: this.target,
      installed: true,
      active: true,
      modelId,
      configPath: settingsPath,
      detail,
    };
  }

  async restore(): Promise<IntegrationStatus> {
    const snapshot = this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY);
    if (!snapshot) {
      // No snapshot — but the settings file may still be wired to the gateway
      // (e.g. the snapshot was lost due to a globalState reset). Fall back to
      // stripping every managed key so the user is not stuck.
      return this.restoreFallback();
    }

    let settings: ClaudeSettings | undefined;
    try {
      settings = readJsonFile<ClaudeSettings>(snapshot.settingsPath);
    } catch {
      throw new Error(
        `${snapshot.settingsPath} contains invalid JSON — restore it from ${backupPathFor(snapshot.settingsPath)}`,
      );
    }

    if (settings) {
      if (settings.env) {
        for (const key of MANAGED_ENV_KEYS) {
          const previous = snapshot.previousEnv?.[key];
          if (previous !== undefined) {
            settings.env[key] = previous;
          } else {
            delete settings.env[key];
          }
        }
        if (Object.keys(settings.env).length === 0) {
          delete settings.env;
        }
      }
      if (snapshot.previousTopLevelModel !== undefined) {
        settings.model = snapshot.previousTopLevelModel;
      } else {
        delete settings.model;
      }
      writeJsonFileAtomic(snapshot.settingsPath, settings);
      Logger.info(`Claude Code settings restored in ${snapshot.settingsPath}`);
    }

    await this.clearVsCodeSettings(
      snapshot.previousVsCodeEnvVars,
      snapshot.previousDisableLoginPrompt,
    );
    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }

  /**
   * Fallback restore when no snapshot is available: strip managed env keys and
   * the top-level model from the settings file, then clear VS Code settings.
   */
  private async restoreFallback(): Promise<IntegrationStatus> {
    const settingsPath = this.settingsPath();
    let settings: ClaudeSettings | undefined;
    try {
      settings = readJsonFile<ClaudeSettings>(settingsPath);
    } catch {
      Logger.warn(`${settingsPath} has invalid JSON — skipping fallback restore`);
      return this.getStatus();
    }

    if (!settings) {
      return this.getStatus();
    }

    // Only act if the file is actually wired to the gateway.
    const isWired = settings.env?.ANTHROPIC_BASE_URL?.includes('127.0.0.1');
    if (!isWired) {
      return this.getStatus();
    }

    Logger.info('No snapshot found — performing fallback restore by stripping managed keys');
    if (settings.env) {
      for (const key of MANAGED_ENV_KEYS) {
        delete settings.env[key];
      }
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
    }
    delete settings.model;
    writeJsonFileAtomic(settingsPath, settings);
    await this.clearVsCodeSettings(undefined, undefined);
    Logger.info(`Claude Code fallback restore completed in ${settingsPath}`);
    return this.getStatus();
  }

  /**
   * Last-resort restore: copy the backup file over the current settings,
   * ignoring the snapshot entirely. Use when both restore() and the fallback
   * fail to produce a working configuration.
   */
  async forceRestore(): Promise<IntegrationStatus> {
    const settingsPath = this.settingsPath();
    const backup = backupPathFor(settingsPath);

    if (!fs.existsSync(backup)) {
      throw new Error(
        `No backup file found at ${backup}. Manually delete ${settingsPath} and restart Claude Code.`,
      );
    }

    fs.copyFileSync(backup, settingsPath);
    Logger.info(`Claude Code force-restored from ${backup}`);

    await this.clearVsCodeSettings(undefined, undefined);
    await this.globalState.update(SNAPSHOT_KEY, undefined);
    return this.getStatus();
  }

  /** Helper to reset the claudeCode.* VS Code settings. */
  private async clearVsCodeSettings(
    previousEnvVars: unknown,
    previousDisableLoginPrompt: unknown,
  ): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(
        'claudeCode.environmentVariables',
        previousEnvVars,
        vscode.ConfigurationTarget.Global,
      );
      await config.update(
        'claudeCode.disableLoginPrompt',
        previousDisableLoginPrompt,
        vscode.ConfigurationTarget.Global,
      );
    } catch (error) {
      Logger.warn('Could not restore claudeCode.* VS Code settings', error);
    }
  }

  /** Capture the pre-apply state once, so restore() reaches the true original. */
  private async snapshotOnce(
    settingsPath: string,
    env: Record<string, string>,
    settings: ClaudeSettings,
  ): Promise<void> {
    if (this.globalState.get<ClaudeSnapshot>(SNAPSHOT_KEY)) {
      return;
    }

    const previousEnv: Record<string, string | undefined> = {};
    for (const key of MANAGED_ENV_KEYS) {
      previousEnv[key] = env[key];
    }

    const config = vscode.workspace.getConfiguration();
    await this.globalState.update(SNAPSHOT_KEY, {
      settingsPath,
      previousEnv,
      previousVsCodeEnvVars: config.inspect('claudeCode.environmentVariables')?.globalValue,
      previousDisableLoginPrompt: config.inspect('claudeCode.disableLoginPrompt')?.globalValue,
      previousTopLevelModel: settings.model,
    } satisfies ClaudeSnapshot);
  }

  /**
   * Mirror the credentials into the Claude Code VS Code extension's own
   * settings — it validates them before launching the CLI.
   */
  private async updateVsCodeSettings(endpoint: GatewayEndpoint): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(
        'claudeCode.environmentVariables',
        [
          { name: 'ANTHROPIC_BASE_URL', value: endpoint.baseUrl },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: endpoint.apiKey },
          { name: 'ANTHROPIC_API_KEY', value: '' },
        ],
        vscode.ConfigurationTarget.Global,
      );
      // Otherwise the extension shows its Anthropic login screen instead of
      // using these credentials.
      await config.update('claudeCode.disableLoginPrompt', true, vscode.ConfigurationTarget.Global);
      return 'Restart any running Claude Code sessions to pick up the change.';
    } catch (error) {
      Logger.warn('Could not update claudeCode.* settings (extension not installed?)', error);
      return 'Claude Code VS Code extension not detected — CLI sessions will still use the gateway.';
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
