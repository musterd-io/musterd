import {
  composeQuickActionLine,
  makeEnvelope,
  QuickActionSchema,
  type QuickAction,
  type QuickActionPr,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendAudit } from '../store/audit.js';
import { listLanes } from '../store/lanes.js';
import { getMemberById, listMembers } from '../store/members.js';
import { hasLivePresence } from '../store/presence.js';
import { getResidency } from '../store/residency.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { listPrs, prForLane, prWatchRepos, readPrState, type GhRunner } from './prState.js';
import { routeEnvelope } from './route.js';

/**
 * Quick actions (ADR 779): Start, Check inbox, Check PR and Resume as a person's `steer` carrying
 * `meta.quick_action`. The steer already rings an idle session and is an immediate wake reason; this
 * module gives it its line — composed from the action and structured fields, never the body — and
 * the "Start everyone" fan-out.
 */

const LIVE_LANE_STATES = ['claimed', 'active', 'blocked', 'awaiting_acceptance'] as const;

/** The seat's one live lane, its branch, and — for Check PR — what GitHub says about its PR. */
export async function quickActionContext(
  db: Driver,
  team: { id: string; slug: string },
  seat: string,
  opts: { readPr?: boolean; run?: GhRunner; repos?: Map<string, string> } = {},
): Promise<{ lane?: string; branch?: string; pr?: QuickActionPr }> {
  const lanes = await listLanes(db, team.id, team.slug, {
    owner: seat,
    states: [...LIVE_LANE_STATES],
  });
  const lane = lanes.length === 1 ? lanes[0] : undefined;
  if (!lane) return {};
  const branch = lane.branch ?? undefined;
  const ctx = { lane: lane.id, ...(branch ? { branch } : {}) };
  if (lane.merged?.pr)
    return { ...ctx, pr: { number: lane.merged.pr, state: 'merged', checks: 'green' } };
  if (!opts.readPr) return ctx;
  const repo = (opts.repos ?? prWatchRepos()).get(team.slug);
  if (branch) return { ...ctx, pr: await readPrState(branch, repo, opts.run) };
  // No branch on the lane (most seats never set one): the PR that names the lane id.
  if (!repo) return { ...ctx, pr: { unknown: 'no_repo' } };
  const prs = await listPrs(repo, opts.run);
  if (!Array.isArray(prs)) return { ...ctx, pr: prs };
  const pr = prForLane(prs, lane);
  return {
    ...ctx,
    pr: pr ? { number: pr.number, state: pr.state, checks: pr.checks } : { unknown: 'no_pr' },
  };
}

/**
 * The line for a quick action addressed to `seat`, or null when the act is not one: not a steer, no
 * valid `meta.quick_action`, not from a person, or not addressed to this seat. A null caller keeps
 * its ordinary line.
 */
export async function quickActionLineFor(
  db: Driver,
  team: { id: string; slug: string },
  seat: string,
  actId: string,
  /** `readGitHub` false inside a transaction: a `gh` call (up to 5 s) must never hold one open. */
  opts: { readGitHub?: boolean; run?: GhRunner; repos?: Map<string, string> } = {},
): Promise<string | null> {
  const row = await db.get<{
    act: string;
    meta: string | null;
    from_member: string;
    to_member: string | null;
  }>('SELECT act, meta, from_member, to_member FROM messages WHERE team_id = ? AND id = ?', [
    team.id,
    actId,
  ]);
  if (!row || row.act !== 'steer' || !row.meta) return null;
  const action = QuickActionSchema.safeParse(
    (JSON.parse(row.meta) as Record<string, unknown>)['quick_action'],
  );
  if (!action.success) return null;
  const person = await getMemberById(db, row.from_member);
  const target = row.to_member ? await getMemberById(db, row.to_member) : undefined;
  if (!person || person.kind !== 'human' || target?.name !== seat) return null;
  const ctx = await quickActionContext(db, team, seat, {
    readPr: action.data === 'check_pr' && opts.readGitHub !== false,
    ...(opts.run ? { run: opts.run } : {}),
    ...(opts.repos ? { repos: opts.repos } : {}),
  });
  return composeQuickActionLine({
    team: team.slug,
    seat,
    person: person.name,
    action: action.data,
    actId,
    ...ctx,
  });
}

