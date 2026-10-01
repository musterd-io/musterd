import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import {
  ConsoleTokenError,
  JTI_RETENTION_S,
  JWKS_MAX_AGE_MS,
  JWKS_REFETCH_MS,
  JwksCache,
  redeemJti,
  verifyConsoleToken,
} from './consoleToken.js';
import { testIssuer, type TestIssuer } from './testIssuer.js';

const AUD = 'https://cloud.test';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** What a refusal says, so each case asserts the REASON, not merely that something threw. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    if (e instanceof ConsoleTokenError) return e.reason;
    throw e;
  }
}

describe('verifyConsoleToken (1C task 5, spec §4.3)', () => {
  let issuer: TestIssuer;
  let jwks: JwksCache;
  let now: number;
  beforeEach(async () => {
    issuer = testIssuer();
    await issuer.serve();
    now = Date.now();
    jwks = new JwksCache(issuer.url, { now: () => now });
  });
  afterEach(async () => issuer.close());
  const verify = (t: string) => verifyConsoleToken(t, { jwks, audience: AUD, nowMs: now });

  it('accepts a fresh ES256 token for this audience and returns its claims', async () => {
    const claims = await verify(issuer.token(AUD, { sub: 'acct_1' }));
    expect(claims.sub).toBe('acct_1');
    expect(claims.aud).toBe(AUD);
    expect(typeof claims.jti).toBe('string');
  });

  it('refuses an expired token (5 s skew allowed, not more)', async () => {
    const s = Math.floor(now / 1000);
    expect(await refusal(verify(issuer.token(AUD, { exp: s - 4 })))).toBe('accepted');
    expect(await refusal(verify(issuer.token(AUD, { exp: s - 6 })))).toBe('expired');
  });

  it('refuses a token living longer than 60 s', async () => {
    const s = Math.floor(now / 1000);
    expect(await refusal(verify(issuer.token(AUD, { exp: s + 3600 })))).toBe('lifetime');
  });

  it('refuses another audience', async () => {
    expect(await refusal(verify(issuer.token('https/other.test')))).toBe('wrong_audience');
  });

  it('refuses a token without a jti or a sub', async () => {
    expect(await refusal(verify(issuer.token(AUD, { jti: '' })))).toBe('malformed');
    expect(await refusal(verify(issuer.token(AUD, { sub: undefined })))).toBe('malformed');
  });

  it('refuses a tampered payload (bad signature)', async () => {
    const [h, , sig] = issuer.token(AUD).split('.');
    const forged = b64({
      sub: 'acct_evil',
      aud: AUD,
      jti: 'x',
      exp: Math.floor(now / 1000) + 30,
    });
    expect(await refusal(verify(`${h}.${forged}.${sig}`))).toBe('bad_signature');
  });

  it('refuses a signature from a key the console never published', async () => {
    const stranger = testIssuer({ kid: issuer.kid });
    expect(await refusal(verify(stranger.token(AUD)))).toBe('bad_signature');
  });

  it('refuses alg confusion: none, and HS256 keyed with the public JWK', async () => {
    const claims = { sub: 'a', aud: AUD, jti: 'j', exp: Math.floor(now / 1000) + 30 };
    const none = `${b64({ alg: 'none', kid: issuer.kid })}.${b64(claims)}.`;
    expect(await refusal(verify(none))).toBe('bad_alg');
    const head = b64({ alg: 'HS256', kid: issuer.kid });
    const body = b64(claims);
    const mac = createHmac('sha256', JSON.stringify(issuer.jwks().keys[0]))
      .update(`${head}.${body}`)
      .digest('base64url');
    expect(await refusal(verify(`${head}.${body}.${mac}`))).toBe('bad_alg');
  });

  it('refuses malformed compact serialisations', async () => {
    for (const t of ['', 'a.b', 'a.b.c.d', '!!.??.**', `${b64('x')}.${b64('y')}.zz`])
      expect(await refusal(verify(t)), t).toBe('malformed');
  });

  it('a rotated key is fetched once on an unknown kid; a bogus kid does not refetch again within 30 s', async () => {
    await verify(issuer.token(AUD));
    expect(issuer.fetches).toBe(1);
    issuer.rotate();
    now += 31_000;
    expect(await refusal(verify(issuer.token(AUD)))).toBe('accepted');
    expect(issuer.fetches).toBe(2);
    const bogus = testIssuer({ kid: 'nobody' });
    expect(await refusal(verify(bogus.token(AUD)))).toBe('unknown_key');
    expect(issuer.fetches).toBe(2);
  });

  it('a key the console stopped publishing stops working within the max age (review I4)', async () => {
    const later = now + JWKS_MAX_AGE_MS + 1_000;
    // Signed with the soon-revoked key, valid at `later` — what an attacker holding it would send.
    const revokedKeyToken = issuer.token(AUD, { exp: Math.floor(later / 1000) + 30 });
    await verify(issuer.token(AUD)); // the cache holds the key
    issuer.rotate(); // the console revokes it: the JWKS now publishes only a new key
    now = later;
    expect(await refusal(verify(revokedKeyToken))).toBe('unknown_key');
    expect(issuer.fetches).toBe(2);
  });

  it('a stale cache with the console unreachable fails closed, not open', async () => {
    const later = now + JWKS_MAX_AGE_MS + 1_000;
    const token = issuer.token(AUD, { exp: Math.floor(later / 1000) + 30 });
    await verify(issuer.token(AUD));
    issuer.setDown(true);
    now = later;
    expect(await refusal(verify(token))).toBe('console_unreachable');
  });

  it('concurrent misses share one fetch (single flight)', async () => {
    const tokens = Array.from({ length: 5 }, () => issuer.token(AUD));
    const got = await Promise.all(tokens.map((t) => refusal(verify(t))));
    expect(got).toEqual(Array(5).fill('accepted'));
    expect(issuer.fetches).toBe(1);
  });

  it('a failed fetch backs off: no refetch for JWKS_REFETCH_MS (review M5)', async () => {
    issuer.setDown(true);
    expect(await refusal(verify(issuer.token(AUD)))).toBe('console_unreachable');
    now += 1_000;
    expect(await refusal(verify(issuer.token(AUD)))).toBe('console_unreachable');
    expect(issuer.fetches).toBe(1);
    issuer.setDown(false);
    now += JWKS_REFETCH_MS;
    expect(await refusal(verify(issuer.token(AUD)))).toBe('accepted');
    expect(issuer.fetches).toBe(2);
  });

  it('an unreachable JWKS is console_unreachable, not a refusal of the token', async () => {
    const dead = new JwksCache('http://127.0.0.1:9/jwks', { now: () => now, timeoutMs: 500 });
    expect(
      await refusal(
        verifyConsoleToken(issuer.token(AUD), { jwks: dead, audience: AUD, nowMs: now }),
      ),
    ).toBe('console_unreachable');
  });
});

