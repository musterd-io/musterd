import type { Envelope } from '@musterd/protocol';
import { advance, initialState, type TourState } from './machine.js';
import { hintFor, stepBody, stepTitle, type TourVars } from './screens.js';
import { fill, TOUR_LANE_TITLE, TOUR_MESSAGES, TOUR_REQUEST } from './script.generated.js';

/**
 * The tour's loop (spec 2026-10-10-first-run-tour-design). All IO sits behind `TourPort` and
 * `TourUi`, so every failure case runs as a unit test; `commands/tour.ts` supplies the real ones.
 *
 * Events come from polling the team timeline, never the socket: the socket skips a member's own
 * acts (route.ts), and the tour must see the lane it opened. Overlapping polls are deduped by id.
 */
export interface TourLane {
  id: string;
  owner: string | null;
  /** When the lane opened (ms), read from its ULID; the replay on resume starts just before it. */
  openedAt: number;
}

export interface TourPort {
  roster(): Promise<{ name: string; kind: string; model?: string }[]>;
  findOpenTourLane(title: string): Promise<TourLane | null>;
  openLane(title: string): Promise<{ id: string; openedAt: number }>;
  abandonLane(id: string): Promise<void>;
  laneDetail(id: string): Promise<string>;
  /** Sends the request_help to the agent; returns its act id. */
  request(agent: string, body: string): Promise<string>;
  verdict(askId: string, accept: boolean, note: string): Promise<void>;
  messagesSince(ts: number): Promise<Envelope[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface TourUi {
  show(title: string, body: string): void;
  hint(text: string): void;
  /** false when the person cancelled (Ctrl-C). */
  pressEnter(): Promise<boolean>;
  pickAgent(names: string[]): Promise<string | null>;
  /** null when the person cancelled. */
  judge(summary: string): Promise<{ accept: boolean; note: string } | null>;
  afterDecline(reason: string): Promise<'skip' | 'quit'>;
}

export const STOPPED = 'Stopped. `musterd tour` picks up where you left off.';
/** How far back each poll reaches past the newest act it has seen; dedupe absorbs the overlap. */
const OVERLAP_MS = 5_000;
/** A runaway guard for a loop that only real events end: ~5.5 hours at the 2s poll. */
const MAX_POLLS = 10_000;
const WAITING = new Set<TourState['step']>(['claims', 'hands_back', 'judge']);

export async function runTour(
  port: TourPort,
  ui: TourUi,
  me: string,
  opts: { reset: boolean; pollMs: number },
): Promise<number> {
  const roster = await port.roster();
  const agents = roster.filter((m) => m.kind === 'agent' && m.name !== me);
  const title = fill(TOUR_LANE_TITLE, { you: me });

  let open = await port.findOpenTourLane(title);
  if (open && opts.reset) {
    await port.abandonLane(open.id);
    open = null;
  }

  let agent = open?.owner ?? null;
  if (!agent) {
    if (agents.length === 0) {
      ui.hint(TOUR_MESSAGES.noAgent);
      return 0;
    }
    agent = agents.length === 1 ? agents[0]!.name : await ui.pickAgent(agents.map((a) => a.name));
    if (!agent) return stop(ui);
  }

  const model = roster.find((m) => m.name === agent)?.model ?? '';
  const vars: TourVars = { you: me, agent, lane: open?.id ?? '', model };
  let state: TourState = initialState(me, agent);
  let cursor: number;

  if (open) {
    // Resume: replay every act since the lane opened through the machine; never a second lane.
    state = { ...state, step: 'claims', laneId: open.id };
    cursor = open.openedAt - OVERLAP_MS;
  } else {
    for (const step of ['what', 'team'] as const) {
      ui.show(stepTitle(step), stepBody({ ...state, step }, vars));
      if (!(await ui.pressEnter())) return stop(ui);
      state = advance(state, { type: 'continue' });
    }
    ui.show(stepTitle('give_work'), stepBody(state, vars));
    cursor = port.now() - OVERLAP_MS;
    const lane = await port.openLane(title);
    vars.lane = lane.id;
    const requestId = await port.request(agent, fill(TOUR_REQUEST, { you: me, lane: lane.id }));
    state = advance(state, { type: 'lane_opened', laneId: lane.id, requestId });
  }

  const seen = new Set<string>();
  let shown: TourState['step'] | null = null;
  let stepStart = port.now();
  let lastHint: string | null = null;
  let polls = 0;

  while (WAITING.has(state.step)) {
    if (state.step !== shown) {
      ui.show(stepTitle(state.step), stepBody(state, vars));
      shown = state.step;
      stepStart = port.now();
      lastHint = null;
    }

    if (state.step === 'claims' && state.outcome === 'declined') {
      ui.hint(`${fill(TOUR_MESSAGES.declined, vars)} ${state.declineReason ?? ''}`.trim());
      if ((await ui.afterDecline(state.declineReason ?? '')) === 'quit') return stop(ui);
      state = advance(state, { type: 'skip_to_record' });
      continue;
    }

    if (state.step === 'judge' && state.askId) {
      const verdict = await ui.judge(await port.laneDetail(vars.lane));
      if (!verdict) return stop(ui);
      await port.verdict(state.askId, verdict.accept, verdict.note);
      state = advance(state, { type: 'verdict', accept: verdict.accept });
      if (!verdict.accept) ui.hint(fill(TOUR_MESSAGES.sentBack, vars));
      continue;
    }

    if (++polls > MAX_POLLS) {
      ui.hint('The tour stopped hearing from the team. Run `musterd tour` to pick up again.');
      return 1;
    }
    const fresh = (await port.messagesSince(cursor))
      .filter((env) => !seen.has(env.id))
      .sort((a, b) => a.ts - b.ts);
    for (const env of fresh) {
      seen.add(env.id);
      cursor = Math.max(cursor, env.ts - OVERLAP_MS);
      state = advance(state, { type: 'act', env });
    }
    if (fresh.length > 0 && state.step !== shown) continue;

    const hint = hintFor(state.step, port.now() - stepStart, vars);
    if (hint && hint !== lastHint) {
      ui.hint(hint);
      lastHint = hint;
    }
    await port.sleep(opts.pollMs);
  }

  if (state.outcome === 'self_closed') ui.hint(fill(TOUR_MESSAGES.selfClosed, vars));
  ui.show(stepTitle('record'), stepBody({ ...state, step: 'record' }, vars));
  ui.show(stepTitle('add_seat'), stepBody({ ...state, step: 'add_seat' }, vars));
  if (!(await ui.pressEnter())) return stop(ui);
  ui.show(stepTitle('next'), stepBody({ ...state, step: 'next' }, vars));
  return 0;
}

function stop(ui: TourUi): number {
  ui.hint(STOPPED);
  return 0;
}
