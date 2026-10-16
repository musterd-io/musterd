import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A high-entropy URL-safe secret (256 bits) for a session id, transaction cookie or link token. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores for a secret (ADR 620): SHA-256, hex. The secret itself is never kept. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time string comparison for two values of a secret's shape. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
