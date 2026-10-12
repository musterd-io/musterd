import type { DeclareGoal, OpenLane, UpdateLane } from '@musterd/protocol';
import { CliError } from '../errors.js';
import type { LaneDep } from './check.js';
import { rerunCommand, STAGE_TTL_MS, type ImportStage } from './stage.js';
import type { SyncAction } from './trackers/sync.js';

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
  /**
   * ADR 561: the lanes carrying one issue ref — read when an open is refused because one does, and
   * just before a re-sync renames or abandons a lane.
   */
  laneBoard(
    team: string,
    q: { source_ref: string; history?: boolean },
  ): Promise<{ lanes: { id: string; state: string; owner_seat: string | null }[] }>;
  updateLane(team: string, id: string, patch: UpdateLane): Promise<unknown>;
}

export interface SaveResult {
  goals: { ref: string; id: string; resumed: boolean; linked?: boolean }[];
  /** `adopted`: the ref was already on the board (a 409 on open), so that lane was recorded instead. */
  lanes: { ref: string; id: string; title: string; resumed: boolean; adopted?: boolean }[];
  /** A tracker re-sync's actions on board lanes, in the order they ran (spec 2026-10-11 §3). */
  sync: { kind: SyncAction['kind']; lane_id: string; ok: boolean; note?: string }[];
}

export function refusal(stage: ImportStage, team: string, now: number): string | null {
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  if (errors > 0)
    return `${String(errors)} error${errors === 1 ? '' : 's'} — fix them and re-run \`${rerunCommand(stage)}\``;
  if (stage.saved_at !== null) return `already saved ${new Date(stage.saved_at).toISOString()}`;
  if (stage.team !== team)
    return `staged for team "${stage.team}", this workspace is "${team}" — re-run \`${rerunCommand(stage)}\` here`;
  // A save that already created something is finished, never re-imported: a fresh stage would not
  // know what this one created and would open it all again.
  const started = Object.keys(stage.created).length > 0;
  if (!started && now - stage.created_at > STAGE_TTL_MS)
    return `older than 24 hours — re-run \`${rerunCommand(stage)}\` to check it against the board again`;
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
  const result: SaveResult = { goals: [], lanes: [], sync: [] };
  const actions = stage.sync?.actions ?? [];
  const total = stage.goals.length + stage.lanes.length + actions.length;
  const runSync = async (kind: SyncAction['kind']) => {
    for (const a of actions.filter((x) => x.kind === kind)) {
      const key = `sync:${a.kind}:${a.lane_id}`;
      if (stage.created[key]) {
        result.sync.push({ kind, lane_id: a.lane_id, ok: true, note: 'done by an earlier run' });
        continue;
      }
      const row = await applySync(opts.port, opts.team, a);
      stage.created[key] = a.lane_id;
      opts.persist(stage);
      result.sync.push({ kind, lane_id: a.lane_id, ...row });
    }
  };

  try {
    // Adoptions first: a legacy lane gets its `source_ref` before anything else reads by it.
    await runSync('adopt');
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
      if (l.source_ref) body.source_ref = l.source_ref;
      if (l.depends_on.length > 0) body.depends_on = l.depends_on.map((d) => resolveDep(d, stage));
      const opened = await openOrAdopt(opts.port, opts.team, body);
      stage.created[l.ref] = opened.id;
      opts.persist(stage);
      result.lanes.push({
        ref: l.ref,
        id: opened.id,
        title: l.title,
        resumed: false,
        ...(opened.adopted ? { adopted: true } : {}),
      });
    }
    await runSync('rename');
    await runSync('abandon');
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

/**
 * One re-sync action (spec 2026-10-11 §3). A rename or abandon reads the lane again first: the board
 * may have moved since the preview, and a lane someone claimed since is never abandoned (review
 * focus 5). A lane already abandoned is the outcome asked for, so it counts as done.
 */
async function applySync(
  port: SavePort,
  team: string,
  a: SyncAction,
): Promise<{ ok: boolean; note?: string }> {
  if (a.kind === 'adopt') {
    try {
      await port.updateLane(team, a.lane_id, { source_ref: a.ref });
      return { ok: true };
    } catch (err) {
      if (err instanceof CliError && err.code === 'conflict')
        return { ok: false, note: `another live lane already holds ${a.ref} — left alone` };
      throw err;
    }
  }
  const { lanes } = await port.laneBoard(team, { source_ref: a.ref, history: true });
  const lane = lanes.find((l) => l.id === a.lane_id);
  if (!lane) return { ok: false, note: 'no longer on the board — left alone' };
  if (a.kind === 'rename') {
    if (lane.state === 'done' || lane.state === 'abandoned')
      return { ok: false, note: `${lane.state} since the preview — left alone` };
    // A stage from before `held_by` reads as unheld at preview: a lane held now is then left alone.
    if (lane.owner_seat !== (a.held_by ?? null))
      return { ok: false, note: 'claimed since the preview — left alone' };
    await port.updateLane(team, a.lane_id, { title: a.title! });
    return { ok: true };
  }
  if (lane.state === 'abandoned') return { ok: true, note: 'already abandoned' };
  if (lane.owner_seat !== null || (lane.state !== 'open' && lane.state !== 'parked'))
    return { ok: false, note: 'claimed since the preview — left alone' };
  await port.updateLane(team, a.lane_id, { state: 'abandoned', abandon_reason: a.reason! });
  return { ok: true };
}

/**
 * ADR 561: a ref already held by a live lane is refused with a 409 — after the preview (someone
 * opened it since) or because this save's earlier create landed and its response was lost. Either
 * way that lane is the row's lane, so record it and go on. With no live holder left, the refusal
 * stands and the save stops as for any other error.
 */
async function openOrAdopt(
  port: SavePort,
  team: string,
  body: OpenLane,
): Promise<{ id: string; adopted: boolean }> {
  try {
    return { id: (await port.openLane(team, body)).lane.id, adopted: false };
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'conflict' && body.source_ref)) throw err;
    const { lanes } = await port.laneBoard(team, { source_ref: body.source_ref });
    const live = lanes.find((x) => x.state !== 'done' && x.state !== 'abandoned');
    if (!live) throw err;
    return { id: live.id, adopted: true };
  }
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
