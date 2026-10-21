import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ClaimCheck,
  claimCheckLines,
  type MemoryEnvelope,
  type MemoryProvenance,
} from '@musterd/protocol';
import {
  type NoteSealClient,
  NoteSealError,
  openForSeat,
  sealForSeat,
} from '@musterd/protocol/note-seal';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import type { HttpClient } from '../client.js';
import { type Config, seatsHoldingSession } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success, sym, termWidth } from '../render/ui.js';
import { findWorkspaceDir, type IdentitySource, resolve } from './helpers.js';

/**
 * `musterd memory [show [--seat <agent>]]|save|clear` — the seat's cross-session continuity blob (ADR 093):
 * the working state a returning occupant needs, written explicitly by the occupant at natural
 * boundaries (before a handoff, at a wrap-up, when told to wind down). One note per seat,
 * last-write-wins; headline ≤120 chars, body ≤8KB (the server rejects over-cap with the limit
 * named). Read rule (ADR 651): an agent seat's note is readable by the seat and any human
 * (`show --seat <agent>`); a human seat's note by that human only; no agent reads another's. The
 * delivery seam is envelope-on-occupy / body-on-demand: `musterd claim` / `musterd status` print
 * {@link renderMemoryLine}; `musterd memory` is the explicit body read. Every subcommand first
 * refuses a seat mismatch ({@link refuseSeatMismatch}, ADR 653).
 */
