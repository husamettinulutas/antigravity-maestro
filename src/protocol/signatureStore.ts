/**
 * Thought signatures the upstream hands out with reasoning and tool calls.
 *
 * Gemini 3 and Claude on the Cloud Code endpoints reject a follow-up turn that
 * replays a tool call without the signature they issued for it, so every
 * signature is kept until the conversation moves on.
 */
interface StoredSignature {
  signature: string;
  at: number;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

class SignatureStore {
  private readonly entries = new Map<string, StoredSignature>();

  set(key: string, signature: string | undefined): void {
    if (!signature || signature.length < 10) {
      return;
    }
    this.entries.set(key, { signature, at: Date.now() });
    this.prune();
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.at > TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.signature;
  }

  /** Signature for a tool call, so replaying it keeps the upstream happy. */
  forToolCall(callId: string): string | undefined {
    return this.get(`tool:${callId}`);
  }

  rememberToolCall(callId: string, signature: string | undefined): void {
    this.set(`tool:${callId}`, signature);
  }

  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    const cutoff = Date.now() - TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) {
        this.entries.delete(key);
      }
    }
    // Still oversized: drop the oldest entries.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

export const signatureStore = new SignatureStore();
