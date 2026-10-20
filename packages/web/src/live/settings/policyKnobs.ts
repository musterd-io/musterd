import type { TeamPolicyRead } from '../client';

/**
 * The team policy knobs the settings overlay offers, in plain groups (nick, 2026-10-19). Each knob
 * is a path into the policy doc, so one table drives the read (the dense effective `policy`), the
 * "set for the team / default" tag (presence in the sparse `stored` doc, ADR 185), and the write.
 *
 * Bounds mirror `PolicySchema` in @musterd/protocol (credentials.ts, residency.ts). The daemon parses
 * every write and refuses out-of-range values, so these only shape the inputs — they are not the
 * check. Secrets (relay tokens, webhook URLs, the bot token) are deliberately absent: the overlay
 * never renders them and round-trips them untouched inside `stored`.
 */

export type KnobKind =
  | { type: 'bool' }
  | { type: 'enum'; options: readonly { value: string; label: string }[] }
  | { type: 'int'; min: number; max: number; unit?: string }
  /** Milliseconds on the wire, minutes in the input. */
  | { type: 'minutes'; min: number; max: number }
  /** USD; `optional` knobs have no default — clearing one stores nothing (unbounded). */
  | { type: 'usd'; max: number };

export interface Knob {
  path: readonly string[];
  label: string;
  hint: string;
  kind: KnobKind;
  /** No schema default: absent means "not set" (unbounded, today's behaviour). */
  optional?: boolean;
}

export interface KnobGroup {
  id: string;
  title: string;
  lede: string;
  knobs: Knob[];
}

const MIN = 60_000;

export const POLICY_GROUPS: KnobGroup[] = [
  {
    id: 'waking',
    title: 'Waking agents',
    lede: 'When the daemon may wake a seat, and how hard it tries.',
    knobs: [
      {
        path: ['residency', 'idle_wake'],
        label: 'Wake an idle session',
        hint: 'An open session sitting at its prompt is pushed a turn when an act is addressed to it.',
        kind: { type: 'bool' },
      },
      {
        path: ['residency', 'flow'],
        label: 'Board loops may wake seats',
        hint: 'On: the review and dispatch loops can wake a seat with work, where the loop is switched on.',
        kind: {
          type: 'enum',
          options: [
            { value: 'manual', label: 'off' },
            { value: 'auto', label: 'on' },
          ],
        },
      },
      {
        path: ['residency', 'cooldown_ms'],
        label: 'Rest between batched wakes',
        hint: 'Per seat.',
        kind: { type: 'minutes', min: 1, max: 1440 },
      },
      {
        path: ['residency', 'hourly_cap'],
        label: 'Wakes per hour',
        hint: 'Per seat.',
        kind: { type: 'int', min: 1, max: 20 },
      },
      {
        path: ['residency', 'attempt_cap'],
        label: 'Tries per act',
        hint: 'Before a wake that keeps failing gives up.',
        kind: { type: 'int', min: 1, max: 10 },
      },
      {
        path: ['residency', 'work_timeout_ms'],
        label: 'Longest work wake',
        hint: 'A coding session from the board is stopped after this.',
        kind: { type: 'minutes', min: 1, max: 60 },
      },
    ],
  },
  {
    id: 'spend',
    title: 'Spend',
    lede: 'What a wake may cost, and what the team allows in a week.',
    knobs: [
      {
        path: ['residency', 'budget_usd'],
        label: 'Flag a wake over',
        hint: 'Shown in the report. Nothing is stopped mid-run.',
        kind: { type: 'usd', max: 100 },
        optional: true,
      },
      {
        path: ['spend_cap_usd'],
        label: 'Weekly team cap',
        hint: 'Shown against the last 7 days of priced wakes. Nothing is refused on it.',
        kind: { type: 'usd', max: 1_000_000 },
        optional: true,
      },
      {
        path: ['spend_approval_usd'],
        label: 'Ask a human above',
        hint: 'Per wake.',
        kind: { type: 'usd', max: 1_000_000 },
        optional: true,
      },
      {
        path: ['unpriced_wake_cap'],
        label: 'Unpriced wakes a week',
        hint: 'Wakes on a harness with no price row. 0 blocks them.',
        kind: { type: 'int', min: 0, max: 10_000 },
        optional: true,
      },
      {
        path: ['residency', 'dream_enabled'],
        label: 'Dream after hours',
        hint: 'An idle seat is woken outside working hours to re-read the day.',
        kind: { type: 'bool' },
      },
      {
        path: ['residency', 'dream_nightly_wakes'],
        label: 'Dreams a night',
        hint: 'Per seat.',
        kind: { type: 'int', min: 1, max: 3 },
      },
      {
        path: ['residency', 'dream_budget_usd'],
        label: 'Nightly dream ceiling',
        hint: 'Per seat. Reaching it stops the next dream, never the current one.',
        kind: { type: 'usd', max: 100 },
        optional: true,
      },
    ],
  },
  {
    id: 'acceptance',
    title: 'Acceptance & asks',
    lede: 'How long landed work waits for a verdict, and where unanswered asks go.',
    knobs: [
      {
        path: ['acceptance_review_window_ms'],
        label: 'Review window',
        hint: 'How long an acceptance ask waits before the owner may close on silence.',
        kind: { type: 'minutes', min: 1, max: 1440 },
      },
      {
        path: ['ask_fallback_to_nonadmin'],
        label: 'Unanswered asks reach everyone',
        hint: 'After the tier timeout, non-admin humans get it too.',
        kind: { type: 'bool' },
      },
      {
        path: ['challenge_evidence_rail'],
        label: 'Concessions name a check',
        hint: 'Warn an agent that gives in to a challenge without saying what it checked.',
        kind: { type: 'bool' },
      },
    ],
  },
  {
    id: 'huddles',
    title: 'Huddles',
    lede: 'Seats that collide on the same work.',
    knobs: [
      {
        path: ['residency', 'convene_huddles'],
        label: 'Call a huddle',
        hint: 'Wake the seats in a collision to sort it out together.',
        kind: { type: 'bool' },
      },
    ],
  },
  {
    id: 'joining',
    title: 'Joining the team',
    lede: 'How seats and invitees get in.',
    knobs: [
      {
        path: ['standing_reseat_known_agents'],
        label: 'Known agents re-seat',
        hint: 'An agent returning to its own seat gets in without an admin.',
        kind: { type: 'bool' },
      },
      {
        path: ['allow_pre_issued_grants'],
        label: 'Pre-issued grants',
        hint: 'A claim with a grant skips the request round-trip.',
        kind: { type: 'bool' },
      },
      {
        path: ['invite_requires_expiry'],
        label: 'Invites must expire',
        hint: 'Refuse an invite with no end date.',
        kind: { type: 'bool' },
      },
      {
        path: ['agent_connect'],
        label: 'Agent connect links',
        hint: 'Who may hand a sponsored agent to a new device. Anyone needs expiring invites.',
        kind: {
          type: 'enum',
          options: [
            { value: 'sponsor', label: 'its sponsor' },
            { value: 'any_member', label: 'any member' },
          ],
        },
      },
      {
        path: ['sponsored_agent_cap'],
        label: 'Agents per sponsor',
        hint: 'Live member-created agents.',
        kind: { type: 'int', min: 1, max: 100 },
      },
    ],
  },
];