/**
 * The flags `musterd memory` takes (lane
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
export const MEMORY_FLAGS = [
  '--',
  '--git-dir',
  '--porcelain',
  '--show-toplevel',
  '-c',
  'abort',
  'aborted',
  'act',
  'add',
  'all',
  'away',
  'blocking',
  'bootstrap',
  'branch',
  'canonical',
  'check',
  'check-build',
  'client',
  'close',
  'cloud-provision',
  'commit',
  'connect',
  'connection',
  'content-type',
  'credential',
  'data',
  'deferred',
  'end',
  'enroll',
  'error',
  'exec',
  'exit',
  'fetch',
  'firehose',
  'fix',
  'for',
  'from',
  'git',
  'grant',
  'harness',
  'headline',
  'hex',
  'hook',
  'host',
  'id',
  'ignore',
  'inbox',
  'installed',
  'interval',
  'key',
  'key-env',
  'leases',
  'limit',
  'local-session-live',
  'log',
  'ls-files',
  'main',
  'malformed',
  'members',
  'message',
  'migrate-bootstrap',
  'musterd',
  'musterd-cli',
  'musterd-host',
  'new',
  'no-gateway',
  'offline',
  'online',
  'open',
  'origin',
  'pipe',
  'pull',
  'push',
  'refresh-permissions',
  'remote',
  'repair',
  'resumable',
  'rev-list',
  'rev-parse',
  'review',
  'role',
  'roster',
  'seat',
  'session',
  'sha256',
  'skipped',
  'sponsor',
  'sqlite3',
  'status',
  'surface',
  'timeout',
  'until',
  'until-lane',
  'until-reply',
  'utf8',
  'waiting',
  'wakeable',
  'workspace',
] as const;

export async function memoryCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? 'show';
  const { config, team, identity, identitySource, http } = resolve(parsed.flags);
  refuseSeatMismatch({ config, team, folderSeat: identity.name, identitySource });

  if (sub === 'save') {
    // Save takes no target: it writes THIS seat's note, as the caller. A flag it does not know is
    // refused rather than ignored — the memory-isolation canary (lane 01M561ZCDS, 2026-10-20) ran
    // `memory save --seat canary-7` from canary-4, got "memory saved", and had to halt and read the
    // audit to learn the write had stayed on canary-4. `--seat` is `show`'s flag (ADR 651); on save
    // it is a cross-seat write request, and the answer to that is a refusal, not a silent self-write.
    rejectUnknownFlags(
      parsed.flags,
      [...GLOBAL_FLAGS, 'headline'],
      'save writes this seat\'s own note and takes no target: musterd memory save --headline "<subject>" [body...]',
    );
    const headline = flagStr(parsed.flags, 'headline');
    if (!headline) {
      throw new CliError('usage: musterd memory save --headline "<subject>" [body...]', 2);
    }
    const body = parsed.positionals.slice(1).join(' ');
    await http.saveMemory(team, await sealOrRefuse(noteClient(http, team), { headline, body }));
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true, headline }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`memory saved — your next occupy shows ${theme.accent(`"${headline}"`)}`, {
        next: 'musterd memory',
      }) + '\n',
    );
    return 0;
  }

  if (sub === 'clear') {
    await http.clearMemory(team);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ok: true }) + '\n');
      return 0;
    }
    process.stdout.write(
      success('memory cleared', {
        next: 'musterd memory save --headline "<subject>"',
      }) + '\n',
    );
    return 0;
  }

  if (sub !== 'show') {
    throw new CliError(
      'usage: musterd memory [show [--seat <agent>]] | save --headline "<subject>" [body...] | clear',
      2,
    );
  }

  // The explicit body read. A seat with nothing saved is a normal state, not an error exit.
  // `--seat <agent>`: a human reading an agent seat's note (ADR 651); the server enforces who may.
  const seat = flagStr(parsed.flags, 'seat');
  let mem: {
    headline: string;
    body: string;
    saved_at: number;
    checks?: ClaimCheck[];
    provenance?: MemoryProvenance;
  };
  try {
    mem = seat ? await http.getMemberMemory(team, seat) : await http.getMemory(team);
  } catch (err) {
    if (err instanceof CliError && err.code === 'not_found') {
      process.stdout.write(
        theme.meta(
          seat
            ? `no memory saved for ${seat} (or no such member)`
            : 'no memory saved for this seat yet — nothing to carry over. musterd memory save --headline "<subject>"',
        ) + '\n',
      );
      return 0;
    }
    throw err;
  }
  // ADR 657: a human's own note is sealed to their machines — open it here, and re-seal it when a
  // newly trusted machine (or a note saved before sealing) is not reached yet.
  let sealLine: string | undefined;
  if (!seat || seat === identity.name) {
    const opened = await openForSeat(noteClient(http, team), mem);
    if (opened.kind === 'closed') {
      process.stdout.write(theme.warn(opened.line) + '\n');
      return 0;
    }
    if (opened.kind === 'open') {
      mem = { ...mem, headline: opened.headline, body: opened.body };
      sealLine = opened.line;
    }
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(mem) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent(seat ? `memory · ${seat}` : 'memory')} ${theme.meta(`(saved ${ago(Date.now() - mem.saved_at)} ago)`)} — ${mem.headline}\n`,
  );
  // ADR 654: who saved it — a warning when the note reads as suspect, a plain fact otherwise.
  if (mem.provenance)
    process.stdout.write(
      (mem.provenance.suspect
        ? theme.warn(`⚠ ${mem.provenance.line}`)
        : theme.meta(mem.provenance.line)) + '\n',
    );
  if (sealLine) process.stdout.write(theme.meta(sealLine) + '\n');
  // ADR 522: the note's claims checked against the Team now — above the body, read first.
  for (const line of claimCheckLines(mem.checks ?? []))
    process.stdout.write(theme.warn(line) + '\n');
  if (mem.body) process.stdout.write(mem.body + (mem.body.endsWith('\n') ? '' : '\n'));
  return 0;
}

/** The seat-side seal flow (ADR 657) bound to this team, over the CLI's client. A daemon older than
 *  ADR 657 has no recipients route (404), and never seals. */
function noteClient(
  http: Pick<HttpClient, 'noteRecipients' | 'saveMemory'>,
  team: string,
): NoteSealClient {
  return {
    recipients: async (publicKey) => {
      try {
        return await http.noteRecipients(team, publicKey);
      } catch (err) {
        if (err instanceof CliError && err.code === 'not_found') return null;
        throw err;
      }
    },
    save: (input) => http.saveMemory(team, input),
  };
}

