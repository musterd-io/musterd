import * as p from '@clack/prompts';
import { makeEnvelope } from '@musterd/protocol';
import { decodeTime, ulid } from 'ulid';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { paint as pc } from '../render/theme.js';
import { termWidth } from '../render/ui.js';
import { runTour, type TourPort, type TourUi } from '../tour/run.js';
import { wrapBody } from '../tour/screens.js';
import { TOUR_MESSAGES } from '../tour/script.generated.js';
import { resolve, sendOrEcho } from './helpers.js';

/** States a resumable tour lane can be in; a closed one starts a fresh tour. */
const LIVE_STATES = new Set(['open', 'claimed', 'active', 'blocked', 'awaiting_acceptance']);
const POLL_MS = 2_000;

/**
 * `musterd tour` — the hands-on first-run tour (spec 2026-10-10-first-run-tour-design). The loop
 * lives in `tour/run.ts`; this file only binds it to the daemon and to @clack/prompts.
 */
/**
 * The flags `musterd tour` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd tour` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const TOUR_FLAGS = [
  'home',
  'next',
  'online',
  'record',
  'reset',
  'role',
  'rotate',
  'step',
  'what',
] as const;

export async function tourCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...TOUR_FLAGS],
    'the flags `musterd tour` takes are listed by `musterd help tour`',
  );
  const { team, identity, http } = resolve(parsed.flags);
  const me = identity.name;

  const send = async (env: Parameters<typeof makeEnvelope>[0]): Promise<string> => {
    const envelope = makeEnvelope(env);
    await sendOrEcho(() => http.send(team, envelope), envelope);
    return envelope.id;
  };

  const port: TourPort = {
    roster: async () =>
      (await http.roster(team)).members.map((m) => {
        const model = m.presences[0]?.model;
        return {
          name: m.name,
          kind: m.kind,
          ...(model && model !== 'unknown' ? { model } : {}),
        };
      }),
    findOpenTourLane: async (title) => {
      const { lanes } = await http.laneBoard(team, {});
      const lane = lanes.find((l) => l.title === title && LIVE_STATES.has(l.state));
      return lane ? { id: lane.id, owner: lane.owner_seat, openedAt: decodeTime(lane.id) } : null;
    },
    openLane: async (title) => {
      const { lane } = await http.openLane(team, { title, stakes: 'normal' });
      return { id: lane.id, openedAt: decodeTime(lane.id) };
    },
    abandonLane: async (id) => {
      await http.updateLane(team, id, { state: 'abandoned', abandon_reason: 'tour reset' });
    },
    laneDetail: async (id) => {
      const { lanes } = await http.laneBoard(team, {});
      return lanes.find((l) => l.id === id)?.detail ?? '';
    },
    request: (agent, body) =>
      send({
        id: ulid(),
        team,
        from: me,
        to: { kind: 'member', name: agent },
        act: 'request_help',
        body,
        thread: null,
        meta: null,
      }),
    verdict: async (askId, accept, note) => {
      await send({
        id: ulid(),
        team,
        from: me,
        to: { kind: 'team' },
        act: accept ? 'accept' : 'decline',
        body: note || (accept ? 'accepted in the tour' : 'sent back in the tour'),
        thread: null,
        meta: { in_reply_to: askId },
      });
    },
    messagesSince: async (since) => (await http.messages(team, { since, limit: 200 })).messages,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  const ui: TourUi = {
    // clack draws a note as wide as its longest line; the box adds 6 columns, a log line 3.
    show: (title, body) => p.note(wrapBody(body, termWidth() - 6), title),
    hint: (text) => p.log.info(pc.dim(wrapBody(text, termWidth() - 3))),
    pressEnter: async () => {
      const go = await p.confirm({ message: 'Continue?', initialValue: true });
      return !p.isCancel(go) && go;
    },
    pickAgent: async (names) => {
      const pick = await p.select({
        message: TOUR_MESSAGES.pickAgent,
        options: names.map((n) => ({ value: n, label: n })),
      });
      return p.isCancel(pick) ? null : pick;
    },
    judge: async (summary) => {
      p.log.message(wrapBody(summary, termWidth() - 3) || pc.dim('(the lane has no summary yet)'));
      const accept = await p.select({
        message: 'Your verdict',
        options: [
          { value: true, label: 'Accept it' },
          { value: false, label: 'Send it back with a note' },
        ],
      });
      if (p.isCancel(accept)) return null;
      if (accept) return { accept: true, note: '' };
      const note = await p.text({ message: 'What should change?' });
      return p.isCancel(note) ? null : { accept: false, note };
    },
    afterDecline: async () => {
      const next = await p.select({
        message: 'What now?',
        options: [
          { value: 'skip' as const, label: 'See the record' },
          { value: 'quit' as const, label: 'Stop here' },
        ],
      });
      return p.isCancel(next) ? 'quit' : next;
    },
  };

  p.intro(pc.yellow('musterd tour'));
  return runTour(port, ui, me, { reset: Boolean(parsed.flags['reset']), pollMs: POLL_MS });
}