type Doc = Record<string, unknown>;

function at(doc: unknown, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Doc)[key];
  }
  return cur;
}

/** The knob's effective value — from the dense `policy` the daemon answered. */
export function knobValue(read: TeamPolicyRead, knob: Knob): unknown {
  return at(read.policy, knob.path);
}

/** Chosen for this team, or the shipped default? Presence in the sparse doc is the answer (ADR 185). */
export function knobIsSet(read: TeamPolicyRead, knob: Knob): boolean {
  return at(read.stored, knob.path) !== undefined;
}

/**
 * The stored doc with one knob set — or, with `undefined`, dropped back to its default. Every other
 * key, secrets included, rides along untouched: `POST /policy` replaces the whole doc, and a key
 * left out resets (ADR 185). A sub-block left empty is dropped whole. Nothing here mutates.
 */
export function withKnob(
  stored: TeamPolicyRead['stored'],
  path: readonly string[],
  value: unknown,
): TeamPolicyRead['stored'] {
  const [head, ...rest] = path;
  if (head === undefined) return stored;
  const next: Doc = { ...stored };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = typeof next[head] === 'object' && next[head] !== null ? (next[head] as Doc) : {};
  const merged = withKnob(child as TeamPolicyRead['stored'], rest, value) as Doc;
  if (Object.keys(merged).length === 0) delete next[head];
  else next[head] = merged;
  return next;
}

/** What the input shows for a wire value. */
export function toInput(kind: KnobKind, value: unknown): string {
  if (typeof value !== 'number') return '';
  return kind.type === 'minutes' ? String(Math.round(value / MIN)) : String(value);
}

/**
 * Parse what was typed back to the wire value: a number in range, or `undefined` for a blank optional
 * knob (unset), or an error line to show instead of sending a write the daemon would refuse anyway.
 */
export function fromInput(
  knob: Knob,
  text: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return knob.optional ? { ok: true, value: undefined } : { ok: false, error: 'needs a value' };
  }
  const n = Number(trimmed);
  const { kind } = knob;
  if (!Number.isFinite(n)) return { ok: false, error: 'a number' };
  switch (kind.type) {
    case 'int':
      if (!Number.isInteger(n) || n < kind.min || n > kind.max)
        return { ok: false, error: `${kind.min}–${kind.max}` };
      return { ok: true, value: n };
    case 'minutes':
      if (!Number.isInteger(n) || n < kind.min || n > kind.max)
        return { ok: false, error: `${kind.min}–${kind.max} min` };
      return { ok: true, value: n * MIN };
    case 'usd':
      if (n <= 0 || n > kind.max) return { ok: false, error: `over $0, at most $${kind.max}` };
      return { ok: true, value: n };
    default:
      return { ok: false, error: 'not a number knob' };
  }
}
