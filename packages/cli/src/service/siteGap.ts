/**
 * Landed is not live (ADR 308 §Observability, lane 01M2XD2RPG). The public site is published by one
 * seat's standing authorization, outside the merge → accept loop, so a stranger-facing change can be
 * merged, accepted and recorded `done` while musterd.io keeps serving the sentence it removed —
 * measured 2026-09-19 with four homepage strings, every instrument green. This module is the
 * instrument that ADR's Observability section asked for: compare the build marker the site serves
 * (`/build.json`, staged by `stage-site.mjs` from the ADR 135 stamp) against `origin/main` and
 * report the site-affecting commits between them.
 *
 * Pure: every fact (the marker, the tip, git's answer) is injected, so the tick and the human
 * command share one computation and the tests need no network and no repo.
 */

/** The `/build.json` the site serves — the ADR 135 stamp shape. `null` ref = stamped outside git. */
export interface DeployedMarker {
  ref: string | null;
  builtAt?: string;
}

/** A commit in the gap: short sha + subject, in `git log` (newest-first) order. */
export interface GapCommit {
  sha: string;
  subject: string;
}

export type SiteGapStatus =
  /** The deployed ref is the tip, or nothing site-affecting landed since it. */
  | 'current'
  /** Site-affecting commits sit between the deployed ref and the tip. */
  | 'behind'
  /** The site serves no marker (a deploy from before the marker existed) — the gap is unknowable. */
  | 'no_marker'
  /** The marker names a ref this checkout does not have (a `-dirty` deploy, or an unfetched sha). */
  | 'unknown_ref';

export interface SiteGap {
  status: SiteGapStatus;
  /** The ref as the marker gave it (`-dirty` suffix kept: a dirty deploy is a fact worth printing). */
  deployed: string | null;
  tip: string;
  behind: GapCommit[];
}

/**
 * The paths whose commits count as "the site changed". `packages/web` is the whole public artifact
 * — routes, content, the docs manifest and the site-files plugin all live under it. The conservative
 * side still holds: a false "behind" costs miley one glance at the list; a false "current" is the
 * exact defect this instrument exists to end.
 *
 * _(2026-10-13, lane 01M4VA7NQG)_ The daemon-only sources inside it are excluded — see
 * {@link sitePathspecs}. Counting them asked nick for two deploys that changed nothing public
 * (#2480, #2485: `src/live` only). They are excluded by a list the deploy itself decides
 * (`stage-allowlist.mjs` `DAEMON_ONLY_SOURCES`), never one written here, so a false "current" can
 * only come from a public page importing daemon code, which `site-routes.test.ts` refuses.
 */
export const SITE_PATHS = ['packages/web'] as const;

/**
 * The `git log` pathspecs: {@link SITE_PATHS}, minus each daemon-only source (relative to
 * `packages/web`, as `DAEMON_ONLY_SOURCES` gives them). A commit that also touches anything
 * outside those still counts. An empty list — the allowlist could not be read — counts everything,
 * which is the old, conservative answer.
 */
export function sitePathspecs(daemonOnly: readonly string[]): string[] {
  return [...SITE_PATHS, ...daemonOnly.map((p) => `:(exclude)packages/web/${p}`)];
}

export interface GitReader {
  /** Does this ref resolve to a commit in the local object store? */
  hasCommit: (ref: string) => boolean;
  /** `git log --format=%h%x09%s <from>..<to> -- <paths>`, one line per commit, newest first. */
  logRange: (from: string, to: string, paths: readonly string[]) => string[];
}

export function computeSiteGap(
  marker: DeployedMarker | null,
  tip: string,
  git: GitReader,
  daemonOnly: readonly string[] = [],
): SiteGap {
  if (!marker || !marker.ref) return { status: 'no_marker', deployed: null, tip, behind: [] };
  const deployed = marker.ref;
  const sha = deployed.replace(/-dirty$/, '');
  if (!git.hasCommit(sha)) return { status: 'unknown_ref', deployed, tip, behind: [] };
  const behind = git
    .logRange(sha, tip, sitePathspecs(daemonOnly))
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const i = l.indexOf('\t');
      return i < 0 ? { sha: l, subject: '' } : { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });
  return { status: behind.length === 0 ? 'current' : 'behind', deployed, tip, behind };
}

const short = (ref: string) => ref.replace(/^([0-9a-f]{8})[0-9a-f]*(-dirty)?$/, '$1$2');

/** One line a human or a log can read; the ask body is built from the same facts. */
export function siteGapLine(g: SiteGap, origin: string): string {
  switch (g.status) {
    case 'current':
      return `${origin} is at ${short(g.deployed!)} — current with ${short(g.tip)} on ${SITE_PATHS.join(', ')}`;
    case 'behind':
      return `${origin} is at ${short(g.deployed!)} — ${g.behind.length} site-affecting commit(s) behind ${short(g.tip)}`;
    case 'no_marker':
      return `${origin} serves no /build.json — deployed from a build before the marker existed; the gap cannot be measured until the next deploy`;
    case 'unknown_ref':
      return `${origin} is at ${short(g.deployed!)}, a ref this checkout does not have — fetch, or a dirty deploy (ADR 135)`;
  }
}