/** {@link sealForSeat} with its refusals as CLI errors: a cap is a usage error, no machine a state one. */
async function sealOrRefuse(
  client: NoteSealClient,
  note: { headline: string; body: string },
): Promise<{ headline: string; body?: string }> {
  try {
    return await sealForSeat(client, note);
  } catch (err) {
    if (err instanceof NoteSealError) throw new CliError(err.message, err.kind === 'cap' ? 2 : 5);
    throw err;
  }
}

/** The running harness session's own id, where the harness hands one to the processes it spawns.
 *  Claude Code sets `CLAUDE_CODE_SESSION_ID`; no other harness we ship exposes one (ADR 653). */
export function runningSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env['CLAUDE_CODE_SESSION_ID']?.trim();
  return id ? id : undefined;
}

/**
 * ADR 653: the CLI acts as the seat whose folder it runs in, so a session launched as seat A that
 * runs `musterd memory` inside seat B's folder would read and write B's note. When this session's
 * own seat is known — a bound folder on this machine whose captured slot names the running session
 * — and it is not the folder's seat, refuse, naming both. An env identity (`MUSTERD_CLAIM`) was
 * chosen on purpose and is never second-guessed; an unknown session (no id, or no slot names it)
 * passes, because nothing says it belongs anywhere else.
 */
export function refuseSeatMismatch(input: {
  config: Config;
  team: string;
  folderSeat: string;
  identitySource: IdentitySource;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): void {
  if (input.identitySource !== 'binding') return;
  const sessionId = runningSessionId(input.env);
  if (!sessionId) return;
  const holders = seatsHoldingSession(
    sessionId,
    input.team,
    candidateFolders(input.config, input.cwd),
  );
  const other = holders.find((h) => h.seat !== input.folderSeat);
  if (!other) return;
  throw new CliError(
    `this session is seat ${other.seat}, but this folder is seat ${input.folderSeat}'s — ` +
      `\`musterd memory\` here would read and write ${input.folderSeat}'s note, so it is refused ` +
      `(ADR 653). Run it from your own folder: ${other.dir}`,
    5,
  );
}

/** Where a seat's folder may be: every folder the global registry records (ADR 020), plus the
 *  siblings of this folder's Workspace (a roster home keeps seats side by side). */
function candidateFolders(config: Config, cwd?: string): string[] {
  const dirs = Object.keys(config.bindings);
  const here = findWorkspaceDir(cwd);
  if (here) {
    const parent = dirname(here);
    try {
      for (const e of readdirSync(parent, { withFileTypes: true }))
        if (e.isDirectory()) dirs.push(join(parent, e.name));
    } catch {
      // an unreadable parent only narrows the search
    }
  }
  return dirs;
}

/**
 * The one-line continuity pointer `musterd claim` / `musterd status` print (ADR 093 §3) — headline +
 * age, never the body, so the returning occupant makes an informed fetch decision.
 *
 * `compact` is the `status` header form: glyph-led and clipped to one line. The long prose form
 * (`saved memory from 6d ago: "…" — \`musterd memory\` to load it`) is right when it is the *only*
 * thing on screen after a claim, and is the single noisiest line in a header that has five other
 * things to say — so the header gets a version that states the same facts and sits down.
 */
export function renderMemoryLine(
  env: MemoryEnvelope,
  now = Date.now(),
  opts: { compact?: boolean; width?: number } = {},
): string {
  const age = ago(now - env.saved_at);
  if (!opts.compact) {
    return theme.meta(
      `saved memory from ${age} ago: "${env.headline}" — \`musterd memory\` to load it`,
    );
  }
  const width = opts.width ?? termWidth();
  const lead = `${sym.goal} memory ${sym.dot} ${age}  `;
  const tail = `  ${sym.arrow} musterd memory`;
  const room = Math.max(16, width - lead.length - tail.length - 2);
  const headline =
    env.headline.length > room ? env.headline.slice(0, room - 1) + sym.more : env.headline;
  return theme.meta(`${lead}"${headline}"${tail}`);
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}
