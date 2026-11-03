import { join } from 'node:path';
import { type SeatToolsPolicy, SeatToolSetSchema } from '@musterd/protocol';
import { z } from 'zod';
import { FLOOR_DENIED_SKILLS, SEAT_TOOLS_CACHE_REL } from '../permissions.js';
import type { FsSeam } from '../reconcile/context.js';
import { type DeclaredSet, declaredSetFor, emptyDeclaredSet } from './resolve.js';

export { SEAT_TOOLS_CACHE_REL, seatToolsCacheDenies } from '../permissions.js';

/** The cache file: the resolved set as last read from the daemon, and when. */
const CachedSetSchema = SeatToolSetSchema.extend({ readAt: z.number().int().positive() });

export interface LoadDeclaredSetArgs {
  worktreeRoot: string;
  fs: FsSeam;
  /** Reads the team's grants from the daemon (`GET /seat-tools`); rejects when it can't. */
  fetch: () => Promise<SeatToolsPolicy>;
  /** The roles the bound seat holds. */
  roles: readonly string[];
  now: number;
}

/**
 * The seat's declared set (ADR 794 §1c). A good read is cached in the folder and returned as
 * `server`. A failed read falls back to the cache (`cache`), and with no readable cache to repo
 * tools and the floor only (`none`) — never to anything wider. Never throws: a launch must not
 * fail because the daemon is down.
 */
export async function loadDeclaredSet(args: LoadDeclaredSetArgs): Promise<DeclaredSet> {
  const path = join(args.worktreeRoot, SEAT_TOOLS_CACHE_REL);
  let policy: SeatToolsPolicy | undefined;
  try {
    policy = await args.fetch();
  } catch {
    policy = undefined;
  }
  if (policy) {
    const set: DeclaredSet = {
      ...declaredSetFor(policy, args.roles),
      source: 'server',
      readAt: args.now,
    };
    writeCache(args.fs, path, set);
    return set;
  }
  return readCache(args.fs, path) ?? emptyDeclaredSet();
}

function writeCache(fs: FsSeam, path: string, set: DeclaredSet): void {
  const { deniedSkills: _floor, source: _source, ...body } = set;
  const stage = `${path}.tmp-${String(process.pid)}`;
  try {
    fs.mkdirp(join(path, '..'));
    fs.writeFile(stage, `${JSON.stringify(body, null, 2)}\n`, 0o644);
    fs.rename(stage, path);
  } catch {
    // A cache that can't be written costs the next offline launch its grants, nothing more.
    try {
      fs.rm(stage);
    } catch {
      /* already gone */
    }
  }
}

function readCache(fs: FsSeam, path: string): DeclaredSet | undefined {
  const raw = fs.readFile(path);
  if (raw === null) return undefined;
  try {
    const parsed = CachedSetSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const { readAt, ...set } = parsed.data;
    // The floor is never read from the file: a seat that edited it would otherwise lift it.
    const floor = new Set(FLOOR_DENIED_SKILLS);
    const skills = set.skills.filter((name) => !floor.has(name));
    return { ...set, skills, deniedSkills: [...FLOOR_DENIED_SKILLS], source: 'cache', readAt };
  } catch {
    return undefined;
  }
}
