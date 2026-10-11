import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from '../errors.js';
import { writeJsonAtomic } from '../onboard/atomicWrite.js';
import type { PlannedGoal, PlannedLane } from './check.js';
import type { Diagnostic, ImportFormat } from './rows.js';

/**
 * Staged imports (spec 2026-10-10 §"Step 1"/"Step 2"): what step 1 previewed, saved so step 2 creates
 * exactly that, plus the `created` map that makes a re-run resume instead of duplicate. Workspace-local;
 * `.musterd/` is not wholly gitignored (ADR 058 commits team.toml), so the folder ignores itself.
 */
export const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ImportStage {
  version: 1;
  id: string;
  team: string;
  project: string;
  created_at: number;
  source: { path: string; sha256: string; format: ImportFormat };
  goals: PlannedGoal[];
  lanes: PlannedLane[];
  linked_goals: string[];
  diagnostics: Diagnostic[];
  created: Record<string, string>;
  saved_at: number | null;
}

/** Shape guard for a file read back off disk — enough to refuse garbage, not a second schema of record. */
const StageShape = z
  .object({
    version: z.literal(1),
    id: z.string(),
    team: z.string(),
    project: z.string(),
    created_at: z.number(),
    source: z.object({ path: z.string(), sha256: z.string(), format: z.enum(['csv', 'jsonl']) }),
    goals: z.array(z.object({ ref: z.string(), id: z.string() }).passthrough()),
    lanes: z.array(z.object({ ref: z.string(), title: z.string() }).passthrough()),
    linked_goals: z.array(z.string()),
    diagnostics: z.array(z.object({ level: z.enum(['error', 'warning']) }).passthrough()),
    created: z.record(z.string()),
    saved_at: z.number().nullable(),
  })
  .passthrough();

export function importsDir(workspace: string): string {
  return join(workspace, '.musterd', 'imports');
}

export function newStageId(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}

/** Make the imports folder and its own `.gitignore` (`*`) — before anything can fail, so a draft a
 *  skill wrote there is never committed even when the import itself never stages. */
export function ensureImportsDir(workspace: string): string {
  const dir = importsDir(workspace);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

export function createStage(
  workspace: string,
  init: Omit<ImportStage, 'version' | 'id' | 'created' | 'saved_at'>,
  now: number,
): ImportStage {
  ensureImportsDir(workspace);
  const stage: ImportStage = {
    version: 1,
    id: newStageId(now),
    ...init,
    created: {},
    saved_at: null,
  };
  writeStage(workspace, stage);
  return stage;
}

export function writeStage(workspace: string, stage: ImportStage): void {
  writeJsonAtomic(
    join(importsDir(workspace), `${stage.id}.json`),
    stage,
    (v) => StageShape.safeParse(v).success,
  );
}

export function readStage(workspace: string, id: string): ImportStage {
  const path = join(importsDir(workspace), `${id}.json`);
  if (!/^[\w-]+$/.test(id) || !existsSync(path)) {
    throw new CliError(
      `no staged import "${id}" in this workspace — run \`musterd import list\``,
      2,
    );
  }
  const parsed = safeParse(readFileSync(path, 'utf8'));
  if (!parsed)
    throw new CliError(
      `${path} is not a readable staged import — re-run \`musterd import <file>\``,
      2,
    );
  return parsed;
}

export function listStages(workspace: string): ImportStage[] {
  const dir = importsDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const s = safeParse(readFileSync(join(dir, f), 'utf8'));
      return s ? [s] : [];
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

function safeParse(text: string): ImportStage | null {
  try {
    const r = StageShape.safeParse(JSON.parse(text));
    return r.success ? (r.data as unknown as ImportStage) : null;
  } catch {
    return null;
  }
}
