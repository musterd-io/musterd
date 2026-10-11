import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { runTour, type TourLane, type TourPort, type TourUi } from './run.js';

type RosterRow = { name: string; kind: string; model?: string };

function fakes(
  script: {
    roster?: RosterRow[];
    acts?: Envelope[];
    openLane?: TourLane | null;
    judge?: { accept: boolean; note: string } | null;
    afterDecline?: 'skip' | 'quit';
  } = {},
) {
  const calls: string[] = [];
  const hints: string[] = [];
  const shown: string[] = [];
  const bodies: string[] = [];
  let t = 1_000_000;
  const acts = script.acts ?? [];
  const port: TourPort = {
    roster: async () =>
      script.roster ?? [
        { name: 'nick', kind: 'human' },
        { name: 'ada', kind: 'agent', model: 'm1' },
      ],
    findOpenTourLane: async () => script.openLane ?? null,
    openLane: async (title) => {
      calls.push(`openLane:${title}`);
      return { id: 'L1', openedAt: t };
    },
    abandonLane: async (id) => void calls.push(`abandon:${id}`),
    laneDetail: async () => 'three lines',
    request: async (agent) => {
      calls.push(`request:${agent}`);
      return 'R1';
    },
    verdict: async (askId, accept) => void calls.push(`verdict:${askId}:${accept}`),
    // Every poll returns the whole list, as overlapping `since` windows do; the loop must dedupe.
    messagesSince: async () => acts,
    now: () => (t += 1_000),
    sleep: async () => undefined,
  };
  const ui: TourUi = {
    show: (title, body) => {
      shown.push(title);
      bodies.push(body);
    },
    hint: (text) => void hints.push(text),
    pressEnter: async () => true,
    pickAgent: async (names) => names[1] ?? names[0] ?? null,
    judge: async () => (script.judge === undefined ? { accept: true, note: '' } : script.judge),
    afterDecline: async () => script.afterDecline ?? 'skip',
  };
  return { port, ui, calls, shown, bodies, hints };
}

const act = (p: Partial<Envelope> & { meta?: Record<string, unknown> }): Envelope =>
  ({
    v: 1,
    id: p.id ?? 'A',
    team: 't',
    from: p.from ?? 'ada',
    to: p.to ?? { kind: 'team' },
    act: p.act ?? 'message',
    body: p.body ?? '',
    thread: null,
    ts: p.ts ?? 2,
    meta: p.meta ?? null,
  }) as unknown as Envelope;

const claim = act({ id: 'C1', ts: 2, meta: { lane_claim: { lane: 'L1', title: 't' } } });
const ask = act({
  id: 'Q1',
  ts: 3,
  act: 'ask',
  to: { kind: 'member', name: 'nick' },
  meta: { lane_review: { lane: 'L1' } },
});
const opts = { reset: false, pollMs: 0 };

