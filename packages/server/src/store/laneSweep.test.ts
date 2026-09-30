import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openTestDb } from '../db/testing.js';
import { openLane, updateLane } from './lanes.js';
import { SWEEP_GRACE_MS, sweepAbandonedAcceptance } from './laneSweep.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

async function seed() {
  const db = openTestDb(':memory:');
  const team = await createTeam(db, { slug: 'revive' });
  await addMember(db, team, { name: 'nick', kind: 'human' });
  await addMember(db, team, { name: 'dolly', kind: 'agent' });
  return { db, team };
}

/** The `lane.closed` audit row the sweep owes, decoded. */
function closeRow(db: ReturnType<typeof openDb>, laneId: string) {
  const row = db
    .prepare<
      [string],
      { actor: string; detail: string }
    >(`SELECT actor, detail FROM audit WHERE action = 'lane.closed' AND target = ? ORDER BY ts DESC LIMIT 1`)
    .get(laneId);
  return row
    ? { actor: row.actor, detail: JSON.parse(row.detail) as Record<string, unknown> }
    : null;
}

/** A lane parked in awaiting_acceptance `agedMs` ago. */
async function stranded(
  db: ReturnType<typeof openDb>,
  teamId: string,
  agedMs: number,
  title = 'lane',
) {
  const lane = await openLane(db, teamId, 'revive', 'dolly', { title, claim: true });
  await updateLane(db, teamId, lane.id, 'revive', { state: 'awaiting_acceptance' });
  db.prepare(`UPDATE lanes SET updated_at = ? WHERE id = ?`).run(Date.now() - agedMs, lane.id);
  return lane;
}

/**
 * Plant the `lane.ready_for_review` row the submit would have written, so a swept close has the
 * routing facts to report. `await stranded()` alone writes none — which is itself the abstaining case.
 */
function readyRow(
  db: ReturnType<typeof openDb>,
  teamId: string,
  laneId: string,
  detail: Record<string, unknown>,
) {
  db.prepare(
    `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
     VALUES (?, ?, ?, ?, 'lane.ready_for_review', ?, 'allow', ?, ?)`,
  ).run(
    `ready-${laneId}`,
    teamId,
    Date.now() - 1000,
    'dolly',
    laneId,
    JSON.stringify({ lane: laneId, owner: 'dolly', ...detail }),
    Date.now() - 1000,
  );
}

/**
 * A swept lane must say whether anyone was ever ASKED — the question `review_swept` alone cannot
 * answer (lane 01M042GWK3).
 *
 * The seat-closed ladder in laneClose.ts already separates "nobody was asked" from "asked and
 * nobody answered", with an ADR behind each rung. The sweep short-circuited ahead of all of it, so
 * the ONE path where no human is watching recorded the least. Measured 2026-08-15: lane 01M016D5GA
 * (44 files joining typecheck, every CI-deciding gate among them) was swept at exactly 24h with
 * `reason: review_swept` — and no ask had ever been sent, because the roster was an all-claude
 * monoculture and `pickReviewCounterpart` returned null. Nothing in the close row could say so.
 *
 * Only one of the two is anyone's fault, and a retrospective query cannot tell which without this.
 */
describe('a swept close reports whether an ask was ever sent', async () => {
  it('names the absent ask when the picker found no counterpart', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);
    readyRow(db, team.id, lane.id, { no_candidate: true, human_required: false });

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    const row = closeRow(db, lane.id);
    // The ADR 229 fact is untouched: the clock closed it, not a seat.
    expect(row?.detail['reason']).toBe('review_swept');
    // …and the orthogonal fact it could not carry before.
    expect(row?.detail['ask_outcome']).toBe('no_candidate');
  });

  it('distinguishes a lane whose reviewer WAS asked and never answered', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);
    readyRow(db, team.id, lane.id, { reviewer: 'nick', review_grade: 'cross_family' });

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    const row = closeRow(db, lane.id);
    expect(row?.detail['reason']).toBe('review_swept');
    expect(row?.detail['ask_outcome']).toBe('routed');
  });

  it('reports a by-design exemption as its own thing, not as a degradation', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);
    readyRow(db, team.id, lane.id, { acceptance_exempt: true });

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    expect(closeRow(db, lane.id)?.detail['ask_outcome']).toBe('acceptance_exempt');
  });

  it('names a REQUIRED human who was never live, above the plain no-candidate', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);
    readyRow(db, team.id, lane.id, { no_candidate: true, human_required: true });

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    expect(closeRow(db, lane.id)?.detail['ask_outcome']).toBe('human_review_missed');
  });

  it('ABSTAINS when no ready row exists — a lane from before the field invents no verdict', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    const row = closeRow(db, lane.id);
    expect(row?.detail['reason']).toBe('review_swept');
    // Absent, not a guess: the same discipline every other rung in this ladder follows.
    expect(row?.detail).not.toHaveProperty('ask_outcome');
  });
});

