import type { DeclareGoal, OpenLane } from '@musterd/protocol';
import { CliError } from '../errors.js';
import type { LaneDep } from './check.js';
import { STAGE_TTL_MS, type ImportStage } from './stage.js';

/**
 * Step 2 of `musterd import` (spec 2026-10-10 §"Step 2"): goals, then lanes, in the order the stage
 * holds; each new id is persisted before the next call, so a re-run skips what exists instead of
 * creating it again. A goal that appeared on the board after the preview is linked, not re-declared
 * (a re-declaration amends it, latest wins) — the board is read once more at save time for that.
 */
export interface SavePort {
  goals(team: string): Promise<{ goals: { id: string }[] }>;
  declareGoal(team: string, body: DeclareGoal): Promise<{ id: string }>;
  openLane(team: string, body: OpenLane): Promise<{ lane: { id: string } }>;
}

export interface SaveResult {
  goals: { ref: string; id: string; resumed: boolean; linked?: boolean }[];
  lanes: { ref: string; id: string; title: string; resumed: boolean }[];
}

export function refusal(stage: ImportStage, team: string, now: number): string | null {
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  if (errors > 0)
    return `${String(errors)} error${errors === 1 ? '' : 's'} — fix the file and re-run \`musterd import <file>\``;
  if (stage.saved_at !== null) return `already saved ${new Date(stage.saved_at).toISOString()}`;
  if (stage.team !== team)
    return `staged for team "${stage.team}", this workspace is "${team}" — re-run \`musterd import <file>\` here`;
  // A save that already created something is finished, never re-imported: a fresh stage would not
  // know what this one created and would open it all again.
  const started = Object.keys(stage.created).length > 0;
  if (!started && now - stage.created_at > STAGE_TTL_MS)
    return 'older than 24 hours — re-run `musterd import <file>` to check it against the board again';
  return null;
}

export async function saveStage(
  input: ImportStage,
  opts: { team: string; port: SavePort; persist: (s: ImportStage) => void; now: () => number },
): Promise<SaveResult> {
  const why = refusal(input, opts.team, opts.now());
  if (why) throw new CliError(`import ${input.id} not saved: ${why}`, 2);
  const stage: ImportStage = {
    ...input,
    created: { ...input.created },
    linked_goals: [...input.linked_goals],
  };
  const result: SaveResult = { goals: [], lanes: [] };
  const total = stage.goals.length + stage.lanes.length;

  try {
    const onBoard = new Set((await opts.port.goals(opts.team)).goals.map((g) => g.id));
    for (const g of stage.goals) {
      const have = stage.created[g.ref];
      if (have) {
        result.goals.push({ ref: g.ref, id: have, resumed: true });
        continue;
      }
      if (onBoard.has(g.id)) {
        stage.created[g.ref] = g.id;
        stage.linked_goals.push(g.id);
        opts.persist(stage);
        result.goals.push({ ref: g.ref, id: g.id, resumed: false, linked: true });
        continue;
      }
      const body: DeclareGoal = { id: g.id, title: g.title };
      if (g.story) body.story = g.story;
      if (g.depends_on.length > 0) body.depends_on = g.depends_on;
      const goal = await opts.port.declareGoal(opts.team, body);
      stage.created[g.ref] = goal.id;
      opts.persist(stage);
      result.goals.push({ ref: g.ref, id: goal.id, resumed: false });
    }

    for (const l of stage.lanes) {
      const have = stage.created[l.ref];
      if (have) {
        result.lanes.push({ ref: l.ref, id: have, title: l.title, resumed: true });
        continue;
      }
      const body: OpenLane = { title: l.title, project: stage.project };
      if (l.detail) body.detail = l.detail;
      if (l.goal_id) body.goal_id = l.goal_id;
      if (l.stakes) body.stakes = l.stakes;
      if (l.depends_on.length > 0) body.depends_on = l.depends_on.map((d) => resolveDep(d, stage));
      const res = await opts.port.openLane(opts.team, body);
      stage.created[l.ref] = res.lane.id;
      opts.persist(stage);
      result.lanes.push({ ref: l.ref, id: res.lane.id, title: l.title, resumed: false });
    }
  } catch (err) {
    const done = Object.keys(stage.created).length;
    const cause = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `import ${stage.id} stopped after ${String(done)} of ${String(total)}: ${cause} — ` +
        `re-run \`musterd import save ${stage.id}\` to resume (do not re-import the file: ` +
        `what was created is recorded in this stage)`,
      1,
    );
  }

  stage.saved_at = opts.now();
  opts.persist(stage);
  return result;
}

function resolveDep(d: LaneDep, stage: ImportStage): string {
  if (d.kind === 'existing') return d.id;
  const id = stage.created[d.ref];
  if (!id)
    throw new Error(
      `import ${stage.id}: ${d.ref} was not created before a lane that depends on it`,
    );
  return id;
}