withDrivers('redeemJti — single use is enforced in the database (spec §4.3)', (open) => {
  it('the first redemption wins; the second is a replay', async () => {
    const db = await open();
    const exp = Math.floor(Date.now() / 1000) + 60;
    await redeemJti(db, 'jti-1', exp);
    expect(await refusal(redeemJti(db, 'jti-1', exp))).toBe('replayed');
  });

  it('a redemption prunes rows an hour past their exp, and keeps every younger one', async () => {
    const db = await open();
    const nowS = Math.floor(Date.now() / 1000);
    await db.run('INSERT INTO console_token_jti (jti, exp) VALUES (?, ?), (?, ?)', [
      'ancient',
      nowS - JTI_RETENTION_S - 1,
      'recent',
      nowS - 120,
    ]);
    await redeemJti(db, 'fresh', nowS + 60);
    const rows = await db.all<{ jti: string }>('SELECT jti FROM console_token_jti ORDER BY jti');
    expect(rows.map((r) => r.jti)).toEqual(['fresh', 'recent']);
  });
});

/**
 * Review I1: verification happens when the request ARRIVES, redemption after its body is read — a
 * slow body (Node's request timeout is minutes) reaches redemption long after `exp`. Redemption
 * must refuse an expired token itself, and the prune that keeps the table small must never remove
 * a row while its token could still be presented anywhere.
 */
withDrivers(
  'redeemJti — expiry is enforced at redemption, not only at verification (review I1)',
  (open) => {
    const E = Math.floor(Date.now() / 1000) + 60;

    it('a token presented past exp + skew is refused as expired, even if never redeemed', async () => {
      const db = await open();
      expect(await refusal(redeemJti(db, 'late', E, (E + 6) * 1000))).toBe('expired');
    });

    it('once T is redeemed, a prune by a later redemption cannot open T to a second use', async () => {
      const db = await open();
      await redeemJti(db, 'T', E, (E - 10) * 1000);
      // Another console call, just past T's exp + skew: under the old margin this pruned T's row.
      await redeemJti(db, 'later', E + 100, (E + 6) * 1000);
      expect(await refusal(redeemJti(db, 'T', E, (E + 6) * 1000))).not.toBe('accepted');
      const rows = await db.all<{ jti: string }>('SELECT jti FROM console_token_jti ORDER BY jti');
      expect(rows.map((r) => r.jti)).toEqual(['T', 'later']);
    });
  },
);
