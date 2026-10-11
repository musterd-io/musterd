import type { DeclareGoal, OpenLane } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
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
});
