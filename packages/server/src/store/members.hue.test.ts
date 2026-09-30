import { HUE_MIN_SEPARATION, defaultHue, hueConflict, hueSeparation } from '@musterd/protocol/hue';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember, getMemberByName, leaveMember, setMemberHue, takenHues } from './members.js';
import { toMember } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * The hue on a DB-only team (ADR 374). Here the daemon IS the source, so `addMember` assigns when
 * the caller says nothing (`hue` undefined), stores what it is told, and refuses a collision by
 * name. `null` is a different statement — "the file has no hue" — and is stored as null: that is
 * reconcile's word, and the daemon never argues with the file.
 */
async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  return { db, team };
}

withDrivers('members.hue', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('addMember hue (ADR 374)', async () => {
    it('assigns a hue when none is given, and every seat on a fresh team is separated', async () => {
      const { db, team } = await seed();
      const hues: number[] = [];
      for (let i = 0; i < 12; i++) {
        const { row } = await addMember(db, team, { name: `seat-${i}`, kind: 'agent' });
        expect(row.hue).not.toBeNull();
        hues.push(row.hue!);
      }
      for (let i = 0; i < hues.length; i++)
        for (let j = i + 1; j < hues.length; j++)
          expect(hueSeparation(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(HUE_MIN_SEPARATION);
    });

    /* gptbot's #1258 acceptance: the seed was looked up by row id, which a NEW member does not have
     yet, so every fresh seat started from `defaultHue('')` and only `assignHue` walking them apart
     hid it. The default is the NAME's (ADR 374 decision 4), and the first seat on an empty team
     must land exactly on it — nothing to walk away from. */
    it('a fresh seat seeds from its own name, not from an empty one', async () => {
      const { db, team } = await seed();
      expect((await addMember(db, team, { name: 'miley', kind: 'agent' })).row.hue).toBe(
        defaultHue('miley'),
      );
      expect(defaultHue('miley')).not.toBe(defaultHue(''));
    });

    it('stores an explicit hue and carries it onto the wire', async () => {
      const { db, team } = await seed();
      const { row } = await addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 });
      expect(row.hue).toBe(212);
      expect(toMember((await getMemberByName(db, team.id, 'miley'))!, 'revive').hue).toBe(212);
    });

    it('refuses an explicit hue that collides, naming the neighbour', async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
      await expect(addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 })).rejects.toThrow(
        /hue 212 .*"ryder" \(214\)/,
      );
    });

    it('stores null when told null — the file said nothing, and the daemon does not invent', async () => {
      const { db, team } = await seed();
      const { row } = await addMember(db, team, { name: 'dolly', kind: 'agent', hue: null });
      expect(row.hue).toBeNull();
    });

    it('a departed member does not hold its hue against the living', async () => {
      const { db, team } = await seed();
      const { row } = await addMember(db, team, { name: 'ghost', kind: 'agent', hue: 100 });
      await leaveMember(db, row.id);
      expect((await addMember(db, team, { name: 'kimi', kind: 'agent', hue: 100 })).row.hue).toBe(
        100,
      );
    });

    /* ADR 409: observers are sessions, not roster members. Live revive had nine web-* watchers
     holding hues against `team add`, so a file-backed explicit hue that was clear of every seat
     still 409'd. The uniqueness floor is observer = 0. */
    it('an observer does not hold its hue against a new seat', async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'web-abc123', kind: 'human', observer: true, hue: 212 });
      expect((await addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 })).row.hue).toBe(
        212,
      );
    });

    it('a fresh seat still seeds from its name when an observer sits on that hue', async () => {
      const { db, team } = await seed();
      const seedHue = defaultHue('miley');
      await addMember(db, team, { name: 'web-xyz', kind: 'human', observer: true, hue: seedHue });
      expect((await addMember(db, team, { name: 'miley', kind: 'agent' })).row.hue).toBe(seedHue);
    });

    it('REVIVE on a DB-only team keeps the hue the seat had when the caller says nothing', async () => {
      const { db, team } = await seed();
      const { row } = await addMember(db, team, { name: 'compo', kind: 'agent', hue: 77 });
      await leaveMember(db, row.id);
      expect((await addMember(db, team, { name: 'compo', kind: 'agent' })).row.hue).toBe(77);
    });

    /* Lane 01M2P43WQ7 — past a full wheel (the greedy walk seats a median 24 at 12°), an explicit hue
     that collides is KEPT and the neighbour is named on the way out, never a bare 409 with no hatch
     (ADR 145: degrade, never wedge). The 409 survives only while a clear hue exists — and then it
     names one, so it is a redirect rather than a dead end. */
    async function fillTheWheel(
      db: ReturnType<typeof seed>['db'],
      team: ReturnType<typeof seed>['team'],
    ) {
      for (let i = 0; i < 40; i++) await addMember(db, team, { name: `seat-${i}`, kind: 'agent' });
      expect(hueConflict(212, await takenHues(db, team.id))).not.toBeNull();
    }

    it('past a full wheel an explicit colliding hue is kept, and the neighbour it shares with is named', async () => {
      const { db, team } = await seed();
      await fillTheWheel(db, team);
      const { row, hue_shared_with } = await addMember(db, team, {
        name: 'miley',
        kind: 'agent',
        hue: 212,
      });
      expect(row.hue).toBe(212);
      expect(hue_shared_with).toMatch(/^seat-\d+$/);
    });

    it('with clear hues left, an explicit collision is still refused — and the refusal names a clear hue', async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
      let message = '';
      try {
        await addMember(db, team, { name: 'miley', kind: 'agent', hue: 212 });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/"ryder" \(214\)/);
      const alt = Number(/(\d+) is clear/.exec(message)?.[1]);
      expect(Number.isInteger(alt)).toBe(true);
      expect(hueConflict(alt, await takenHues(db, team.id))).toBeNull();
    });

    it("the seat file's word is never refused — a declared hue is stored even when it collides", async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
      const { row, hue_shared_with } = await addMember(db, team, {
        name: 'miley',
        kind: 'agent',
        hue: 212,
        hueDeclared: true,
      });
      expect(row.hue).toBe(212);
      expect(hue_shared_with).toBe('ryder');
    });

    it('setMemberHue follows the same rule: refused with an alternative while clear hues exist, kept past a full wheel', async () => {
      const { db, team } = await seed();
      await addMember(db, team, { name: 'ryder', kind: 'agent', hue: 214 });
      const { row: miley } = await addMember(db, team, { name: 'miley', kind: 'agent', hue: 40 });
      await expect(setMemberHue(db, miley, 212)).rejects.toThrow(/is clear/);
      // A member's own hue is left out of its own way — so past a full wheel, re-asking for the
      // colour it already has is clear, and only a NEW colour meets the shared verdict.
      await fillTheWheel(db, team);
      const { row: lin } = await addMember(db, team, { name: 'lin', kind: 'agent', hue: 212 });
      expect(await setMemberHue(db, lin, 214)).toBe('ryder');
      expect((await getMemberByName(db, team.id, 'lin'))!.hue).toBe(214);
    });
  });
});