export type StartAllResult = 'started' | 'offline';

/**
 * One seat's quick action sent as `person` (ADR 791, the phone): the same `steer` `/live` posts,
 * through the ordinary route. `started` when the seat can hear it — live, or enrolled with a host
 * that can wake it; `offline` otherwise, and the steer still waits in its inbox. Null when `seat`
 * is not a standing agent seat on this team.
 */
export async function sendSeatQuickAction(
  ctx: Ctx,
  team: TeamRow,
  person: MemberRow,
  seat: string,
  action: QuickAction,
  now: number = Date.now(),
): Promise<'started' | 'offline' | null> {
  if (person.kind !== 'human')
    throw new MusterdError('forbidden', "a quick action is a person's (ADR 779)");
  const agent = (await listMembers(ctx.db, team.id)).find(
    (m) => m.name === seat && m.kind === 'agent' && m.left_at === null && m.observer === 0,
  );
  if (!agent) return null;
  const live = await hasLivePresence(ctx.db, agent.id, ctx.config.presenceTimeoutMs);
  const enrolled = (await getResidency(ctx.db, team.id, agent.id)) !== null;
  await routeEnvelope(
    ctx,
    team,
    person,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: person.name,
      to: { kind: 'member', name: agent.name },
      act: 'steer',
      body: QUICK_ACTION_BODY[action],
      meta: { quick_action: action },
      ts: now,
    }),
  );
  return live || enrolled ? 'started' : 'offline';
}

/** The steer's body for each action — never read by the seat (its line is composed), but kept
 *  the same words `/live` sends, so the timeline reads the same from either surface. */
const QUICK_ACTION_BODY: Record<QuickAction, string> = {
  start: 'Start',
  check_inbox: 'Check inbox',
  check_pr: 'Check PR',
  resume: 'Resume',
};

/**
 * "Start everyone" (ADR 779 §3): one `start` steer per agent seat that can hear it — live, or enrolled
 * with a host that can wake it; a seat with neither is `offline`. A Start is a person's steer, so it
 * passes the seat's hourly cap and cooldown (ADR 790) and is never held back as `capped`.
 */
export async function startAll(
  ctx: Ctx,
  team: TeamRow,
  person: MemberRow,
  now: number = Date.now(),
): Promise<{ seats: Array<{ seat: string; result: StartAllResult }> }> {
  if (person.kind !== 'human')
    throw new MusterdError('forbidden', "a quick action is a person's (ADR 779)");
  const agents = (await listMembers(ctx.db, team.id)).filter(
    (m) => m.kind === 'agent' && m.left_at === null && m.observer === 0,
  );
  const seats: Array<{ seat: string; result: StartAllResult }> = [];
  for (const agent of agents) {
    const live = await hasLivePresence(ctx.db, agent.id, ctx.config.presenceTimeoutMs);
    const enrolled = (await getResidency(ctx.db, team.id, agent.id)) !== null;
    if (!live && !enrolled) {
      seats.push({ seat: agent.name, result: 'offline' });
      continue;
    }
    await routeEnvelope(
      ctx,
      team,
      person,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: person.name,
        to: { kind: 'member', name: agent.name },
        act: 'steer',
        body: 'Start',
        meta: { quick_action: 'start' },
        ts: now,
      }),
    );
    seats.push({ seat: agent.name, result: 'started' });
  }
  await appendAudit(ctx.db, team.id, {
    actor: person.name,
    action: 'quick_action.start_all',
    target: null,
    result: 'allow',
    detail: {
      count: seats.filter((s) => s.result === 'started').length,
      offline: seats.filter((s) => s.result === 'offline').length,
    },
  });
  return { seats };
}
