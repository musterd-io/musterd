import { createHash } from 'node:crypto';
import type { HttpClient } from '../../client.js';
import { checkAgainstBoard } from '../check.js';
import { renderPreview } from '../render.js';
import type { Diagnostic } from '../rows.js';
import { createStage } from '../stage.js';
import { issuesToRows } from './rows.js';
import { absentRefs, planSync } from './sync.js';
import type { TrackerSource, UpstreamState } from './types.js';

/**
 * `musterd import github|linear|jira` (spec 2026-10-11 §2–3): fetch the open issues, ask each absent
 * board lane's issue for its state, plan the re-sync, and stage it — the same preview → save as a
 * file import. Every fetch happens before the stage is written, so a failure stages nothing.
 */
const LARGE_BACKLOG = 500;

/**
 * Checks that are noise for a tracker: a new issue in a group already on the board is meant to link
 * to it (`goal_exists`), and an issue with no group is ordinary (`no_goal`).
 */
const TRACKER_QUIET = new Set(['goal_exists', 'no_goal']);

export async function runTrackerImport(
  source: TrackerSource,
  ctx: {
    ws: string;
    team: string;
    http: Pick<HttpClient, 'goals' | 'laneBoard'>;
    project: string;
    /** The command tail that re-runs this import, e.g. `github acme/app`. */
    rerun: string;
    limit?: number;
  },
): Promise<number> {
  const open = await source.open(ctx.limit);
  const [goals, board] = await Promise.all([
    ctx.http.goals(ctx.team),
    ctx.http.laneBoard(ctx.team, { history: true }),
  ]);
  const upstream: Record<string, UpstreamState> = {};
  // One request per lane whose issue left the open set, in turn — never a burst at the tracker.
  for (const ref of absentRefs(source, open, board.lanes, ctx.project))
    upstream[ref] = await source.state(ref);

  const sync = planSync({ source, open, lanes: board.lanes, project: ctx.project, upstream });
  const plan = checkAgainstBoard(issuesToRows(sync.fresh), {
    goals: goals.goals,
    lanes: board.lanes,
  });
  const notes: Diagnostic[] = [];
  if (ctx.limit !== undefined && open.length >= ctx.limit)
    notes.push({
      level: 'warning',
      row: null,
      code: 'large_backlog',
      message: `stopped at --limit ${String(ctx.limit)} — open issues past it are not imported`,
    });
  else if (open.length > LARGE_BACKLOG)
    notes.push({
      level: 'warning',
      row: null,
      code: 'large_backlog',
      message: `${String(open.length)} open issues — pass --limit N to bring in fewer`,
    });

  const stage = createStage(
    ctx.ws,
    {
      team: ctx.team,
      project: ctx.project,
      created_at: Date.now(),
      source: {
        path: ctx.rerun,
        sha256: createHash('sha256').update(JSON.stringify(open)).digest('hex'),
        format: source.tracker,
      },
      goals: plan.goals,
      lanes: plan.lanes,
      linked_goals: plan.linkedGoals,
      diagnostics: [
        ...notes,
        ...sync.warnings,
        ...plan.diagnostics.filter((d) => !TRACKER_QUIET.has(d.code)),
      ],
      sync: { actions: sync.actions, unchanged: sync.unchanged },
    },
    Date.now(),
  );
  process.stdout.write(renderPreview(stage) + '\n');
  return stage.diagnostics.some((d) => d.level === 'error') ? 1 : 0;
}
