/**
 * Thought signatures the upstream hands out with reasoning and tool calls.
 *
 * Gemini 3 and Claude on the Cloud Code endpoints reject a follow-up turn that
 * replays a tool call without the signature they issued for it, so every
 * signature is kept until the conversation moves on.
 *
 * A signature belongs to the model family that minted it. Switching model
 * mid-conversation — picking Claude partway through a Gemini session — leaves
 * the earlier turns carrying signatures the new model has never issued, and
 * the upstream does not forgive that: Gemini answers HTTP 400 ("Function call
 * is missing a thought_signature"), Claude closes the stream with no content
 * at all. So the minting family is stored alongside the signature, and a
 * lookup from another family reports nothing rather than handing back a
 * signature that cannot be replayed.
 */
interface StoredSignature {
  signature: string;
  /** The family that issued it; a lookup from another one misses. */
  family: SignatureFamily;
  at: number;
}

/**
 * Coarse enough that revisions within a family keep their signatures
 * (`gemini-3.8-flash-tiered` replays what `gemini-3-flash` minted), specific
 * enough to separate the families the upstream translates differently.
 * Mirrors `familyOf` in `upstream/modelCatalog`, kept local so the store stays
 * clear of the account and catalogue plumbing.
 */
export type SignatureFamily = 'gemini' | 'claude' | 'gpt';

export function signatureFamilyOf(modelId: string): SignatureFamily {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude')) {
    return 'claude';
  }
  if (id.startsWith('gpt')) {
    return 'gpt';
  }
  return 'gemini';
}

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

class SignatureStore {
  private readonly entries = new Map<string, StoredSignature>();

  set(key: string, signature: string | undefined, model: string): void {
    if (!signature || signature.length < 10) {
      return;
    }
    this.entries.set(key, { signature, family: signatureFamilyOf(model), at: Date.now() });
    this.prune();
  }

  get(key: string, model: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.at > TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    // Kept rather than deleted: the conversation may well go back to the
    // family that minted it, and then the signature is wanted again.
    return entry.family === signatureFamilyOf(model) ? entry.signature : undefined;
  }

  /** Signature for a tool call, so replaying it keeps the upstream happy. */
  forToolCall(callId: string, model: string): string | undefined {
    return this.get(`tool:${callId}`, model);
  }

  rememberToolCall(callId: string, signature: string | undefined, model: string): void {
    this.set(`tool:${callId}`, signature, model);
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
