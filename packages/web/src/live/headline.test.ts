import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { collapseHeadlines, headline, headlineText, type Headline } from './headline';

const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: '01HEADLINEID',
    team: 'revive',
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    ts: 0,
    meta: null,
    ...over,
  }) as Envelope;
const to = (name: string) => ({ kind: 'member', name }) as Envelope['to'];
const ctx = { laneTitle: (id: string) => (id === 'L9' ? 'Grok hook fix' : null) };
const text = (h: Headline | null) => (h ? headlineText(h) : null);

describe('headline — one line a room can read (ADR 464 §5)', () => {
  it('a handoff names the work and who gets it', () => {
    const h = headline(
      env({
        act: 'handoff',
        to: to('dolly'),
        meta: { lane_handoff: { lane: 'L9', branch: 'x' } },
        body: 'private note',
      }),
      ctx,
    );
    expect(text(h)).toBe('ryder handed Grok hook fix to dolly');
    expect(h?.tone).toBe('handoff');
  });

  it('a plain handoff with no lane still reads', () => {
    expect(text(headline(env({ act: 'handoff', to: to('dolly') }), ctx))).toBe(
      'ryder handed work to dolly',
    );
  });

  it('accept and decline name whose work', () => {
    expect(text(headline(env({ from: 'big-body', act: 'accept', to: to('izzo') }), ctx))).toBe(
      "big-body accepted izzo's work",
    );
    expect(text(headline(env({ from: 'big-body', act: 'decline', to: to('izzo') }), ctx))).toBe(
      "big-body sent izzo's work back",
    );
  });

  it('lane events: claimed, opened, closed, submitted for review', () => {
    expect(
      text(headline(env({ meta: { lane_claim: { lane: 'L1', title: 'Roster fix' } } }), ctx)),
    ).toBe('ryder picked up Roster fix');
    expect(
      text(headline(env({ meta: { lane_open: { lane: 'L1', title: 'Roster fix' } } }), ctx)),
    ).toBe('ryder opened Roster fix');
    expect(
      text(
        headline(
          env({ meta: { lane_resolve: { lane: 'L1', title: 'Roster fix', state: 'done' } } }),
          ctx,
        ),
      ),
    ).toBe('ryder closed Roster fix');
    expect(
      text(
        headline(
          env({
            meta: { lane_state: { lane: 'L1', title: 'Roster fix', state: 'awaiting_acceptance' } },
          }),
          ctx,
        ),
      ),
    ).toBe('ryder sent Roster fix for review');
    expect(
      text(
        headline(
          env({ meta: { lane_state: { lane: 'L1', title: 'Roster fix', state: 'blocked' } } }),
          ctx,
        ),
      ),
    ).toBe('ryder is blocked on Roster fix');
  });

  it('asks and help requests name the person; an ask quotes its one-line question (the only body read)', () => {
    expect(text(headline(env({ act: 'request_help', to: to('dolly') }), ctx))).toBe(
      'ryder asked dolly for help',
    );
    expect(
      text(
        headline(
          env({
            act: 'request_help',
            to: { kind: 'team' },
            meta: { eligible: ['dolly', 'sloane'] },
          }),
          ctx,
        ),
      ),
    ).toBe('ryder asked dolly or sloane for help');
    const ask = headline(
      env({
        act: 'ask',
        to: to('nick'),
        body: 'may I merge #12?\nsecond line',
        meta: { species: 'approve', tier: 'standard' },
      }),
      ctx,
    );
    expect(text(ask)).toBe('ryder is asking nick: may I merge #12?');
  });

  it('a lane-review ask says whose acceptance was asked, never the machine prefix', () => {
    const h = headline(
      env({
        act: 'ask',
        to: to('big-body'),
        body: '[lane] acceptance requested: "Cursor Read gap — one session" — Judge the LANDED OUTCOME…',
        meta: { species: 'approve', tier: 'standard' },
      }),
      ctx,
    );
    expect(text(h)).toBe('ryder asked big-body to accept Cursor Read gap — one session');
    expect(text(h)).not.toContain('[lane]');
  });

  it('steer and resolve', () => {
    expect(text(headline(env({ act: 'steer', to: to('izzo') }), ctx))).toBe(
      'ryder redirected izzo',
    );
    expect(text(headline(env({ act: 'resolve', to: to('izzo') }), ctx))).toBe(
      'ryder resolved the thread with izzo',
    );
  });

  it('quiet acts never headline, and no headline carries a body or an id (falsifier 3)', () => {
    expect(headline(env({ act: 'status_update', body: 'secret status' }), ctx)).toBeNull();
    expect(headline(env({ act: 'message', body: 'hello' }), ctx)).toBeNull();
    const h = headline(
      env({
        act: 'handoff',
        to: to('dolly'),
        body: 'SECRET',
        meta: { lane_handoff: { lane: 'L9', branch: 'b' } },
      }),
      ctx,
    );
    expect(headlineText(h!)).not.toContain('SECRET');
    expect(headlineText(h!)).not.toContain('L9');
    expect(headlineText(h!)).not.toContain('01HEADLINEID');
  });
});

describe('collapseHeadlines', () => {
  const open = (ts: number, title: string): Headline =>
    headline(env({ ts, id: `e${ts}`, meta: { lane_open: { lane: `L${ts}`, title } } }), ctx)!;

  it('folds adjacent same-actor same-verb headlines within 30s into one count', () => {
    const out = collapseHeadlines([
      open(0, 'a'),
      open(5_000, 'b'),
      open(9_000, 'c'),
      open(50_000, 'd'),
    ]);
    expect(out.map(headlineText)).toEqual(['ryder opened 3 lanes', 'ryder opened d']);
    expect(out[0]?.count).toBe(3);
  });

  it('does not fold across actors', () => {
    const b = { ...open(1_000, 'b'), who: 'dolly' };
    expect(collapseHeadlines([open(0, 'a'), b]).map(headlineText)).toEqual([
      'ryder opened a',
      'dolly opened b',
    ]);
  });
});
