import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd reap [--yes]` (ADR 242) — reclaim orphaned MCP sidecar processes.
 *
 * The CLI never kills anything itself: it reads the daemon's latest footprint tick, shows what the
 * sampler classified `orphaned`, and — only with `--yes` — asks the daemon to reap those pids. The
 * daemon re-verifies every pid against the live process table at kill time (allowlist match + still
 * orphaned) and refuses the rest with named reasons, so a stale sample can never kill a recycled
 * pid. No interactive prompt: list first, `--yes` to apply, matching the CLI's non-interactive
 * convention.
 */

interface FootprintStackLike {
  classification: string;
  procs: number;
  rss_kb: number;
  pids: string;
}
export interface FootprintTickLike {
  ts: number;
  stacks: FootprintStackLike[];
  machine: {
    swap_used_mb: number | null;
    swap_total_mb: number | null;
    free_mem_mb: number | null;
  };
}
export interface ReapResultLike {
  killed: number[];
  refused: { pid: number; reason: string }[];
}

/** Pids of every orphaned stack in the tick; a malformed pids blob is skipped, never thrown on. */
export function orphanPids(tick: FootprintTickLike): number[] {
  const pids: number[] = [];
  for (const s of tick.stacks) {
    if (s.classification !== 'orphaned') continue;
    try {
      const parsed = JSON.parse(s.pids) as unknown;
      if (Array.isArray(parsed))
        pids.push(...parsed.filter((p): p is number => Number.isInteger(p)));
    } catch {
      /* a malformed blob loses its pids, not the command */
    }
  }
  return pids;
}

export function renderReapPlan(tick: FootprintTickLike): string {
  const orphaned = tick.stacks.filter((s) => s.classification === 'orphaned');
  const procs = orphaned.reduce((sum, s) => sum + s.procs, 0);
  if (procs === 0) return 'no orphaned MCP sidecars — nothing to reap.';
  const mb = Math.round(orphaned.reduce((sum, s) => sum + s.rss_kb, 0) / 1024);
  return (
    `${procs} orphaned MCP sidecar proc${procs === 1 ? '' : 's'} (~${mb} MB RSS) from ended sessions.\n` +
    `run again with --yes to reap them (the daemon re-verifies each pid before any kill).`
  );
}

export function renderReapResult(result: ReapResultLike): string {
  const lines = [`killed ${result.killed.length} proc${result.killed.length === 1 ? '' : 's'}`];
  if (result.refused.length > 0) {
    lines.push(
      `refused ${result.refused.length}: ` +
        result.refused.map((r) => `${r.pid} (${r.reason})`).join(', '),
    );
  }
  return lines.join('\n');
}

/**
 * The flags `musterd reap` takes (lane
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
 * The flags `musterd reap` takes (lane
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
export const REAP_FLAGS = ['yes'] as const;

export async function reapCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...REAP_FLAGS],
    'the flags `musterd reap` takes are listed by `musterd help reap`',
  );
  const { http, team } = resolveRead(parsed.flags, { claimSeatPerRequest: true });
  const tick = await http.footprint(team);
  if (!tick) {
    process.stdout.write(
      'the daemon has no footprint data yet (older daemon, or its sampler just started).\n',
    );
    return 0;
  }
  if (parsed.flags['yes'] !== true) {
    process.stdout.write(renderReapPlan(tick) + '\n');
    return 0;
  }
  const pids = orphanPids(tick);
  if (pids.length === 0) {
    process.stdout.write('no orphaned MCP sidecars — nothing to reap.\n');
    return 0;
  }
  const result = await http.reapFootprint(team, pids);
  process.stdout.write(renderReapResult(result) + '\n');
  return 0;
}
