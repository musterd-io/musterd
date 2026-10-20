import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { Driver } from '../db/driver.js';

/**
 * Console → team server trust (spec §4.3). Every admin operation on a Cloud team server carries a
 * console-signed token: ES256 compact JWS, `aud` = this team server, at most 60 s of life, and a
 * `jti` that redeems exactly once — in the database, so two servers cannot both accept it.
 * Verified with `node:crypto` against the console's JWKS (no JOSE dependency, hard rule 6).
 *
 * The token proves the console authenticated a person (`sub` = their account id). It does not by
 * itself authorize import, export, or delete. Those routes (lanes `01M3Z42W1J` and `01M3Z42YFH`)
 * also check that this account is bound to an owner of that team.
 */

export type ConsoleTokenRefusal =
  | 'malformed'
  | 'bad_alg'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'lifetime'
  | 'wrong_audience'
  | 'replayed';

/** The stable sentence (spec §5.5) when the console's keys cannot be fetched. */
export const CONSOLE_UNREACHABLE_SENTENCE = 'console unreachable';

export class ConsoleTokenError extends Error {
  constructor(
    readonly reason: ConsoleTokenRefusal | 'console_unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'ConsoleTokenError';
  }
}

export interface ConsoleClaims {
  sub: string;
  aud: string;
  jti: string;
  exp: number;
}

/** The longest a console token may live (§4.3), and the clock skew tolerated either side. */
export const MAX_LIFETIME_S = 60;
export const SKEW_S = 5;
/** An unknown `kid` refetches the JWKS at most this often — a rotated key lands within it. */
export const JWKS_REFETCH_MS = 30_000;
/** A cached key set is trusted this long; past it, the set is refetched before any key is used —
 *  so a key the console revokes stops working everywhere within this bound (review I4). */
export const JWKS_MAX_AGE_MS = 10 * 60_000;

const refuse = (reason: ConsoleTokenRefusal, detail: string) =>
  new ConsoleTokenError(reason, `console token refused (${reason}): ${detail}`);

const Jwks = z.object({
  keys: z.array(z.object({ kid: z.string(), kty: z.string() }).passthrough()),
});

