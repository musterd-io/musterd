import { describe, expect, it } from 'vitest';
import { readLaneChain } from './guards.js';
import { laneChain, laneChainLines, type LaneChainEvent, type LaneChainLane } from './laneChain.js';

const empty: LaneChainLane = { owner_seat: null, requested: null, merged: null };

function link(name: string, value: string | null, mark: string) {
  return { link: name, value, mark };
}

describe('laneChain', () => {
  it('prints five links and treats an empty lane as missing except a stored owner', () => {
    expect(laneChain({ owner_seat: 'TJ' })).toEqual([
      link('asked', null, 'missing'),
      link('claimed', 'TJ', 'verified'),
      link('model', null, 'missing'),
      link('accepted', null, 'missing'),
      link('authorized', null, 'missing'),
    ]);
    expect(laneChainLines(laneChain({ owner_seat: 'TJ' }))).toEqual([
      'chain:',
      '  asked      —  missing',
      '  claimed    TJ  verified',
      '  model      —  missing',
      '  accepted   —  missing',
      '  authorized —  missing',
    ]);
  });

  it('marks a checked asker verified and a stated or basis-less name stated', () => {
    expect(laneChain({ ...empty, requested: { by: 'ada', basis: 'act' } })[0]).toEqual(
      link('asked', 'ada', 'verified'),
    );
    expect(laneChain({ ...empty, requested: { by: 'ada', basis: 'seed' } })[0]?.mark).toBe(
      'verified',
    );
    expect(laneChain({ ...empty, requested: { by: 'nick', basis: 'self' } })[0]?.mark).toBe(
      'verified',
    );
    expect(laneChain({ ...empty, requested: { by: 'big-body', basis: 'stated' } })[0]).toEqual(
      link('asked', 'big-body', 'stated'),
    );
    expect(laneChain({ ...empty, requested: { by: 'ada' } })[0]).toEqual(
      link('asked', 'ada', 'stated'),
    );
    expect(laneChain({ ...empty, requested: { by: '  ', basis: 'self' } })[0]?.mark).toBe(
      'missing',
    );
  });

  it('keeps the current owner, and the latest claim once the lane is released', () => {
    const history: LaneChainEvent[] = [
      { action: 'lane.claimed', actor: 'TJ', owner: 'TJ' },
      { action: 'lane.claimed', actor: 'bo', owner: 'bo' },
      { action: 'lane.released', actor: 'nick', owner: 'bo' },
    ];
    expect(laneChain({ owner_seat: 'bo' }, history)[1]).toEqual(link('claimed', 'bo', 'verified'));
    expect(laneChain({ owner_seat: null }, history)[1]).toEqual(link('claimed', 'bo', 'verified'));
    expect(laneChain(empty, [{ action: 'lane.opened', actor: 'izzo' }])[1]?.mark).toBe('missing');
    expect(laneChain(empty, [{ action: 'lane.claimed', actor: 'ada', owner: null }])[1]).toEqual(
      link('claimed', 'ada', 'verified'),
    );
  });

  it('takes the newest model and verifies only an observed source', () => {
    const history: LaneChainEvent[] = [
      { action: 'lane.opened', actor: 'ada', model: 'claude-opus-4', model_source: 'binding' },
      { action: 'lane.claimed', actor: 'ada', model: 'grok-4', model_source: 'environment' },
      { action: 'lane.state_changed', actor: 'ada', model: 'unknown', model_source: 'observed' },
    ];
    expect(laneChain(empty, history)[2]).toEqual(link('model', 'grok-4', 'stated'));
    expect(
      laneChain(empty, [
        { action: 'lane.claimed', actor: 'ada', model: 'grok-4.5', model_source: 'observed' },
      ])[2],
    ).toEqual(link('model', 'grok-4.5', 'verified'));
    expect(
      laneChain(empty, [{ action: 'lane.claimed', actor: 'ada', model: 'grok-4' }])[2],
    ).toEqual(link('model', 'grok-4', 'stated'));
  });

  it('accepts only a confirmed close that names the closer', () => {
    const history: LaneChainEvent[] = [
      { action: 'lane.closed', actor: 'TJ', verified: false },
      { action: 'lane.closed', actor: null, verified: true },
      { action: 'lane.closed', actor: 'schmidt', verified: true },
    ];
    expect(laneChain(empty, history)[3]).toEqual(link('accepted', 'schmidt', 'verified'));
    expect(laneChain(empty, [{ action: 'lane.closed', actor: 'TJ', verified: false }])[3]).toEqual(
      link('accepted', null, 'missing'),
    );
  });

  it('states who authorized and does not promote the name because a SHA landed', () => {
    expect(
      laneChain({
        ...empty,
        merged: { authorized_by: 'nick' },
      })[4],
    ).toEqual(link('authorized', 'nick', 'stated'));
    expect(laneChain({ ...empty, merged: {} })[4]?.mark).toBe('missing');
  });
});

describe('readLaneChain', () => {
  it('reads the detail envelope and skips a history row that is not an object', () => {
    const links = readLaneChain({
      lane: {
        owner_seat: 'TJ',
        requested: { by: 'big-body', basis: 'stated' },
        merged: { authorized_by: 'nick', verification: 'ancestor' },
      },
      history: [
        { action: 'lane.claimed', actor: 'TJ', model: 'grok-4', model_source: 'observed' },
        'nope',
        { action: 'lane.closed', actor: 'schmidt', verified: true },
      ],
    });
    expect(links).toEqual([
      link('asked', 'big-body', 'stated'),
      link('claimed', 'TJ', 'verified'),
      link('model', 'grok-4', 'verified'),
      link('accepted', 'schmidt', 'verified'),
      link('authorized', 'nick', 'stated'),
    ]);
  });

  it('refuses a body that is not a lane detail', () => {
    expect(() => readLaneChain({ lane: {} })).toThrow(/lane detail/);
    expect(() => readLaneChain(null)).toThrow(/lane detail/);
  });
});
