import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module per test: loadSnapshot memoises its read for the page's lifetime. */
async function fresh() {
  vi.resetModules();
  return import('./liveCache');
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

const roster = [{ name: 'dolly' }] as unknown as MemberSummary[];
const env = (n: number) => ({ id: `e${n}`, ts: n }) as unknown as Envelope;
const lane = (id: string, state: string, title = 'work') => ({ id, state, title });
const board = (lanes: ReturnType<typeof lane>[]) => ({ lanes }) as unknown as LaneBoard;

describe('liveCache', () => {
  it('paints what was last saved for this team and seat, and nothing for another seat', async () => {
    const c = await fresh();
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [env(1)], board: null });
    const again = await fresh();
    expect(again.loadSnapshot('revive', 'nick')?.roster).toEqual(roster);
    expect(again.loadSnapshot('revive', 'alfie')).toBeNull();
  });

  it("signing out clears the seat's snapshot, on this page and the next", async () => {
    const c = await fresh();
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null });
    expect(c.loadSnapshot('revive', 'nick')).not.toBeNull();
    c.clearSnapshot('revive', 'nick');
    expect(c.loadSnapshot('revive', 'nick')).toBeNull();
    expect((await fresh()).loadSnapshot('revive', 'nick')).toBeNull();
  });

  it('a signed-out seat stays cleared until it connects again, whatever the old saver does', async () => {
    const c = await fresh();
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null });
    c.clearSnapshot('revive', 'nick');
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null });
    expect(store.has('musterd.live.v1:revive:nick')).toBe(false);
    // A re-render of the old connection reads the snapshot; that must not lift the guard.
    c.loadSnapshot('revive', 'nick');
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null });
    expect(store.has('musterd.live.v1:revive:nick')).toBe(false);
    c.resumeSnapshot('revive', 'nick');
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null });
    expect(store.has('musterd.live.v1:revive:nick')).toBe(true);
  });

  it('keeps only the newest 120 envelopes', async () => {
    const c = await fresh();
    const many = Array.from({ length: 300 }, (_, i) => env(i));
    c.saveSnapshot('revive', 'nick', { roster, envelopes: many, board: null });
    const got = (await fresh()).loadSnapshot('revive', 'nick')!.envelopes;
    expect(got).toHaveLength(120);
    expect(got.at(-1)).toEqual(env(299));
  });

  it('drops closed lanes but keeps a closed tour lane, which the tour entry reads', async () => {
    const c = await fresh();
    const b = board([
      lane('a', 'claimed'),
      lane('b', 'done'),
      lane('c', 'abandoned'),
      lane('t', 'done', '[tour] nick: summarise'),
    ]);
    c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: b });
    const ids = (await fresh()).loadSnapshot('revive', 'nick')!.board!.lanes.map((l) => l.id);
    expect(ids).toEqual(['a', 't']);
  });

  it('starts empty on unreadable or blocked storage instead of throwing', async () => {
    store.set('musterd.live.v1:revive:nick', '{not json');
    expect((await fresh()).loadSnapshot('revive', 'nick')).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const c = await fresh();
    expect(c.loadSnapshot('revive', 'nick')).toBeNull();
    expect(() => c.saveSnapshot('revive', 'nick', { roster, envelopes: [], board: null })).not.toThrow();
  });
});
