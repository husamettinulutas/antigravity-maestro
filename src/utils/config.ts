import * as vscode from 'vscode';

/** Typed access to the extension's `antigravityMaestro.*` settings. */
export const Config = {
  gatewayPort: (): number => get<number>('gateway.port', 8765),
  gatewayAutoStart: (): boolean => get<boolean>('gateway.autoStart', true),
  quotaAutoRefreshMinutes: (): number => get<number>('quota.autoRefreshMinutes', 10),
  rotationStrategy: (): 'manual' | 'round-robin' | 'highest-quota-first' =>
    get('rotation.strategy', 'highest-quota-first'),
  rotationCooldownMinutes: (): number => get<number>('rotation.cooldownMinutes', 15),
  requestTimeoutMs: (): number => get<number>('requestTimeoutSeconds', 120) * 1000,
  upstreamProxyUrl: (): string => get<string>('upstreamProxyUrl', '').trim(),
  oauthClientId: (): string => get<string>('oauth.clientId', '').trim(),
  oauthClientSecret: (): string => get<string>('oauth.clientSecret', '').trim(),
  claudeCodeSettingsScope: (): 'user' | 'project' => get('claudeCode.settingsScope', 'user'),
  claudeCodeSmallFastModel: (): string => get<string>('claudeCode.smallFastModel', '').trim(),
  codexConfigPath: (): string => get<string>('codex.configPath', '').trim(),
  reloadOnModelChange: (): 'prompt' | 'auto' | 'never' => get('reloadOnModelChange', 'prompt'),
};

function get<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('antigravityMaestro').get<T>(key, fallback);
}
