import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { machineConfigRoot } from '../machinePaths.js';

/*
 * ~/.musterd/launcher.json (ADR 491 Decision 8): the launcher's recents and a secret-free snapshot
 * of the last seat catalog — what the first screen paints from, so the paint never waits on the
 * protocol schemas. Beside config.json, so MUSTERD_CONFIG isolates it in tests (ADR 190). Zod is the
 * only package this module loads: it is on the paint path.
 */

export const LAUNCHER_FILE = 'launcher.json';

const SessionSchema = z
  .object({
    harness: z.string().min(1),
    started_at: z.number().int(),
    ended_at: z.number().int().nullable(),
  })
  .strict();

const ProblemSchema = z
  .object({
    kind: z.enum([
      'binding-legacy',
      'binding-invalid',
      'provisioning-legacy',
      'provisioning-invalid',
    ]),
    fix: z.string().min(1),
  })
  .strict();
export type SeatProblem = z.infer<typeof ProblemSchema>;

/** One seat the launcher can start — no secret, and no harness session id (a resume reads it fresh). */
export const SeatSchema = z
  .object({
    address: z.string().min(1),
    team: z.string().min(1),
    project: z.string().min(1),
    member: z.string().min(1),
    server: z.string(),
    path: z.string().min(1),
    kind: z.enum(['agent', 'human']),
    harnesses: z.array(z.string()),
    remote: z.string().nullable(),
    last_session: SessionSchema.nullable(),
    problem: ProblemSchema.nullable(),
  })
  .strict();
export type Seat = z.infer<typeof SeatSchema>;

export const TeamEntrySchema = z.object({ team: z.string().min(1), here: z.boolean() }).strict();
export type TeamEntry = z.infer<typeof TeamEntrySchema>;

/** Where a member lives, derived from the roster (ADR 503 Decision 2) — never stored by the server. */
export const WhereSchema = z.enum(['here', 'node', 'cloud', 'nowhere']);
export type Where = z.infer<typeof WhereSchema>;
/** What `⏎` on the row does from THIS machine (ADR 503 Decision 2). */
export const CanSchema = z.enum(['launch', 'wake', 'setup', 'none']);
export type Can = z.infer<typeof CanSchema>;

/**
 * One member of a team this machine knows — the roster-first row (ADR 503 Decision 1). `address`
 * names the Workspace here when one exists; null is a member with no folder on this machine.
 * `where`/`can` are plain strings so the snapshot may cache them (Decision 4); `node` is the
 * node's id and `where_label` its label — never a credential.
 */
export const MemberEntrySchema = z
  .object({
    team: z.string().min(1),
    member: z.string().min(1),
    kind: z.enum(['agent', 'human']),
    address: z.string().nullable(),
    where: WhereSchema,
    node: z.string().nullable(),
    where_label: z.string().nullable(),
    can: CanSchema,
  })
  .strict();
export type MemberEntry = z.infer<typeof MemberEntrySchema>;

export const SnapshotSchema = z
  .object({
    taken_at: z.number().int(),
    seats: z.array(SeatSchema),
    teams: z.array(TeamEntrySchema),
    /** ADR 503: the roster-first rows from the last successful roster reads. Absent on a snapshot
     *  written before the field existed, or when no roster answered. */
    members: z.array(MemberEntrySchema).optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

const RecentSchema = z
  .object({
    path: z.string().min(1),
    harness: z.string().min(1),
    mode: z.enum(['fresh', 'resume']),
    launched_at: z.number().int(),
    ended_at: z.number().int().nullable(),
    exit: z.number().int().nullable(),
  })
  .strict();
export type Recent = z.infer<typeof RecentSchema>;

export const LauncherFileSchema = z
  .object({
    version: z.literal(1),
    last: z.string().nullable(),
    seats: z.record(z.string(), RecentSchema),
    snapshot: SnapshotSchema.nullable(),
  })
  .strict();
export type LauncherFile = z.infer<typeof LauncherFileSchema>;

export const EMPTY_LAUNCHER_FILE: LauncherFile = {
  version: 1,
  last: null,
  seats: {},
  snapshot: null,
};

export function launcherFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(machineConfigRoot(env), LAUNCHER_FILE);
}

/** Read launcher.json. Missing → empty. Unreadable, not JSON, or off-schema → set aside as
 *  `<file>.corrupt-<now>` and empty. Never throws: recents must never block a launch. */
export function readLauncherFile(path: string, now: number = Date.now()): LauncherFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return structuredClone(EMPTY_LAUNCHER_FILE);
  }
  try {
    const parsed = LauncherFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // not JSON — set aside below
  }
  try {
    renameSync(path, `${path}.corrupt-${now}`);
  } catch {
    // best effort
  }
  return structuredClone(EMPTY_LAUNCHER_FILE);
}

