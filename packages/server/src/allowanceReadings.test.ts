import type { AllowancePost } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowanceForRoster,
  allowanceSpread,
  clearAllowance,
  ingestAllowance,
  type AllowanceRosterSeat,
} from './allowanceReadings.js';

const TEAM = 'allowance-readings';
const MAX = 'aaaaaaaaaaaaaaaa';
const PRO = 'bbbbbbbbbbbbbbbb';

function claude(
  account: string,
  readAt: number,
  left: number,
  label = 'Claude Max',
): AllowancePost['accounts'][number] {
  return {
    provider: 'claude',
    account,
    label,
    readAt,
    windows: [{ name: '5h', left, resetsAt: readAt + 1, kind: 'percent' }],
  };
}

function post(
  accounts: AllowancePost['accounts'],
  opts: { holder: string | null; local: boolean },
): void {
  ingestAllowance(TEAM, { accounts }, opts);
}

function seat(
  partial: Partial<AllowanceRosterSeat> & Pick<AllowanceRosterSeat, 'name'>,
): AllowanceRosterSeat {
  return {
    kind: 'human',
    present: false,
    presences: [],
    ...partial,
  };
}

describe('allowance readings', () => {
  beforeEach(() => clearAllowance(TEAM));

  it('collapses the same account key and keeps the newest windows', () => {
    post([claude(MAX, 100, 0.4, 'Claude Max')], { holder: 'nick', local: true });
    post([claude(MAX, 50, 0.1, 'Claude Max stale')], { holder: 'ada', local: false });
    post([claude(MAX, 200, 0.2, 'Claude Max')], { holder: 'nick', local: true });
    const view = allowanceForRoster(TEAM, [seat({ name: 'nick' }), seat({ name: 'ada' })]);
    expect(view.get('nick')?.accounts).toEqual([
      {
        provider: 'claude',
        label: 'Claude Max',
        readAt: 200,
        windows: [{ name: '5h', left: 0.2, resetsAt: 201, kind: 'percent' }],
      },
    ]);
    expect(view.get('ada')?.accounts[0]?.readAt).toBe(200);
    expect(view.get('ada')?.accounts[0]?.windows[0]?.left).toBe(0.2);
    expect(JSON.stringify(view)).not.toContain(MAX);
  });

  it('keeps two accounts as two lines and drops the one a holder left', () => {
    post([claude(MAX, 100, 0.38, 'Claude Max')], { holder: 'nick', local: true });
    post([claude(PRO, 100, 0.71, 'Claude Pro')], { holder: 'ada', local: true });
    const both = [seat({ name: 'nick' }), seat({ name: 'ada' })];
    expect(
      allowanceForRoster(TEAM, both)
        .get('nick')
        ?.accounts.map((a) => a.label),
    ).toEqual(['Claude Max']);
    expect(
      allowanceForRoster(TEAM, both)
        .get('ada')
        ?.accounts.map((a) => a.label),
    ).toEqual(['Claude Pro']);
    post([claude(PRO, 110, 0.7, 'Claude Pro')], { holder: 'nick', local: true });
    const moved = allowanceForRoster(TEAM, both);
    expect(moved.get('nick')?.accounts.map((a) => a.label)).toEqual(['Claude Pro']);
    expect(moved.get('ada')?.accounts.map((a) => a.label)).toEqual(['Claude Pro']);
    const agent = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'claude-opus-4', driver: 'nick' }],
    });
    expect(
      allowanceForRoster(TEAM, [agent])
        .get('tj')
        ?.accounts.map((a) => a.label),
    ).toEqual(['Claude Pro']);
  });

  it('shows an unauthenticated reading only to the one human present on that node', () => {
    post([claude(MAX, 100, 0.5)], { holder: null, local: true });
    const nick = seat({
      name: 'nick',
      present: true,
      presences: [{ status: 'online', node: null, model: null, driver: null }],
    });
    const ada = seat({
      name: 'ada',
      present: true,
      presences: [{ status: 'online', node: null, model: null, driver: null }],
    });
    expect(allowanceForRoster(TEAM, [nick]).get('nick')?.accounts).toHaveLength(1);
    expect(allowanceForRoster(TEAM, [nick, ada]).has('nick')).toBe(false);
    expect(allowanceForRoster(TEAM, [nick, ada]).has('ada')).toBe(false);
  });

  it('paints an agent from the node, and from the driver when two accounts share the node', () => {
    post([claude(MAX, 100, 0.38, 'Claude Max')], { holder: 'nick', local: true });
    const agent = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'claude-opus-4', driver: 'nick' }],
    });
    expect(allowanceForRoster(TEAM, [agent]).get('tj')?.accounts[0]?.label).toBe('Claude Max');
    post([claude(PRO, 120, 0.71, 'Claude Pro')], { holder: 'ada', local: true });
    const shared = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'claude-opus-4', driver: 'ada' }],
    });
    expect(allowanceForRoster(TEAM, [shared]).get('tj')?.accounts[0]?.label).toBe('Claude Pro');
    const unnamed = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'claude-opus-4', driver: null }],
    });
    expect(allowanceForRoster(TEAM, [unnamed]).has('tj')).toBe(false);
  });

  it('does not put cursor or elevenlabs on an agent, or any reading on a service seat', () => {
    ingestAllowance(
      TEAM,
      {
        accounts: [
          {
            provider: 'cursor',
            account: 'cccccccccccccccc',
            label: 'Cursor',
            readAt: 100,
            windows: [{ name: 'month', left: 0.5, resetsAt: null, kind: 'percent' }],
          },
          {
            provider: 'elevenlabs',
            account: 'dddddddddddddddd',
            label: 'ElevenLabs',
            readAt: 100,
            windows: [
              {
                name: 'characters',
                left: 0.4,
                resetsAt: null,
                kind: 'amount',
                used: 1,
                limit: 10,
                unit: 'characters',
              },
            ],
          },
        ],
      },
      { holder: 'nick', local: true },
    );
    const nick = seat({ name: 'nick' });
    const agent = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'claude-sonnet', driver: 'nick' }],
    });
    const service = seat({ name: 'nick', kind: 'service', present: true });
    expect(
      allowanceForRoster(TEAM, [nick])
        .get('nick')
        ?.accounts.map((a) => a.provider),
    ).toEqual(['cursor', 'elevenlabs']);
    expect(allowanceForRoster(TEAM, [agent]).has('tj')).toBe(false);
    expect(allowanceForRoster(TEAM, [service]).has('nick')).toBe(false);
  });

  it('paints Muse on a muse-wonder presence, and not on musterd', () => {
    ingestAllowance(
      TEAM,
      {
        accounts: [
          {
            provider: 'muse',
            account: 'eeeeeeeeeeeeeeee',
            label: 'Muse',
            readAt: 100,
            windows: [{ name: '5h', left: 0.65, resetsAt: null, kind: 'percent' }],
          },
          {
            provider: 'cursor',
            account: 'cccccccccccccccc',
            label: 'Cursor',
            readAt: 100,
            windows: [{ name: 'month', left: 0.5, resetsAt: null, kind: 'percent' }],
          },
          {
            provider: 'elevenlabs',
            account: 'dddddddddddddddd',
            label: 'ElevenLabs',
            readAt: 100,
            windows: [
              {
                name: 'characters',
                left: 0.4,
                resetsAt: null,
                kind: 'amount',
                used: 1,
                limit: 10,
                unit: 'characters',
              },
            ],
          },
        ],
      },
      { holder: 'nick', local: true },
    );
    const wonder = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'muse-wonder-1.0', driver: null }],
    });
    const spark = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'muse-spark-x', driver: 'nick' }],
    });
    const word = seat({
      name: 'tj',
      kind: 'agent',
      present: true,
      presences: [{ status: 'online', node: null, model: 'musterd', driver: 'nick' }],
    });
    expect(
      allowanceForRoster(TEAM, [wonder])
        .get('tj')
        ?.accounts.map((account) => account.provider),
    ).toEqual(['muse']);
    expect(allowanceForRoster(TEAM, [spark]).get('tj')?.accounts[0]?.label).toBe('Muse');
    expect(allowanceForRoster(TEAM, [word]).has('tj')).toBe(false);
    const nick = seat({ name: 'nick' });
    expect(
      allowanceForRoster(TEAM, [nick])
        .get('nick')
        ?.accounts.map((account) => account.provider),
    ).toEqual(['cursor', 'elevenlabs', 'muse']);
  });

  it('omits the field for a broadcast reader and keeps it for a public reader', () => {
    const view = {
      readAt: 1,
      accounts: [
        {
          provider: 'claude' as const,
          label: 'Claude Max',
          readAt: 1,
          windows: [{ name: '5h' as const, left: 0.5, resetsAt: null, kind: 'percent' as const }],
        },
      ],
    };
    expect(allowanceSpread('broadcast', view)).toEqual({});
    expect(allowanceSpread('public', view)).toEqual({ allowance: view });
    expect(allowanceSpread('team', null)).toEqual({});
  });
});
