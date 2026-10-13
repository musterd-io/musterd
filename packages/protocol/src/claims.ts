import { z } from 'zod';

/**
 * Verification as protocol (ADR 585): the closed vocabulary of claims a seat files when it
 * submits a lane, each checked by deterministic code — never by a model — and recorded with its
 * verdict and who checked it. A submitter's claims are checked in the submitter's own clone; an
 * acceptor's `accept` re-checks the same claims in the acceptor's clone, so a lane closed by a
 * different seat carries two independent readings of the same facts.
 *
 * Anything outside the vocabulary is not a claim. The vocabulary widens one kind at a time, each
 * with a deterministic checker; nothing is ever half-verified.
 */
export const LANE_CLAIM_KINDS = [
  /** The attested SHA is reachable from origin/main (`git merge-base --is-ancestor`). */
  'commit_landed',
  /** The lane's branch exists on the remote (`git ls-remote --heads origin <branch>`). */
  'branch_pushed',
  /** The attested PR is merged and its merge commit is the attested SHA (`gh pr view`). */
  'pr_merged',
  /** The PR's required check concluded success (`gh pr checks`). */
  'ci_green',
] as const;
export type LaneClaimKind = (typeof LANE_CLAIM_KINDS)[number];

export const LANE_CLAIM_VERDICTS = ['confirmed', 'unconfirmed', 'unverifiable'] as const;
export type LaneClaimVerdict = (typeof LANE_CLAIM_VERDICTS)[number];

export const LaneClaimSchema = z.object({
  kind: z.enum(LANE_CLAIM_KINDS),
  /** What the claim is about: the SHA, the branch, the PR number, the check name. */
  ref: z.string().min(1).max(120),
  verdict: z.enum(LANE_CLAIM_VERDICTS),
  /** The seat whose clone ran the check. Stamped by the daemon from the authenticated sender,
   *  never trusted from the body. */
  checked_by: z.string().min(1).max(80),
  checked_at: z.number().int().nonnegative(),
  /** One line of what the checker saw — a git exit, a `gh` field, "gh not installed". */
  evidence: z.string().max(200).optional(),
});
export type LaneClaim = z.infer<typeof LaneClaimSchema>;

/** At most this many claims ride one submit or one accept. */
export const LANE_CLAIMS_MAX = 16;
export const LaneClaimsSchema = z.array(LaneClaimSchema).max(LANE_CLAIMS_MAX);

/** What the checkers observed; each `null` means the check could not run (recorded unverifiable). */
export interface ClaimEvidence {
  /** The merge-verified-submit tier (ADR 300): `ancestor` confirms, `not_ancestor` refutes,
   *  anything else abstains. Undefined when no SHA was attested. */
  ancestry?: 'ancestor' | 'not_ancestor' | 'unknown_object' | 'fetch_failed' | 'unattested';
  /** `git ls-remote --heads origin <branch>` found the ref. */
  branch_on_remote?: boolean | null;
  /** `gh pr view <pr> --json state,mergeCommit`: merged, and the merge commit if merged. */
  pr?: { merged: boolean; merge_sha?: string | undefined } | null;
  /** `gh pr checks <pr>`: every required check concluded success. */
  ci_green?: boolean | null;
}

export interface ClaimRefs {
  sha?: string | undefined;
  branch?: string | undefined;
  pr?: number | undefined;
}

/**
 * Turn what was attested and what the checkers saw into claims. Pure: the exec happens in the
 * package that owns a clone (`@musterd/mcp`, `@musterd/cli`); this is the one place the verdict
 * rule lives, so the two never disagree about what "confirmed" means.
 */
