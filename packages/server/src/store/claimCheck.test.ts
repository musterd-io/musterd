import { expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { checkClaims } from './claimCheck.js';
import { liftHold, setHold } from './holds.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

withDrivers('claimCheck', (_o, kind) => {
  /**
   * ADR 522: what a stored note says, checked against what is true now. The demo-freeze note is the
   * headline case; the false-positive cases matter as much — a margin note that cries wolf on
   * "don't forget to merge" teaches seats to skip the margin.
   */
  async function setup() {
    const db = await openTestDriver(kind);
    const team = await createTeam(db, { slug: 'dawn' });
    await addMember(db, team, { kind: 'human', name: 'nick', role: '' });
    await addMember(db, team, { kind: 'agent', name: 'ada', role: '' });
    return { db, team };
  }

  it('a freeze nobody set reads as unsourced — the Team is not paused', async () => {
    const { db, team } = await setup();
    const checks = await checkClaims(
      db,
      team,
      'Demo at 2pm. Nobody merges or refreshes until then.',
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ kind: 'rule', verdict: 'unsourced' });
    expect(checks[0]!.line).toContain('the Team is not paused');
    expect(checks[0]!.ref).toBe('Nobody merges or refreshes until then.');
  });

  it('a rule an active hold carries reads as backed, naming the hold', async () => {
    const { db, team } = await setup();
    await setHold(db, team.id, 'nick', {
      effect: 'merges_paused',
      reason: 'demo',
      for_ms: 3600_000,
    });
    const [c] = await checkClaims(db, team, "don't merge anything before the demo");
    expect(c).toMatchObject({ kind: 'rule', verdict: 'current' });
    expect(c!.line).toContain('backed: merges paused by nick until');
  });

  it('the effect must match: an autorefresh hold does not back "no merges"', async () => {
    const { db, team } = await setup();
    await setHold(db, team.id, 'nick', {
      effect: 'autorefresh_paused',
      reason: 'demo',
      for_ms: 3600_000,
    });
    expect((await checkClaims(db, team, 'no merges today'))[0]?.verdict).toBe('unsourced');
    expect((await checkClaims(db, team, 'hold off on refreshing the daemon'))[0]?.verdict).toBe(
      'current',
    );
  });

  it('a named hold reads with its real state — in force, or lifted', async () => {
    const { db, team } = await setup();
    const h = await setHold(db, team.id, 'nick', {
      effect: 'notice',
      reason: 'deck',
      for_ms: 60_000,
    });
    expect((await checkClaims(db, team, `see ${h.id}`))[0]).toMatchObject({
      kind: 'hold',
      verdict: 'current',
    });
    await liftHold(db, team.id, 'nick', h.id);
    const [ended] = await checkClaims(db, team, `see ${h.id}`);
    expect(ended).toMatchObject({ kind: 'hold', verdict: 'ended' });
    expect(ended!.line).toContain('was lifted by nick');
  });

  it('a lane is reported only once it has ended — a live lane says nothing', async () => {
    const { db, team } = await setup();
    const live = await openLane(db, team.id, 'dawn', 'ada', { title: 'still going', claim: true });
    const gone = await openLane(db, team.id, 'dawn', 'ada', { title: 'shipped it', claim: true });
    await updateLane(db, team.id, gone.id, 'dawn', { state: 'done' });
    const checks = await checkClaims(db, team, `carrying ${live.id} and ${gone.id}`);
    expect(checks).toEqual([
      expect.objectContaining({ kind: 'lane', ref: gone.id, verdict: 'ended' }),
    ]);
    expect(checks[0]!.line).toContain('is done');
  });

  it.each([
    "don't forget to merge #2099 after CI",
    'I merged #2099 and pushed the fix',
    'the PR never merged because CI was red',
    'pushed to feat/holds; refreshed the daemon',
    '',
  ])('reads %j as no Team rule at all', async (text) => {
    const { db, team } = await setup();
    expect(await checkClaims(db, team, text)).toEqual([]);
  });

  it('is capped, so a long note cannot turn its margin into a second copy of itself', async () => {
    const { db, team } = await setup();
    const text = Array.from({ length: 20 }, (_, i) => `Rule ${i}: no merges until ${i}.`).join(' ');
    expect((await checkClaims(db, team, text)).length).toBe(6);
  });
});
