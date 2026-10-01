import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, deriveHuddles, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  gatheredFrom,
  gatheredSeats,
  huddleBudget,
  openHuddles,
  sinceOpen,
  streamPlacement,
} from './huddles';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** A minimal timeline envelope — the huddle lens reads act/meta/thread/ts/id/from/to only. */
function env(
  id: string,
  act: Envelope['act'],
  opts: {
    from?: string;
    ts?: number;
    thread?: string | null;
    meta?: Record<string, unknown> | null;
    body?: string;
    to?: Envelope['to'];
  } = {},
): Envelope {
  return {
    id,
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: opts.from ?? 'ada',
    to: opts.to ?? { kind: 'team' },
    act,
    body: opts.body ?? '',
    thread: opts.thread ?? null,
    meta: opts.meta ?? null,
    ts: opts.ts ?? 1000,
  } as Envelope;
}

const HUDDLE = {
  topic: { kind: 'lane', id: '01LANE' },
  room: 'https://board.example/huddle-01root',
  anchor: 'docs/wiki/huddles.md',
};

const root = (id: string, ts: number, extra: Record<string, unknown> = {}) =>
  env(id, 'message', { ts, from: 'ada', meta: { huddle: { ...HUDDLE, ...extra } } });

describe('openHuddles', () => {
  it('keeps a huddle whose thread carries no resolve', () => {
    const views = deriveHuddles([root('01r', 1000)], 'ada');
    expect(openHuddles(views).map((v) => v.id)).toEqual(['01r']);
  });

  it('drops a huddle once a resolve closes its thread', () => {
    const views = deriveHuddles(
      [root('01r', 1000), env('01c', 'resolve', { ts: 2000, thread: '01r' })],
      'ada',
    );
    expect(openHuddles(views)).toEqual([]);
  });
});

describe('gatheredSeats', () => {
  it('gathers the opener and everyone who has taken a turn, not the merely invited', () => {
    const views = deriveHuddles(
      [
        root('01r', 1000, {}),
        env('01t', 'message', { ts: 1100, thread: '01r', from: 'bo' }),
      ].map((e, i) => (i === 0 ? { ...e, meta: { ...e.meta, eligible: ['cy'] } } : e)),
      'ada',
    );
    expect([...gatheredSeats(views)].sort()).toEqual(['ada', 'bo']);
  });

  it('gathers nobody from a closed huddle — the room emptied when it resolved', () => {
    const views = deriveHuddles(
      [root('01r', 1000), env('01c', 'resolve', { ts: 2000, thread: '01r', from: 'ada' })],
      'ada',
    );
    expect(gatheredSeats(views).size).toBe(0);
  });
});

describe('huddleBudget', () => {
  const withBudget = (budget: Record<string, number>, turns = 0) =>
    deriveHuddles(
      [
        root('01r', 1000, { budget }),
        ...Array.from({ length: turns }, (_, i) =>
          env(`01t${i}`, 'message', { ts: 1100 + i, thread: '01r', from: 'bo' }),
        ),
      ],
      'ada',
    )[0]!;

  it('reports no budget when the opener declared none', () => {
    const b = huddleBudget(deriveHuddles([root('01r', 1000)], 'ada')[0]!, 5000);
    expect(b).toMatchObject({ phase: 'none', turnsUsed: 0, overTurns: false, overTime: false });
  });

  it('counts turns used against the declared turns', () => {
    const b = huddleBudget(withBudget({ turns: 6 }, 2), 5000);
    expect(b).toMatchObject({ turnsUsed: 2, turnsDeclared: 6, turnsLeft: 4, phase: 'within' });
  });

  it('says spent — never closed — when the declared turns are used up', () => {
    const b = huddleBudget(withBudget({ turns: 2 }, 3), 5000);
    expect(b).toMatchObject({ turnsUsed: 3, turnsLeft: -1, overTurns: true, phase: 'spent' });
  });

  it('reads the time left from the declared end and the clock passed in', () => {
    const b = huddleBudget(withBudget({ until: 9000 }), 5000);
    expect(b).toMatchObject({ msLeft: 4000, overTime: false, phase: 'within' });
  });

  it('goes over on time without ending the huddle', () => {
    const b = huddleBudget(withBudget({ until: 4000 }), 5000);
    expect(b).toMatchObject({ msLeft: -1000, overTime: true, phase: 'spent' });
  });
});

describe('gatheredFrom — the timeline the office already holds', () => {
  it('reads the gathering straight off the envelopes, with no roster and no fetch', () => {
    const timeline = [
      root('01r', 1000),
      env('01t', 'message', { ts: 1100, thread: '01r', from: 'bo' }),
      env('01x', 'status_update', { ts: 1200, from: 'cy' }),
    ];
    expect([...gatheredFrom(timeline)].sort()).toEqual(['ada', 'bo']);
  });

  it('gathers nobody from a timeline with no huddle in it', () => {
    expect(gatheredFrom([env('01x', 'status_update', { ts: 1, from: 'cy' })]).size).toBe(0);
  });
});

