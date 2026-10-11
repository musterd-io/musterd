import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusterdClient } from './client.js';
import type { IdleWake } from './idleWake/decider.js';
import { SessionAttestation } from './sessionLiveness.js';

/**
 * Lane 01M2KCG5Z8 — the WIRING half. `shouldReleaseOnVerdict` is unit-tested in
 * sessionLiveness.test.ts; this file exists because the defect could survive a perfect pure
 * function. `attestSession` is the only caller, and if it does not hand the verdict's transcript
 * age down, the new clause is dead code and the seat is still released on every heartbeat.
 *
 * The scenario is the measured one, on seat `izzo` 2026-09-15: the binding names a session whose
 * transcript has been quiet for hours, the harness is driving this adapter from a different session,
 * and nothing rewrote `binding.session` — so the adopted id never changes and no re-adoption guard
 * fires.
 */
let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const DEAD_SESSION = {
  harness: 'claude-code',
  id: 'sess-that-died',
  transcript_path: '/t/dead.jsonl',
  started_at: 1,
};

function adapterJudging() {
  dir = mkdtempSync(join(tmpdir(), 'musterd-attest-'));
  mkdirSync(join(dir, '.musterd'));
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      agent_key: 'mskey_team',
      claim: { mode: 'seat', name: 'Ada' },
      session: DEAD_SESSION,
    }),
  );
  const client = new MusterdClient({
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'musterd',
    provenance: 'session',
    workspace: 'agents@main',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: dir,
  } as never);
  // The transcript's age is a knob, because the defect needs BOTH phases and my first attempt at
  // this harness only had the second: the ladder refuses to adopt a capture that is already a
  // corpse, so a binding born stale is never judged at all and the test passed for the wrong
  // reason. The real session was adopted while alive at 17:13Z and only crossed the staleness
  // horizon at 20:06Z, three hours later — that is the shape reproduced here.
  // Phase 2 pins the mtime once rather than recomputing it from Date.now() on every stat: the
  // ladder captures its own `now` before it stats, so a recomputed mtime that lands a millisecond
  // later reported age_ms 7199997 against the 2h bound (CI run 37411265975).
  let silentSince: number | undefined;
  // Injected rather than left to the real world: the ladder adopts nothing for the first
  // ADOPT_SETTLE_MS of PROCESS life, and a test runner's uptime is not something to gamble a
  // regression test on. processStart 0 means settled; the stat is controlled.
  (client as unknown as { session: SessionAttestation }).session = new SessionAttestation({
    bindingDir: dir,
    readSession: () => DEAD_SESSION,
    statMtime: () => silentSince ?? Date.now(),
    ppid: () => 4242,
    processStart: 0,
  });
  // `attestSession` is private and deliberately so; this is the one place that needs it, and going
  // through the 15s heartbeat instead would buy nothing but a slow test.
  const attest = () => (client as unknown as { attestSession: () => boolean }).attestSession();
  // Phase 1: the session is alive and writing, so the adapter adopts it — as it legitimately did.
  expect(attest(), 'a live session must be adopted, not released').toBe(false);
  return {
    client,
    attest,
    /** Phase 2: the harness moved on, nothing rewrote `binding.session`, and the adopted
     *  transcript falls silent past the one-hour horizon. */
    transcriptFallsSilent: () => {
      silentSince = Date.now() - 2 * 60 * 60_000;
    },
  };
}

describe('attestSession hands the transcript age down (lane 01M2KCG5Z8)', () => {
  it('keeps the seat when this adapter was driven after its adopted transcript went quiet', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    transcriptFallsSilent();
    // The harness called a tool three minutes ago — far outside the 15s activity window that used
    // to be the only guard, and unambiguously after a transcript silent for two hours. Both cannot
    // be the same session, so the stale rung is evidence about somebody else.
    client.noteActivity(Date.now() - 180_000);
    expect(attest(), 'a transcript we are newer than is not ours — fail open').toBe(false);
    expect(client.releasedByLiveness).toBe(false);
    client.close();
  });

  it('still releases the seat for a genuinely dormant harness', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    transcriptFallsSilent();
    // Nothing has driven this adapter since, so there is no contradiction to fail open on and the
    // ADR 164 crash backstop must still fire.
    expect(attest(), 'no first-hand evidence — the backstop stands').toBe(true);
    expect(client.releasedByLiveness).toBe(true);
    client.close();
  });
});

describe('an armed idle-wake core keeps presence past the stale rung (ADR 558 §5)', () => {
  it('a session that can be pushed while idle is not released for a quiet transcript', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    client.attachIdleWake({ armed: () => true } as unknown as IdleWake);
    transcriptFallsSilent();
    expect(attest(), 'idle at the prompt and reachable — keep the seat').toBe(false);
    expect(client.releasedByLiveness).toBe(false);
    client.close();
  });

  it('a deaf core changes nothing: the backstop still fires', () => {
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    client.attachIdleWake({ armed: () => false } as unknown as IdleWake);
    transcriptFallsSilent();
    expect(attest()).toBe(true);
    client.close();
  });
});

/**
 * ADR 164 increment 2 (lane 01M3TAKNCF): the one client→server path the ADR said did not exist. A
 * release on rungs 2–4 tells the daemon the rung, so `presence.session_ended` can be counted by it.
 */
describe('a ladder release reports its rung to the daemon (ADR 164 increment 2)', () => {
  it('POSTs a rung-bearing end before releasing, and never for a kept seat', async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, enrolled: true }), { status: 200 });
    });
    const { client, attest, transcriptFallsSilent } = adapterJudging();
    transcriptFallsSilent();
    client.noteActivity(Date.now() - 180_000);
    expect(attest()).toBe(false);
    expect(posts).toHaveLength(0);

    client.noteActivity(Date.now() - 3 * 60 * 60_000);
    expect(attest()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('http://127.0.0.1:1/teams/dawn/residency/session');
    expect(posts[0]!.body).toMatchObject({
      seat: 'Ada',
      harness: 'claude-code',
      event: 'end',
      rung: 'stale',
    });
    expect(posts[0]!.body['age_ms']).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(posts[0]!.body).not.toHaveProperty('session_id');
    client.close();
  });
});
