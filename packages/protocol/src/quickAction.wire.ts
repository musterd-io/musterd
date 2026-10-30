/**
 * Quick actions (ADR 779): the four prompts a person used to type into a seat's session — Start,
 * Check inbox, Check PR, Resume — as a typed `steer`. Plain TypeScript, no zod, so `/live` and the
 * phone read the vocabulary without a validator. `quickAction.ts` builds the schemas.
 */

export const QUICK_ACTIONS = ['start', 'check_inbox', 'check_pr', 'resume'] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

export const PR_EVENT_STATES = ['merged', 'ci_red', 'ci_green'] as const;
export type PrEventState = (typeof PR_EVENT_STATES)[number];

/** What the daemon read of the seat's lane PR for `check_pr`, or why it could not. */
export type QuickActionPr =
  | {
      number: number;
      state: 'open' | 'merged' | 'closed';
      checks: 'green' | 'red' | 'pending' | 'none';
    }
  | { unknown: 'no_pr' | 'no_gh' | 'gh_error' };

/** A structured field is only interpolated when it is a plain token (ADR 558's idle-seam rule). */
function token(s: string | undefined): string | undefined {
  return s !== undefined && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/.test(s) ? s : undefined;
}

function prPhrase(pr: QuickActionPr | undefined, branch: string | undefined): string {
  // Not read (a headless wake reads no GitHub inside its lease): point the seat at its PR instead.
  if (pr === undefined)
    return branch
      ? `check your lane's PR yourself (gh pr view ${branch})`
      : 'no PR on your lane yet';
  if ('unknown' in pr && pr.unknown === 'no_pr') return 'no PR on your lane yet';
  if ('unknown' in pr)
    return pr.unknown === 'no_gh'
      ? 'musterd could not read GitHub here (no gh login on the hub) — check it yourself'
      : 'musterd could not read GitHub just now — check it yourself';
  const checks = pr.checks === 'none' ? 'no checks' : `checks ${pr.checks}`;
  return `your lane's PR #${pr.number} is ${pr.state}, ${checks}`;
}

/**
 * The daemon-composed line for a quick action (ADR 779 §2): ids and daemon-read states only, never
 * the steer's body (ADR 088 §4). Seat memory is referred to, never quoted.
 */
export function composeQuickActionLine(p: {
  team: string;
  seat: string;
  person: string;
  action: QuickAction;
  actId: string;
  lane?: string | undefined;
  branch?: string | undefined;
  pr?: QuickActionPr | undefined;
}): string {
  const head = `⚡ musterd [${p.team}]: ${p.person} pressed ${p.action.replace('_', ' ')} for you, seat "${p.seat}" — `;
  const lane = token(p.lane);
  const branch = token(p.branch);
  const ask = (() => {
    switch (p.action) {
      case 'start':
        return 'orient now: run the musterd-orient skill (team_inbox_check first) and handle what is addressed to you.';
      case 'check_inbox':
        return 'read your inbox (team_inbox_check) and act on what is addressed to you.';
      case 'check_pr':
        return `${prPhrase(p.pr, branch)}. If it merged, lane_submit; if it is red, look at the failing check.`;
      case 'resume':
        return lane
          ? `pick up lane ${lane}${branch ? ` on branch ${branch}` : ''} where you left off; read your seat memory first (team_memory_read).`
          : 'pick up where you left off: read your seat memory (team_memory_read), then team_next.';
    }
  })();
  return `${head}${ask} (act ${p.actId})`;
}
