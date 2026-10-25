import type { Envelope, Lane } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DIRECTED,
  MAX_LANES,
  directedOwed,
  orientationBlock,
  renderOrientation,
  resetOrientationShown,
} from './orientation.js';

/**
 * Lane 01M5N4ED6T (finding 022 follow-up): the join answer orients the seat — held lanes on this
 * project, the open count, the directed acts waiting — rendered once per session, degrading to
 * nothing when a read fails.
 */

const lane = (over: Partial<Lane>): Lane =>
  ({
    id: '01LANE',
    team: 'dawn',
    project: 'repo',
    title: 'a lane',
    state: 'claimed',
    owner_seat: 'bob',
    scope: [],
    depends_on: [],
    updated_at: 1,
    ...over,
  }) as unknown as Lane;

const act = (over: Partial<Envelope>): Envelope =>
  ({
    v: 'musterd/0.3',
    id: '01ACT',
    from: 'bob',
    to: { kind: 'member', name: 'ada' },
    act: 'request_help',
    body: 'can you review #12',
    ts: 1,
    ...over,
  }) as unknown as Envelope;

describe('renderOrientation', () => {
  it('is empty when nothing is held, open or waiting — a quiet team costs nothing', () => {
    expect(renderOrientation({ project: 'repo', lanes: [], unread: [] })).toBe('');
  });

  it('lists held lanes with owner and scope, the seat’s own first, then the open lanes', () => {
    const out = renderOrientation({
      project: 'repo',
      me: 'ada',
      lanes: [
        lane({ id: '01A', owner_seat: 'bob', state: 'active', scope: ['a.ts', 'b.ts', 'c.ts'] }),
        lane({ id: '01B', owner_seat: 'ada', title: 'mine' }),
        lane({ id: '01C', state: 'open', owner_seat: null, title: 'free', scope: ['c.ts'] }),
        lane({ id: '01D', state: 'done', owner_seat: 'bob' }),
      ],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Orientation — repo now:');
    expect(lines[1]).toContain('held lanes (2)');
    expect(lines[2]).toContain('01B [claimed] "mine" — ada (yours)');
    expect(lines[3]).toBe('  01A [active] "a lane" — bob · a.ts, b.ts +1');
    expect(lines[4]).toBe('open lanes (1) — unowned, claimable on repo:');
    expect(lines[5]).toBe('  01C [open] "free" · c.ts');
    // Finding 025: the pre-open `lane_board` read asks "what is on the board before I open a
    // lane"; the block answers it and says lane_open checks the overlap itself.
    expect(lines[6]).toContain(
      'to start: lane_claim the one above that is your work, else lane_open',
    );
    expect(lines[6]).toContain('no board read first');
    expect(out).not.toContain('01D');
    expect(out).not.toContain('directed acts');
  });

  it('caps held and open lanes together, held first', () => {
    const held = Array.from({ length: MAX_LANES - 2 }, (_, i) => lane({ id: `01H${i}` }));
    const open = Array.from({ length: 5 }, (_, i) =>
      lane({ id: `01O${i}`, state: 'open', owner_seat: null, updated_at: 10 - i }),
    );
    const out = renderOrientation({ project: 'repo', lanes: [...open, ...held] });
    expect(out.split('\n').filter((l) => l.startsWith('  01H'))).toHaveLength(MAX_LANES - 2);
    expect(out.split('\n').filter((l) => l.startsWith('  01O'))).toHaveLength(2);
    expect(out).toContain('  01O0 [open]');
    expect(out).toContain('+3 more — team_next ranks them');
  });

  it('caps the held list and says how many more', () => {
    const lanes = Array.from({ length: MAX_LANES + 3 }, (_, i) =>
      lane({ id: `01L${i}`, updated_at: i }),
    );
    const out = renderOrientation({ project: 'repo', lanes });
    expect(out.split('\n').filter((l) => l.startsWith('  01L'))).toHaveLength(MAX_LANES);
    expect(out).toContain('+3 more — lane_board');
  });

  it('renders only the directed obligations, clipped, with the reply instruction', () => {
    const out = renderOrientation({
      project: 'repo',
      lanes: [],
      unread: [
        act({ id: '01R', body: 'x'.repeat(200) }),
        act({ id: '01T', to: { kind: 'team' } as Envelope['to'] }),
        act({ id: '01M', act: 'message' }),
      ],
    });
    expect(out).toContain('directed acts waiting on you (1)');
    expect(out).toContain('bob · request_help · 01R: ' + 'x'.repeat(89) + '…');
    expect(out).not.toContain('01T');
    expect(out).not.toContain('01M');
    expect(out).toContain('team_send {reply_to}');
    expect(out).toContain('open lanes: none on repo');
    expect(out).toContain('to start: lane_open declares your work');
  });

  it('caps the directed list', () => {
    const unread = Array.from({ length: MAX_DIRECTED + 2 }, (_, i) => act({ id: `01D${i}` }));
    expect(directedOwed(unread)).toHaveLength(MAX_DIRECTED + 2);
    const out = renderOrientation({ project: 'repo', lanes: [], unread });
    expect(out).toContain(`+2 more — team_inbox_check`);
  });
});

describe('orientationBlock', () => {
  const client = () => ({
    member: 'ada',
    laneBoard: vi.fn(async () => ({ lanes: [lane({})], warnings: [] })),
    fetchInbox: vi.fn(async () => ({ messages: [act({})], cursor: { last_read_ts: 0 } })),
  });

  it('reads the board for this project and PEEKS the inbox, then renders once per session', async () => {
    const c = client();
    const first = await orientationBlock(c as never, 'repo', { withDirected: true });
    expect(c.laneBoard).toHaveBeenCalledWith({ project: 'repo' });
    expect(c.fetchInbox).toHaveBeenCalledWith(true, 50, true);
    expect(first).toContain('held lanes (1)');
    expect(first).toContain('directed acts waiting on you (1)');
    const second = await orientationBlock(c as never, 'repo', { withDirected: true });
    expect(second).toBe('');
    expect(c.laneBoard).toHaveBeenCalledTimes(1);
    resetOrientationShown(c);
  });

  it('skips the inbox read on the inbox path — that reply already carries the acts', async () => {
    const c = client();
    const out = await orientationBlock(c as never, 'repo', { withDirected: false });
    expect(c.fetchInbox).not.toHaveBeenCalled();
    expect(out).toContain('held lanes (1)');
    expect(out).not.toContain('directed acts');
  });

  it('degrades to nothing when the reads fail or the client lacks them', async () => {
    const failing = {
      member: 'ada',
      laneBoard: vi.fn(async () => {
        throw new Error('down');
      }),
      fetchInbox: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    expect(await orientationBlock(failing as never, 'repo', { withDirected: true })).toBe('');
    expect(await orientationBlock({} as never, 'repo', { withDirected: true })).toBe('');
  });
});
