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

function rig(t0 = 2_000, ready = true) {
  let t = t0;
  let chatReady = ready;
  let liveAnswer: boolean | null = true;
  let reply: unknown = { live: true, poll: null };
  let tokens = 0;
  const calls: { path: string; auth: string; body?: unknown }[] = [];
  const posted: string[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('http://hub/teams/revive', '');
    const auth = String((init?.headers as Record<string, string>)['authorization']);
    calls.push({ path, auth, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/polls/open?token=1') {
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
    chat: () =>
      chatReady
        ? { post: async (l) => (posted.push(l), true), live: async () => liveAnswer }
        : null,
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
    ready: () => (chatReady = true),
    liveAnswer: (a: boolean | null) => (liveAnswer = a),
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
    expect(r.posted[0]).toContain('nick asks: What next?');
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
    expect(r.posted.filter((l) => l.includes('Poll closed'))).toEqual([
      '🗳️ Poll closed — 1 vote. Winner: Option 2 - Ask the team (100%). Thanks for voting!',
    ]);
    r.rt.stop();
  });

  it('waits for the chat reader: no poll read, count or live report until chat is ready, then announces', async () => {
    const r = rig(2_000, false);
    r.set({ live: true, poll: POLL });
    await r.rt.tick();
    await r.rt.tick();
    await settle();
    // Nothing reaches the daemon on a guess: no live=false, no counts, not even the open-poll read.
    expect(r.calls).toEqual([]);
    expect(r.posted).toEqual([]);
    r.ready();
    r.advance(5_000);
    await r.rt.tick();
    await settle();
    expect(r.calls.map((c) => c.path)).toEqual([
      '/stream/live',
      '/polls/open?token=1',
      `/polls/${POLL.id}/counts`,
    ]);
    expect(r.calls[0]!.body).toEqual({ live: true });
    expect(r.calls[2]!.body).toMatchObject({ live: true, post_failed: false });
    expect(r.posted[0]).toContain('nick asks: What next?');
    r.rt.stop();
  });

  it('treats an unanswered Twitch check as unknown, not offline, and recovers on the next answer', async () => {
    const r = rig();
    r.set({ live: true, poll: POLL });
    r.liveAnswer(null);
    await r.rt.tick();
    r.advance(5_000);
    await r.rt.tick();
    await settle();
    // No live=false, no counts, no poll read, nothing posted while Twitch has not answered.
    expect(r.calls).toEqual([]);
    expect(r.posted).toEqual([]);
    r.liveAnswer(true);
    r.advance(5_000);
    await r.rt.tick();
    await settle();
    expect(r.calls.map((c) => c.path)).toEqual([
      '/stream/live',
      '/polls/open?token=1',
      `/polls/${POLL.id}/counts`,
    ]);
    expect(r.calls[0]!.body).toEqual({ live: true });
    expect(r.calls[2]!.body).toMatchObject({ live: true });
    expect(r.posted[0]).toContain('nick asks: What next?');
    r.rt.stop();
  });

  it('stops refreshing liveness once the last answered check is past the grace, keeps the votes, and resumes on an answer', async () => {
    const r = rig();
    r.set({ live: true, poll: POLL });
    await r.rt.tick(); // answered live at t=2_000
    await settle();
    r.liveAnswer(null);
    r.rt.onChat('U1', '!vote 1');
    const countsCalls = () => r.calls.filter((c) => c.path.endsWith('/counts'));
    // Inside the 90 s grace the last answer still stands.
    r.advance(60_000);
    await r.rt.tick();
    expect(countsCalls()).toHaveLength(2);
    // Past it: no counts and no live report, so the hub sees silence.
    r.advance(31_000);
    const before = r.calls.length;
    await r.rt.tick();
    r.advance(30_000);
    await r.rt.tick();
    expect(r.calls.slice(before).map((c) => c.path)).toEqual([
      '/polls/open?token=1',
      '/polls/open?token=1',
    ]);
    // A vote cast while silent is kept, and goes up with the first answered check.
    r.rt.onChat('U2', '!vote 2');
    r.liveAnswer(true);
    r.advance(30_000);
    await r.rt.tick();
    expect(r.calls.filter((c) => c.path === '/stream/live').at(-1)!.body).toEqual({ live: true });
    expect(countsCalls().at(-1)!.body).toMatchObject({ counts: [1, 1], voters: 2, live: true });
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
