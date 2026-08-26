import { randomBytes, randomUUID } from 'crypto';

/** RFC 4122 v4 UUID. */
export function uuid(): string {
  return randomUUID();
}

/**
 * A `requestId` in the shape the Cloud Code endpoints expect from the official
 * client: `agent/<epoch-millis>/<8 hex chars>`. A bare UUID is accepted but
 * marks the caller as something other than Antigravity, and the endpoints treat
 * unrecognised clients far more harshly.
 */
export function officialRequestId(): string {
  return `agent/${Date.now()}/${randomBytes(4).toString('hex')}`;
}

/**
 * The `sessionId` the official client derives from the signed-in account: an
 * FNV-1a hash over the id, seeded so the result is the large negative integer
 * the endpoints see from a real session. Stable per account, which is the point
 * — it is what ties a conversation's turns together upstream.
 */
export function sessionIdFor(accountId: string): string {
  const PRIME = 1099511628211n;
  const MASK = (1n << 64n) - 1n;
  // The official offset basis, as an unsigned 64-bit value.
  let hash = BigInt.asUintN(64, -3750763034362895579n);

  for (const byte of Buffer.from(accountId, 'utf-8')) {
    hash = (hash * PRIME) & MASK;
    hash ^= BigInt(byte);
  }

  return BigInt.asIntN(64, hash).toString();
}

/** URL-safe random token, used for the local gateway's bearer key. */
export function randomToken(byteLength = 24): string {
  return randomBytes(byteLength).toString('hex');
}

/** Short random id with a readable prefix (message ids, tool call ids). */
export function prefixedId(prefix: string, byteLength = 12): string {
  return `${prefix}_${randomBytes(byteLength).toString('hex')}`;
}