/** Validate, then publish atomically (tmp + rename, 0600). Throws only on an invalid object. */
export function writeLauncherFile(path: string, file: LauncherFile): void {
  const valid = LauncherFileSchema.parse(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function withLaunch(
  file: LauncherFile,
  seat: Seat,
  harness: string,
  mode: 'fresh' | 'resume',
  at: number,
): LauncherFile {
  return {
    ...file,
    last: seat.address,
    seats: {
      ...file.seats,
      [seat.address]: {
        path: seat.path,
        harness,
        mode,
        launched_at: at,
        ended_at: null,
        exit: null,
      },
    },
  };
}

export function withExit(
  file: LauncherFile,
  address: string,
  at: number,
  exit: number,
): LauncherFile {
  const prior = file.seats[address];
  if (!prior) return file;
  return { ...file, seats: { ...file.seats, [address]: { ...prior, ended_at: at, exit } } };
}

export function withSnapshot(file: LauncherFile, snapshot: Snapshot): LauncherFile {
  return { ...file, snapshot };
}

/** When a seat was last used: the newer of the launcher's record and the captured session start. */
export function lastUsedAt(seat: Seat, file: LauncherFile): number | null {
  const mine = file.seats[seat.address]?.launched_at ?? null;
  const captured = seat.last_session?.started_at ?? null;
  if (mine === null) return captured;
  if (captured === null) return mine;
  return Math.max(mine, captured);
}

/**
 * The member workspace the process is standing in (ADR 717). `team` and `member` come from
 * `.musterd/workspace.json`'s claim; `root` is the directory that holds `.musterd`. Secret-free:
 * the read copies those two strings and drops the rest of the file. A chat or role claim, or a
 * file that is not a seat claim, is no scope — the walk stops there. `MUSTERD_BINDING` counts
 * only when it names a seat claim inside this directory and the walk found no workspace file.
 */
export interface FolderScope {
  team: string;
  member: string;
  root: string;
}

export function folderSeat(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): FolderScope | null {
  const walked = walkScope(startDir);
  if (walked === 'stop') return null;
  if (walked) return walked;
  return scopeFromBinding(startDir, env);
}

/** The catalog seat this folder is, for opening its harness step. */
export function seatInFolder(seats: readonly Seat[], scope: FolderScope): Seat | undefined {
  const named = seats.filter((s) => s.team === scope.team && s.member === scope.member);
  const matched = named.filter((s) => pathRelation(scope.root, s.path) === 'match');
  if (matched.length > 0) return matched[0];
  const only = named.length === 1 ? named[0] : undefined;
  if (only && pathRelation(scope.root, only.path) !== 'differ') return only;
  return undefined;
}

/** Launch permission. A second seat with the same name and a different existing path is refused. */
export function sameFolder(scope: FolderScope, seat: Seat): boolean {
  if (scope.team !== seat.team || scope.member !== seat.member) return false;
  return pathRelation(scope.root, seat.path) === 'match';
}

/** The one line a refused start shows. `path` null means this machine has no folder for them. */
export function elsewhereLine(here: string, other: string, path: string | null): string {
  const where = path && path.length > 0 ? path : `${other}'s own workspace`;
  return `this folder is ${here} — ${other} starts from ${where}`;
}

type ClaimRead = { kind: 'seat'; team: string; member: string } | { kind: 'other' };

/** `match` when the paths are the same, `differ` when both exist and are not, else `unknown`. */
function pathRelation(a: string, b: string): 'match' | 'differ' | 'unknown' {
  try {
    if (existsSync(a) && existsSync(b)) {
      return realpathSync(a) === realpathSync(b) ? 'match' : 'differ';
    }
  } catch {
    return 'unknown';
  }
  return resolve(a) === resolve(b) ? 'match' : 'unknown';
}

function walkStart(startDir: string): string {
  const missing: string[] = [];
  let dir = resolve(startDir);
  for (;;) {
    try {
      const real = realpathSync(dir);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(startDir);
      missing.push(dir.slice(parent.length + 1));
      dir = parent;
    }
  }
}

function insideRoot(root: string, startDir: string): boolean {
  const r = walkStart(root);
  const s = walkStart(startDir);
  return s === r || s.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Seat claim, or `stop` when a workspace file is here and is not one. Null means keep walking. */
function walkScope(startDir: string): FolderScope | 'stop' | null {
  let dir = walkStart(startDir);
  for (;;) {
    const file = join(dir, '.musterd', 'workspace.json');
    if (existsSync(file)) {
      const got = readClaimFile(file);
      if (got?.kind === 'seat') return { team: got.team, member: got.member, root: dir };
      return 'stop';
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function scopeFromBinding(startDir: string, env: NodeJS.ProcessEnv): FolderScope | null {
  const explicit = env['MUSTERD_BINDING'];
  if (!explicit) return null;
  const bindingPath = resolve(explicit);
  const root = dirname(dirname(bindingPath));
  if (!insideRoot(root, startDir)) return null;
  const got = readClaimFile(bindingPath);
  if (got?.kind !== 'seat') return null;
  return { team: got.team, member: got.member, root: walkStart(root) };
}

/** Copy `team` and a seat-claim `name` only. Anything else, including a secret, is dropped. */
function readClaimFile(file: string): ClaimRead | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const team = token((data as { team?: unknown }).team);
  const claim = (data as { claim?: unknown }).claim;
  if (!team) return null;
  if (typeof claim !== 'object' || claim === null) return { kind: 'other' };
  const mode = (claim as { mode?: unknown }).mode;
  const name = token((claim as { name?: unknown }).name);
  if (mode === 'seat' && name) return { kind: 'seat', team, member: name };
  return { kind: 'other' };
}

function token(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /\s/.test(s)) return null;
  return s;
}
