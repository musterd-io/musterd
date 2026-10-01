import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRESENCE_TIMEOUT_MS } from '../config.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { setDoorbellPrefs } from './doorbell.js';
import { addMember, setAvailability } from './members.js';
import { attach } from './presence.js';
import {
  adminHumanPresent,
  adminHumanReachable,
  liveTeammateExists,
  teammateRouteOpen,
  unblockerReachable,
} from './reachability.js';
import type { MemberRow } from './rows.js';
import { createTeam, setPolicy } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('reachability', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  const T = PRESENCE_TIMEOUT_MS;

  async function makeAdmin(db: Database, m: MemberRow): Promise<void> {
    await db.run('UPDATE members SET capabilities = ? WHERE id = ?', [
      JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      m.id,
    ]);
  }

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const raiser = (await addMember(db, team, { name: 'stanley', kind: 'agent' })).row;
    return { db, team, raiser };
  }

  describe('unblockerReachable (ADR 153 §1)', async () => {
    it('a headless solo seat — no human, no teammate — is unreachable (the FB3 shape)', async () => {
      const { db, team, raiser } = await seed();
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
    });

    it('human term: a PRESENT admin human settles it', async () => {
      const { db, team, raiser } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false); // exists but offline, no loud reach
      await attach(db, nick.id, 'web', null);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
    });

    it('human term: an OFFLINE admin human counts once the loud reach (ask_slack_webhook) is wired', async () => {
      const { db, team, raiser } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
      expect(await adminHumanReachable(db, team.id, T)).toBe(true);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
    });

    it('human term (ADR 443): an OFFLINE admin whose only off-machine sink is their own personal webhook counts', async () => {
      const { db, team, raiser } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      expect(await adminHumanReachable(db, team.id, T)).toBe(false);
      await setDoorbellPrefs(db, nick.id, {
        sinks: { webhook: { on: true, url: 'https://ntfy.sh/nick' } },
      });
      expect(await adminHumanReachable(db, team.id, T)).toBe(true);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
    });

    it('human term (ADR 443): a team URL the admin switched off, or a sink the team does not allow, does not count', async () => {
      const { db, team } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
      await setDoorbellPrefs(db, nick.id, { sinks: { slack: { on: false } } });
      expect(await adminHumanReachable(db, team.id, T)).toBe(false);
      await setPolicy(db, team.id, { doorbell: { allow: ['live', 'os'] } });
      await setDoorbellPrefs(db, nick.id, {
        sinks: { webhook: { on: true, url: 'https://ntfy.sh/nick' } },
      });
      expect(await adminHumanReachable(db, team.id, T)).toBe(false);
    });

    it('the webhook alone is NOT reachability — with no admin human seat there is nobody to notify', async () => {
      const { db, team, raiser } = await seed();
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
    });

    it('a non-admin human does not satisfy the human term (only an admin can settle a top-tier ask)', async () => {
      const { db, team, raiser } = await seed();
      const guest = (await addMember(db, team, { name: 'guest', kind: 'human' })).row;
      await attach(db, guest.id, 'web', null);
      expect(await adminHumanReachable(db, team.id, T)).toBe(false);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
    });

    it('teammate term: a LIVE agent seat other than the raiser reaches while the route-around is open (D5)', async () => {
      const { db, team, raiser } = await seed();
      const del = (await addMember(db, team, { name: 'del', kind: 'agent' })).row;
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false); // exists but not live
      await attach(db, del.id, 'claude-code', null);
      expect(await liveTeammateExists(db, team.id, raiser.name, T)).toBe(true);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
    });

    it('the raiser itself never counts as its own teammate', async () => {
      const { db, team, raiser } = await seed();
      await attach(db, raiser.id, 'claude-code', null);
      expect(await liveTeammateExists(db, team.id, raiser.name, T)).toBe(false);
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
    });

    it('teammate term drops when item 2 closes the local-merge route-around (block-posture class) — reachability collapses to human-only', async () => {
      const { db, team, raiser } = await seed();
      const del = (await addMember(db, team, { name: 'del', kind: 'agent' })).row;
      await attach(db, del.id, 'claude-code', null);
      await setPolicy(db, team.id, {
        enforcement: {
          classes: [
            {
              class: 'local-merge',
              kind: 'costly-action',
              match: ['git merge *'],
              posture: 'block',
            },
          ],
        },
      });
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(false);
      // …but a warn-posture class leaves the route open.
      await setPolicy(db, team.id, {
        enforcement: {
          classes: [
            {
              class: 'local-merge',
              kind: 'costly-action',
              match: ['git merge *'],
              posture: 'warn',
            },
          ],
        },
      });
      expect(await unblockerReachable(db, team.id, raiser.name, T)).toBe(true);
    });

    it('teammateRouteOpen: open on an empty policy, closed only by a matching block-posture class', () => {
      expect(teammateRouteOpen({ classes: [] })).toBe(true);
      expect(
        teammateRouteOpen({
          classes: [
            {
              class: 'push-remote',
              kind: 'costly-action',
              match: ['git push *'],
              posture: 'block',
            },
          ],
        }),
      ).toBe(true); // gates the push, not the merge route
    });

    it('teammateRouteOpen: the OBVIOUS glob closes the sibling-worktree route — probe agrees with enforcement (ADR 153 exercise)', () => {
      // The exercise author wrote the obvious `git merge*` intending to close local merges. The probe now
      // tests the worst-case `git -C <main> merge …` form a teammate actually runs; command normalization
      // lifts the `-C` global off, so the block class matches and the route reads CLOSED — no crossing-glob
      // trick, no probe/enforcement disagreement.
      expect(
        teammateRouteOpen({
          classes: [
            {
              class: 'local-merge',
              kind: 'costly-action',
              match: ['git merge*'],
              posture: 'block',
            },
          ],
        }),
      ).toBe(false);
      // A warn-posture class of the same shape leaves the route open (posture, not match, is the switch).
      expect(
        teammateRouteOpen({
          classes: [
            { class: 'local-merge', kind: 'costly-action', match: ['git merge*'], posture: 'warn' },
          ],
        }),
      ).toBe(true);
    });
  });

  describe('adminHumanPresent (ADR 155 Increment 2)', async () => {
    it('false with no admin human, and false when the admin exists but is offline — even with the webhook wired', async () => {
      const { db, team } = await seed();
      expect(await adminHumanPresent(db, team.id, T)).toBe(false);
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.example/x' });
      // Notifiable ≠ present: the webhook makes nick REACHABLE (the ADR 153 settle term) but eager-
      // escalation still applies — presence is strictly narrower than reachability.
      expect(await adminHumanReachable(db, team.id, T)).toBe(true);
      expect(await adminHumanPresent(db, team.id, T)).toBe(false);
    });

    it('a live presence row composes present; self-set away/dnd/off_hours overrides it (availability outranks)', async () => {
      const { db, team } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      await attach(db, nick.id, 'web', null);
      expect(await adminHumanPresent(db, team.id, T)).toBe(true);
      for (const status of ['away', 'dnd', 'off_hours'] as const) {
        await setAvailability(db, nick.id, { status });
        expect(await adminHumanPresent(db, team.id, T)).toBe(false);
      }
      await setAvailability(db, nick.id, { status: 'available' });
      expect(await adminHumanPresent(db, team.id, T)).toBe(true);
    });

    it('steering marks you present (Inc 1): a live driver link composes the admin present without their own heartbeat', async () => {
      const { db, team, raiser } = await seed();
      const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
      await makeAdmin(db, nick);
      expect(await adminHumanPresent(db, team.id, T)).toBe(false);
      await attach(db, raiser.id, 'claude-code', null, { driver: 'nick' });
      expect(await adminHumanPresent(db, team.id, T)).toBe(true);
    });

    it('a present NON-admin human never composes (only an admin modulates the ask clock)', async () => {
      const { db, team } = await seed();
      const guest = (await addMember(db, team, { name: 'guest', kind: 'human' })).row;
      await attach(db, guest.id, 'web', null);
      expect(await adminHumanPresent(db, team.id, T)).toBe(false);
    });
  });
});
