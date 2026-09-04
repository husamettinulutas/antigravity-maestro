/**
 * Minimal `vscode` stand-in for tests. Only the API surface the provider code
 * actually touches is implemented; everything else stays absent on purpose so
 * a test that reaches further fails loudly instead of silently passing.
 */

export enum LanguageModelChatMessageRole {
  System = 0,
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    readonly callId: string,
    readonly name: string,
    readonly input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    readonly callId: string,
    readonly content: unknown[],
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];

  get event() {
    return (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }

  fire(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }

  dispose(): void {}
}

/**
 * Settings a test wants to pin. Anything left unset reads its real default, so
 * a test only says what it actually depends on.
 */
export const testSettings: Record<string, unknown> = {};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T) =>
      key in testSettings ? (testSettings[key] as T) : fallback,
    update: async () => undefined,
    inspect: () => undefined,
  }),
};

export const env = {
  machineId: 'test-machine-id',
  sessionId: 'test-session-id',
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
};
