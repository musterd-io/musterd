import { isObligationAct, type Envelope, type Lane } from '@musterd/protocol';
import type { MusterdClient } from '../client.js';

/**
 * One call orients a seat (lane 01M5N4ED6T, finding 022 follow-up). On CooperBench core, 27 of
 * 100 board / status / plain-inbox reads were an agent orienting before its first claim, in
 * separate calls: roster, board, inbox. The join answer now carries the two things those reads
 * were after — who holds what on this project, and what waits for this seat — so a session is
 * oriented by the call that seated it. Most seats auto-claim (ADR 707) and never see a join
 * answer, so the same block rides the FIRST `team_inbox_check` of a session instead, lanes only
 * (that reply already renders the directed acts). Rendered once per session, like the style
 * block (ADR 514 inc 3).
 *
 * Cost, priced the way finding 019 prices everything (cost ≈ calls × context): the block is at
 * most `MAX_LANES` + `MAX_DIRECTED` lines, ~40 tokens each — under 1k tokens once. The three
 * calls it replaces each re-read the whole context (42–62k tokens on the pilot) and `lane_board`
 * alone rendered every lane on the team, 50+ lines on revive. Removing one call pays for the
 * block many times over.
 */

/** In-flight states a teammate holds: what an arriving seat must not build in. */
const HELD_STATES: readonly string[] = ['claimed', 'active', 'blocked', 'awaiting_acceptance'];

export const MAX_LANES = 12;
export const MAX_DIRECTED = 6;
const TITLE_MAX = 90;
const BODY_MAX = 90;

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function scopeOf(lane: Lane): string {
  const scope = lane.scope ?? [];
  if (scope.length === 0) return '';
  const shown = scope.slice(0, 2).join(', ');
  const more = scope.length > 2 ? ` +${scope.length - 2}` : '';
  return ` · ${shown}${more}`;
}

export interface OrientationInput {
  /** This workspace's project (the lane filter). */
  project: string;
  /** Lanes the daemon returned for `project` — every state; this module picks the held ones. */
  lanes: readonly Lane[];
  /** Unread acts peeked (not marked read): only the directed obligations render. Omit on the
   *  inbox path, whose reply already carries them. */
  unread?: readonly Envelope[] | undefined;
  /** This seat — its own held lanes render first, marked `(yours)`. */
  me?: string | undefined;
}

/** The directed, still-owed acts among `unread` — what the inbox tool pins (ADR 599 shape). */
export function directedOwed(unread: readonly Envelope[]): Envelope[] {
  return unread.filter((e) => e.to?.kind === 'member' && isObligationAct(e.act, true));
}

/**
 * The block. Empty string when there is nothing to say (no held lanes, no open lanes, no directed
 * acts) — a seat on a quiet team pays nothing.
 */
export function renderOrientation(input: OrientationInput): string {
  const held = input.lanes
    .filter((l) => HELD_STATES.includes(l.state) && l.owner_seat !== null)
    .sort((a, b) => {
      const mineA = a.owner_seat === input.me ? 0 : 1;
      const mineB = b.owner_seat === input.me ? 0 : 1;
      return mineA - mineB || (b.updated_at ?? 0) - (a.updated_at ?? 0);
    });
  const open = input.lanes.filter((l) => l.state === 'open' && l.owner_seat === null).length;
  const directed = input.unread ? directedOwed(input.unread) : [];
  if (held.length === 0 && open === 0 && directed.length === 0) return '';

  const lines: string[] = [`Orientation — ${input.project} now:`];
  if (held.length > 0) {
    lines.push(`held lanes (${held.length}) — never build in one a teammate owns:`);
    for (const l of held.slice(0, MAX_LANES)) {
      const who = l.owner_seat === input.me ? `${l.owner_seat} (yours)` : l.owner_seat;
      lines.push(`  ${l.id} [${l.state}] "${clip(l.title, TITLE_MAX)}" — ${who}${scopeOf(l)}`);
    }
    if (held.length > MAX_LANES) lines.push(`  +${held.length - MAX_LANES} more — lane_board`);
  }
  lines.push(
    open > 0
      ? `open lanes: ${open} claimable on ${input.project} — team_next ranks them; lane_claim before you build`
      : `open lanes: none on ${input.project} — lane_open declares your work`,
  );
  if (directed.length > 0) {
    lines.push(`directed acts waiting on you (${directed.length}):`);
    for (const e of directed.slice(0, MAX_DIRECTED))
      lines.push(`  ${e.from} · ${e.act} · ${e.id}: ${clip(e.body, BODY_MAX)}`);
    if (directed.length > MAX_DIRECTED)
      lines.push(`  +${directed.length - MAX_DIRECTED} more — team_inbox_check`);
    lines.push(
      'answer them with team_send {reply_to}; team_inbox_check marks them read and shows the rest.',
    );
  }
  return lines.join('\n');
}

/** Sessions whose orientation has rendered — once per client, like the style block. */
const shown = new WeakSet<object>();

export function orientationShown(client: object): boolean {
  return shown.has(client);
}
export function markOrientationShown(client: object): void {
  shown.add(client);
}
/** Test seam. */
export function resetOrientationShown(client: object): void {
  shown.delete(client);
}

type OrientClient = Pick<MusterdClient, 'laneBoard' | 'fetchInbox' | 'member'>;

/**
 * Fetch and render the block for a seated client, once per session. Degrades to '' when a read
 * fails — orientation is a convenience over the reads the seat could still make itself, never a
 * reason the join or inbox call fails. `withDirected: false` is the inbox path (that reply already
 * renders the directed acts).
 */
export async function orientationBlock(
  client: OrientClient,
  project: string,
  opts: { withDirected: boolean },
): Promise<string> {
  if (shown.has(client)) return '';
  markOrientationShown(client);
  const [lanes, unread] = await Promise.all([
    Promise.resolve()
      .then(() => client.laneBoard({ project }))
      .then((r) => r.lanes)
      .catch(() => [] as Lane[]),
    opts.withDirected
      ? Promise.resolve()
          // peek: the daemon does not count this as showing the acts, so they stay unread for
          // the inbox check that marks them (doorbell clause 7(iv)).
          .then(() => client.fetchInbox(true, 50, true))
          .then((r) => r.messages)
          .catch(() => [] as Envelope[])
      : Promise.resolve(undefined),
  ]);
  return renderOrientation({ project, lanes, unread, me: client.member });
}
