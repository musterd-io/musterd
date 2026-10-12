import type { DeclareGoal, OpenLane, UpdateLane } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { refusal, saveStage, type SavePort } from './save.js';
import type { ImportStage } from './stage.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const base = (): ImportStage => ({
  version: 1,
  id: 's1',
  team: 'dawn',
  project: 'demo',
  created_at: NOW - 1000,
  source: { path: 'x.csv', sha256: 'ab', format: 'csv' },
  goals: [{ ref: 'goal:g', row: 2, id: 'g', title: 'G', depends_on: [] }],
  lanes: [
    { ref: 'lane:a', row: 3, title: 'A', goal_id: 'g', depends_on: [] },
    {
      ref: 'lane:b',
      row: 4,
      title: 'B',
      goal_id: 'g',
      depends_on: [
        { kind: 'staged', ref: 'lane:a' },
        { kind: 'existing', id: 'OLD' },
      ],
      stakes: 'high',
    },
  ],
  linked_goals: [],
  diagnostics: [],
  created: {},
  saved_at: null,
});

function fakePort(failOnLane?: string) {
  let n = 0;
  const port: SavePort = {
    goals: vi.fn(async () => ({ goals: [] as { id: string }[] })),
    laneBoard: vi.fn(async () => ({
      lanes: [] as { id: string; state: string; owner_seat: string | null }[],
    })),
    updateLane: vi.fn(async () => ({})),
    declareGoal: vi.fn(async (_t: string, body: DeclareGoal) => ({ id: body.id })),
    openLane: vi.fn(async (_t: string, body: OpenLane) => {
      if (body.title === failOnLane) throw new Error('daemon restarted');
      n += 1;
      return { lane: { id: `L${String(n)}` } };
    }),
  };
  return port;
}

describe('refusal', () => {
  it('refuses errors, saved, other team, expired — in that order', () => {
    expect(
      refusal(
        { ...base(), diagnostics: [{ level: 'error', row: 2, code: 'x', message: 'm' }] },
        'dawn',
        NOW,
      ),
    ).toMatch(/1 error/);
    expect(refusal({ ...base(), saved_at: NOW - 5 }, 'dawn', NOW)).toMatch(/already saved/);
    expect(refusal(base(), 'dusk', NOW)).toMatch(
      /staged for team "dawn", this workspace is "dusk"/,
    );
    expect(refusal({ ...base(), created_at: NOW - 25 * 3600_000 }, 'dawn', NOW)).toMatch(
      /older than 24 hours/,
    );
    expect(
      refusal(
        { ...base(), diagnostics: [{ level: 'warning', row: 2, code: 'x', message: 'm' }] },
        'dawn',
        NOW,
      ),
    ).toBeNull();
  });
});

