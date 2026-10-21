import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope, Lane, MemberSummary, SeatMoved, SeatMoveRequest } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { type MoveDeps, type MoveInput, preAcceptClaudeTrust, runMove } from './move.js';

/**
 * `musterd move` (ADR 696): the CLI's half — who it refuses before the hub is asked, the wrap-up
 * steer and its bounded wait, the unpushed-branch warning, and which half of the move runs here.
 * The hub's own authority and transaction are `server/src/sync/move.test.ts`.
 */

const member = (name: string, kind: string, presence = 'offline'): MemberSummary =>
  ({
    name,
    kind,
    presence,
    residence: { node: 'nA', node_label: 'mac.lan', kind: 'node' },
  }) as unknown as MemberSummary;

const moved = (seat: string, kind: 'agent' | 'human' = 'agent'): SeatMoved => ({
  seat,
  kind,
  from: [{ node_id: 'nA', label: 'mac.lan' }],
  to: { node_id: 'nB', label: 'macbook-air-2.lan' },
  residency: null,
});

function harness(over: {
  members?: MemberSummary[];
  replies?: (sent: Envelope) => Envelope[];
  lanes?: Lane[];
  onOrigin?: Record<string, boolean>;
}) {
  const out: string[] = [];
  const sent: Envelope[] = [];
  const moves: Array<{ seat: string; body: SeatMoveRequest }> = [];
  const arrivals: SeatMoved[] = [];
  let clock = 1_000;
  const deps: MoveDeps = {
    roster: async () => ({
      members: over.members ?? [member('nick', 'human'), member('wallow', 'agent')],
      node: { id: 'nB', label: 'macbook-air-2.lan' },
    }),
    send: async (env) => {
      sent.push(env);
    },
    messagesSince: async () => (sent[0] && over.replies ? over.replies(sent[0]) : []),
    lanesOf: async () => over.lanes ?? [],
    branchOnOrigin: (b) => over.onOrigin?.[b] ?? true,
    move: async (seat, body) => {
      moves.push({ seat, body });
      return moved(seat, seat === 'nick' ? 'human' : 'agent');
    },
    arrive: async (m) => {
      arrivals.push(m);
      return [`arrived ${m.seat}\n`];
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    out: (l) => out.push(l),
  };
  return { deps, out, sent, moves, arrivals, text: () => out.join('') };
}

const base: MoveInput = { team: 'revive', caller: 'nick', seat: 'wallow' };

describe('musterd move (ADR 696)', () => {
  it('an idle agent comes here: no steer, the hub moves it, this machine stands it up', async () => {
    const h = harness({});
    const r = await runMove(base, h.deps);
    expect(r.wrapUp).toBe('not_live');
    expect(h.sent).toEqual([]);
    expect(h.moves).toEqual([{ seat: 'wallow', body: {} }]);
    expect(h.arrivals.map((a) => a.seat)).toEqual(['wallow']);
    expect(h.text()).toContain('mac.lan → ');
  });

  it('a live agent is told in its own thread, and the move waits for its accept', async () => {
    const h = harness({
      members: [member('nick', 'human'), member('wallow', 'agent', 'online')],
      replies: (steer) => [
        {
          id: 'r1',
          from: 'wallow',
          act: 'accept',
          thread: steer.thread,
          ts: 2_000,
          meta: { in_reply_to: steer.id },
        } as unknown as Envelope,
      ],
    });
    const r = await runMove(base, h.deps);
    expect(r.wrapUp).toBe('accepted');
    expect(h.sent[0]).toMatchObject({ act: 'steer', to: { kind: 'member', name: 'wallow' } });
    expect(h.sent[0]!.thread).toBe(h.sent[0]!.id);
    expect(h.moves).toHaveLength(1);
  });

  it('a live agent that never answers is moved at the deadline, with its unpushed branch named', async () => {
    const h = harness({
      members: [member('nick', 'human'), member('wallow', 'agent', 'online')],
      lanes: [
        { id: 'L1', branch: 'feat/seat-move' } as Lane,
        { id: 'L2', branch: 'feat/pushed' } as Lane,
        { id: 'L3', branch: null } as Lane,
      ],
      onOrigin: { 'feat/seat-move': false },
    });
    const r = await runMove({ ...base, waitMs: 10_000 }, h.deps);
    expect(r.wrapUp).toBe('timeout');
    expect(r.unpushed).toEqual(['feat/seat-move']);
    expect(h.text()).toContain('branch feat/seat-move is not on origin');
    expect(h.moves).toHaveLength(1);
  });

  it('--now skips the wait but still names unpushed work', async () => {
    const h = harness({
      members: [member('nick', 'human'), member('wallow', 'agent', 'online')],
      lanes: [{ id: 'L1', branch: 'wip' } as Lane],
      onOrigin: { wip: false },
    });
    const r = await runMove({ ...base, now: true }, h.deps);
    expect(r.wrapUp).toBe('skipped');
    expect(h.sent).toEqual([]);
    expect(r.unpushed).toEqual(['wip']);
  });

  it('a seat sends ITSELF with --to; the destination half is left to the target, with the command named', async () => {
    const h = harness({});
    const r = await runMove(
      { team: 'revive', caller: 'wallow', seat: 'wallow', to: 'macbook-air-2.lan' },
      h.deps,
    );
    expect(r.wrapUp).toBe('self');
    expect(h.moves).toEqual([{ seat: 'wallow', body: { to: 'macbook-air-2.lan' } }]);
    expect(h.arrivals).toEqual([]);
    expect(h.text()).toContain('on macbook-air-2.lan: musterd move wallow');
    expect(h.text()).toContain('end it once the new one is up');
  });

  it('a seat cannot bring itself here — that is run from the person at the destination', async () => {
    const h = harness({});
    await expect(runMove({ ...base, caller: 'wallow' }, h.deps)).rejects.toThrow(/--to <machine>/);
    expect(h.moves).toEqual([]);
  });

  it("a person's seat moves only by that person; nobody else is asked", async () => {
    const h = harness({ members: [member('nick', 'human'), member('tj', 'human')] });
    await expect(runMove({ ...base, seat: 'tj' }, h.deps)).rejects.toThrow(/only tj can add/);
    expect(h.moves).toEqual([]);
    await runMove({ ...base, seat: 'nick', to: 'macbook-air-2.lan', only: true }, h.deps);
    expect(h.moves).toEqual([{ seat: 'nick', body: { to: 'macbook-air-2.lan', only: true } }]);
  });

  it('--dry-run says what would happen and changes nothing', async () => {
    const h = harness({ members: [member('nick', 'human'), member('wallow', 'agent', 'online')] });
    const r = await runMove({ ...base, dryRun: true }, h.deps);
    expect(r.moved).toBeNull();
    expect(h.sent).toEqual([]);
    expect(h.moves).toEqual([]);
    expect(h.text()).toContain('would move wallow (agent) from mac.lan to macbook-air-2.lan');
  });

  it('an answer about a different seat is refused before anything is set up here', async () => {
    const h = harness({});
    h.deps.move = async () => moved('ryder');
    await expect(runMove(base, h.deps)).rejects.toThrow(/answered for "ryder", not "wallow"/);
    expect(h.arrivals).toEqual([]);
  });

  it('a service seat is refused: it belongs to its machine', async () => {
    const h = harness({ members: [member('nick', 'human'), member('guardian', 'service')] });
    await expect(runMove({ ...base, seat: 'guardian' }, h.deps)).rejects.toThrow(/service install/);
  });
});

describe("pre-accepting Claude Code's folder trust", () => {
  it('marks the folder trusted and keeps everything else in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-move-'));
    try {
      const file = join(dir, '.claude.json');
      writeFileSync(file, JSON.stringify({ theme: 'dark', projects: { '/x': { a: 1 } } }));
      preAcceptClaudeTrust('/ws/wallow', file);
      const after = JSON.parse(readFileSync(file, 'utf8'));
      expect(after.theme).toBe('dark');
      expect(after.projects['/x']).toEqual({ a: 1 });
      expect(after.projects['/ws/wallow']).toEqual({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
