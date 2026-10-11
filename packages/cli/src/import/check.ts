import type { LaneStakes } from '@musterd/protocol';
import type { Diagnostic, ImportRow } from './rows.js';

/**
 * The board half of `musterd import` (spec 2026-10-10 §"Step 1"). The server checks neither that a
 * lane's depends_on ids exist (store/lanes.ts stores them as given) nor that a goal id is new (a
 * re-declaration amends it, latest wins — store/goals.ts), so both guards live here.
 */
export type LaneDep = { kind: 'existing'; id: string } | { kind: 'staged'; ref: string };

export interface PlannedGoal {
  ref: string;
  row: number;
  id: string;
  title: string;
  story?: string;
  depends_on: string[];
  source_ref?: string;
}

export interface PlannedLane {
  ref: string;
  row: number;
  title: string;
  detail?: string;
  goal_id?: string;
  depends_on: LaneDep[];
  stakes?: LaneStakes;
}

export interface BoardSnapshot {
  goals: { id: string }[];
  lanes: { id: string; title: string; state: string }[];
}

export interface ImportPlan {
  goals: PlannedGoal[];
  lanes: PlannedLane[];
  linkedGoals: string[];
  diagnostics: Diagnostic[];
}

const CLOSED = new Set(['done', 'abandoned']);

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function checkAgainstBoard(rows: ImportRow[], board: BoardSnapshot): ImportPlan {
  const diagnostics: Diagnostic[] = [];
  const boardGoals = new Set(board.goals.map((g) => g.id));
  const boardLanes = new Set(board.lanes.map((l) => l.id));
  const openTitles = new Set(
    board.lanes.filter((l) => !CLOSED.has(l.state)).map((l) => normalizeTitle(l.title)),
  );

  const goalRows = rows.filter((r) => r.kind === 'goal');
  const laneRows = rows.filter((r) => r.kind === 'lane');
  const fileGoalKeys = new Set(goalRows.map((r) => r.key!));
  const laneRefByKey = new Map(
    laneRows.filter((r) => r.key).map((r) => [r.key!, `lane:${r.key!}`]),
  );

  const linkedGoals: string[] = [];
  const goals: PlannedGoal[] = [];
  for (const r of goalRows) {
    const id = r.key!;
    if (boardGoals.has(id)) {
      linkedGoals.push(id);
      diagnostics.push(
        warn(
          r.row,
          'goal_exists',
          `goal "${id}" is already on the board — lanes link to it; it is not re-declared`,
        ),
      );
      continue;
    }
    const deps: string[] = [];
    for (const d of r.depends_on) {
      if (fileGoalKeys.has(d) || boardGoals.has(d)) deps.push(d);
      else
        diagnostics.push(
          err(
            r.row,
            'unresolved_dependency',
            `goal dependency "${d}" is not a goal in this file or on the board`,
          ),
        );
    }
    goals.push({
      ref: `goal:${id}`,
      row: r.row,
      id,
      title: r.title,
      depends_on: deps,
      ...(r.story ? { story: r.story } : {}),
      ...(r.source_ref ? { source_ref: r.source_ref } : {}),
    });
  }

  const lanes: PlannedLane[] = [];
  for (const r of laneRows) {
    const ref = r.key ? `lane:${r.key}` : `lane@${String(r.row)}`;
    const lane: PlannedLane = { ref, row: r.row, title: r.title, depends_on: [] };
    if (r.goal !== undefined) {
      if (fileGoalKeys.has(r.goal) || boardGoals.has(r.goal)) lane.goal_id = r.goal;
      else
        diagnostics.push(
          err(
            r.row,
            'unresolved_goal',
            `goal "${r.goal}" is not a goal in this file or on the board`,
          ),
        );
    }
    for (const d of r.depends_on) {
      const staged = laneRefByKey.get(d);
      if (staged) lane.depends_on.push({ kind: 'staged', ref: staged });
      else if (boardLanes.has(d)) lane.depends_on.push({ kind: 'existing', id: d });
      else
        diagnostics.push(
          err(
            r.row,
            'unresolved_dependency',
            `lane dependency "${d}" is not a lane key in this file or a lane on the board (use the full lane id)`,
          ),
        );
    }
    if (openTitles.has(normalizeTitle(r.title)))
      diagnostics.push(
        warn(
          r.row,
          'likely_duplicate',
          `an open lane on the board has the same title: "${r.title}"`,
        ),
      );
    if (lane.goal_id === undefined && r.goal === undefined)
      diagnostics.push(warn(r.row, 'no_goal', 'lane has no goal'));
    const detail = [r.detail, r.source_ref ? `Source: ${r.source_ref}` : undefined]
      .filter(Boolean)
      .join('\n\n');
    if (detail) lane.detail = detail;
    if (r.stakes) lane.stakes = r.stakes;
    lanes.push(lane);
  }

  const goalOrder = topo(goals, (g) =>
    g.depends_on.filter((d) => fileGoalKeys.has(d) && !boardGoals.has(d)).map((d) => `goal:${d}`),
  );
  const laneOrder = topo(lanes, (l) =>
    l.depends_on.flatMap((d) => (d.kind === 'staged' ? [d.ref] : [])),
  );
  for (const cyc of [goalOrder.cycle, laneOrder.cycle]) {
    if (cyc.length > 0)
      diagnostics.push(
        err(cyc[0]!, 'dependency_cycle', `dependency cycle among lines ${cyc.join(', ')}`),
      );
  }

  diagnostics.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { goals: goalOrder.items, lanes: laneOrder.items, linkedGoals, diagnostics };
}

/** Stable Kahn sort; on a cycle returns input order plus the rows left in the cycle. */
function topo<T extends { ref: string; row: number }>(
  items: T[],
  deps: (t: T) => string[],
): { items: T[]; cycle: number[] } {
  const byRef = new Map(items.map((t) => [t.ref, t]));
  const placed = new Set<string>();
  const out: T[] = [];
  let progress = true;
  while (out.length < items.length && progress) {
    progress = false;
    for (const t of items) {
      if (placed.has(t.ref)) continue;
      if (deps(t).every((d) => placed.has(d) || !byRef.has(d))) {
        placed.add(t.ref);
        out.push(t);
        progress = true;
      }
    }
  }
  if (out.length === items.length) return { items: out, cycle: [] };
  return { items, cycle: items.filter((t) => !placed.has(t.ref)).map((t) => t.row) };
}

const err = (row: number, code: string, message: string): Diagnostic => ({
  level: 'error',
  row,
  code,
  message,
});
const warn = (row: number, code: string, message: string): Diagnostic => ({
  level: 'warning',
  row,
  code,
  message,
});
