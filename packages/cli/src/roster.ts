import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Lifecycle,
  type MemberKind,
  type SeatFile,
  parseSeatFile,
  serializeSeat,
} from '@musterd/protocol';
import { assignHue, defaultHue } from '@musterd/protocol/hue';

/**
 * Writing durable seat files (ADR 058 §5: the file is the single writer). Shared by `team add`,
 * `claim`, and `team export` so every seat that lands on disk is canonical from birth. A seat file is
 * only written when the team is *file-backed* (its slug is in `config.rosterHome`) — the writer's
 * caller gates on that; a db-only team keeps the legacy originate path untouched.
 */

export interface SeatFields {
  kind: MemberKind;
  role?: string | undefined;
  lifecycle?: Lifecycle | undefined;
  /** ISO-8601 or any Date-parseable string; normalized to canonical ISO on write. */
  until?: string | undefined;
  /** ADR 700: the sponsoring member's name. Valid only on an agent seat; ignored otherwise. */
  sponsored_by?: string | undefined;
  /** The seat's colour (ADR 374). Undefined ⇒ assigned at write, clear of the sibling seat files. */
  hue?: number | undefined;
}

/** Build a canonical {@link SeatFile} body from CLI inputs (drops `lifecycle`/`until` when forever). */
export function buildSeat(fields: SeatFields): SeatFile {
  const seat: SeatFile = { kind: fields.kind, role: fields.role ?? '' };
  if (fields.kind === 'agent' && fields.sponsored_by) seat.sponsored_by = fields.sponsored_by;
  if (fields.hue !== undefined) seat.hue = fields.hue;
  if (fields.lifecycle && fields.lifecycle !== 'forever') {
    seat.lifecycle = fields.lifecycle;
    if (fields.lifecycle === 'until' && fields.until) {
      seat.until = new Date(fields.until).toISOString();
    }
  }
  return seat;
}

export function seatsDir(home: string): string {
  return join(home, '.musterd', 'seats');
}

export function seatFilePath(home: string, name: string): string {
  return join(seatsDir(home), `${name}.toml`);
}

export function seatFileExists(home: string, name: string): boolean {
  return existsSync(seatFilePath(home, name));
}

/**
 * Write `seats/<name>.toml` (canonical) under a roster home, creating `seats/` as needed.
 *
 * A seat lands on disk coloured (ADR 374): when the caller names no hue, one is assigned here from
 * the name's default, walked clear of every hue the sibling seat files already hold. The file is
 * the source of truth on a file-backed team, so this — not the daemon — is where the colour is
 * born, and it is born in a diff someone can read.
 */
export function writeSeatFile(home: string, name: string, fields: SeatFields): string {
  mkdirSync(seatsDir(home), { recursive: true });
  const p = seatFilePath(home, name);
  const hue = fields.hue ?? assignHue(defaultHue(name), Object.values(readSeatHues(home, name)));
  writeFileSync(p, serializeSeat(buildSeat({ ...fields, hue })), 'utf8');
  return p;
}

/**
 * Whether a seat file written under `home` can reach another machine yet (ADR 547). A seat replicates
 * over sync but its roster entry travels by git, so a joiner whose copy of the roster repo lacks the
 * file stops at the first event naming the seat (Air 2, 2026-10-08: alfie never pushed, 15 hours).
 *
 *  - `'uncommitted'` — git has no commit for the file: never added, only staged, or ignored.
 *  - `'unpushed'` — committed, but the commit is on no remote-tracking branch.
 *  - `null` — published, or there is nothing to say: `home` is not a git repo, or git itself failed.
 *    Silence is the safe answer to "could not tell"; a warning that is sometimes wrong is not read.
 *
 * "Published" asks about the last commit that touched the file, so a later local edit to a seat that
 * already reached the remote does not warn: peers can resolve the seat, they just hold an older role.
 */
export type SeatFilePublication = 'uncommitted' | 'unpushed';

