import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export const SnapshotSchema = z
  .object({
    taken_at: z.number().int(),
    seats: z.array(SeatSchema),
    teams: z.array(TeamEntrySchema),
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
