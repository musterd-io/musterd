import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';

const USAGE =
  'usage:\n' +
  '  musterd store prune [--dry-run]   run the ADR 478 retention pass now (audit churn + trace content)\n' +
  '  musterd store compact             one-time VACUUM → incremental auto-vacuum; holds the write lock\n' +
  '  musterd store archive ls          what the prune has archived beside the db';

interface StoreSizes {
  db_bytes?: number;
  sync_log_rows: number;
  sync_log_bytes?: number;
  archive_bytes?: number;
}
interface PruneResponse extends StoreSizes {
  dry_run: boolean;
  archive_dir: string | null;
  audit_churn: { rows?: number; pruned?: number; archivedBytes?: number; cutoff: number };
  trace_content?: { pruned: number };
}
interface CompactResponse {
  ok: true;
  before_bytes: number;
  after_bytes: number;
}

const mb = (n: number | undefined) => (n === undefined ? '?' : `${(n / 1048576).toFixed(1)} MB`);

/** The daemon's own `/health` says which file it serves — the archive sits beside that file. */
async function daemonDbPath(server: string): Promise<string> {
  const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new CliError(`daemon at ${server}: health ${res.status}`, 1);
  const body = (await res.json()) as { db?: string };
  if (!body.db) throw new CliError(`daemon at ${server} reports no db path`, 1);
  return body.db;
}

async function post<T>(server: string, path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new CliError(body.error?.message ?? `daemon at ${server}: ${path} ${res.status}`, 1);
  }
  return body;
}

/**
 * `musterd store …` (ADR 478 §4): the operator's two store verbs plus a look at the archive. These
 * talk to THIS machine's daemon over its localhost-only routes — the daemon holds the file, so it
 * runs the pass and the `VACUUM`; the CLI never opens `musterd.db` itself.
 */
/**
 * The flags `musterd store` takes (lane
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
export const STORE_FLAGS = ['dry-run'] as const;

export async function storeCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...STORE_FLAGS],
    'the flags `musterd store` takes are listed by `musterd help store`',
  );
  const sub = parsed.positionals[0];
  const server = loadConfig().server;

  if (sub === 'prune') {
    const dryRun = parsed.flags['dry-run'] === true;
    const r = await post<PruneResponse>(
      server,
      `/store/prune${dryRun ? '?dry_run=1' : ''}`,
      120_000,
    );
    const sizes =
      `  db ${mb(r.db_bytes)} · sync_log ${r.sync_log_rows} rows / ${mb(r.sync_log_bytes)}` +
      ` · archive ${mb(r.archive_bytes ?? 0)}\n`;
    if (r.dry_run) {
      process.stdout.write(
        `${theme.meta('dry run — nothing pruned')}\n` +
          `  audit churn prunable now: ${r.audit_churn.rows ?? 0} rows (older than ${new Date(r.audit_churn.cutoff).toISOString().slice(0, 10)})\n` +
          sizes +
          theme.meta(`  archive dir: ${r.archive_dir ?? 'none (in-memory store)'}\n`),
      );
      return 0;
    }
    process.stdout.write(
      success(
        `pruned ${r.audit_churn.pruned ?? 0} audit churn rows (${mb(r.audit_churn.archivedBytes)} archived)` +
          `, ${r.trace_content?.pruned ?? 0} trace content rows`,
        { next: 'musterd store compact  (once, to hand the freed pages back to disk)' },
      ) +
        '\n' +
        sizes,
    );
    return 0;
  }

  if (sub === 'compact') {
    process.stdout.write(
      theme.meta('compacting — the daemon holds the write lock until the VACUUM finishes\n'),
    );
    const r = await post<CompactResponse>(server, '/store/compact', 600_000);
    process.stdout.write(
      success(
        `compacted ${mb(r.before_bytes)} → ${mb(r.after_bytes)}; auto-vacuum is incremental from here`,
      ) + '\n',
    );
    return 0;
  }

  if (sub === 'archive' && parsed.positionals[1] === 'ls') {
    const dir = join(dirname(await daemonDbPath(server)), 'archive');
    if (!existsSync(dir)) {
      process.stdout.write(`${theme.meta(`no archive yet at ${dir}`)}\n`);
      return 0;
    }
    const files = readdirSync(dir).sort();
    let total = 0;
    for (const f of files) {
      const size = statSync(join(dir, f)).size;
      total += size;
      process.stdout.write(`  ${f.padEnd(28)} ${mb(size)}\n`);
    }
    process.stdout.write(theme.meta(`  ${files.length} file(s), ${mb(total)} — ${dir}\n`));
    return 0;
  }

  throw new CliError(USAGE, 2);
}
