/**
 * How an agent tells the gateway which VS Code window it runs in.
 *
 * Each window publishes the account it chose under its key (see
 * AccountStore), and the agents it launches inherit the key from its
 * environment. Their configs turn that variable into a header, so whichever
 * window's gateway they reach serves them from their own window's account.
 */

/** Header an agent names its window with on every gateway request. */
export const WINDOW_HEADER = 'x-maestro-window';

/** Variable each window sets to its key for the agents it launches. */
export const WINDOW_ENV = 'ANTIGRAVITY_MAESTRO_WINDOW';

/** Claude Code's variable for extra request headers, one `Name: value` per line. */
export const CLAUDE_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS';

/**
 * `existing` Claude Code headers with the window header set to `windowKey`,
 * or taken out when it is undefined. Headers the user set are kept.
 */
export function withWindowHeader(
  existing: string | undefined,
  windowKey: string | undefined,
): string | undefined {
  const lines = (existing ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().toLowerCase().startsWith(`${WINDOW_HEADER}:`));
  if (windowKey) {
    lines.push(`${WINDOW_HEADER}: ${windowKey}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
