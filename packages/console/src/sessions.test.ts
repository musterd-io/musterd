import { describe, expect, it } from 'vitest';
import { appendAudit } from './audit.js';
import { csrfTokenFor, csrfTokenValid } from './csrf.js';
import { hit } from './ratelimit.js';
import { migrate } from './schema.js';
import { hashSecret } from './secrets.js';
import {
  ABSOLUTE_MS,
  createSession,
  FRESH_MS,
  IDLE_MS,
  isFresh,
  loadSession,
  revokeAllSessions,
  revokeSession,
  TOUCH_EVERY_MS,
} from './sessions.js';
import { pglite } from './testing.js';

const T0 = 1_800_000_000_000;

async function store() {
  const { db, q } = await pglite();
  await db.exec('CREATE ROLE console_app NOLOGIN');
  await migrate(q, 'console_app');
  await q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acc_1', T0]);
  return { db, q };
}
const github = {
  accountId: 'acc_1',
  method: 'github',
  identityProvider: 'github',
  identitySubject: '42',
} as const;

describe('console sessions (ADR 620 decision 7)', () => {
  it('a new session is live, and only its hash is stored', async () => {
    const { q } = await store();
    const sid = await createSession(q, github, T0);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const s = await loadSession(q, sid, T0 + 1000);
    expect(s?.accountId).toBe('acc_1');
    const stored = await q.query<{ id_hash: string }>('SELECT id_hash FROM sessions', []);
    expect(stored.rows[0]?.id_hash).toBe(hashSecret(sid));
    expect(JSON.stringify(stored.rows)).not.toContain(sid);
  });

  it('every sign-in issues a new id — never adopts one (fixation)', async () => {
    const { q } = await store();
    const a = await createSession(q, github, T0);
    const b = await createSession(q, github, T0);
    expect(a).not.toBe(b);
    expect(await loadSession(q, 'x'.repeat(43), T0)).toBeNull();
    expect(await loadSession(q, 'short', T0)).toBeNull();
    expect(await loadSession(q, undefined, T0)).toBeNull();
  });

  it('dies after 14 days idle; activity extends it, but never past 30 days absolute', async () => {
    const { q } = await store();
    const sid = await createSession(q, github, T0);
    expect(await loadSession(q, sid, T0 + IDLE_MS + 1)).toBeNull();

    const sid2 = await createSession(q, github, T0);
    let t = T0;
    while (t + IDLE_MS / 2 < T0 + ABSOLUTE_MS) {
      t += IDLE_MS / 2;
      expect(await loadSession(q, sid2, t), `day ${(t - T0) / 86_400_000}`).not.toBeNull();
    }
    expect(await loadSession(q, sid2, T0 + ABSOLUTE_MS + 1)).toBeNull();
  });

  it('touches last-activity at most once a minute', async () => {
    const { q } = await store();
    const sid = await createSession(q, github, T0);
    await loadSession(q, sid, T0 + 10_000);
    const r1 = await q.query<{ l: string }>('SELECT last_activity_at AS l FROM sessions', []);
    expect(Number(r1.rows[0]?.l)).toBe(T0);
    await loadSession(q, sid, T0 + TOUCH_EVERY_MS);
    const r2 = await q.query<{ l: string }>('SELECT last_activity_at AS l FROM sessions', []);
    expect(Number(r2.rows[0]?.l)).toBe(T0 + TOUCH_EVERY_MS);
  });

  it('revoke kills one; revoke-all kills every one; a disabled account has none', async () => {
    const { q } = await store();
    const a = await createSession(q, github, T0);
    const b = await createSession(q, github, T0);
    await revokeSession(q, hashSecret(a), 'logout', T0);
    expect(await loadSession(q, a, T0)).toBeNull();
    expect(await loadSession(q, b, T0)).not.toBeNull();

    await revokeAllSessions(q, 'acc_1');
    expect(await loadSession(q, b, T0)).toBeNull();
    const c = await createSession(q, github, T0);
    expect(await loadSession(q, c, T0)).not.toBeNull();

    await q.query('UPDATE accounts SET disabled_at = $1 WHERE id = $2', [T0, 'acc_1']);
    expect(await loadSession(q, c, T0)).toBeNull();
    await expect(createSession(q, github, T0)).rejects.toThrow(/disabled/);
  });

  it('is fresh for 15 minutes after sign-in, then not', async () => {
    const { q } = await store();
    const sid = await createSession(q, github, T0);
    const s = (await loadSession(q, sid, T0))!;
    expect(isFresh(s, T0 + FRESH_MS)).toBe(true);
    expect(isFresh(s, T0 + FRESH_MS + 1)).toBe(false);
  });
});

describe('CSRF token (ADR 620 decision 8)', () => {
  it('is bound to the session id and checked in constant time', () => {
    const t = csrfTokenFor('session-a');
    expect(csrfTokenValid('session-a', t)).toBe(true);
    expect(csrfTokenValid('session-b', t)).toBe(false);
    expect(csrfTokenValid('session-a', undefined)).toBe(false);
    expect(csrfTokenValid('session-a', t.slice(0, -1))).toBe(false);
  });
});

describe('rate limits (ADR 620 decision 9)', () => {
  it('counts per bucket per window, across calls, and resets with the window', async () => {
    const { q } = await store();
    const lim = { bucket: 'ip:203.0.113.9', max: 3, windowMs: 60_000 };
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await hit(q, lim, T0));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await hit(q, { ...lim, bucket: 'email:other' }, T0)).toBe(true);
    expect(await hit(q, lim, T0 + 60_000)).toBe(true);
  });
});

describe('audit (ADR 620 decision 10)', () => {
  it('drops secret-named fields and scrubs strings before the insert', async () => {
    const { q } = await store();
    await appendAudit(
      q,
      {
        action: 'signin.result',
        requestId: 'rid-12345678',
        actorAccountId: 'acc_1',
        detail: {
          provider: 'github',
          code: 'oauth-code-abc',
          verifier: 'pkce-verifier',
          note: 'used mscr_abcdefghijklmnopqrstuvwxyz0123',
        },
      },
      T0,
    );
    const r = await q.query<{ detail: string }>('SELECT detail FROM audit', []);
    const d = r.rows[0]!.detail;
    expect(d).toContain('github');
    expect(d).not.toContain('oauth-code-abc');
    expect(d).not.toContain('mscr_');
  });
});
