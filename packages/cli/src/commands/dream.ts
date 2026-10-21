import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { resolve } from './helpers.js';

/** Where the canonical dreaming skill lives in a musterd checkout (ADR 299). */
export const DREAMING_SKILL_PATH = '.agents/skills/dreaming/SKILL.md';

/**
 * The dreaming skill as THIS build carries it (lane 01M44B3C5Q): read beside the running CLI, not
 * from the seat's workspace. A dream wake runs the actuator's own build (pinnedBin.ts), and that
 * build's checkout is kept on main by autorefresh — while the seat's workspace can rest on any
 * branch. On 2026-10-04 ghost dreamed on its handed-off branch, which predates the skill, so the
 * path its wake line named did not exist; #2038's fast-forward deliberately never moves a branch.
 * Walks up from this module to the checkout root. Null when this build is not a checkout (a
 * published package ships `dist` only); the wake line still names the path as a fallback.
 */
export function dreamingSkill(
  from: string = fileURLToPath(import.meta.url),
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): { path: string; text: string } | null {
  let dir = dirname(from);
  for (let i = 0; i < 8; i++) {
    const path = join(dir, DREAMING_SKILL_PATH);
    try {
      return { path, text: read(path) };
    } catch {
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }
  return null;
}

/**
 * Goal dreaming, lane 2: print this seat's dream packet — its lanes' day, its note, the team's
 * insights since its last dream — as JSON, with the dreaming skill in `skill` (null when this build
 * carries none). The reader is a dreaming session, so there is no human rendering; the server
 * scopes the packet to the calling seat.
 */
/**
 * The flags `musterd dream` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const DREAM_FLAGS = ['since'] as const;

export async function dreamCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...DREAM_FLAGS],
    'the flags `musterd dream` takes are listed by `musterd help dream`',
  );
  const rawSince = flagStr(parsed.flags, 'since');
  if (rawSince !== undefined && !/^\d+$/.test(rawSince)) {
    throw new CliError('usage: musterd dream [--since <epoch-ms>]', 2);
  }
  const { team, http } = resolve(parsed.flags);
  const built = await http.dreamPacket(team, rawSince === undefined ? undefined : Number(rawSince));
  process.stdout.write(JSON.stringify({ ...built, skill: dreamingSkill() }) + '\n');
  return 0;
}
