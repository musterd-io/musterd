import { PROTOCOL_VERSION, type Envelope, type Lane, type LaneEvent } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAsks, deriveReviewQueue, resurrectRefusedVerdicts } from './asks';
import {
  lanesMissingReviewAsk,
  recoverReviewAsks,
  reviewAskedAt,
  reviewAsksIn,
} from './recoverAsks';

const cfg = { team: 'revive', as: 'nick', token: 'mscr_watch' } as never;

function env(id: string, act: Envelope['act'], ts: number, meta: Record<string, unknown> | null = null, from = 'ada'): Envelope {
  return {
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from,
    to: act === 'ask' ? { kind: 'member', name: 'nick' } : { kind: 'team' },
    act,
    body: '',
    thread: null,
    meta,
    ts,
  } as Envelope;
}
const reviewAsk = (id: string, laneId: string, ts: number) =>
  env(id, 'ask', ts, { species: 'approve', tier: 'blocking', lane_review: { lane: laneId, grade: 'human' } }, 'ryder');
const lane = (id: string, extra: Partial<Lane> = {}) =>
  ({ id, state: 'awaiting_acceptance', title: `lane ${id}`, owner_seat: 'ryder', updated_at: 1, ...extra }) as Lane;
const event = (action: string, ts: number) => ({ ts, action, actor: null }) as LaneEvent;
/** The newest-200 window a fresh load holds: chatter only, the review ask and its verdict long gone. */
const windowOf = (from: number) => Array.from({ length: 200 }, (_, i) => env(`w${i}`, 'status_update', from + i));

afterEach(() => vi.unstubAllGlobals());

describe('lanesMissingReviewAsk (lane 01M5G10DB2)', () => {
  it('names an awaiting lane with no reviewer whose review ask the window does not hold', () => {
    expect(lanesMissingReviewAsk([lane('L1')], windowOf(9000))).toEqual(['L1']);
  });

  it('skips a lane whose ask is held, one the board names a reviewer for, and one not in acceptance', () => {
    const lanes = [lane('HELD'), lane('ROUTED', { acceptance_reviewer: 'nick' }), lane('DONE', { state: 'done' })];
    expect(lanesMissingReviewAsk(lanes, [reviewAsk('a1', 'HELD', 5)])).toEqual([]);
  });
});

describe('reviewAskedAt / reviewAsksIn', () => {
  it('dates the newest review ask from the lane history, human stage or single stage', () => {
    expect(reviewAskedAt([event('lane.claimed', 1), event('lane.ready_for_review', 10), event('lane.review_human_asked', 20)])).toBe(20);
    expect(reviewAskedAt([event('lane.ready_for_review', 10)])).toBe(10);
    expect(reviewAskedAt([event('lane.claimed', 1)])).toBeNull();
  });

  it("keeps only that lane's review asks from a page", () => {
    const page = [env('x', 'status_update', 1), reviewAsk('a1', 'L1', 2), reviewAsk('a2', 'L2', 3)];
    expect(reviewAsksIn(page, 'L1').map((e) => e.id)).toEqual(['a1']);
  });
});

describe('recoverReviewAsks', () => {
  it('reads the lane history, then one forward page from just before the ask', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        calls.push(path);
        const body = path.includes('/lanes/')
          ? { history: [event('lane.review_human_asked', 100_000)] }
          : { messages: [env('x', 'status_update', 99_000), reviewAsk('a1', 'L1', 99_990)] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }),
    );
    const got = await recoverReviewAsks(cfg, 'L1');
    expect(got.map((e) => e.id)).toEqual(['a1']);
    expect(calls).toEqual(['/teams/revive/lanes/L1', '/teams/revive/messages?since=40000&limit=200']);
  });
});

describe('a refused-verdict ask older than the backfill window', () => {
  it('is offered again once recovered, and the review queue names who it waits on', () => {
    const lanes = [lane('L1')];
    const window = windowOf(9000);
    // Fresh load, before the fix: nothing to derive, the queue reads the lane as unrouted.
    expect(deriveAsks(window)).toEqual([]);
    expect(deriveReviewQueue(lanes, deriveAsks(window))[0]?.waitingOn ?? null).toBeNull();
    // The recovered ask, merged ahead of the window as AsksStrip does.
    const asks = resurrectRefusedVerdicts(deriveAsks([reviewAsk('a1', 'L1', 50), ...window]), lanes, new Set(['nick']));
    expect(asks.filter((a) => a.state === 'open').map((a) => a.env.id)).toEqual(['a1']);
    expect(deriveReviewQueue(lanes, asks)[0]?.waitingOn).toBe('nick');
  });
});
