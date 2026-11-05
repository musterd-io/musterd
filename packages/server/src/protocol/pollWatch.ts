import {
  makeEnvelope,
  type ApprovalProof,
  type OpenPoll,
  type PollMeta,
  type PollSpec,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { requireAuthority } from '../store/authority.js';
import { boardSeat } from '../store/boardSeat.js';
import { getMemberByName } from '../store/members.js';
import {
  closePoll,
  duePolls,
  openMeta,
  openPoll,
  pollMessage,
  setPollMessage,
} from '../store/polls.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { getTeamById } from '../store/teams.js';
import { routeEnvelope } from './route.js';

/**
 * Twitch polls' record (ADR 807 §9): the daemon composes both acts, so their `meta.poll` survives the
 * strip a client copy gets. Opening posts a team `message`; closing posts a `resolve` on its thread.
 * The sweep closes a poll at its deadline, or once its stream has been offline (or silent) 90 s.
 */

export const POLL_WATCH_MS = 5_000;

function optionList(options: readonly string[]): string {
  return options.map((o, i) => `${i + 1} · ${o}`).join(', ');
}

/** The closing line, as the team's history reads it. */
export function closeLine(p: Extract<PollMeta, { state: 'closed' }>): string {
  const pick = (i: number) => `${i + 1} · ${p.options[i]}`;
  switch (p.end) {
    case 'cancelled':
      return `[poll] cancelled: ${p.question}`;
    case 'interrupted':
      return `[poll] interrupted when the stream dropped (${p.voters} votes): ${p.question}`;
    default:
      if (p.winners.length === 0) return `[poll] closed with no votes: ${p.question}`;
      if (p.winners.length > 1)
        return `[poll] closed, a tie (${p.voters} votes): ${p.question} → ${p.winners.map(pick).join(' and ')}`;
      return `[poll] closed (${p.voters} votes): ${p.question} → ${pick(p.winners[0]!)}`;
  }
}

/** The open act's A2 check, returning the assurance so `bearer_unenrolled` can be refused. */
export async function requirePollAuthority(
  ctx: Ctx,
  team: TeamRow,
  presenter: MemberRow,
  spec: unknown,
  proof: ApprovalProof | undefined,
  opts: { expectedOrigins: string[]; expectedNodeId?: string },
): Promise<string> {
  const check = await requireAuthority(ctx.db, {
    teamId: team.id,
    audience: team.slug,
    presenter,
    credential: presenter.kind === 'human' ? 'human' : 'agent',
    act: 'credential_mint',
    target: team.slug,
    payload: { action: 'poll_open', spec },
    proof,
    expectedOrigins: opts.expectedOrigins,
    ...(opts.expectedNodeId ? { expectedNodeId: opts.expectedNodeId } : {}),
  });
  if (!check.ok)
    throw new MusterdError(
      'forbidden',
      `authority refused (${check.reason}): opening a poll requires an A2 device signature (ADR 807)`,
    );
  if (check.assurance === 'bearer_unenrolled')
    throw new MusterdError(
      'forbidden',
      'poll needs a passkey: enroll one before opening a poll (ADR 807)',
    );
  return check.assurance;
}

/** Open the team's poll and post its opening message. The caller checked the admin and the passkey. */
export async function openAndAnnounce(
  ctx: Ctx,
  team: TeamRow,
  opener: MemberRow,
  spec: PollSpec,
  assurance: string,
  now: number = Date.now(),
): Promise<OpenPoll> {
  const { poll } = await openPoll(ctx.db, team.id, opener.name, spec, now);
  const id = ulid();
  await routeEnvelope(
    ctx,
    team,
    opener,
    makeEnvelope({
      id,
      team: team.slug,
      from: opener.name,
      to: { kind: 'team' },
      act: 'message',
      body: `[poll] ${opener.name} asks the stream: ${poll.question} (${optionList(poll.options)}; ${poll.minutes} min)`,
      meta: { poll: openMeta(poll) },
      ts: now,
    }),
    undefined,
    true,
  );
  await setPollMessage(ctx.db, poll.id, id);
  await appendAudit(ctx.db, team.id, {
    actor: opener.name,
    action: 'poll.open',
    target: poll.id,
    result: 'allow',
    detail: { options: poll.options.length, minutes: poll.minutes, assurance },
  });
  return poll;
}

/** Close a poll and post the result on its thread. Null when it was not open. */
export async function closeAndAnnounce(
  ctx: Ctx,
  team: TeamRow,
  pollId: string,
  end: Extract<PollMeta, { state: 'closed' }>['end'],
  by: MemberRow | null,
  now: number = Date.now(),
): Promise<Extract<PollMeta, { state: 'closed' }> | null> {
  const record = await closePoll(ctx.db, team.id, pollId, end, now);
  if (!record) return null;
  const sender =
    by ??
    (await getMemberByName(ctx.db, team.id, record.opened_by)) ??
    (await boardSeat(ctx.db, team));
  const thread = (await pollMessage(ctx.db, pollId)) ?? pollId;
  if (sender) {
    await routeEnvelope(
      ctx,
      team,
      sender,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: sender.name,
        to: { kind: 'team' },
        act: 'resolve',
        thread,
        body: closeLine(record),
        meta: { poll: record },
        ts: now,
      }),
      undefined,
      true,
    );
  }
  await appendAudit(ctx.db, team.id, {
    actor: sender?.name ?? null,
    action: 'poll.close',
    target: pollId,
    result: 'allow',
    detail: { end, voters: record.voters, winners: record.winners },
  });
  return record;
}

/** One pass: close every poll that is due. Returns how many it closed. */
export async function sweepPolls(ctx: Ctx, now: number = Date.now()): Promise<number> {
  let closed = 0;
  for (const due of await duePolls(ctx.db, now)) {
    const team = await getTeamById(ctx.db, due.teamId);
    if (!team) continue;
    if (await closeAndAnnounce(ctx, team, due.pollId, due.end, null, now)) closed++;
  }
  return closed;
}

export function startPollWatch(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepPolls(ctx);
    } catch (err) {
      log.warn({ msg: 'poll_watch_failed', err: String(err) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), POLL_WATCH_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
