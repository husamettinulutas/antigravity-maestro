import { randomBytes, randomUUID } from 'crypto';

/** RFC 4122 v4 UUID — used for upstream `requestId` fields. */
export function uuid(): string {
  return randomUUID();
}

/** URL-safe random token, used for the local gateway's bearer key. */
export function randomToken(byteLength = 24): string {
  return randomBytes(byteLength).toString('hex');
}

/** Short random id with a readable prefix (message ids, tool call ids). */
export function prefixedId(prefix: string, byteLength = 12): string {
  return `${prefix}_${randomBytes(byteLength).toString('hex')}`;
}