/**
 * The console's published keys, cached by `kid`, with three rules (spec §4.3; review I4/M5):
 * - **A set is trusted for {@link JWKS_MAX_AGE_MS}.** Past that it is refetched before any key is
 *   used, and if the refetch fails the verification fails CLOSED (`console_unreachable`) — so a key
 *   the console revokes stops working on every server within the max age, never "until restart".
 * - **An unknown `kid` refetches at most every {@link JWKS_REFETCH_MS}**, so a rotation lands and a
 *   flood of made-up kids cannot become a flood of fetches.
 * - **One fetch at a time** (concurrent misses share it), and a failed fetch backs off for the same
 *   {@link JWKS_REFETCH_MS} instead of being retried by every request during a console outage.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  /** Last SUCCESSFUL fetch — what the max age is measured from. */
  private fetchedAt: number | null = null;
  /** Last attempt, success or not — what the refetch interval and the failure backoff use. */
  private attemptedAt: number | null = null;
  private lastFailure: ConsoleTokenError | null = null;
  private inflight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(
    private readonly url: string,
    opts: { now?: () => number; timeoutMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  async key(kid: string): Promise<KeyObject> {
    const now = this.now();
    const fresh = this.fetchedAt !== null && now - this.fetchedAt < JWKS_MAX_AGE_MS;
    const recentlyTried = this.attemptedAt !== null && now - this.attemptedAt < JWKS_REFETCH_MS;
    if (fresh) {
      const have = this.keys.get(kid);
      if (have) return have;
      if (!recentlyTried) await this.refresh();
    } else if (recentlyTried && this.lastFailure) {
      throw this.lastFailure; // backing off a failed fetch; a stale set is not used meanwhile
    } else {
      await this.refresh(); // never fetched, or past its max age: fetch before trusting any key
    }
    const got = this.keys.get(kid);
    if (got) return got;
    throw refuse('unknown_key', 'the console has not published this key');
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.fetchKeys().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchKeys(): Promise<void> {
    this.attemptedAt = this.now();
    let body: unknown;
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.json();
    } catch (e) {
      throw this.failed(`${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = Jwks.safeParse(body);
    if (!parsed.success) throw this.failed('JWKS is malformed');
    const next = new Map<string, KeyObject>();
    for (const jwk of parsed.data.keys) {
      // ES256 only: an EC P-256 key. Anything else in the set is not a key this server will use.
      if (jwk.kty !== 'EC' || (jwk as { crv?: unknown }).crv !== 'P-256') continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
      } catch {
        // an unusable entry is skipped, not fatal: the rest of the set may still verify
      }
    }
    this.keys = next;
    this.fetchedAt = this.now();
    this.lastFailure = null;
  }

  private failed(detail: string): ConsoleTokenError {
    this.lastFailure = new ConsoleTokenError(
      'console_unreachable',
      `${CONSOLE_UNREACHABLE_SENTENCE}: ${detail}`,
    );
    return this.lastFailure;
  }
}

// One cache per JWKS URL for the process: every request to this server shares the fetched keys.
const caches = new Map<string, JwksCache>();
export function jwksFor(url: string): JwksCache {
  let c = caches.get(url);
  if (!c) caches.set(url, (c = new JwksCache(url)));
  return c;
}

const Header = z.object({ alg: z.string(), kid: z.string().min(1) });
const Claims = z.object({
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  jti: z.string().min(1),
  exp: z.number().int(),
});

function segment(s: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw refuse('malformed', 'not base64url');
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw refuse('malformed', 'segment is not JSON');
  }
}

/**
 * Verify a console token for this team server. The order is deliberate: shape, then `alg` (before
 * any key is touched — no `none`, no HS256 keyed with the public key), then the signature, and only
 * then the claims, so nothing unsigned is ever believed. Does NOT redeem the `jti`; the caller does
 * that with {@link redeemJti} once it is about to act.
 */
export async function verifyConsoleToken(
  token: string,
  opts: { jwks: JwksCache; audience: string; nowMs?: number },
): Promise<ConsoleClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw refuse('malformed', 'not a compact JWS');
  const [h, p, s] = parts as [string, string, string];
  const header = Header.safeParse(segment(h));
  if (!header.success) throw refuse('malformed', 'header lacks alg/kid');
  if (header.data.alg !== 'ES256') throw refuse('bad_alg', 'only ES256 is accepted');
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw refuse('malformed', 'signature is not base64url');
  const key = await opts.jwks.key(header.data.kid);
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw refuse('bad_signature', 'signature does not verify');
  const claims = Claims.safeParse(segment(p));
  if (!claims.success) throw refuse('malformed', 'claims lack sub/aud/jti/exp');
  const c = claims.data;
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(opts.audience)) throw refuse('wrong_audience', 'not minted for this server');
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (c.exp < nowS - SKEW_S) throw refuse('expired', 'past its exp');
  if (c.exp > nowS + MAX_LIFETIME_S + SKEW_S)
    throw refuse('lifetime', `lives longer than ${MAX_LIFETIME_S} s`);
  return { sub: c.sub, aud: opts.audience, jti: c.jti, exp: c.exp };
}

/** Rows stay this long past their token's `exp` — far beyond any clock skew between servers. */
export const JTI_RETENTION_S = 3_600;

/**
 * Single use, enforced where every server sees it (§4.3): one insert into `console_token_jti`. A
 * duplicate key is a replay, whichever server saw the token first. Expiry is checked HERE too, not
 * only in {@link verifyConsoleToken}: verification runs when a request arrives, redemption after its
 * body is read, and a slow body can reach this line long after `exp` (review I1). Rows are pruned on
 * the way in (console tokens are rare: admin calls), but only an hour past their token's `exp` —
 * a row must outlive every moment its token could still be presented on any server, or the prune
 * itself would reopen the token. `db` is the operator handle; the table is global.
 */
export async function redeemJti(
  db: Driver,
  jti: string,
  expS: number,
  nowMs = Date.now(),
): Promise<void> {
  const nowS = Math.floor(nowMs / 1000);
  if (expS < nowS - SKEW_S) throw refuse('expired', 'past its exp at redemption');
  await db.run('DELETE FROM console_token_jti WHERE exp < ?', [nowS - JTI_RETENTION_S]);
  const r = await db.run(
    'INSERT INTO console_token_jti (jti, exp) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING',
    [jti, expS],
  );
  if (r.changes === 0) throw refuse('replayed', 'this token was already used');
}
