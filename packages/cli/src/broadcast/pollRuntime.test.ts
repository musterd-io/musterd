import { describe, expect, it } from 'vitest';
import { startPollRuntime } from './pollRuntime.js';

const POLL = {
  id: '01M6POLL0000000000000000AA',
  question: 'What next?',
  options: ['Camera', 'Ask the team'],
  minutes: 5,
  opened_by: 'nick',
  opened_at: 1_000,
  closes_at: 301_000,
  counts: [0, 0],
  voters: 0,
  post_failed: false,
};

function rig(t0 = 2_000) {
  let t = t0;
  let reply: unknown = { live: true, poll: null };
  let tokens = 0;
  const calls: { path: string; auth: string; body?: unknown }[] = [];
  const posted: string[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('http://hub/teams/revive', '');
    const auth = String((init?.headers as Record<string, string>)['authorization']);
    calls.push({ path, auth, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/polls/open') {
      const r = reply as { poll: { poll_token?: string } | null };
      return Response.json(
        r.poll ? { ...r, poll: { ...r.poll, poll_token: `mspoll_${++tokens}` } } : r,
      );
    }
    if (path.endsWith('/counts')) return new Response(null, { status: 202 });
    return new Response(null, { status: 202 });
  };
  const rt = startPollRuntime({
    server: 'http://hub',
    team: 'revive',
    seatToken: 'mscr_seat',
    chat: () => ({ post: async (l) => (posted.push(l), true), live: async () => true }),
    log: () => {},
    fetch: fetchFn as unknown as typeof fetch,
    now: () => t,
    tickMs: 1_000_000,
  });
  return {
    rt,
    calls,
    posted,
    set: (r: unknown) => (reply = r),
    advance: (ms: number) => (t += ms),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('startPollRuntime (ADR 807)', () => {
  it('reports live on the seat, announces a fresh poll, counts votes on the poll token, and posts the result once', async () => {
    const r = rig();
    r.set({ live: true, poll: POLL });
    await r.rt.tick();
    await settle();
    expect(r.calls.find((c) => c.path === '/stream/live')).toMatchObject({
      auth: 'Bearer mscr_seat',
      body: { live: true },
    });
    expect(r.posted[0]).toContain('nick wants to ask you: What next?');
    r.rt.onChat('U1', '!vote 2');
    r.advance(5_000);
    await r.rt.tick();
    const counts = r.calls.filter((c) => c.path.endsWith('/counts'));
    expect(counts.at(-1)).toMatchObject({
      auth: 'Bearer mspoll_2',
      body: { counts: [0, 1], voters: 1 },
    });
    // The seat token never rides a counts report, and the poll token never rides a seat call.
    expect(counts.every((c) => c.auth.startsWith('Bearer mspoll_'))).toBe(true);
    expect(
      r.calls
        .filter((c) => !c.path.endsWith('/counts'))
        .every((c) => c.auth === 'Bearer mscr_seat'),
    ).toBe(true);
    r.set({
      live: true,
      poll: null,
      last: {
        id: POLL.id,
        question: POLL.question,
        options: POLL.options,
        opened_by: POLL.opened_by,
        opened_at: POLL.opened_at,
        closes_at: POLL.closes_at,
        state: 'closed',
        counts: [0, 1],
        voters: 1,
        end: 'deadline',
        winners: [1],
        closed_at: 300_000,
      },
    });
    await r.rt.tick();
    await r.rt.tick();
    await settle();
    expect(r.posted.filter((l) => l.startsWith('🗳️'))).toEqual([
      '🗳️ Poll closed — 1 vote. Winner: 2 · Ask the team (100%). Thanks for voting!',
    ]);
    r.rt.stop();
  });

  it('joins a poll it finds already running without announcing it again', async () => {
    const r = rig(1_000 + 120_000);
    r.set({ live: true, poll: { ...POLL, counts: [3, 1], voters: 4 } });
    await r.rt.tick();
    await settle();
    expect(r.posted).toEqual([]);
    expect(r.calls.find((c) => c.path.endsWith('/counts'))?.body).toMatchObject({
      counts: [3, 1],
      voters: 4,
    });
    r.rt.stop();
  });
});
