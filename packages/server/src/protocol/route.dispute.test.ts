import { disputeOf, makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { getLane, openLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { insertMessage, listInbox } from '../store/messages.js';
import { attach } from '../store/presence.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

/**
 * ADR 505 — a review rejection is a dispute the lane's owner answers. The reviewer's `decline` on a
 * `lane_review` ask is stamped `meta.dispute {via:'review'}` by the daemon, pinned in the owner's
 * inbox like any obligation, and the owner's reply moves things: `accept` concedes (recorded, lane
 * stays active for the fix), `decline` holds — the lane goes back to awaiting_acceptance and the
 * disagreement is re-routed to a second, other-family reviewer whose verdict settles it.
 */
withDrivers('route.dispute', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const member = async (name: string, model: string) => {
      const row = (await addMember(db, team, { name, kind: 'agent', role: '' })).row;
      await attach(db, row.id, 'claude-code', `conn-${name}`, { model });
      return row;
    };
    const ada = await member('ada', 'claude-opus-5'); // the owner
    const bo = await member('bo', 'gpt-6-luna'); // first reviewer
    const cy = await member('cy', 'grok-4.5'); // the tiebreak pool
    const ctx = stubCtx(db);
    const lane = await openLane(db, team.id, 'revive', 'ada', {
      title: 'ada built this',
      claim: true,
    });
    await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    // The daemon's own review ask, as `lane_submit` mints it (server-composed `lane_review`).
    await insertMessage(
      db,
      team.id,
      ada.id,
      bo.id,
      makeEnvelope({
        id: 'ask-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'member', name: 'bo' },
        act: 'ask',
        body: '[lane] acceptance requested',
        meta: { lane_review: { lane: lane.id }, species: 'approve', tier: 'standard' },
      }),
    );
    const send = (
      from: typeof ada,
      to: string,
      act: 'accept' | 'decline' | 'challenge',
      id: string,
      meta: Record<string, unknown>,
      body = 'x',
    ) =>
      routeEnvelope(
        ctx,
        team,
        from,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: { kind: 'member', name: to },
          act,
          body,
          meta,
        }),
      );
    const metaOf = async (id: string) => {
      const row = await db.get<{ meta: string | null }>('SELECT meta FROM messages WHERE id = ?', [
        id,
      ]);
      return row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
    };
    const audits = (action: string) =>
      db.all<{ detail: string | null }>(
        'SELECT detail FROM audit WHERE team_id = ? AND action = ? ORDER BY created_at ASC',
        [team.id, action],
      );
    return { db, team, ctx, ada, bo, cy, lane, send, metaOf, audits };
  }

  it("stamps the reviewer's decline as a review dispute and pins it in the owner's inbox", async () => {
    const { db, team, ada, bo, lane, send, metaOf } = await seed();
    const r = await send(
      bo,
      'ada',
      'decline',
      'rej-1',
      { in_reply_to: 'ask-1' },
      'the §8.1 re-run is missing',
    );
    expect(r.lane_verdict).toEqual({ lane: lane.id, state: 'active' });
    expect(disputeOf(await metaOf('rej-1'))).toEqual({
      via: 'review',
      lane: lane.id,
      ask: 'ask-1',
    });
    // An obligation now: the bounded read every agent surface makes carries it past the limit.
    for (let i = 0; i < 5; i++) {
      await insertMessage(
        db,
        team.id,
        bo.id,
        null,
        makeEnvelope({
          id: `m${i}`,
          team: 'revive',
          from: 'bo',
          to: { kind: 'team' },
          act: 'message',
          body: 'noise',
        }),
      );
    }
    const page = await listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 1 });
    expect(page.map((m) => m.id)).toContain('rej-1');
  });

  it('a client-supplied dispute stamp is stripped — only the daemon says what opened a dispute', async () => {
    const { bo, send, metaOf } = await seed();
    await send(bo, 'ada', 'decline', 'forged', {
      in_reply_to: 'nope',
      dispute: { via: 'review', lane: 'L' },
    });
    expect(disputeOf(await metaOf('forged'))).toBeNull();
  });

  it("the owner's accept concedes: recorded, the lane stays active for the fix, nothing re-routed", async () => {
    const { db, team, ada, bo, lane, send, audits } = await seed();
    await send(bo, 'ada', 'decline', 'rej-1', { in_reply_to: 'ask-1' });
    const r = await send(
      ada,
      'bo',
      'accept',
      'ans-1',
      { in_reply_to: 'rej-1' },
      'verified: re-ran §8.1, you were right',
    );
    expect(r.dispute).toEqual({ lane: lane.id, verdict: 'conceded' });
    expect((await getLane(db, team.id, lane.id, 'revive'))?.state).toBe('active');
    const rows = await audits('lane.dispute_answered');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
      lane: lane.id,
      owner: 'ada',
      verdict: 'conceded',
      dispute: 'rej-1',
    });
    expect(await audits('lane.review_rerouted')).toHaveLength(0);
    // Answered: the rejection leaves the owner's pinned set — once newer traffic pushes it off the
    // newest-N tail, nothing carries it any more.
    for (let i = 0; i < 5; i++) {
      await insertMessage(
        db,
        team.id,
        bo.id,
        null,
        makeEnvelope({
          id: `n${i}`,
          team: 'revive',
          from: 'bo',
          to: { kind: 'team' },
          act: 'message',
          body: 'noise',
        }),
      );
    }
    const page = await listInbox(db, ada, { unreadOnly: true, cursorTs: 0, limit: 1 });
    expect(page.map((m) => m.id)).not.toContain('rej-1');
  });

  it("the owner's decline holds: the lane re-enters acceptance and a cross-family tiebreak ask goes to a second reviewer", async () => {
    const { db, team, ada, bo, cy, lane, send, audits } = await seed();
    await send(bo, 'ada', 'decline', 'rej-1', { in_reply_to: 'ask-1' }, 'missing re-run');
    const r = await send(
      ada,
      'bo',
      'decline',
      'hold-1',
      { in_reply_to: 'rej-1' },
      'holding: docs/perf/x.md:12 carries the re-run',
    );
    expect(r.dispute).toMatchObject({
      lane: lane.id,
      verdict: 'held',
      tiebreak: { reviewer: 'cy' },
    });
    expect((await getLane(db, team.id, lane.id, 'revive'))?.state).toBe('awaiting_acceptance');

    const asks = await db.all<{ id: string; meta: string }>(
      'SELECT id, meta FROM messages WHERE team_id = ? AND act = ? AND to_member = ? ORDER BY created_at ASC',
      [team.id, 'ask', cy.id],
    );
    expect(asks).toHaveLength(1);
    const meta = JSON.parse(asks[0]!.meta) as { lane_review: Record<string, unknown> };
    expect(meta.lane_review).toMatchObject({
      lane: lane.id,
      route: 'tiebreak',
      tiebreak: { rejection: 'rej-1', hold: 'hold-1', first_reviewer: 'bo' },
    });
    // The first reviewer is never the tiebreak, and the original ask is superseded by the re-route row.
    const rerouted = await audits('lane.review_rerouted');
    expect(rerouted).toHaveLength(1);
    expect(JSON.parse(rerouted[0]!.detail!)).toMatchObject({
      lane: lane.id,
      route: 'tiebreak',
      from_reviewer: 'bo',
      reviewer: 'cy',
      superseded_ask: 'ask-1',
    });
    expect(JSON.parse((await audits('lane.dispute_answered'))[0]!.detail!)).toMatchObject({
      verdict: 'held',
    });

    // The second reviewer's verdict settles it — here, for the owner.
    const v = await send(
      cy,
      'ada',
      'accept',
      'tb-1',
      { in_reply_to: asks[0]!.id },
      'the hold stands: the re-run is at x.md:12',
    );
    expect(v.lane_verdict).toEqual({ lane: lane.id, state: 'done' });
    expect(bo.name).toBe('bo');
  });

  it('a hold with nobody to pick stays on the record and the lane stays active', async () => {
    const { db, team, ada, bo, cy, lane, send } = await seed();
    // Only bo and ada are live: cy left.
    await db.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), cy.id]);
    await send(bo, 'ada', 'decline', 'rej-1', { in_reply_to: 'ask-1' });
    const r = await send(ada, 'bo', 'decline', 'hold-1', { in_reply_to: 'rej-1' }, 'holding');
    expect(r.dispute).toEqual({ lane: lane.id, verdict: 'held', tiebreak: null });
    expect((await getLane(db, team.id, lane.id, 'revive'))?.state).toBe('active');
  });

  it("only the lane's owner can answer a review dispute — a third seat's reply is a plain answer", async () => {
    const { bo, cy, send } = await seed();
    await send(bo, 'ada', 'decline', 'rej-1', { in_reply_to: 'ask-1' });
    const r = await send(cy, 'bo', 'decline', 'kibitz', { in_reply_to: 'rej-1' });
    expect(r.dispute).toBeUndefined();
  });

  it("an accept of a handoff returns the sender's note with the lane it named (ADR 505 §6)", async () => {
    const { db, team, ada, bo, cy, lane, send } = await seed();
    await insertMessage(
      db,
      team.id,
      ada.id,
      bo.id,
      makeEnvelope({
        id: 'ho-1',
        team: 'revive',
        from: 'ada',
        to: { kind: 'member', name: 'bo' },
        act: 'handoff',
        body: `[lane] "${lane.title}" handed to you — branch feat/x\n\n7 seats remain on the old creds`,
        meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
      }),
    );
    const r = await send(bo, 'ada', 'accept', 'took-1', { in_reply_to: 'ho-1' }, 'taking it');
    expect(r.accepted_handoff).toEqual({
      lane: lane.id,
      branch: 'feat/x',
      note: `[lane] "${lane.title}" handed to you — branch feat/x\n\n7 seats remain on the old creds`,
    });
    // An accept of anything else carries no note back.
    const plain = await send(bo, 'ada', 'accept', 'took-2', { in_reply_to: 'ask-1' }, 'ok');
    expect(plain.accepted_handoff).toBeUndefined();
    // And a seat the handoff was not sent to cannot read it back by accepting it.
    const stranger = await send(cy, 'ada', 'accept', 'took-3', { in_reply_to: 'ho-1' }, 'mine now');
    expect(stranger.accepted_handoff).toBeUndefined();
  });

  it('a challenge is stamped via:challenge — or via:dependency when the sender builds on the recipient', async () => {
    const { db, team, ada, lane, send, metaOf } = await seed();
    await send(ada, 'bo', 'challenge', 'ch-1', {}, 'your p95 number does not reproduce');
    expect(disputeOf(await metaOf('ch-1'))).toEqual({ via: 'challenge' });
    // bo owns a lane; ada opens one that depends on it and challenges bo's claim.
    const bos = await openLane(db, team.id, 'revive', 'bo', {
      title: 'bo measured p95',
      claim: true,
    });
    const mine = await openLane(db, team.id, 'revive', 'ada', {
      title: 'ada builds on the p95',
      claim: true,
      depends_on: [bos.id],
    });
    await send(ada, 'bo', 'challenge', 'ch-2', {}, 'the p95 I re-ran is 3× yours');
    expect(disputeOf(await metaOf('ch-2'))).toEqual({
      via: 'dependency',
      lane: mine.id,
      on: bos.id,
    });
    expect(lane.id).not.toBe(mine.id);
  });
});
