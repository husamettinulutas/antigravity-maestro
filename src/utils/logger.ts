import * as vscode from 'vscode';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Output channel logger with a configurable minimum level. */
export class Logger {
  private static channel: vscode.OutputChannel | undefined;

  static init(): void {
    if (!Logger.channel) {
      Logger.channel = vscode.window.createOutputChannel('Antigravity Maestro');
    }
  }

  static debug(message: string, ...args: unknown[]): void {
    Logger.log('debug', message, ...args);
  }

  static info(message: string, ...args: unknown[]): void {
    Logger.log('info', message, ...args);
  }

  static warn(message: string, ...args: unknown[]): void {
    Logger.log('warn', message, ...args);
  }

  static error(message: string, ...args: unknown[]): void {
    Logger.log('error', message, ...args);
  }

  static show(): void {
    Logger.init();
    Logger.channel?.show();
  }

  static dispose(): void {
    Logger.channel?.dispose();
    Logger.channel = undefined;
  }

  private static minLevel(): number {
    const configured = vscode.workspace
      .getConfiguration('antigravityMaestro')
      .get<LogLevel>('logLevel', 'info');
    return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
  }

  private static log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[level] < Logger.minLevel()) {
      return;
    }
    Logger.init();
    const timestamp = new Date().toISOString();
    const extra = args.length > 0 ? ' ' + args.map((a) => safeStringify(a)).join(' ') : '';
    Logger.channel!.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}${extra}`);
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
