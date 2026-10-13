import { execFile } from 'node:child_process';
import {
  claimsFromEvidence,
  claimsLine,
  type ClaimEvidence,
  type ClaimRefs,
  type LaneClaim,
} from '@musterd/protocol';
import { theme } from '../render/theme.js';

/**
 * ADR 585 — the verification rail's checkers for the CLI, run in the invoking clone: the same
 * evidence the MCP adapter gathers (`packages/mcp/src/mergeVerify.ts`), judged by the one verdict
 * rule in `@musterd/protocol`. The CLI's `lane submit` filed no verification at all before this
 * (the merge-verified submit of ADR 300 lived only in the adapter); now both doors file the same
 * claims. A check that cannot run abstains and the claim records `unverifiable` — never a guess.
 */

export type ExecOut = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

export const defaultExecOut: ExecOut = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout ?? ''),
      });
    });
  });

export async function gatherClaimEvidence(
  refs: ClaimRefs,
  cwd: string,
  execOut: ExecOut = defaultExecOut,
): Promise<ClaimEvidence> {
  const run = async (cmd: string, args: string[], timeoutMs = 15_000) => {
    try {
      return await execOut(cmd, args, { cwd, timeoutMs });
    } catch {
      return null;
    }
  };
  const out: ClaimEvidence = {};
  if (refs.sha !== undefined) {
    // ADR 300's tiers: a negative needs a FRESH fetch (a stale origin/main could fake "not landed");
    // a positive needs no fresh ref — history only grows.
    const fetched = (await run('git', ['fetch', '--quiet', 'origin', 'main']))?.code === 0;
    const exists = (await run('git', ['cat-file', '-e', `${refs.sha}^{commit}`]))?.code === 0;
    if (!exists) out.ancestry = fetched ? 'unknown_object' : 'fetch_failed';
    else {
      const a = await run('git', ['merge-base', '--is-ancestor', refs.sha, 'origin/main']);
      out.ancestry =
        a?.code === 0 ? 'ancestor' : a?.code === 1 && fetched ? 'not_ancestor' : 'fetch_failed';
    }
  }
  if (refs.branch !== undefined) {
    const r = await run('git', ['ls-remote', '--heads', 'origin', refs.branch]);
    out.branch_on_remote = r && r.code === 0 ? r.stdout.trim().length > 0 : null;
  }
  if (refs.pr !== undefined) {
    const v = await run(
      'gh',
      ['pr', 'view', String(refs.pr), '--json', 'state,mergeCommit'],
      20_000,
    );
    if (v && v.code === 0) {
      try {
        const j = JSON.parse(v.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
        out.pr = {
          merged: j.state === 'MERGED',
          ...(j.mergeCommit?.oid ? { merge_sha: j.mergeCommit.oid } : {}),
        };
      } catch {
        out.pr = null;
      }
    } else out.pr = null;
    const c = await run(
      'gh',
      ['pr', 'view', String(refs.pr), '--json', 'statusCheckRollup'],
      20_000,
    );
    if (c && c.code === 0) {
      try {
        const j = JSON.parse(c.stdout) as {
          statusCheckRollup?: { conclusion?: string; status?: string }[];
        };
        const checks = j.statusCheckRollup ?? [];
        const bad = checks.some((x) =>
          ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(x.conclusion ?? ''),
        );
        const good = checks.some((x) => x.conclusion === 'SUCCESS');
        out.ci_green = checks.length === 0 ? null : !bad && good;
      } catch {
        out.ci_green = null;
      }
    } else out.ci_green = null;
  }
  return out;
}

export async function checkClaims(
  refs: ClaimRefs,
  cwd: string,
  checkedBy: string,
  deps: { execOut?: ExecOut; now?: () => number } = {},
): Promise<LaneClaim[]> {
  const evidence = await gatherClaimEvidence(refs, cwd, deps.execOut);
  return claimsFromEvidence(refs, evidence, checkedBy, (deps.now ?? Date.now)());
}

/** One terminal line: `claims: commit_landed ✓ · pr_merged ✓ · ci_green ?  (checked by ryder)`. */
export function renderClaims(claims: readonly LaneClaim[] | undefined): string {
  if (!claims || claims.length === 0) return '';
  const by = [...new Set(claims.map((c) => c.checked_by))].join(', ');
  const unconfirmed = claims.filter((c) => c.verdict === 'unconfirmed');
  const line = `${theme.accent('claims')}: ${claimsLine(claims)} ${theme.meta(`(checked by ${by})`)}`;
  const why = unconfirmed.map(
    (c) => `  ${theme.warn('✗')} ${c.kind} ${c.ref}: ${c.evidence ?? ''}`,
  );
  return [line, ...why].join('\n');
}

/** Injectable for the command tests, which run against an in-process daemon in a temp dir that is
 *  no git clone and must not shell out to `gh`. */
export const claimSeams: { check: typeof checkClaims } = { check: checkClaims };
