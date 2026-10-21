import { type AuditEntry, type MemberKind } from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { clock, theme } from '../render/theme.js';
import { sym } from '../render/ui.js';
import { kindLookup, resolve } from './helpers.js';

/**
 * `musterd audit [--limit <n>] [--before <ms-epoch>] [--authorized-by <seat>] [--json]` — read the
 * governance audit log (ADR 071) via the admin-only `GET /teams/:slug/audit`. Pretty-prints entries
 * newest-first; `--limit` (1..500) and `--before` page older entries; `--authorized-by` keeps rows
 * whose detail.authorized_by matches (ADR 127); `--json` passes the raw array through. `action` is an
 * open string (ADR 074) — unknown verbs render plainly instead of erroring, so P3's new actions don't
 * require a CLI release. Admin-only, so it needs an **explicit** acting identity (ADR 036): an ambient
 * global-config read can't list who-did-what across the team.
 */
/**
 * The flags `musterd audit` takes (lane
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
/**
 * The flags `musterd audit` takes (lane
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
export const AUDIT_FLAGS = [
  'allow',
  'audit',
  'authorized-by',
  'before',
  'limit',
  'system',
] as const;

export async function auditCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...AUDIT_FLAGS],
    'the flags `musterd audit` takes are listed by `musterd help audit`',
  );
  const { team, http } = resolve(parsed.flags);

  const limit = parseLimit(flagStr(parsed.flags, 'limit'));
  const before = parseBefore(flagStr(parsed.flags, 'before'));
  const authorizedBy = flagStr(parsed.flags, 'authorized-by');

  const res = await http.audit(team, {
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(authorizedBy !== undefined ? { authorized_by: authorizedBy } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.audit) + '\n');
    return 0;
  }

  // A roster read gives the actor→kind lookup so named actors color by kind (agent vs human), like
  // `inbox`. Best-effort: a failed read falls back to 'agent' (kindLookup's default).
  const roster = await http.roster(team).catch(() => ({ members: [] }));
  const kindOf = kindLookup(roster.members);

  process.stdout.write(
    `${theme.accent('audit')} — ${team} (${res.audit.length} entr${res.audit.length === 1 ? 'y' : 'ies'})\n`,
  );
  if (res.audit.length === 0) {
    process.stdout.write(
      theme.meta('no governed decisions recorded yet — the ledger is clean') + '\n',
    );
    return 0;
  }
  for (const e of res.audit) process.stdout.write(renderAuditEntry(e, kindOf) + '\n');

  // Page hint: the oldest entry's ts is the next `--before` cursor.
  const oldest = res.audit[res.audit.length - 1]!;
  process.stdout.write(
    theme.meta(`musterd audit --before ${oldest.ts} to page older entries`) + '\n',
  );
  return 0;
}

/** `--limit` must be an integer in the server's 1..500 window; anything else is a usage error. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 500 || !Number.isInteger(n)) {
    throw new CliError('--limit must be an integer in 1..500', 2);
  }
  return n;
}

/** `--before` is a positive ms-epoch integer (the ts of an entry to page beneath). */
function parseBefore(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new CliError('--before must be a positive ms-epoch integer', 2);
  }
  return n;
}

function renderAuditEntry(e: AuditEntry, kindOf: (name: string) => MemberKind): string {
  const ts = theme.meta(clock(e.ts));
  const actor =
    e.actor === null ? theme.meta('system') : theme.memberName(e.actor, kindOf(e.actor));
  const action = theme.meta(`[${e.action}]`);
  const result =
    e.result === 'allow'
      ? `${theme.ok(sym.ok)} ${theme.ok('allow')}`
      : `${theme.err(sym.err)} ${theme.err('deny')}`;
  const target = e.target === null ? theme.meta('—') : e.target;
  const detail = e.detail ? ' ' + theme.meta(JSON.stringify(e.detail)) : '';
  return `${ts} ${actor} ${action} ${result} ${theme.meta(sym.arrow)} ${target}${detail}`;
}
