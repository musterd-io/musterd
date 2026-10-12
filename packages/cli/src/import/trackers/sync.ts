import type { Diagnostic } from '../rows.js';
import type { TrackerIssue, TrackerSource, UpstreamState } from './types.js';

/**
 * Re-sync (spec 2026-10-11 §3): running `musterd import <tracker>` again compares the open issues
 * with the board's live lanes for this source and gives each one action. Pure — the caller fetches
 * the open set, asks `state()` for every `absentRefs` lane, and hands both in.
 *
 * Only lanes neither done nor abandoned are read, and only those whose ref this source owns. A lane
 * is never abandoned on the open list alone: an absent issue needs its own `closed` answer.
 */
export interface BoardLane {
  id: string;
  title: string;
  state: string;
  owner_seat: string | null;
  project: string;
  detail: string | null;
  source_ref?: string | null | undefined;
}

export interface SyncAction {
  kind: 'rename' | 'abandon' | 'adopt';
  lane_id: string;
  ref: string;
  /** rename: the issue's title now. */
  title?: string;
  /** rename and abandon: the lane's title at preview (the preview's row reads it). */
  from?: string;
  /** abandon: `closed in GitHub (acme/app#9)`. */
  reason?: string;
}

export interface SyncPlan {
  /** Open upstream with no live lane: these go through `issuesToRows` and the file import's check. */
  fresh: TrackerIssue[];
  actions: SyncAction[];
  unchanged: number;
  /** `closed_held`, `not_found`, `duplicate_ref` — each leaves its lanes alone. */
  warnings: Diagnostic[];
}

type Source = Pick<TrackerSource, 'tracker' | 'label' | 'scope' | 'ownsRef'>;

const CLOSED = new Set(['done', 'abandoned']);
/** States an abandon may take a lane from: nobody is on it. */
const UNHELD = new Set(['open', 'parked']);
// Phase 1 appended `Source: <ref>` as the detail's last line. Only that position counts: a line the
// same shape anywhere else (quoted text, a pasted issue body) must not tie a lane to an issue.
const LEGACY_SOURCE_RE = /(?:^|\n)Source: (\S+)\s*$/;

interface Owned {
  lane: BoardLane;
  ref: string;
  /** No `source_ref` yet — the ref came from phase 1's `Source:` detail line. */
  legacy: boolean;
}

function refOf(source: Source, lane: BoardLane, project: string): Owned | null {
  let ref = lane.source_ref ?? null;
  let legacy = false;
  if (!ref) {
    const m = LEGACY_SOURCE_RE.exec(lane.detail ?? '');
    if (!m) return null;
    ref = m[1]!;
    legacy = true;
    // The skill's GitHub ref named no repo; it is this repo's only on this repo's project.
    const gh = /^github#(\d+)$/.exec(ref);
    if (gh) {
      if (source.tracker !== 'github' || lane.project !== project) return null;
      ref = `${source.scope}#${gh[1]!}`;
    }
  }
  return source.ownsRef(ref) ? { lane, ref, legacy } : null;
}

function ownedByRef(source: Source, lanes: BoardLane[], project: string): Map<string, Owned[]> {
  const byRef = new Map<string, Owned[]>();
  for (const lane of lanes) {
    if (CLOSED.has(lane.state)) continue;
    const owned = refOf(source, lane, project);
    if (!owned) continue;
    byRef.set(owned.ref, [...(byRef.get(owned.ref) ?? []), owned]);
  }
  return byRef;
}

export function absentRefs(
  source: Source,
  open: TrackerIssue[],
  lanes: BoardLane[],
  project: string,
): string[] {
  const openRefs = new Set(open.map((i) => i.ref));
  return [...ownedByRef(source, lanes, project).keys()].filter((ref) => !openRefs.has(ref));
}

export function planSync(input: {
  source: Source;
  open: TrackerIssue[];
  lanes: BoardLane[];
  project: string;
  upstream: Record<string, UpstreamState>;
}): SyncPlan {
  const { source, open, upstream } = input;
  const byRef = ownedByRef(source, input.lanes, input.project);
  const plan: SyncPlan = { fresh: [], actions: [], unchanged: 0, warnings: [] };
  const warn = (code: string, message: string) =>
    plan.warnings.push({ level: 'warning', row: null, code, message });

  // A ref two live lanes hold (two machines opened it at once, ADR 561): name it, touch neither.
  const single = new Map<string, Owned>();
  for (const [ref, owners] of byRef) {
    if (owners.length === 1) single.set(ref, owners[0]!);
    else
      warn(
        'duplicate_ref',
        `${ref} is held by ${String(owners.length)} live lanes (${owners.map((o) => o.lane.id).join(', ')}) — left alone; abandon all but one`,
      );
  }

  const openRefs = new Set<string>();
  for (const issue of open) {
    openRefs.add(issue.ref);
    if (byRef.has(issue.ref) && !single.has(issue.ref)) continue;
    const owned = single.get(issue.ref);
    if (!owned) {
      plan.fresh.push(issue);
      continue;
    }
    const { lane } = owned;
    if (owned.legacy) plan.actions.push({ kind: 'adopt', lane_id: lane.id, ref: issue.ref });
    if (lane.title !== issue.title)
      plan.actions.push({
        kind: 'rename',
        lane_id: lane.id,
        ref: issue.ref,
        from: lane.title,
        title: issue.title,
      });
    else if (!owned.legacy) plan.unchanged += 1;
  }

  for (const [ref, owned] of single) {
    if (openRefs.has(ref)) continue;
    const { lane } = owned;
    const now = upstream[ref];
    if (now === 'closed') {
      if (lane.owner_seat === null && UNHELD.has(lane.state)) {
        if (owned.legacy) plan.actions.push({ kind: 'adopt', lane_id: lane.id, ref });
        plan.actions.push({
          kind: 'abandon',
          lane_id: lane.id,
          ref,
          from: lane.title,
          reason: `closed in ${source.label} (${ref})`,
        });
      } else
        warn(
          'closed_held',
          `${ref} closed upstream — lane ${lane.id} held by ${lane.owner_seat ?? lane.state}, left alone`,
        );
    } else if (now === 'not_found')
      warn(
        'not_found',
        `${ref} not found upstream (deleted, moved, or no access) — lane ${lane.id} left alone`,
      );
    // 'open' (it reopened between the list and the check) or no answer: leave it.
    else plan.unchanged += 1;
  }
  return plan;
}