describe('saveStage', () => {
  it('declares goals then opens lanes in order, mapping staged deps to real ids', async () => {
    const port = fakePort();
    const persisted: ImportStage[] = [];
    const res = await saveStage(base(), {
      team: 'dawn',
      port,
      persist: (s) => persisted.push(structuredClone(s)),
      now: () => NOW,
    });
    expect(port.declareGoal).toHaveBeenCalledWith('dawn', { id: 'g', title: 'G' });
    expect(port.openLane).toHaveBeenNthCalledWith(1, 'dawn', {
      title: 'A',
      project: 'demo',
      goal_id: 'g',
    });
    expect(port.openLane).toHaveBeenNthCalledWith(2, 'dawn', {
      title: 'B',
      project: 'demo',
      goal_id: 'g',
      stakes: 'high',
      depends_on: ['L1', 'OLD'],
    });
    expect(res.lanes.map((l) => [l.ref, l.id, l.resumed])).toEqual([
      ['lane:a', 'L1', false],
      ['lane:b', 'L2', false],
    ]);
    expect(persisted.at(-1)!.saved_at).toBe(NOW);
    expect(persisted.length).toBe(4); // one per create + the final saved_at
  });

  it('resumes after a failure mid-lanes without creating anything twice', async () => {
    let stage = base();
    const first = fakePort('B');
    await expect(
      saveStage(stage, {
        team: 'dawn',
        port: first,
        persist: (s) => (stage = structuredClone(s)),
        now: () => NOW,
      }),
    ).rejects.toThrow('daemon restarted');
    expect(stage.created).toEqual({ 'goal:g': 'g', 'lane:a': 'L1' });
    expect(stage.saved_at).toBeNull();

    const second: SavePort = {
      goals: vi.fn(async () => ({ goals: [{ id: 'g' }] })),
      declareGoal: vi.fn(),
      openLane: vi.fn(async () => ({ lane: { id: 'L9' } })),
    };
    const res = await saveStage(stage, {
      team: 'dawn',
      port: second,
      persist: (s) => (stage = structuredClone(s)),
      now: () => NOW,
    });
    expect(second.declareGoal).not.toHaveBeenCalled();
    expect(second.openLane).toHaveBeenCalledTimes(1);
    expect(second.openLane).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({ title: 'B', depends_on: ['L1', 'OLD'] }),
    );
    expect(res.goals[0]!.resumed).toBe(true);
    expect(res.lanes.map((l) => l.resumed)).toEqual([true, false]);
    expect(stage.saved_at).toBe(NOW);
  });

  it('creates nothing when refused', async () => {
    const port = fakePort();
    await expect(
      saveStage(base(), { team: 'dusk', port, persist: () => {}, now: () => NOW }),
    ).rejects.toThrow(/dusk/);
    expect(port.declareGoal).not.toHaveBeenCalled();
    expect(port.openLane).not.toHaveBeenCalled();
  });
  it('resumes a partly saved stage even when it is older than 24 hours', async () => {
    const stage: ImportStage = {
      ...base(),
      created_at: NOW - 48 * 3600_000,
      created: { 'goal:g': 'g', 'lane:a': 'L1' },
    };
    expect(refusal(stage, 'dawn', NOW)).toBeNull();
    const port = fakePort();
    const res = await saveStage(stage, { team: 'dawn', port, persist: () => {}, now: () => NOW });
    expect(port.openLane).toHaveBeenCalledTimes(1);
    expect(res.lanes.map((l) => l.resumed)).toEqual([true, false]);
  });

  it('links a goal that appeared on the board since the preview instead of re-declaring it', async () => {
    const port = fakePort();
    port.goals = vi.fn(async () => ({ goals: [{ id: 'g' }] }));
    let last: ImportStage | undefined;
    const res = await saveStage(base(), {
      team: 'dawn',
      port,
      persist: (s) => (last = structuredClone(s)),
      now: () => NOW,
    });
    expect(port.declareGoal).not.toHaveBeenCalled();
    expect(res.goals).toEqual([{ ref: 'goal:g', id: 'g', resumed: false, linked: true }]);
    expect(last!.linked_goals).toEqual(['g']);
    expect(port.openLane).toHaveBeenCalledTimes(2);
  });

  it('says how to resume when a call fails partway', async () => {
    const port = fakePort('B');
    const err = await saveStage(base(), {
      team: 'dawn',
      port,
      persist: () => {},
      now: () => NOW,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain('daemon restarted');
    expect(err.message).toContain('stopped after 2 of 3');
    expect(err.message).toContain('re-run `musterd import save s1` to resume');
  });
});

describe('saveStage — source_ref (ADR 561)', () => {
  it('sends the ref, and adopts the lane that holds it when the open comes back 409', async () => {
    const port = fakePort();
    port.openLane = vi.fn(async (_t: string, body: OpenLane) => {
      if (body.source_ref === 'acme/app#1')
        throw new CliError('source_ref "acme/app#1" already belongs to lane L-HELD', 1, 'conflict');
      return { lane: { id: 'L-NEW' } };
    });
    port.laneBoard = vi.fn(async () => ({
      lanes: [
        { id: 'L-OLD', state: 'abandoned' },
        { id: 'L-HELD', state: 'claimed' },
      ],
    }));
    const stage = base();
    stage.lanes[0]!.source_ref = 'acme/app#1';
    stage.lanes[1]!.source_ref = 'acme/app#2';
    const saved: ImportStage[] = [];
    const r = await saveStage(stage, {
      team: 'dawn',
      port,
      persist: (s) => saved.push(structuredClone(s)),
      now: () => NOW,
    });
    expect(port.laneBoard).toHaveBeenCalledWith('dawn', { source_ref: 'acme/app#1' });
    expect(r.lanes[0]).toMatchObject({
      ref: 'lane:a',
      id: 'L-HELD',
      resumed: false,
      adopted: true,
    });
    // The dependent lane resolves the adopted id.
    expect(port.openLane).toHaveBeenLastCalledWith(
      'dawn',
      expect.objectContaining({ source_ref: 'acme/app#2', depends_on: ['L-HELD', 'OLD'] }),
    );
    expect(saved.at(-1)!.created['lane:a']).toBe('L-HELD');
  });

  it('a 409 with no live holder left still stops the save', async () => {
    const port = fakePort();
    port.openLane = vi.fn(async () => {
      throw new CliError('source_ref "acme/app#1" already belongs to lane L-GONE', 1, 'conflict');
    });
    const stage = base();
    stage.lanes[0]!.source_ref = 'acme/app#1';
    await expect(
      saveStage(stage, { team: 'dawn', port, persist: () => {}, now: () => NOW }),
    ).rejects.toThrow(/stopped after 1 of 3/);
  });
});

describe('saveStage — a tracker sync (spec 2026-10-11 §3)', () => {
  const syncStage = (): ImportStage => ({
    ...base(),
    source: { path: 'github acme/app', sha256: 'ab', format: 'github' },
    goals: [{ ref: 'goal:g', row: 1, id: 'g', title: 'G', depends_on: [] }],
    lanes: [
      {
        ref: 'lane@2',
        row: 2,
        title: 'Fresh',
        goal_id: 'g',
        depends_on: [],
        source_ref: 'acme/app#5',
      },
    ],
    sync: {
      actions: [
        { kind: 'adopt', lane_id: 'D1', ref: 'acme/app#1' },
        {
          kind: 'rename',
          lane_id: 'R1',
          ref: 'acme/app#2',
          from: 'Old',
          title: 'New',
          held_by: 'ada',
        },
        {
          kind: 'rename',
          lane_id: 'R2',
          ref: 'acme/app#7',
          from: 'Old 2',
          title: 'New 2',
          held_by: null,
        },
        {
          kind: 'abandon',
          lane_id: 'A1',
          ref: 'acme/app#3',
          from: 'Gone',
          reason: 'closed in GitHub (acme/app#3)',
        },
        {
          kind: 'abandon',
          lane_id: 'A2',
          ref: 'acme/app#4',
          from: 'Taken',
          reason: 'closed in GitHub (acme/app#4)',
        },
        {
          kind: 'abandon',
          lane_id: 'A3',
          ref: 'acme/app#6',
          from: 'Done',
          reason: 'closed in GitHub (acme/app#6)',
        },
      ],
      unchanged: 2,
    },
  });
  type Live = { id: string; state: string; owner_seat: string | null };
  const board: Record<string, Live> = {
    'acme/app#2': { id: 'R1', state: 'claimed', owner_seat: 'ada' },
    // Unowned at preview, claimed since: the rename is skipped like the abandon (spec §3 Save).
    'acme/app#7': { id: 'R2', state: 'claimed', owner_seat: 'bo' },
    'acme/app#3': { id: 'A1', state: 'open', owner_seat: null },
    'acme/app#4': { id: 'A2', state: 'claimed', owner_seat: 'ada' },
    'acme/app#6': { id: 'A3', state: 'abandoned', owner_seat: null },
  };
  function syncPort() {
    const calls: string[] = [];
    const port = fakePort();
    port.declareGoal = vi.fn(async (_t: string, body: DeclareGoal) => {
      calls.push(`goal ${body.id}`);
      return { id: body.id };
    });
    port.openLane = vi.fn(async (_t: string, body: OpenLane) => {
      calls.push(`open ${body.title}`);
      return { lane: { id: 'L-NEW' } };
    });
    port.updateLane = vi.fn(async (_t: string, id: string, patch: UpdateLane) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`);
      return {};
    });
    port.laneBoard = vi.fn(async (_t: string, q: { source_ref: string }) => ({
      lanes: board[q.source_ref] ? [board[q.source_ref]!] : [],
    }));
    return { port, calls };
  }

  it('adopts, then goals, new lanes, renames, abandons — re-reading each lane first', async () => {
    const { port, calls } = syncPort();
    const r = await saveStage(syncStage(), {
      team: 'dawn',
      port,
      persist: () => {},
      now: () => NOW,
    });
    expect(calls).toEqual([
      'update D1 {"source_ref":"acme/app#1"}',
      'goal g',
      'open Fresh',
      'update R1 {"title":"New"}',
      'update A1 {"state":"abandoned","abandon_reason":"closed in GitHub (acme/app#3)"}',
    ]);
    expect(r.sync).toEqual([
      { kind: 'adopt', lane_id: 'D1', ok: true },
      { kind: 'rename', lane_id: 'R1', ok: true },
      { kind: 'rename', lane_id: 'R2', ok: false, note: 'claimed since the preview — left alone' },
      { kind: 'abandon', lane_id: 'A1', ok: true },
      { kind: 'abandon', lane_id: 'A2', ok: false, note: 'claimed since the preview — left alone' },
      { kind: 'abandon', lane_id: 'A3', ok: true, note: 'already abandoned' },
    ]);
  });

  it('records each action as it completes, so a re-run skips it', async () => {
    const { port } = syncPort();
    let calls = 0;
    port.updateLane = vi.fn(async (_t: string, id: string) => {
      calls += 1;
      if (id === 'A1' && calls < 4) throw new Error('daemon restarted');
      return {};
    });
    let saved: ImportStage | undefined;
    await expect(
      saveStage(syncStage(), {
        team: 'dawn',
        port,
        persist: (s) => (saved = structuredClone(s)),
        now: () => NOW,
      }),
    ).rejects.toThrow(/stopped after/);
    expect(saved!.created).toMatchObject({ 'sync:adopt:D1': 'D1', 'sync:rename:R1': 'R1' });
    const again = await saveStage(saved!, {
      team: 'dawn',
      port,
      persist: () => {},
      now: () => NOW,
    });
    expect(again.sync.slice(0, 2)).toEqual([
      { kind: 'adopt', lane_id: 'D1', ok: true, note: 'done by an earlier run' },
      { kind: 'rename', lane_id: 'R1', ok: true, note: 'done by an earlier run' },
    ]);
    expect(again.sync.find((x) => x.lane_id === 'A1')).toEqual({
      kind: 'abandon',
      lane_id: 'A1',
      ok: true,
    });
  });

  it('a lane gone from the board is not renamed or abandoned', async () => {
    const { port } = syncPort();
    port.laneBoard = vi.fn(async () => ({ lanes: [] }));
    const st = syncStage();
    st.sync!.actions = st.sync!.actions.filter((a) => a.kind !== 'adopt');
    const r = await saveStage(st, { team: 'dawn', port, persist: () => {}, now: () => NOW });
    expect(r.sync.every((x) => !x.ok && x.note === 'no longer on the board — left alone')).toBe(
      true,
    );
    expect(port.updateLane).not.toHaveBeenCalled();
  });
});