/**
 * The seat ADR 308 names, now the FALLBACK (ADR 734): the hand deploy is theirs when the publisher
 * cannot, and the failure of a publisher deploy is sent to them. A constant, not config: the
 * authorization is a person, and the message says so.
 */
export const DEPLOY_AUTHORIZED_SEAT = 'miley';

/**
 * The ask the publisher raises to the authorizing human (ADR 734): the commits, the exact tip an
 * accept deploys, and what decline means. The tip is in full so the reply is checkable against it.
 */
export function siteGapAskBody(g: SiteGap, origin: string): string {
  const list = g.behind
    .slice(0, 12)
    .map((c) => `  ${c.sha} ${c.subject}`)
    .join('\n');
  const more = g.behind.length > 12 ? `\n  … and ${g.behind.length - 12} more` : '';
  return (
    `Deploy ${origin}? ${siteGapLine(g, origin)}.\n${list}${more}\n` +
    `Accept deploys exactly ${short(g.tip)} (${g.tip}) from the publisher's build, with this machine's wrangler login (ADR 734). ` +
    `If main moves first, this ask is withdrawn and a fresh one lists the new set. ` +
    `Decline: no deploy, and no new ask until main moves. ` +
    `The hand path, \`pnpm --filter @musterd/web deploy:site\`, stays ${DEPLOY_AUTHORIZED_SEAT}'s fallback (ADR 308).`
  );
}

/**
 * What the reporter remembers between ticks, at `~/.musterd/live/site-gap.json`. `ask` is the open
 * raise's id — also its thread (a root's thread is its own id, ADR 432) — so the tick that finds the
 * site caught up can close exactly what it opened. `asked_tip` is the tip that ask named, so a tip
 * that moved is noticed (ADR 734 §3). `decided` is the last tip the human answered or the publisher
 * acted on, and how: a declined or failed tip is not asked again until main moves (§4, §5).
 */
export interface SiteGapStamp {
  deployed: string | null;
  tip: string;
  ask: string | null;
  raised_at: number | null;
  asked_tip?: string | null;
  decided?: { tip: string; outcome: 'deployed' | 'declined' | 'failed' } | null;
}

/** The authorizer's answer on the open ask, as the tick read it from the live seat's inbox. */
export type SiteGapReply = 'accept' | 'decline' | null;

export type SiteGapAction =
  /** Ask the authorizer to deploy the tip. */
  | 'raise'
  /** Close the open ask: the site caught up, or a deploy landed somewhere else. */
  | 'resolve'
  /** Main moved past the asked tip: withdraw the ask and raise a fresh one (ADR 734 §3). */
  | 'moved'
  /** Accepted, and the publisher's build of that tip is published: stage and deploy it. */
  | 'deploy'
  /** Accepted, but the build of that tip has not finished: deploy on a later tick. */
  | 'wait'
  /** Declined: close the ask and remember the tip. */
  | 'decline'
  | 'none';

/**
 * The tick's decision, stated as rules. One open ask at a time. A deploy that lands somewhere short
 * of the tip resolves the old ask (the fact changed; the next tick raises afresh). Main moving past
 * the asked tip withdraws the ask, because an accept covers only the commits it named. A tip the
 * human declined, or one the publisher failed on, is not asked again until the tip changes.
 * Catching up resolves. `no_marker` and `unknown_ref` never raise — an ask that cannot name the gap
 * is noise. `built` says the publisher's checkout is at the tip with that tip published.
 */
export function nextAction(
  prev: SiteGapStamp | null,
  g: SiteGap,
  reply: SiteGapReply = null,
  built = false,
): SiteGapAction {
  const open = prev?.ask ?? null;
  if (g.status === 'behind') {
    if (!open) return prev?.decided?.tip === g.tip ? 'none' : 'raise';
    if (prev!.deployed !== g.deployed) return 'resolve';
    if (prev!.asked_tip && prev!.asked_tip !== g.tip) return 'moved';
    if (reply === 'decline') return 'decline';
    if (reply === 'accept') return built ? 'deploy' : 'wait';
    return 'none';
  }
  if (g.status === 'current') return open ? 'resolve' : 'none';
  return 'none';
}

/**
 * The authorizer's answer among the envelopes the live seat read: the newest accept or decline from
 * them that names the ask (`meta.in_reply_to`, or the ask as its thread). Anyone else's answer is
 * not an answer — the ask was to one person.
 */
export function replyOnAsk(
  envelopes: readonly { from: string; act: string; thread?: unknown; meta?: unknown }[],
  ask: string,
  authorizer: string,
): SiteGapReply {
  let reply: SiteGapReply = null;
  for (const e of envelopes) {
    if (e.from !== authorizer) continue;
    if (e.act !== 'accept' && e.act !== 'decline') continue;
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    if (meta['in_reply_to'] !== ask && e.thread !== ask) continue;
    reply = e.act;
  }
  return reply;
}