export function claimsFromEvidence(
  refs: ClaimRefs,
  evidence: ClaimEvidence,
  checkedBy: string,
  now: number,
): LaneClaim[] {
  const out: LaneClaim[] = [];
  const claim = (
    kind: LaneClaimKind,
    ref: string,
    verdict: LaneClaimVerdict,
    evidenceLine: string,
  ): void => {
    out.push({
      kind,
      ref,
      verdict,
      checked_by: checkedBy,
      checked_at: now,
      evidence: evidenceLine,
    });
  };
  if (refs.sha !== undefined) {
    const a = evidence.ancestry;
    claim(
      'commit_landed',
      refs.sha,
      a === 'ancestor' ? 'confirmed' : a === 'not_ancestor' ? 'unconfirmed' : 'unverifiable',
      a === 'ancestor'
        ? 'reachable from origin/main'
        : a === 'not_ancestor'
          ? 'not reachable from origin/main after a fresh fetch'
          : a === 'unknown_object'
            ? 'SHA not in this clone (cross-repo lane?)'
            : a === 'fetch_failed'
              ? 'could not fetch origin/main'
              : 'no check ran',
    );
  }
  if (refs.branch !== undefined) {
    const b = evidence.branch_on_remote;
    claim(
      'branch_pushed',
      refs.branch,
      b === true ? 'confirmed' : b === false ? 'unconfirmed' : 'unverifiable',
      b === true
        ? 'ref present on origin'
        : b === false
          ? 'no such ref on origin (deleted after merge is the normal case)'
          : 'could not read origin',
    );
  }
  if (refs.pr !== undefined) {
    const p = evidence.pr;
    const shaMatch =
      p?.merged === true &&
      refs.sha !== undefined &&
      p.merge_sha !== undefined &&
      p.merge_sha.toLowerCase().startsWith(refs.sha.toLowerCase());
    claim(
      'pr_merged',
      String(refs.pr),
      p === null || p === undefined
        ? 'unverifiable'
        : !p.merged
          ? 'unconfirmed'
          : refs.sha === undefined || shaMatch
            ? 'confirmed'
            : 'unconfirmed',
      p === null || p === undefined
        ? 'gh unavailable or PR unreadable'
        : !p.merged
          ? 'PR is not merged'
          : refs.sha === undefined
            ? 'merged'
            : shaMatch
              ? `merged as ${p.merge_sha ?? '?'}`
              : `merged as ${p.merge_sha ?? '?'}, not the attested SHA`,
    );
    const c = evidence.ci_green;
    claim(
      'ci_green',
      String(refs.pr),
      c === true ? 'confirmed' : c === false ? 'unconfirmed' : 'unverifiable',
      c === true
        ? 'every required check succeeded'
        : c === false
          ? 'a required check did not succeed'
          : 'gh unavailable or checks unreadable',
    );
  }
  return out;
}

export interface ClaimsSummary {
  confirmed: number;
  unconfirmed: number;
  unverifiable: number;
  /** Seats that checked at least one claim. */
  checkers: string[];
}

export function summariseClaims(claims: readonly LaneClaim[]): ClaimsSummary {
  const s: ClaimsSummary = { confirmed: 0, unconfirmed: 0, unverifiable: 0, checkers: [] };
  for (const c of claims) {
    s[c.verdict] += 1;
    if (!s.checkers.includes(c.checked_by)) s.checkers.push(c.checked_by);
  }
  return s;
}

/**
 * Merge a checker's fresh claims into a lane's standing list: a seat's new reading of a
 * (kind, ref) replaces its own earlier one; other seats' readings stay. Order: by kind, then by
 * checker, so the record reads the same whichever seat checked last.
 */
export function mergeClaims(
  standing: readonly LaneClaim[],
  fresh: readonly LaneClaim[],
): LaneClaim[] {
  const keep = standing.filter(
    (s) =>
      !fresh.some((f) => f.kind === s.kind && f.ref === s.ref && f.checked_by === s.checked_by),
  );
  const all = [...keep, ...fresh];
  const kindOrder = (k: LaneClaimKind) => LANE_CLAIM_KINDS.indexOf(k);
  return all
    .sort(
      (a, b) =>
        kindOrder(a.kind) - kindOrder(b.kind) ||
        a.ref.localeCompare(b.ref) ||
        a.checked_by.localeCompare(b.checked_by),
    )
    .slice(0, LANE_CLAIMS_MAX * 4);
}

/** One line for a terminal or a tool reply: `commit_landed ✓ · pr_merged ✓ · ci_green ?`. */
export function claimsLine(claims: readonly LaneClaim[]): string {
  const mark = (v: LaneClaimVerdict) => (v === 'confirmed' ? '✓' : v === 'unconfirmed' ? '✗' : '?');
  return claims.map((c) => `${c.kind} ${mark(c.verdict)}`).join(' · ');
}
