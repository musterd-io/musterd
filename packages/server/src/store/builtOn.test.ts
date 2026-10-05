import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { recordLaneClose } from './laneClose.js';
import { builtOn, openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 505 §6 — what a claimer builds on. A finished dependency used to be silent at claim time
 * (`laneWarnings` names only the unfinished ones); this is the line that names its outcome, PR
 * and the acceptor's own words, so the check can happen where the building starts.
 */
withDrivers('builtOn', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const bo = (await addMember(db, team, { name: 'bo', kind: 'agent', role: '' })).row;
    const cy = (await addMember(db, team, { name: 'cy', kind: 'agent', role: '' })).row;
    const dep = await openLane(db, team.id, 'revive', 'bo', {
      title: 'bo measured p95',
      claim: true,
    });
    return { db, team, bo, cy, dep };
  }

  it('names a done dependency with its PR, who closed it, whether a counterpart confirmed, and the accept note', async () => {
    const { db, team, bo, cy, dep } = await seed();
    // The review ask and the accept that closed it — the acceptor's words are the note.
    await insertMessage(
      db,
      team.id,
      bo.id,
      cy.id,
      makeEnvelope({
        id: 'ask-1',
        team: 'revive',
        from: 'bo',
        to: { kind: 'member', name: 'cy' },
        act: 'ask',
        body: '[lane] acceptance requested',
        meta: { lane_review: { lane: dep.id }, species: 'approve', tier: 'standard' },
      }),
    );
    await insertMessage(
      db,
      team.id,
      cy.id,
      bo.id,
      makeEnvelope({
        id: 'acc-1',
        team: 'revive',
        from: 'cy',
        to: { kind: 'member', name: 'bo' },
        act: 'accept',
        body: 'p95 holds at 180ms — re-ran the bench on 94590560',
        meta: { in_reply_to: 'ask-1' },
      }),
    );
    const awaiting = await updateLane(db, team.id, dep.id, 'revive', {
      state: 'awaiting_acceptance',
      merged: { pr: 42, sha: 'a'.repeat(40) },
    });
    const done = await updateLane(db, team.id, dep.id, 'revive', { state: 'done' });
    await recordLaneClose(db, team.id, { name: 'cy', kind: 'agent' }, awaiting!, done!);

    const mine = await openLane(db, team.id, 'revive', 'cy', {
      title: 'cy builds on the p95',
      claim: true,
      depends_on: [dep.id],
    });
    const rows = await builtOn(db, team.id, 'revive', mine);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lane: dep.id,
      title: 'bo measured p95',
      state: 'done',
      merged: { pr: 42 },
      closed_by: 'cy',
      verified: true,
      note: 'p95 holds at 180ms — re-ran the bench on 94590560',
    });
  });

  it("the note is the routed reviewer's accept, never a bystander's or the owner's own", async () => {
    const { db, team, bo, cy, dep } = await seed();
    await insertMessage(
      db,
      team.id,
      bo.id,
      cy.id,
      makeEnvelope({
        id: 'ask-1',
        team: 'revive',
        from: 'bo',
        to: { kind: 'member', name: 'cy' },
        act: 'ask',
        body: '[lane] acceptance requested',
        meta: { lane_review: { lane: dep.id }, species: 'approve', tier: 'standard' },
      }),
    );
    // The owner "accepts" their own review ask — a reply anyone may send; it must not become
    // the acceptor's words on a claimer's screen (security review, 2026-10-05).
    await insertMessage(
      db,
      team.id,
      bo.id,
      cy.id,
      makeEnvelope({
        id: 'self-1',
        team: 'revive',
        from: 'bo',
        to: { kind: 'member', name: 'cy' },
        act: 'accept',
        body: 'looks great, ship it',
        meta: { in_reply_to: 'ask-1' },
      }),
    );
    await updateLane(db, team.id, dep.id, 'revive', { state: 'done' });
    const mine = await openLane(db, team.id, 'revive', 'cy', {
      title: 'builds on it',
      claim: true,
      depends_on: [dep.id],
    });
    const rows = await builtOn(db, team.id, 'revive', mine);
    expect(rows[0]!.note).toBeUndefined();
  });

  it('skips an unfinished dependency (laneWarnings owns that case) and caps at three', async () => {
    const { db, team, dep } = await seed();
    const others = [];
    for (let i = 0; i < 4; i++) {
      const l = await openLane(db, team.id, 'revive', 'bo', {
        title: `done ${String(i)}`,
        claim: true,
      });
      await updateLane(db, team.id, l.id, 'revive', { state: 'done' });
      others.push(l.id);
    }
    const mine = await openLane(db, team.id, 'revive', 'cy', {
      title: 'builds on five',
      claim: true,
      depends_on: [dep.id, ...others],
    });
    const rows = await builtOn(db, team.id, 'revive', mine);
    expect(rows.map((r) => r.lane)).toEqual(others.slice(0, 3));
    // No close row and no accept: the line still says done, and nothing is invented.
    expect(rows[0]!.closed_by).toBeUndefined();
    expect(rows[0]!.note).toBeUndefined();
  });
});