describe('sweepAbandonedAcceptance — the backstop (ADR 229)', async () => {
  it('closes a lane that has waited past the grace, and says the system did it', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 60_000);

    const swept = await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());
    expect(swept.map((s) => s.id)).toEqual([lane.id]);

    const row = closeRow(db, lane.id);
    expect(row?.actor).toBe('musterd');
    expect(row?.detail['closed_by']).toBe('musterd');
    expect(row?.detail['state']).toBe('done');
  });

  // THE dangerous one. `verified` is derived as "closed by a seat other than the owner", which the
  // system satisfies trivially — so the naive version records every swept lane as a genuine
  // cross-seat review. ADR 056's diversity conclusions read this exact field, so a regression here
  // silently fabricates research data rather than breaking anything visible.
  it('never records a swept close as verified, and never as a counterpart confirm', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS + 1);

    await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());

    const row = closeRow(db, lane.id);
    // Asserted as an explicit false, not a falsy absence (ADR 173 clause 3): a reader folding
    // `undefined` into truthy must not be able to read this as a confirm.
    expect(row?.detail).toHaveProperty('verified', false);
    expect(row?.detail['reason']).toBe('review_swept');
    expect(row?.detail['reason']).not.toBe('counterpart_confirm');
    // A reviewer family is only written for a real confirm — the system has none to claim.
    expect(row?.detail['reviewer_family']).toBeUndefined();
  });

  it('leaves a lane still inside the grace completely alone', async () => {
    const { db, team } = await seed();
    const lane = await stranded(db, team.id, SWEEP_GRACE_MS - 60_000);
    const before = db
      .prepare<[string], { updated_at: number }>(`SELECT updated_at FROM lanes WHERE id = ?`)
      .get(lane.id)!.updated_at;

    expect(await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now())).toEqual([]);

    // Not merely unclosed — UNTOUCHED. recordLaneClose derives time_in_review_ms from updated_at,
    // so a sweep that stamped lanes as it inspected them would corrupt that figure for every later
    // close, including the human-accepted ones this feature is not even about.
    const after = db
      .prepare<
        [string],
        { updated_at: number; state: string }
      >(`SELECT updated_at, state FROM lanes WHERE id = ?`)
      .get(lane.id)!;
    expect(after.updated_at).toBe(before);
    expect(after.state).toBe('awaiting_acceptance');
    expect(closeRow(db, lane.id)).toBeNull();
  });

  it('ignores lanes in every other state, however old', async () => {
    const { db, team } = await seed();
    const old = Date.now() - SWEEP_GRACE_MS * 10;
    for (const state of ['open', 'claimed', 'active', 'blocked'] as const) {
      const lane = await openLane(db, team.id, 'revive', 'dolly', { title: state, claim: true });
      await updateLane(db, team.id, lane.id, 'revive', { state });
      db.prepare(`UPDATE lanes SET updated_at = ? WHERE id = ?`).run(old, lane.id);
    }
    expect(await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now())).toEqual([]);
  });

  it('records how long the lane actually waited', async () => {
    const { db, team } = await seed();
    const waited = SWEEP_GRACE_MS + 3 * 60 * 60 * 1000;
    await stranded(db, team.id, waited);

    const [s] = await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now());
    expect(s!.waited_ms).toBeGreaterThanOrEqual(waited);
    expect(s!.owner_seat).toBe('dolly');
  });
});