export function seatFileUnpublished(home: string, name: string): SeatFilePublication | null {
  const rel = join('.musterd', 'seats', `${name}.toml`);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', home, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') return null;
  } catch {
    return null;
  }
  try {
    git('ls-files', '--error-unmatch', '--', rel);
  } catch {
    return 'uncommitted'; // untracked or ignored
  }
  try {
    const sha = git('log', '-1', '--format=%H', '--', rel);
    if (sha === '') return 'uncommitted'; // staged, not committed
    return git('branch', '-r', '--contains', sha) === '' ? 'unpushed' : null;
  } catch {
    return null;
  }
}

/**
 * The two lines every command that creates a seat prints when its seat file has not reached a remote
 * (`team add`, `musterd agent`): what is wrong, then the commands that fix it. One wording, so the
 * paths cannot drift apart.
 */
/**
 * ADR 591: the lines a seat-enrolling command prints when the seat will not reach the hub — no seat
 * file under the roster home at all (the seat was minted straight into the daemon, as a failed
 * `musterd agent` or a hand-written binding leaves it), or a file that never left this machine.
 * Null when the file is committed and pushed, or when this machine keeps no roster home.
 */
export function seatReachLines(
  name: string,
  home: string | undefined,
  kind: 'agent' | 'human' = 'agent',
  role?: string,
): [warning: string, how: string] | null {
  if (!home) return null;
  if (!seatFileExists(home, name)) {
    const roleFlag = role ? ` --role ${role}` : '';
    return [
      `${name} has no seat file under ${home} — the hub and every other machine stop at the first event naming it`,
      `write it, then publish it: musterd team add ${name} --kind ${kind}${roleFlag} (from a folder bound to you), ` +
        `then git -C ${home} add .musterd/seats/${name}.toml && git -C ${home} commit -m "add ${name}" && git -C ${home} push`,
    ];
  }
  const state = seatFileUnpublished(home, name);
  return state ? unpublishedSeatLines(name, home, state) : null;
}

export function unpublishedSeatLines(
  name: string,
  home: string,
  state: SeatFilePublication,
): [warning: string, how: string] {
  const rel = `.musterd/seats/${name}.toml`;
  const fix =
    state === 'uncommitted'
      ? `git -C ${home} add ${rel} && git -C ${home} commit -m "add ${name}" && git -C ${home} push`
      : `git -C ${home} push`;
  return [
    `other machines cannot resolve ${name} until ${rel} is ${state === 'uncommitted' ? 'committed and pushed' : 'pushed'}`,
    `their sync stops at the first event naming ${name}. ${fix}`,
  ];
}

/**
 * ADR 592: publish a seat file — add, commit and push it from the roster home — so the seat reaches
 * every other machine without a human git step. The three lines ADR 547/591 print are the fallback,
 * not the plan: on 2026-10-13 they were printed, nobody ran them for 100 minutes, and the hub held
 * every lane from every machine behind the seat they named.
 *
 * Narrow on purpose: only the seat's own file is added and committed (`git commit -- <file>`), so a
 * dirty roster home contributes nothing else to the commit. A push the remote refuses as behind is
 * retried once after `git pull --rebase --autostash`; anything past that is the person's call, and
 * the outcome carries git's first line so they can make it.
 *
 *  - `published` — the file is on the remote now (this call pushed it).
 *  - `already` — nothing to do: the file was committed and pushed before this call.
 *  - `skipped` — not a git checkout, or no upstream to push to; `detail` says which.
 *  - `failed` — git refused somewhere; `detail` is what it said. The file stays as it was written.
 */
export interface SeatPublishOutcome {
  state: 'published' | 'already' | 'skipped' | 'failed';
  detail?: string;
}

