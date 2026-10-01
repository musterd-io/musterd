import { describe, expect, it } from 'vitest';
import { resolveSeatWord } from './resolve.js';
import type { Seat } from './store.js';

const seat = (address: string): Seat => {
  const [teamPart, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team: teamPart.split('@')[0]!,
    project,
    member,
    server: 'http://127.0.0.1:4849',
    path: `/w/${address}`,
    kind: 'agent',
    harnesses: [],
    remote: null,
    last_session: null,
    problem: null,
  };
};
const SEATS = [
  seat('revive/agents/stanley'),
  seat('revive/agents/miley'),
  seat('revive/site/miley'),
  seat('dawn/agents/ada'),
];

describe('resolveSeatWord (ADR 491 Decision 2)', () => {
  it('a member name unique on this machine is enough', () => {
    expect(resolveSeatWord('stanley', SEATS, null)).toEqual({ kind: 'seat', seat: SEATS[0] });
  });

  it('an exact address always wins', () => {
    expect(resolveSeatWord('revive/site/miley', SEATS, null)).toEqual({
      kind: 'seat',
      seat: SEATS[2],
    });
  });

  it('a project/member suffix resolves when unique', () => {
    expect(resolveSeatWord('site/miley', SEATS, null)).toEqual({ kind: 'seat', seat: SEATS[2] });
  });

  it('several matches are an ambiguity, with every candidate', () => {
    expect(resolveSeatWord('miley', SEATS, null)).toEqual({
      kind: 'ambiguous',
      candidates: [SEATS[1], SEATS[2]],
    });
  });

  it('`-` is the seat launched last, and none when there is no last', () => {
    expect(resolveSeatWord('-', SEATS, 'dawn/agents/ada')).toEqual({
      kind: 'seat',
      seat: SEATS[3],
    });
    expect(resolveSeatWord('-', SEATS, null)).toEqual({ kind: 'none', nearest: null });
    expect(resolveSeatWord('-', SEATS, 'gone/x/y')).toEqual({ kind: 'none', nearest: null });
  });

  it('no match names the nearest member when it is close', () => {
    expect(resolveSeatWord('stanly', SEATS, null)).toEqual({ kind: 'none', nearest: 'stanley' });
    expect(resolveSeatWord('xyzzy-nonsense', SEATS, null)).toEqual({ kind: 'none', nearest: null });
  });
});
