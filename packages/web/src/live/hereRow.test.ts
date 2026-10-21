import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { LIVE_PAGE_WORKSPACE } from './client';
import { whoIsHere } from './hereRow';

type P = { surface: string; workspace?: string | null; status?: string; attached_at?: number };
const member = (name: string, kind: 'human' | 'agent', presences: P[]) =>
  ({
    name,
    kind,
    presences: presences.map((p) => ({ status: 'online', last_seen_at: 0, ...p })),
  }) as unknown as MemberSummary;
const live = (attached_at?: number, status = 'online'): P => ({
  surface: 'web',
  workspace: LIVE_PAGE_WORKSPACE,
  status,
  ...(attached_at !== undefined ? { attached_at } : {}),
});

describe('whoIsHere (ADR 692)', () => {
  it('is empty when nobody has /live open: the board page and a CLI session do not count', () => {
    const roster = [
      member('nick', 'human', [{ surface: 'web', workspace: null }]),
      member('Ada', 'agent', [{ surface: 'claude-code', workspace: 'slippy · main' }]),
    ];
    expect(whoIsHere(roster, null)).toEqual([]);
  });

  it('shows a signed-in member with /live open, by name and kind', () => {
    const [bo] = whoIsHere([member('Bo', 'human', [live(1000)])], null);
    expect(bo).toMatchObject({ name: 'Bo', kind: 'human', you: false, tabs: 1, since: 1000, idle: false });
  });

  it('counts a member once however many tabs they hold, and keeps the earliest start', () => {
    const [nick] = whoIsHere([member('nick', 'human', [live(3000), live(2000), { surface: 'cli' }])], null);
    expect(nick).toMatchObject({ tabs: 2, since: 2000 });
  });

  it('puts the others in arrival order and the viewer last', () => {
    const roster = [
      member('nick', 'human', [live(1)]),
      member('Bo', 'human', [live(3)]),
      member('Ada', 'agent', [live(2)]),
    ];
    expect(whoIsHere(roster, 'nick').map((e) => [e.name, e.you])).toEqual([
      ['Ada', false],
      ['Bo', false],
      ['nick', true],
    ]);
  });

  it('reads a member whose every /live tab has gone quiet as idle, not gone', () => {
    const [bo] = whoIsHere([member('Bo', 'human', [live(1, 'away')])], null);
    expect(bo?.idle).toBe(true);
  });
});