export function publishSeatFile(home: string, name: string): SeatPublishOutcome {
  const rel = join('.musterd', 'seats', `${name}.toml`);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', home, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  const said = (err: unknown): string => {
    const e = err as { stderr?: unknown; message?: unknown };
    const text =
      typeof e.stderr === 'string' && e.stderr.trim() !== ''
        ? e.stderr
        : typeof e.message === 'string'
          ? e.message
          : String(err);
    return text.trim().split('\n')[0] ?? '';
  };
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true')
      return { state: 'skipped', detail: 'not a git checkout' };
  } catch {
    return { state: 'skipped', detail: 'not a git checkout' };
  }
  try {
    git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  } catch {
    return { state: 'skipped', detail: 'no upstream branch to push to' };
  }
  const state = seatFileUnpublished(home, name);
  if (state === null) return { state: 'already' };
  if (state === 'uncommitted') {
    try {
      git('add', '--', rel);
      git('commit', '--quiet', '-m', `roster: add ${name}`, '--', rel);
    } catch (err) {
      return { state: 'failed', detail: said(err) };
    }
  }
  try {
    git('push', '--quiet');
  } catch (first) {
    // Behind the remote (another machine published a seat first): catch up once, then push again.
    try {
      git('pull', '--rebase', '--autostash', '--quiet');
      git('push', '--quiet');
    } catch (err) {
      return { state: 'failed', detail: said(err) || said(first) };
    }
  }
  return { state: 'published' };
}

/**
 * The line a seat-making command prints for a publish outcome: one sentence for success, the ADR
 * 591 warning + fix when the file still has not reached the remote. Null when there is nothing to
 * say (`already`: the file was published before; a db-only team never gets here).
 */
export function seatPublishLines(
  name: string,
  home: string,
  outcome: SeatPublishOutcome,
  /** `seatFileUnpublished(home, name)` as the caller read it after the publish attempt. */
  unpublished: SeatFilePublication | null,
): { ok?: string; warn?: [warning: string, how: string] } | null {
  const rel = `.musterd/seats/${name}.toml`;
  switch (outcome.state) {
    case 'published':
      return { ok: `published ${rel} — every other machine can resolve ${name} on its next pull` };
    case 'already':
      return null;
    case 'skipped':
    case 'failed': {
      const lines = unpublished
        ? unpublishedSeatLines(name, home, unpublished)
        : (seatReachLines(name, home) ?? null);
      if (!lines) return null;
      return {
        warn: [
          `could not publish ${rel} (${outcome.detail ?? outcome.state}) — ${lines[0]}`,
          lines[1],
        ],
      };
    }
  }
}

/**
 * What a seat-making path runs after the daemon accepted the member (ADR 592 §1): publish the seat
 * file if it has not reached the remote, and say how it went. Null when there is nothing to do or
 * say — the file was already published, or the team is db-only (no roster home). With `publish:
 * false` (`--no-publish`) nothing runs and only the ADR 547 warning comes back. Shared by `musterd
 * agent`, the launcher's new seat and both `musterd init` seat paths, so they print one thing.
 */
export function publishSeatFileReport(
  name: string,
  home: string | undefined,
  opts: { publish?: boolean } = {},
): {
  outcome: SeatPublishOutcome | null;
  ok?: string;
  warn?: [warning: string, how: string];
} | null {
  if (!home || seatFileUnpublished(home, name) === null) return null;
  if (opts.publish === false) {
    const still = seatFileUnpublished(home, name);
    return still ? { outcome: null, warn: unpublishedSeatLines(name, home, still) } : null;
  }
  const outcome = publishSeatFile(home, name);
  const lines = seatPublishLines(name, home, outcome, seatFileUnpublished(home, name));
  return { outcome, ...(lines ?? {}) };
}

/** Every seat file under a roster home, parsed, keyed by seat name. */
export function readSeatFiles(home: string): Record<string, SeatFile> {
  const dir = seatsDir(home);
  if (!existsSync(dir)) return {};
  const out: Record<string, SeatFile> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.toml')) continue;
    const name = f.slice(0, -'.toml'.length);
    out[name] = parseSeatFile(readFileSync(join(dir, f), 'utf8'), name);
  }
  return out;
}

/** The hues the seat files hold, by name — `except` leaves one seat out of its own way. */
export function readSeatHues(home: string, except?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, seat] of Object.entries(readSeatFiles(home))) {
    if (name !== except && seat.hue !== undefined) out[name] = seat.hue;
  }
  return out;
}

/** Set one seat file's hue in place (the `role.ts` edit idiom: parse → change → serialize). */
export function setSeatHue(home: string, name: string, hue: number): string {
  const p = seatFilePath(home, name);
  const seat = parseSeatFile(readFileSync(p, 'utf8'), name);
  writeFileSync(p, serializeSeat({ ...seat, hue }), 'utf8');
  return p;
}