describe('runTour', () => {
  it('runs end to end: opens one lane, asks the agent, sends the verdict', async () => {
    const f = fakes({ acts: [claim, ask] });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.calls).toEqual([
      "openLane:[tour] nick: summarise this repo's README in three lines",
      'request:ada',
      'verdict:Q1:true',
    ]);
    expect(f.shown[0]).toBe('Step 1 of 9 · What musterd is');
    expect(f.shown).toContain('Step 6 of 9 · You judge it');
    expect(f.shown.at(-1)).toBe('Step 9 of 9 · Where to go next');
  });

  it('step 2 shows the roster it names', async () => {
    const f = fakes({ acts: [claim, ask] });
    await runTour(f.port, f.ui, 'nick', opts);
    const team = f.bodies[f.shown.indexOf('Step 2 of 9 · Your team')]!;
    expect(team).toContain('  nick  human, you');
    expect(team).toContain('  ada   agent');
  });

  it('dedupes overlapping polls', async () => {
    const f = fakes({ acts: [claim, claim, ask, ask] });
    await runTour(f.port, f.ui, 'nick', opts);
    expect(f.calls.filter((c) => c.startsWith('verdict'))).toHaveLength(1);
  });

  it('ignores acts about other lanes', async () => {
    const other = act({ id: 'C0', ts: 1, meta: { lane_claim: { lane: 'L9' } } });
    const f = fakes({ acts: [other, claim, ask] });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.calls.at(-1)).toBe('verdict:Q1:true');
  });

  it('resumes an open tour lane without opening a second one', async () => {
    const f = fakes({
      acts: [claim, ask],
      openLane: { id: 'L1', owner: 'ada', openedAt: 1 },
    });
    await runTour(f.port, f.ui, 'nick', opts);
    expect(f.calls.some((c) => c.startsWith('openLane'))).toBe(false);
    expect(f.calls).toContain('verdict:Q1:true');
  });

  it('reset abandons the open lane and starts fresh', async () => {
    const f = fakes({ acts: [claim, ask], openLane: { id: 'L0', owner: null, openedAt: 1 } });
    await runTour(f.port, f.ui, 'nick', { ...opts, reset: true });
    expect(f.calls[0]).toBe('abandon:L0');
    expect(f.calls[1]).toMatch(/^openLane:/);
  });

  it('no agent on the team: says how to add one and exits 0', async () => {
    const f = fakes({ roster: [{ name: 'nick', kind: 'human' }] });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.hints[0]).toMatch(/^No agent on your team yet\./);
  });

  it('refuses to run as an agent: the verdict must come from a person', async () => {
    const f = fakes({});
    expect(await runTour(f.port, f.ui, 'ada', opts)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.hints[0]).toMatch(/^The tour runs as you, and this folder acts as ada, an agent\./);
  });

  it('strips terminal control sequences from what the agent wrote', async () => {
    const f = fakes({ acts: [claim, ask] });
    f.port.laneDetail = async () => 'line one\x1b[2J\x1b]0;pwned\x07\nline two';
    let judged = '';
    f.ui.judge = async (summary) => {
      judged = summary;
      return { accept: true, note: '' };
    };
    await runTour(f.port, f.ui, 'nick', opts);
    expect(judged).toBe('line one[2J]0;pwned\nline two');
  });

  it('more than one agent: asks which one', async () => {
    const f = fakes({
      acts: [act({ ...claim, from: 'bo' }), act({ ...ask, from: 'bo' })],
      roster: [
        { name: 'nick', kind: 'human' },
        { name: 'ada', kind: 'agent' },
        { name: 'bo', kind: 'agent' },
      ],
    });
    await runTour(f.port, f.ui, 'nick', opts);
    expect(f.calls).toContain('request:bo');
  });

  it('self-close while waiting still ends on the record', async () => {
    const closed = act({ id: 'X1', ts: 3, meta: { lane_resolve: { lane: 'L1', state: 'done' } } });
    const f = fakes({ acts: [claim, closed] });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.shown).toContain('Step 7 of 9 · The record');
    expect(f.calls.some((c) => c.startsWith('verdict'))).toBe(false);
  });

  it('a decline replying to the request is shown, then skips to the record', async () => {
    const no = act({ id: 'D1', act: 'decline', body: 'no README', meta: { in_reply_to: 'R1' } });
    const f = fakes({ acts: [no] });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.shown).toContain('Step 7 of 9 · The record');
  });

  it('sending it back waits for the next submit', async () => {
    let first = true;
    const f = fakes({ acts: [claim, ask] });
    f.ui.judge = async () => {
      if (first) {
        first = false;
        return { accept: false, note: 'shorter' };
      }
      return { accept: true, note: '' };
    };
    const ask2 = act({ ...ask, id: 'Q2', ts: 4 });
    const base = f.port.messagesSince;
    f.port.messagesSince = async (since) =>
      f.calls.includes('verdict:Q1:false') ? [claim, ask, ask2] : base(since);
    await runTour(f.port, f.ui, 'nick', opts);
    expect(f.calls.filter((c) => c.startsWith('verdict'))).toEqual([
      'verdict:Q1:false',
      'verdict:Q2:true',
    ]);
  });

  it('Ctrl-C at the verdict stops cleanly with exit 0', async () => {
    const f = fakes({ acts: [claim, ask], judge: null });
    expect(await runTour(f.port, f.ui, 'nick', opts)).toBe(0);
    expect(f.hints.at(-1)).toBe('Stopped. `musterd tour` picks up where you left off.');
  });

  it('shows the 60s hint once while the agent is silent', async () => {
    const f = fakes({ acts: [] });
    let polls = 0;
    f.port.messagesSince = async () => (++polls > 70 ? [claim, ask] : []);
    await runTour(f.port, f.ui, 'nick', opts);
    expect(f.hints.filter((h) => h.startsWith('Still waiting.'))).toHaveLength(1);
  });
});