/**
 * The zod guard. `@musterd/protocol` builds its schemas at module scope, so ONE value imported from
 * the barrel pulls zod and the whole `z.object(...)` graph into the browser — ~20 KB gzipped on
 * /live, measured 2026-09-04 and repaid in #1307 by moving the browser onto `/wire`. The huddle fold
 * is a value, so it is exactly the shape of import that silently undoes that repayment; the budget
 * gate catches it, but only after a build, and only while the budget has no headroom.
 */
describe('the browser reads the fold without the validator', () => {
  it('takes deriveHuddles from /wire, never from the schema barrel', () => {
    for (const file of ['./huddles.ts', './HuddleRail.tsx']) {
      const text = src(file);
      if (!text.includes('deriveHuddles')) continue;
      expect(text).toMatch(/import \{[^}]*deriveHuddles[^}]*\} from '@musterd\/protocol\/wire'/);
    }
  });
});

/**
 * The wiring guard. The gathering is derived in `OfficeScene` and applied in the scene's `update`,
 * and neither hop has a unit test that could fail — a scene needs a canvas. What CAN be checked is
 * that the two hops exist: drop either and the floor silently stops gathering while every test here
 * stays green. Same idiom as `officeRoom.test.ts`'s parity guard, and for the same reason.
 */
describe('the office floor reads the gathering', () => {
  it('OfficeScene derives it from the envelopes it already holds', () => {
    const scene = src('./OfficeScene.tsx');
    expect(scene).toContain('gatheredFrom');
  });

  it('the office frames its own huddles — the rail rides the room, on both surfaces at once', () => {
    const scene = src('./OfficeScene.tsx');
    expect(scene).toContain('<HuddleRail');
    // One mount inside the room is what makes /live and /broadcast agree without either route
    // wiring anything — the officeRoom parity argument, applied to the rail.
    expect(scene).toMatch(/roomLink=\{!broadcast\}/);
  });

  it('the scene hands it to assignSeats — nothing else moves a member to the table', () => {
    const index = src('./office-scene/index.ts');
    expect(index).toMatch(/assignSeats\(\s*next\.nodes,/);
  });
});

describe('streamPlacement — where the Stream draws a huddle as one card', () => {
  const timeline = [
    root('01r', 1000),
    env('01a', 'status_update', { ts: 1500, from: 'ryder' }),
    env('01t1', 'message', { ts: 2000, from: 'miley', thread: '01r' }),
    env('01b', 'message', { ts: 2500, from: 'ghost' }),
    env('01t2', 'steer', { ts: 3000, from: 'ada', thread: '01r' }),
    env('01c', 'message', { ts: 3500, from: 'lazara' }),
  ];

  it('anchors the card at its latest row, not where it opened', () => {
    const { cardAt } = streamPlacement(timeline);
    expect([...cardAt.keys()]).toEqual(['01t2']);
    expect(cardAt.get('01t2')!.id).toBe('01r');
  });

  it('folds the root and every thread row into the card, and nothing else', () => {
    const { folded } = streamPlacement(timeline);
    expect([...folded].sort()).toEqual(['01r', '01t1', '01t2']);
  });

  it('follows the live edge: a new turn moves the anchor to it', () => {
    const next = [...timeline, env('01t3', 'message', { ts: 4000, from: 'ghost', thread: '01r' })];
    expect([...streamPlacement(next).cardAt.keys()]).toEqual(['01t3']);
  });

  it('stays where it closed: the resolve is the last row the card claims', () => {
    const closed = [
      ...timeline,
      env('01x', 'resolve', { ts: 4000, from: 'ada', thread: '01r' }),
      env('01d', 'message', { ts: 5000, from: 'ryder' }),
    ];
    const { cardAt, folded } = streamPlacement(closed);
    expect([...cardAt.keys()]).toEqual(['01x']);
    expect(folded.has('01x')).toBe(true);
    expect(folded.has('01d')).toBe(false);
  });

  it('leaves an ordinary thread alone: only huddle roots group', () => {
    const plain = [
      env('01p', 'request_help', { ts: 1000 }),
      env('01q', 'accept', { ts: 2000, thread: '01p' }),
    ];
    const { cardAt, folded } = streamPlacement(plain);
    expect(cardAt.size).toBe(0);
    expect(folded.size).toBe(0);
  });
});

describe('sinceOpen — time-to-turn in the close-note format', () => {
  it('reads seconds under a minute', () => expect(sinceOpen(45_000)).toBe('+45s'));
  it('reads tenths of a minute under an hour', () => expect(sinceOpen(84_000)).toBe('+1.4m'));
  it('reads hours past the hour', () => expect(sinceOpen(65 * 60_000)).toBe('+1h05m'));
  it('never goes negative on a skewed clock', () => expect(sinceOpen(-3000)).toBe('+0s'));
});
