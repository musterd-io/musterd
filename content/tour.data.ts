/**
 * The first-run tour's script — the single source for both tours (spec
 * docs/superpowers/specs/2026-10-10-first-run-tour-design.md). `pnpm tour:gen` copies it into the
 * CLI; the web build reads it at build-prep. Edit here, then regenerate; `tour:check` fails on drift.
 * Copy rules: brand.md §4 (no contrast frame), ADR 550 §3 ("opened by", never "asked by").
 */
export type TourStepId =
  | 'what'
  | 'team'
  | 'give_work'
  | 'claims'
  | 'hands_back'
  | 'judge'
  | 'record'
  | 'add_seat'
  | 'next';
export type TourWait =
  | 'continue'
  | 'none'
  | 'lane_opened'
  | 'lane_claimed'
  | 'awaiting_you'
  | 'verdict';
export interface TourHint {
  afterMs: number;
  text: string;
}
export interface TourStep {
  id: TourStepId;
  title: string;
  body: string[];
  wait: TourWait;
  hints: TourHint[];
}

export const TOUR_LANE_PREFIX = '[tour]';
/** `{you}` keeps two people's tours apart on one team; resume finds a lane by this exact title. */
export const TOUR_LANE_TITLE = `${TOUR_LANE_PREFIX} {you}: summarise this repo's README in three lines`;

export const TOUR_REQUEST =
  '{you} is taking the musterd tour, and this is your part. Claim lane {lane} with lane_claim. ' +
  "Read this repo's README and write a three-line summary of it into the lane's detail with " +
  "lane_update. Change no files. Then submit it to {you}: lane_submit {id: '{lane}', acceptor: '{you}'}. " +
  '{you} will accept it or send it back. Wait for that verdict, and leave the lane open until it comes.';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'what',
    title: 'What musterd is',
    wait: 'continue',
    hints: [],
    body: [
      'musterd makes your agents accountable.',
      'Your agents and the people you work with join one team as named members. Every piece of work ' +
        'carries its chain: who opened it, who claimed it, which model did it, and who accepted it.',
      'In the next few minutes you give {agent} a small piece of work and judge what comes back.',
    ],
  },
  {
    id: 'team',
    title: 'Your team',
    wait: 'none',
    hints: [],
    body: [
      'This is your roster. You and {agent} are both members, each with a name that stays.',
      '{agent} is running {model}. The harness reports the model; the agent does not choose what it says.',
    ],
  },
  {
    id: 'give_work',
    title: 'Give it work',
    wait: 'lane_opened',
    hints: [],
    body: [
      'Work on musterd is a lane: one claimed unit of work with an owner.',
      "The tour opens one for you, in your name: summarise this repo's README in three lines. No files change.",
    ],
  },
  {
    id: 'claims',
    title: 'It claims it',
    wait: 'lane_claimed',
    body: [
      'The tour has asked {agent} to claim lane {lane}.',
      'Claiming is how a member says "this one is mine". When two members reach for the same work, the claim shows it first.',
    ],
    hints: [
      {
        afterMs: 60_000,
        text: "Still waiting. Switch to {agent}'s window and say: check your inbox.",
      },
      {
        afterMs: 180_000,
        text: '{agent} can take a few minutes to wake. The tour waits as long as it takes. Ctrl-C to stop; `musterd tour` picks up where you left off.',
      },
    ],
  },
  {
    id: 'hands_back',
    title: 'It hands it back',
    wait: 'awaiting_you',
    hints: [
      {
        afterMs: 180_000,
        text: '{agent} is still working. Switch to its window if you want to watch.',
      },
    ],
    body: [
      '{agent} claimed it. It is doing the work now, then it submits the lane to you.',
      'Submitting asks a different member to judge the work. Nobody accepts their own.',
    ],
  },
  {
    id: 'judge',
    title: 'You judge it',
    wait: 'verdict',
    hints: [],
    body: ['{agent} says the work is done. Here is what it wrote:'],
  },
  {
    id: 'record',
    title: 'The record',
    wait: 'none',
    hints: [],
    body: [
      'This is the chain the team keeps for lane {lane}:',
      'opened by {you} · claimed by {agent} · model {model} · {verdict}',
      'Every lane on the team carries the same chain, whoever does the work.',
    ],
  },
  {
    id: 'add_seat',
    title: 'When to add a seat',
    wait: 'continue',
    hints: [],
    body: [
      'Add a seat when you want one of these:',
      '  More capacity: a second piece of work, built, researched or brainstormed in parallel.',
      '  A different model: another perspective, or a model you want to try.',
      '  A role the team lacks: a domain or a responsibility nobody holds yet.',
      'One command does it: musterd agent <name>',
      'Ideas we have not tested with a new team yet: a reviewer on a different model, a second tool ' +
        'joining, a teammate bringing their own agent.',
    ],
  },
  {
    id: 'next',
    title: 'Where to go next',
    wait: 'none',
    hints: [],
    body: [
      "musterd board          the team's work, in your browser",
      'musterd live           watch the team at work',
      'musterd inbox --watch  stay present and see acts as they arrive',
    ],
  },
];

export const TOUR_MESSAGES = {
  noAgent:
    'No agent on your team yet. Open your agent in this folder, or add one: musterd agent <name>',
  pickAgent: 'Which agent should take the tour lane?',
  declined: '{agent} said no to lane {lane}:',
  selfClosed: '{agent} closed lane {lane} itself before you judged it. The record shows that too.',
  sentBack: 'Sent back to {agent} with your note. It will submit again.',
} as const;

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
