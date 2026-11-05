import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApprovalProofSchema,
  PollCountsSchema,
  PollSpecSchema,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { closeAndAnnounce, openAndAnnounce, requirePollAuthority } from '../protocol/pollWatch.js';
import { parseOrBadRequest } from '../protocol/validate.js';
import { authMember } from '../store/members.js';
import { openPollReply, reportCounts, reportLive } from '../store/polls.js';
import { resolveCapabilities, resolveObserverScope, type MemberRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { authorityAtHub } from '../sync/authorityRelay.js';
import { joinerEnrollment } from '../sync/claim.js';
import { HubUnreachableError } from '../sync/hubDiagnosis.js';

/**
 * Twitch polls over HTTP (ADR 807), under `/teams/:slug`:
 *
 * - `POST /polls` — a human admin opens the team's poll, with A2 proof for `credential_mint`; a joiner
 *   relays it to the hub (ADR 728). `bearer_unenrolled` is refused: a passkey is the point.
 * - `POST /polls/:id/end` and `/cancel` — a human admin, on the hub. No proof: nothing is minted.
 * - `GET /polls/open` — any member that can read; the broadcast observer seat gets the token only
 *   when it asks (`?token=1`), so the /broadcast page's reads on that seat mint nothing.
 * - `POST /polls/:id/counts` — the `mspoll_` token only, and integers only (`PollCountsSchema`).
 * - `POST /stream/live` — the broadcast observer seat says whether Twitch shows the channel live.
 */

/** http.ts's request helpers, handed in so this module stays out of the routing file. */
export interface PollHttp {
  bearer(req: IncomingMessage): string;
  actingSeat(req: IncomingMessage): string | undefined;
  agentSessionLease(req: IncomingMessage): string | undefined;
  readJson(req: IncomingMessage): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  assertSeatCanRead(member: MemberRow): void;
}

const OpenBody = z
  .object({ spec: PollSpecSchema, approval: ApprovalProofSchema.optional() })
  .strict();
const LiveBody = z.object({ live: z.boolean() }).strict();

function assertHumanAdmin(member: MemberRow): void {
  if (member.kind !== 'human' || !resolveCapabilities(member).is_admin)
    throw new MusterdError('forbidden', 'polls are opened and closed by a human admin (ADR 807)');
}

/** Handle a poll route; false when `rest` is not one. */
export async function handlePollRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  slug: string,
  rest: string,
  h: PollHttp,
): Promise<boolean> {
  const auth = () =>
    authMember(ctx.db, slug, h.bearer(req), h.actingSeat(req), h.agentSessionLease(req));

  if (method === 'POST' && rest === '/polls') {
    const { team, member } = await auth();
    assertHumanAdmin(member);
    const body = parseOrBadRequest(OpenBody, await h.readJson(req));
    const enrollment = await joinerEnrollment(ctx.db, team.id, team.slug);
    if (enrollment) {
      try {
        const out = await authorityAtHub(enrollment, team.slug, {
          op: 'poll.open',
          actor: member.name,
          spec: body.spec,
          ...(body.approval ? { approval: body.approval } : {}),
        });
        h.sendJson(res, 201, { poll: out.poll });
      } catch (error) {
        if (error instanceof HubUnreachableError)
          throw new MusterdError('hub_unreachable', error.message);
        throw error;
      }
      return true;
    }
    const assurance = await requirePollAuthority(ctx, team, member, body.spec, body.approval, {
      expectedOrigins: [...new Set(ctx.config.webauthnOrigins)],
    });
    const poll = await openAndAnnounce(ctx, team, member, body.spec, assurance);
    h.sendJson(res, 201, { poll });
    return true;
  }

  const close = rest.match(/^\/polls\/([^/]+)\/(end|cancel)$/);
  if (method === 'POST' && close) {
    const { team, member } = await auth();
    assertHumanAdmin(member);
    if (await joinerEnrollment(ctx.db, team.id, team.slug))
      throw new MusterdError(
        'hub_local_required',
        'end or cancel a poll on a Surface attached to the hub',
      );
    const record = await closeAndAnnounce(
      ctx,
      team,
      decodeURIComponent(close[1]!),
      close[2] === 'end' ? 'ended' : 'cancelled',
      member,
    );
    if (!record) throw new MusterdError('not_found', 'no open poll with that id');
    h.sendJson(res, 200, { poll: record });
    return true;
  }

  if (method === 'GET' && rest === '/polls/open') {
    const { team, member } = await auth();
    h.assertSeatCanRead(member);
    // The token is minted only on an explicit `token=1` from the broadcast seat (the stream
    // machine). The /broadcast page reads on that same seat to draw the tally, and each mint
    // replaces the last token, so a page read must not mint one.
    const wantsToken = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === '1';
    const broadcast =
      wantsToken && member.observer === 1 && resolveObserverScope(member) === 'broadcast';
    h.sendJson(res, 200, await openPollReply(ctx.db, team.id, { broadcast }, Date.now()));
    return true;
  }

  const counts = rest.match(/^\/polls\/([^/]+)\/counts$/);
  if (method === 'POST' && counts) {
    // The poll's own token, not a member credential: this route is the one way chat reaches the team.
    const token = h.bearer(req);
    if (!token.startsWith(TOKEN_PREFIXES.poll))
      throw new MusterdError('unauthorized', 'a poll counts report needs the poll token');
    const team = await getTeamBySlug(ctx.db, slug);
    if (!team) throw new MusterdError('unauthorized', 'unknown team');
    const body = parseOrBadRequest(PollCountsSchema, await h.readJson(req));
    const out = await reportCounts(
      ctx.db,
      team.id,
      decodeURIComponent(counts[1]!),
      token,
      body,
      Date.now(),
    );
    if (out === 'bad_token')
      throw new MusterdError('unauthorized', 'that poll token is not current');
    if (out === 'closed') throw new MusterdError('conflict', 'the poll is closed');
    if (out === 'bad_counts') throw new MusterdError('bad_request', 'counts do not fit the poll');
    h.sendJson(res, 202, {});
    return true;
  }

  if (method === 'POST' && rest === '/stream/live') {
    // Leaseless and presence-neutral, like `/stream/winddown`: the stream's observer seat, nothing else.
    const { team, member } = await authMember(
      ctx.db,
      slug,
      h.bearer(req),
      h.actingSeat(req),
      undefined,
      {
        leaseless: true,
      },
    );
    if (member.observer !== 1 || resolveObserverScope(member) !== 'broadcast')
      throw new MusterdError(
        'forbidden',
        'only the broadcast seat reports the stream live (ADR 807)',
      );
    const body = parseOrBadRequest(LiveBody, await h.readJson(req));
    await reportLive(ctx.db, team.id, body.live, Date.now());
    h.sendJson(res, 202, {});
    return true;
  }

  return false;
}
