/*
 * Merge-verified submit: classify a lane's merge attestation against origin/main using only
 * this worktree's git — no GitHub API, no poller, no new credential. The repo itself is the
 * source of truth for "merged", and the author's own `lane_submit` is the event that carries
 * the check (ADR 294 dec 2 / ADR 297 forbid the background-sweep shape).
 */
import { execFile } from 'node:child_process';
import {
  claimsFromEvidence,
  type ClaimEvidence,
  type ClaimRefs,
  type LaneClaim,
  type MergeVerification,
} from '@musterd/protocol';

/** What a submit-time check can conclude: a persistable tier, or the one refusal outcome. */
export type VerifyOutcome = MergeVerification | 'not_ancestor';

export type GitExec = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number }>;

/** Squash SHAs as callers actually pass them: abbreviated (≥7 hex) or full. */
export const SHA_FORMAT = /^[0-9a-f]{7,40}$/i;

export const defaultGitExec: GitExec = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err) => {
      // execFile errors carry a numeric exit code for a non-zero exit; spawn/timeout errors
      // carry a string code (ENOENT, ETIMEDOUT) or none — those reject and are caught above.
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });

/**
 * `not_ancestor` requires a SUCCESSFUL fetch: a stale origin/main ref can produce a false
 * "not landed", so without a fresh fetch the negative degrades to `fetch_failed` (abstain).
 * The positive needs no fresh ref — history only grows, so a stale ref cannot fake a landing.
 */
export async function verifyMerge(
  input: { sha?: string | undefined; cwd: string },
  exec: GitExec = defaultGitExec,
): Promise<VerifyOutcome> {
  if (input.sha === undefined) return 'unattested';
  const run = async (args: string[]): Promise<number> => {
    try {
      return (await exec(args, { cwd: input.cwd, timeoutMs: 15_000 })).code;
    } catch {
      return -1; // spawn failure / timeout — "could not run", never a throw to the caller
    }
  };
  const fetched = (await run(['fetch', '--quiet', 'origin', 'main'])) === 0;
  const exists = (await run(['cat-file', '-e', `${input.sha}^{commit}`])) === 0;
  if (!exists) return fetched ? 'unknown_object' : 'fetch_failed';
  const ancestry = await run(['merge-base', '--is-ancestor', input.sha, 'origin/main']);
  if (ancestry === 0) return 'ancestor';
  if (ancestry === 1 && fetched) return 'not_ancestor';
  return 'fetch_failed';
}

// ---------------------------------------------------------------------------------------------
// ADR 585 — the verification rail's checkers, run in THIS clone. Each check is deterministic code
// over git or `gh` output; a check that cannot run abstains (`null`) and the claim records
// `unverifiable`. The verdict rule itself lives in `@musterd/protocol` (`claimsFromEvidence`), so
// the CLI's checker and this one cannot disagree about what "confirmed" means.

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

/**
 * Gather the evidence the claims are judged from. `ancestry` reuses {@link verifyMerge}; the
 * branch check is one `ls-remote`; the PR checks go through `gh`, which may be absent or signed
 * out — then both PR claims abstain rather than guess.
 */
export async function gatherClaimEvidence(
  refs: ClaimRefs,
  cwd: string,
  exec: GitExec = defaultGitExec,
  execOut: ExecOut = defaultExecOut,
): Promise<ClaimEvidence> {
  const out: ClaimEvidence = {};
  if (refs.sha !== undefined) {
    const v = await verifyMerge({ sha: refs.sha, cwd }, exec);
    out.ancestry = v;
  }
  if (refs.branch !== undefined) {
    try {
      const r = await execOut('git', ['ls-remote', '--heads', 'origin', refs.branch], {
        cwd,
        timeoutMs: 15_000,
      });
      out.branch_on_remote = r.code === 0 ? r.stdout.trim().length > 0 : null;
    } catch {
      out.branch_on_remote = null;
    }
  }
  if (refs.pr !== undefined) {
    try {
      const r = await execOut(
        'gh',
        ['pr', 'view', String(refs.pr), '--json', 'state,mergeCommit'],
        { cwd, timeoutMs: 20_000 },
      );
      if (r.code === 0) {
        const j = JSON.parse(r.stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
        out.pr = {
          merged: j.state === 'MERGED',
          ...(j.mergeCommit?.oid ? { merge_sha: j.mergeCommit.oid } : {}),
        };
      } else out.pr = null;
    } catch {
      out.pr = null;
    }
    try {
      const r = await execOut(
        'gh',
        ['pr', 'view', String(refs.pr), '--json', 'statusCheckRollup'],
        { cwd, timeoutMs: 20_000 },
      );
      if (r.code === 0) {
        const j = JSON.parse(r.stdout) as {
          statusCheckRollup?: { conclusion?: string; status?: string }[];
        };
        const checks = j.statusCheckRollup ?? [];
        // Green means: nothing failed, and at least one check concluded success. Skipped leaves are
        // CI picking what a PR can affect (ci.yml), not a missing check.
        const bad = checks.some((c) =>
          ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion ?? ''),
        );
        const good = checks.some((c) => c.conclusion === 'SUCCESS');
        out.ci_green = checks.length === 0 ? null : !bad && good;
      } else out.ci_green = null;
    } catch {
      out.ci_green = null;
    }
  }
  return out;
}

/** The claims this seat files for a submit or an accept, checked in `cwd`. */
export async function checkClaims(
  refs: ClaimRefs,
  cwd: string,
  checkedBy: string,
  deps: { exec?: GitExec; execOut?: ExecOut; now?: () => number } = {},
): Promise<LaneClaim[]> {
  const evidence = await gatherClaimEvidence(refs, cwd, deps.exec, deps.execOut);
  return claimsFromEvidence(refs, evidence, checkedBy, (deps.now ?? Date.now)());
}
