/** How long a local gateway gets to answer a probe. */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * True when a Maestro gateway that accepts `apiKey` answers at `baseUrl` —
 * one this extension runs in some VS Code window, rather than another local
 * proxy on the port or nothing at all.
 */
export async function isLiveGateway(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
