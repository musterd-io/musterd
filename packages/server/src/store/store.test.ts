import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_PRESENCE_TTL_MS } from '../config.js';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { resolveActivity } from './activity.js';
import { appendAudit, appendLaneEventRequired, appendReplicatedEvent, listAudit } from './audit.js';
import { getCursor, setCursor } from './cursors.js';
import { getLane, openLane } from './lanes.js';
import {
  addMember,
  authMember,
  getMemberById,
  getMemberByName,
  hashToken,
  leaveMember,
  markSeatReleased,
  markSessionEnded,
  listMembers,
  mintAgentSeatCredential,
  mintCredential,
  reapExcessIdleObservers,
  reapStaleObservers,
} from './members.js';
import { insertMessage, latestStatusUpdate, listInbox, listTeamMessages } from './messages.js';
import {
  attach,
  clearMemberPresence,
  clearPresenceById,
  countLivePresences,
  currentAttestedModel,
  detach,
  heartbeat,
  reattestGuidanceEpoch,
  reattestModel,
  reattestSurface,
  hasActivePresence,
  hasLivePresence,
  listLiveDrivers,
  listPresence,
  listReclaimableMemberIds,
  presenceById,
  reapStale,
  recordUnattestedOccupancy,
  release,
  touchAmbientPresence,
} from './presence.js';
import { hasValidSessionLease, mintSessionLease } from './session-leases.js';
import {
  bootstrapCutoverReadiness,
  createTeam,
  cutoverLegacyBootstrap,
  findBootstrapCredential,
  getAgentKeyHash,
  migrateLegacyBootstrapCredential,
  mintBootstrapCredential,
  recordBootstrapCredentialUse,
  requireTeam,
  revokeBootstrapCredential,
  rotateAgentKey,
} from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('store', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function freshTeam() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    return { db, team };
  }

  async function legacyBootstrap(db: ReturnType<typeof openDb>, teamId: string) {
    return (await rotateAgentKey(db, teamId)).agent_key;
  }

  describe('teams + members', async () => {
    it('records the compatibility Team key as an explicit active legacy credential', async () => {
      const { db, team } = await freshTeam();
      const legacyKey = await legacyBootstrap(db, team.id);
      expect(await findBootstrapCredential(db, team.id, legacyKey)).toMatchObject({
        team_id: team.id,
        use_kind: 'legacy',
        state: 'active',
      });
    });

    it('migrates a legacy key only to the seat proven by its agent-seat credential (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const { seat_credential } = await mintAgentSeatCredential(db, ada.row.id);
      const legacyKey = await legacyBootstrap(db, team.id);
      const now = 1_790_096_938_029;

      const migrated = await migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: seat_credential,
        now,
      });

      expect(migrated.credential).toMatchObject({
        team_id: team.id,
        use_kind: 'claim_seat',
        target: 'Ada',
        migration_target_member_id: ada.row.id,
        first_used_at: null,
      });
      expect(migrated.credential.expires_at).toBe(now + 90 * 24 * 60 * 60 * 1000);
      expect(migrated.agent_key).toMatch(/^mskey_/);
      expect(migrated.replaced_credential_id).toBeNull();
    });

    it('replaces only an unused migration successor and never one with scoped use (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const { seat_credential } = await mintAgentSeatCredential(db, ada.row.id);
      const legacyKey = await legacyBootstrap(db, team.id);
      const now = Date.now();

      const first = await migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: seat_credential,
        now,
      });
      const second = await migrateLegacyBootstrapCredential(db, {
        legacyKey,
        seatCredential: seat_credential,
        now: now + 1_000,
      });
      expect(second.replaced_credential_id).toBe(first.credential.id);
      expect(second.credential.expires_at).toBe(now + 1_000 + 90 * 24 * 60 * 60 * 1000);
      expect(await findBootstrapCredential(db, team.id, first.agent_key)).toBeNull();

      await recordBootstrapCredentialUse(db, second.credential.id, 1234);
      await expect(
        migrateLegacyBootstrapCredential(db, {
          legacyKey,
          seatCredential: seat_credential,
        }),
      ).rejects.toThrow(/already migrated/);
      expect((await findBootstrapCredential(db, team.id, second.agent_key))?.first_used_at).toBe(
        1234,
      );
    });

    it('refuses cross-Team and inactive seat proofs without minting a successor (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      const other = await createTeam(db, { slug: 'dusk' });
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const lin = await addMember(db, other, { name: 'Lin', kind: 'agent' });
      const adaCredential = (await mintAgentSeatCredential(db, ada.row.id)).seat_credential;
      const linCredential = (await mintAgentSeatCredential(db, lin.row.id)).seat_credential;
      const legacyKey = await legacyBootstrap(db, team.id);

      await expect(
        migrateLegacyBootstrapCredential(db, {
          legacyKey,
          seatCredential: linCredential,
        }),
      ).rejects.toThrow(/same Team/);
      await leaveMember(db, ada.row.id);
      await expect(
        migrateLegacyBootstrapCredential(db, {
          legacyKey,
          seatCredential: adaCredential,
        }),
      ).rejects.toThrow(/agent seat credential/);
      expect(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'claim_seat'",
          )
        )?.count,
      ).toBe(0);
    });

    it.each(['disabled', 'banned', 'archived'] as const)(
      'refuses a %s agent seat without minting a successor (ADR 350)',
      async (status) => {
        const { db, team } = await freshTeam();
        const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
        const seatCredential = (await mintAgentSeatCredential(db, ada.row.id)).seat_credential;
        const legacyKey = await legacyBootstrap(db, team.id);
        await db.run('UPDATE members SET account_status = ? WHERE id = ?', [status, ada.row.id]);

        await expect(
          migrateLegacyBootstrapCredential(db, { legacyKey, seatCredential }),
        ).rejects.toThrow(new RegExp(status));
        expect(
          (
            await db.get(
              "SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'claim_seat'",
            )
          )?.count,
        ).toBe(0);
      },
    );

    it('refuses human, non-legacy, revoked, and expired migration proofs (ADR 350)', async () => {
      const humanCase = await freshTeam();
      const nick = await addMember(humanCase.db, humanCase.team, {
        name: 'Nick',
        kind: 'human',
      });
      const humanCredential = (await mintCredential(humanCase.db, nick.row.id)).credential;
      const humanLegacy = await legacyBootstrap(humanCase.db, humanCase.team.id);
      await expect(
        migrateLegacyBootstrapCredential(humanCase.db, {
          legacyKey: humanLegacy,
          seatCredential: humanCredential,
        }),
      ).rejects.toThrow(/agent seat credential/);

      const scopedCase = await freshTeam();
      const ada = await addMember(scopedCase.db, scopedCase.team, {
        name: 'Ada',
        kind: 'agent',
      });
      const seatCredential = (await mintAgentSeatCredential(scopedCase.db, ada.row.id))
        .seat_credential;
      const scopedKey = (
        await mintBootstrapCredential(scopedCase.db, {
          teamId: scopedCase.team.id,
          useKind: 'claim_seat',
          target: 'Ada',
        })
      ).agent_key;
      await expect(
        migrateLegacyBootstrapCredential(scopedCase.db, {
          legacyKey: scopedKey,
          seatCredential,
        }),
      ).rejects.toThrow(/legacy bootstrap/);

      for (const state of ['revoked', 'expired'] as const) {
        const credentialCase = await freshTeam();
        const member = await addMember(credentialCase.db, credentialCase.team, {
          name: 'Ada',
          kind: 'agent',
        });
        const credential = (await mintAgentSeatCredential(credentialCase.db, member.row.id))
          .seat_credential;
        const legacy = await legacyBootstrap(credentialCase.db, credentialCase.team.id);
        await credentialCase.db.run(
          state === 'revoked'
            ? "UPDATE agent_bootstrap_credentials SET state = 'revoked' WHERE use_kind = 'legacy'"
            : "UPDATE agent_bootstrap_credentials SET expires_at = 1 WHERE use_kind = 'legacy'",
        );
        await expect(
          migrateLegacyBootstrapCredential(credentialCase.db, {
            legacyKey: legacy,
            seatCredential: credential,
            now: 2,
          }),
        ).rejects.toThrow(/legacy bootstrap/);
      }
    });

    it('requires successful scoped use for every held agent seat and enrolled host (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      await legacyBootstrap(db, team.id);
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const grace = await addMember(db, team, { name: 'Grace', kind: 'agent' });
      const unheld = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      const disabled = await addMember(db, team, { name: 'Dormant', kind: 'agent' });
      await db.run('UPDATE members SET bound_at = 1 WHERE id IN (?, ?, ?)', [
        ada.row.id,
        grace.row.id,
        disabled.row.id,
      ]);
      await db.run("UPDATE members SET account_status = 'disabled' WHERE id = ?", [
        disabled.row.id,
      ]);

      const insertResidency = (id: string, memberId: string) =>
        db.run(
          `INSERT INTO residency
        (id, team_id, member_id, harness, host, created_at, updated_at)
       VALUES (?, ?, ?, 'cursor', ?, 1, 1)`,
          [id, team.id, memberId, 'mac-studio'],
        );
      await insertResidency('res-ada', ada.row.id);
      await insertResidency('res-grace', grace.row.id);

      const adaKey = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Ada',
      });
      const graceKey = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Grace',
      });
      const hostKey = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'host',
        target: 'mac-studio',
      });
      void unheld;
      await recordBootstrapCredentialUse(db, graceKey.credential.id, 10);

      expect(await bootstrapCutoverReadiness(db, team.id)).toEqual({
        already_cut_over: false,
        unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
        unmet_hosts: ['mac-studio'],
      });

      await recordBootstrapCredentialUse(db, adaKey.credential.id, 11);
      await recordBootstrapCredentialUse(db, hostKey.credential.id, 12);
      expect(await bootstrapCutoverReadiness(db, team.id)).toEqual({
        already_cut_over: false,
        unmet_seats: [],
        unmet_hosts: [],
      });
    });

    it('refuses incomplete cutover unless forced and makes repeated cutover idempotent (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      await legacyBootstrap(db, team.id);
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await db.run('UPDATE members SET bound_at = 1 WHERE id = ?', [ada.row.id]);

      await expect(
        cutoverLegacyBootstrap(db, { teamId: team.id, actor: 'Nick', force: false, now: 100 }),
      ).rejects.toThrow(/not ready/);
      expect(await getAgentKeyHash(db, team.id)).not.toBeNull();

      const forced = await cutoverLegacyBootstrap(db, {
        teamId: team.id,
        actor: 'Nick',
        force: true,
        now: 101,
      });
      expect(forced).toEqual({
        already_cut_over: false,
        unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
        unmet_hosts: [],
      });
      expect(await getAgentKeyHash(db, team.id)).toBeNull();
      expect((await requireTeam(db, team.slug)).bootstrap_cutover_at).toBe(101);
      await expect(rotateAgentKey(db, team.id)).rejects.toThrow(/already cut over/);
      expect(
        (await db.get(
          "SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'legacy' AND state IN ('active', 'rotated')",
        ))!.count,
      ).toBe(0);

      expect(
        await cutoverLegacyBootstrap(db, {
          teamId: team.id,
          actor: 'Nick',
          force: false,
          now: 102,
        }),
      ).toEqual({
        already_cut_over: true,
        unmet_seats: [{ member_id: ada.row.id, name: 'Ada' }],
        unmet_hosts: [],
      });
      expect((await requireTeam(db, team.slug)).bootstrap_cutover_at).toBe(101);
    });

    it('rolls back legacy cutover when its audit write fails (ADR 350)', async () => {
      const { db, team } = await freshTeam();
      await legacyBootstrap(db, team.id);
      // The failure injection is a trigger, spelled per engine (the one place a test writes DDL).
      await db.exec(
        db.dialect === 'sqlite'
          ? `CREATE TRIGGER fail_bootstrap_cutover_audit
             BEFORE INSERT ON audit
             WHEN NEW.action = 'bootstrap_credential.cutover'
             BEGIN
               SELECT RAISE(ABORT, 'injected audit failure');
             END`
          : `DROP TRIGGER IF EXISTS fail_bootstrap_cutover_audit ON audit;
             CREATE OR REPLACE FUNCTION fail_bootstrap_cutover_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.action = 'bootstrap_credential.cutover' THEN
                 RAISE EXCEPTION 'injected audit failure';
               END IF;
               RETURN NEW;
             END $$;
             CREATE TRIGGER fail_bootstrap_cutover_audit BEFORE INSERT ON audit
               FOR EACH ROW EXECUTE FUNCTION fail_bootstrap_cutover_audit_fn()`,
      );

      // The trigger is real schema on Postgres — on the Neon pass, the shared test database — so it
      // goes when the test does, whatever the assertions did.
      try {
        await expect(
          cutoverLegacyBootstrap(db, { teamId: team.id, actor: 'Nick', force: false, now: 100 }),
        ).rejects.toThrow(/injected audit failure/);
        expect(await getAgentKeyHash(db, team.id)).not.toBeNull();
        expect((await requireTeam(db, team.slug)).bootstrap_cutover_at).toBeNull();
        expect(
          (await db.get(
            "SELECT COUNT(*) AS count FROM agent_bootstrap_credentials WHERE use_kind = 'legacy' AND state = 'active'",
          ))!.count,
        ).toBe(1);
      } finally {
        if (db.dialect === 'postgres')
          await db.exec(
            'DROP TRIGGER IF EXISTS fail_bootstrap_cutover_audit ON audit; DROP FUNCTION IF EXISTS fail_bootstrap_cutover_audit_fn()',
          );
      }
    });

    it('mints and resolves a target-scoped bootstrap credential', async () => {
      const { db, team } = await freshTeam();
      const minted = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Ada',
        label: 'ada-workspace',
      });

      expect(await findBootstrapCredential(db, team.id, minted.agent_key)).toMatchObject({
        id: minted.credential.id,
        use_kind: 'claim_seat',
        target: 'Ada',
      });
      expect(await findBootstrapCredential(db, team.id, 'mskey_wrong')).toBeNull();
    });

    it('revokes a scoped bootstrap credential without affecting another credential', async () => {
      const { db, team } = await freshTeam();
      const ada = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Ada',
      });
      const lin = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Lin',
      });

      expect(await revokeBootstrapCredential(db, team.id, ada.credential.id)).toBe(true);
      expect(await findBootstrapCredential(db, team.id, ada.agent_key)).toBeNull();
      expect(await findBootstrapCredential(db, team.id, lin.agent_key)).toMatchObject({
        id: lin.credential.id,
        state: 'active',
      });
    });

    it('marks a predecessor rotated while keeping both credentials valid for staged migration', async () => {
      const { db, team } = await freshTeam();
      const predecessor = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Ada',
      });
      const successor = await mintBootstrapCredential(db, {
        teamId: team.id,
        useKind: 'claim_seat',
        target: 'Ada',
      });

      expect(await findBootstrapCredential(db, team.id, predecessor.agent_key)).toMatchObject({
        state: 'rotated',
      });
      expect(await findBootstrapCredential(db, team.id, successor.agent_key)).toMatchObject({
        state: 'active',
      });
    });

    it('rejects a duplicate slug with conflict', async () => {
      const { db } = await freshTeam();
      await expect(createTeam(db, { slug: 'dawn' })).rejects.toThrow(MusterdError);
      try {
        await createTeam(db, { slug: 'dawn' });
      } catch (e) {
        expect((e as MusterdError).code).toBe('conflict');
      }
    });

    it('issues a token whose sha256 matches the stored hash; plaintext not stored', async () => {
      const { db, team } = await freshTeam();
      const { row, token } = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect(row.token_hash).toBe(hashToken(token));
      const stored = await db.get('SELECT token_hash FROM members WHERE id = ?', [row.id]);
      expect(stored?.token_hash).not.toContain(token);
    });

    it('rejects the removed v0.2 per-seat token (mskd_ cutover, ADR 069)', async () => {
      const { db, team } = await freshTeam();
      const { token } = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect(token).toMatch(/^mskd_/); // addMember still mints the durable seat token_hash …
      // … but it no longer authenticates — the team agent key + human credential are the only paths now.
      await expect(authMember(db, 'dawn', token)).rejects.toThrow(MusterdError);
      await expect(authMember(db, 'dawn', 'mskd_wrong')).rejects.toThrow(MusterdError);
    });

    it('rejects a duplicate member name with conflict', async () => {
      const { db, team } = await freshTeam();
      await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await expect(addMember(db, team, { name: 'Ada', kind: 'agent' })).rejects.toThrow(
        /already exists/,
      );
    });

    it('leaveMember soft-removes from the roster but keeps the row (ADR 019)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect((await listMembers(db, team.id)).map((m) => m.name)).toContain('Ada');

      await leaveMember(db, ada.row.id);
      // Off the live roster ...
      expect((await listMembers(db, team.id)).map((m) => m.name)).not.toContain('Ada');
      // ... but the row survives (history/provenance), now stamped with left_at.
      const row = await getMemberByName(db, team.id, 'Ada');
      expect(row).toBeDefined();
      expect(row?.left_at).not.toBeNull();
    });

    it('leaveMember releases in-flight claims so the board cannot name a ghost owner (ADR 196)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const wip = await openLane(db, team.id, 'dawn', 'Ada', { title: 'wip', claim: true });
      const awaiting = await openLane(db, team.id, 'dawn', 'Ada', { title: 'merged', claim: true });
      await db.run(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`, [awaiting.id]);

      await leaveMember(db, ada.row.id);
      expect(await getLane(db, team.id, wip.id, 'dawn')).toMatchObject({
        state: 'open',
        owner_seat: null,
      });
      expect(await getLane(db, team.id, awaiting.id, 'dawn')).toMatchObject({
        state: 'awaiting_acceptance',
        owner_seat: 'Ada',
      });
    });

    it('re-adding a soft-removed name revives it instead of dead-ending on UNIQUE (ADR 065)', async () => {
      const { db, team } = await freshTeam();
      const first = await addMember(db, team, { name: 'Ada', kind: 'human' });
      await leaveMember(db, first.row.id);

      // The bug this guards: a tombstoned (team, name) row used to make re-add throw a UNIQUE error
      // with no CLI escape. Re-add now revives: same id (history continuous), new kind/role, fresh token.
      const revived = await addMember(db, team, { name: 'Ada', kind: 'agent', role: 'engineer' });
      expect(revived.row.id).toBe(first.row.id);
      expect(revived.row.kind).toBe('agent');
      expect(revived.row.role).toBe('engineer');
      expect(revived.row.left_at).toBeNull();
      expect(revived.token).not.toBe(first.token); // deletion was a revocation — token re-minted
      expect((await listMembers(db, team.id)).map((m) => m.name)).toContain('Ada');
    });
  });

  // ADR 337 keeps the team key at the claim bootstrap boundary. Routine agent authority is instead
  // self-identifying and bound to the exact Presence that minted its short-lived lease.
  describe('authMember credential and lease dispatch (ADR 337)', async () => {
    it('agent credential plus its live lease resolves only its named seat', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const presence = await attach(db, ada.row.id, 'cli', null);
      const { seat_credential } = await mintAgentSeatCredential(db, ada.row.id);
      const { session_lease } = await mintSessionLease(db, {
        teamId: team.id,
        memberId: ada.row.id,
        presenceId: presence.id,
      });

      const ok = await authMember(db, 'dawn', seat_credential, 'Ada', session_lease);
      expect(ok.member.name).toBe('Ada');
      await expect(authMember(db, 'dawn', seat_credential, 'Ada')).rejects.toThrow(MusterdError);
    });

    it('the team agent key is never routine HTTP authority', async () => {
      const { db, team } = await freshTeam();
      await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const { agent_key } = await rotateAgentKey(db, team.id);
      await expect(authMember(db, 'dawn', agent_key)).rejects.toThrow(MusterdError);
    });

    it('the team agent key cannot select a non-existent or left seat', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const { agent_key } = await rotateAgentKey(db, team.id);
      await expect(authMember(db, 'dawn', agent_key, 'Nobody')).rejects.toThrow(MusterdError);
      await leaveMember(db, ada.row.id);
      await expect(authMember(db, 'dawn', agent_key, 'Ada')).rejects.toThrow(MusterdError);
    });

    it('a wrong agent key is unauthorized', async () => {
      const { db, team } = await freshTeam();
      await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await rotateAgentKey(db, team.id);
      await expect(authMember(db, 'dawn', 'mskey_bogus', 'Ada')).rejects.toThrow(MusterdError);
    });

    it('the team agent key cannot act as a HUMAN seat — bootstrap-only', async () => {
      const { db, team } = await freshTeam();
      await addMember(db, team, { name: 'nick', kind: 'human' }); // a human admin seat
      const { agent_key } = await rotateAgentKey(db, team.id);
      // The bootstrap-only key must be refused before any caller-selected seat is consulted.
      await expect(authMember(db, 'dawn', agent_key, 'nick')).rejects.toThrow(MusterdError);
      try {
        await authMember(db, 'dawn', agent_key, 'nick');
      } catch (e) {
        expect((e as MusterdError).code).toBe('unauthorized');
      }
    });

    it('a human credential is self-identifying (no acting seat needed)', async () => {
      const { db, team } = await freshTeam();
      const human = await addMember(db, team, { name: 'Nick', kind: 'human' });
      const { credential } = await mintCredential(db, human.row.id);

      const ok = await authMember(db, 'dawn', credential);
      expect(ok.member.name).toBe('Nick');
      // A matching x-musterd-seat is accepted; a mismatching one is forbidden (the credential is authority).
      expect((await authMember(db, 'dawn', credential, 'Nick')).member.name).toBe('Nick');
      await expect(authMember(db, 'dawn', credential, 'Ada')).rejects.toThrow(MusterdError);
    });
  });

  describe('messages + inbox', async () => {
    it('delivers a direct message to the recipient inbox, excluding the sender', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const lin = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      const env = makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'handoff',
        body: 'x',
        ts: 100,
      });
      await insertMessage(db, team.id, ada.row.id, lin.row.id, env);

      const linInbox = await listInbox(db, lin.row);
      expect(linInbox.map((m) => m.id)).toEqual(['m1']);
      const adaInbox = await listInbox(db, ada.row);
      expect(adaInbox).toEqual([]); // sender doesn't see own message
    });

    it('counts unread relative to a cursor and clears on advance', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const lin = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      const env = makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Lin' },
        act: 'message',
        body: 'hi',
        ts: 100,
      });
      await insertMessage(db, team.id, ada.row.id, lin.row.id, env);

      let cur = await getCursor(db, lin.row.id);
      expect(
        await listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts }),
      ).toHaveLength(1);
      await setCursor(db, lin.row.id, 'm1');
      cur = await getCursor(db, lin.row.id);
      expect(
        await listInbox(db, lin.row, { unreadOnly: true, cursorTs: cur.last_read_ts }),
      ).toHaveLength(0);
    });

    it('delivers team messages to all members except the sender', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const lin = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      const nick = await addMember(db, team, { name: 'nick', kind: 'human' });
      const env = makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'go',
        ts: 100,
      });
      await insertMessage(db, team.id, ada.row.id, null, env);
      expect(await listInbox(db, lin.row)).toHaveLength(1);
      expect(await listInbox(db, nick.row)).toHaveLength(1);
      expect(await listInbox(db, ada.row)).toHaveLength(0);
    });

    it('persists a resolve act, closing a thread (ADR 025 — schema v5 widened the act CHECK)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const lin = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      // Lin asks; Ada closes the thread once done. `resolve` carries the thread id it closes.
      const ask = makeEnvelope({
        id: 'm1',
        team: 'dawn',
        from: 'Lin',
        to: { kind: 'team' },
        act: 'request_help',
        body: 'review auth?',
        ts: 100,
      });
      await insertMessage(db, team.id, lin.row.id, null, ask);
      const done = makeEnvelope({
        id: 'm2',
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'resolve',
        thread: 'm1',
        body: 'merged',
        ts: 200,
      });
      await expect(insertMessage(db, team.id, ada.row.id, null, done)).resolves.not.toBeNull();
      const linInbox = await listInbox(db, lin.row);
      expect(linInbox.map((m) => `${m.act}:${m.thread_id ?? ''}`)).toContain('resolve:m1');
    });
  });

  describe('activity (two-clocks)', async () => {
    it('resolveActivity: offline when not live; active when live with no status; working with a status', () => {
      expect(resolveActivity(false, { state: 'x', ts: 1 })).toEqual({
        activity: 'offline',
        state: null,
        last_status_at: null,
      });
      expect(resolveActivity(true, null)).toEqual({
        activity: 'active',
        state: null,
        last_status_at: null,
      });
      expect(resolveActivity(true, { state: 'refactoring auth', ts: 100 })).toEqual({
        activity: 'working',
        state: 'refactoring auth',
        last_status_at: 100,
      });
    });

    it('listLiveDrivers: distinct drivers on live team presence; stale/other-team excluded (ADR 155)', async () => {
      const { db, team } = await freshTeam();
      const other = await createTeam(db, { slug: 'dusk' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const lin = (await addMember(db, team, { name: 'Lin', kind: 'agent' })).row;
      const far = (await addMember(db, other, { name: 'Rex', kind: 'agent' })).row;

      await attach(db, ada.id, 'claude-code', 'c1', { driver: 'nick' });
      await attach(db, lin.id, 'cli', 'c2', { driver: 'nick' }); // same driver, two seats → one entry
      await attach(db, far.id, 'cli', 'c3', { driver: 'bo' }); // other team → excluded

      const drivers = await listLiveDrivers(db, team.id, 60_000);
      expect([...drivers]).toEqual(['nick']); // distinct + team-scoped
      expect((await listLiveDrivers(db, other.id, 60_000)).has('bo')).toBe(true);
      // A zero timeout makes every heartbeat stale → no live drivers (the live filter).
      expect((await listLiveDrivers(db, team.id, 0)).size).toBe(0);
    });

    it('resolveActivity: steering marks you working even without your own heartbeat (ADR 155)', () => {
      // Not live on your own, but steering a live agent seat → working, present (the driver-copresence fix).
      expect(resolveActivity(false, null, true)).toEqual({
        activity: 'working',
        state: null,
        last_status_at: null,
      });
      // Steering keeps your own status text as the working label when you have one.
      expect(resolveActivity(true, { state: 'pairing on gate B', ts: 42 }, true)).toEqual({
        activity: 'working',
        state: 'pairing on gate B',
        last_status_at: 42,
      });
      // steering defaults false — the existing two-clocks behaviour is untouched.
      expect(resolveActivity(true, null).activity).toBe('active');
    });

    it('resolveActivity: the decay window turns a stale working label into active — claim kept with its age (ADR 155 Inc 3, presence-honesty \u00a72.1)', () => {
      const fresh = { state: 'reviewing asks', ts: Date.now() - 1_000 };
      const stale = { state: 'reviewing asks', ts: Date.now() - 46_000 };
      // Within the window the status is a live task label.
      expect(resolveActivity(true, fresh, false, 45_000)).toEqual({
        activity: 'working',
        state: 'reviewing asks',
        last_status_at: fresh.ts,
      });
      // Past it the read decays to active, but the claim is KEPT with its age — the renderer shows
      // `last: "<status>" \u00b7 20m ago`, never an erased history.
      expect(resolveActivity(true, stale, false, 45_000)).toEqual({
        activity: 'active',
        state: 'reviewing asks',
        last_status_at: stale.ts,
      });
      // Steering outranks the decay — a live driver link is a current action, not a stale report.
      expect(resolveActivity(true, stale, true, 45_000).activity).toBe('working');
      // No window keeps the ADR 010 never-silently-revert read (callers now always pass one).
      expect(resolveActivity(true, stale)).toEqual({
        activity: 'working',
        state: 'reviewing asks',
        last_status_at: stale.ts,
      });
      // Not live stays offline regardless of the window.
      expect(resolveActivity(false, stale, false, 45_000).activity).toBe('offline');
    });

    it('latestStatusUpdate: takes the newest status_update, prefers meta.state, else body', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect(await latestStatusUpdate(db, ada.row.id)).toBeNull();

      // body-only status
      await insertMessage(
        db,
        team.id,
        ada.row.id,
        null,
        makeEnvelope({
          id: 's1',
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'scaffolding',
          ts: 100,
        }),
      );
      expect(await latestStatusUpdate(db, ada.row.id)).toEqual({ state: 'scaffolding', ts: 100 });

      // newer status with meta.state wins over body
      await insertMessage(
        db,
        team.id,
        ada.row.id,
        null,
        makeEnvelope({
          id: 's2',
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'ignored body',
          meta: { state: 'refactoring auth', progress: 0.5 },
          ts: 200,
        }),
      );
      expect(await latestStatusUpdate(db, ada.row.id)).toEqual({
        state: 'refactoring auth',
        ts: 200,
      });

      // a non-status_update message does not change the label
      await insertMessage(
        db,
        team.id,
        ada.row.id,
        null,
        makeEnvelope({
          id: 'm3',
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'message',
          body: 'just chatting',
          ts: 300,
        }),
      );
      expect(await latestStatusUpdate(db, ada.row.id)).toEqual({
        state: 'refactoring auth',
        ts: 200,
      });
    });
  });

  describe('replicated audit (presence replication, 2026-09-02)', async () => {
    it('appendReplicatedEvent stamps a presence.* row from the node allocator, densely with lane rows', async () => {
      const { db, team } = await freshTeam();
      await appendReplicatedEvent(db, team.id, {
        actor: 'ada',
        action: 'presence.attached',
        target: 'ada',
        result: 'allow',
        detail: { presence: 'p1' },
      });
      await appendLaneEventRequired(db, team.id, {
        actor: 'ada',
        action: 'lane.opened',
        target: 'l1',
        result: 'allow',
        detail: { lane: 'l1' },
      });
      const seqs = await db.all(
        'SELECT origin_seq, action FROM audit WHERE origin_seq > 0 ORDER BY origin_seq',
      );
      expect(seqs.map((r) => r.origin_seq)).toEqual([1, 2]);
      expect(seqs[0]!.action).toBe('presence.attached');
    });
  });

  describe('presence', async () => {
    it('presence transitions are stamped audit rows: attach, reattest, detach — and a heartbeat is not', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const row = await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-opus-5',
        model_source: 'observed',
        workspace: '~/x',
        driver: 'nick',
      });
      await heartbeat(db, row.id);
      await reattestModel(db, row.id, 'claude-sonnet-5', 'observed');
      await detach(db, row.id);
      const rows = await db.all(
        "SELECT action, actor, detail, origin_seq FROM audit WHERE action LIKE 'presence.%' ORDER BY origin_seq",
      );
      expect(rows.map((r) => r.action)).toEqual([
        'presence.attached',
        'presence.reattested',
        'presence.detached',
      ]);
      expect(rows.every((r) => r.actor === 'Ada' && r.origin_seq > 0)).toBe(true);
      expect(JSON.parse(rows[0]!.detail)).toMatchObject({
        presence: row.id,
        surface: 'claude-code',
        model: 'claude-opus-5',
        model_source: 'observed',
        workspace: '~/x',
        driver: 'nick',
      });
      expect(JSON.parse(rows[0]!.detail)).not.toHaveProperty('wake_lease');
      expect(JSON.parse(rows[1]!.detail)).toMatchObject({
        presence: row.id,
        model: 'claude-sonnet-5',
        model_source: 'observed',
        surface: 'claude-code',
      });
      expect(JSON.parse(rows[2]!.detail)).toEqual({ presence: row.id, reason: 'goodbye' });
    });

    it('a resumed reaper judges nobody silent until it has watched for a full timeout — and the session lease survives with the presence', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const a = await attach(db, ada.row.id, 'claude-code', 'c1');
      const lease = await mintSessionLease(db, {
        teamId: team.id,
        memberId: ada.row.id,
        presenceId: a.id,
      });
      // The daemon was down for ten minutes: nothing could heartbeat, so last_seen_at is ancient.
      await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [
        Date.now() - 600_000,
        a.id,
      ]);

      // The loop resumed 10s ago — less than the 45s timeout it is about to judge by.
      expect(await reapStale(db, 45_000, Date.now() - 10_000)).toEqual([]);
      expect(await presenceById(db, a.id)).toBeDefined();
      expect(
        await hasValidSessionLease(db, {
          teamId: team.id,
          memberId: ada.row.id,
          token: lease.session_lease,
        }),
      ).toBe(true);

      // Once it has watched a full window and the row still has not spoken, it is genuinely silent.
      expect((await reapStale(db, 45_000, Date.now() - 60_000)).map((r) => r.id)).toEqual([a.id]);
      expect(await presenceById(db, a.id)).toBeUndefined();
      expect(
        await hasValidSessionLease(db, {
          teamId: team.id,
          memberId: ada.row.id,
          token: lease.session_lease,
        }),
      ).toBe(false);
    });

    it('reapStale judges by the clock the tick started on — a tick that itself blocked past the timeout cannot reap what it could not have heard', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const a = await attach(db, ada.row.id, 'claude-code', 'c1');
      // Measured 2026-09-14 15:57:46Z (lane 01M2GBPX2S): the first tick after a 3.6-day host suspend
      // reset the ADR 236 window, then blocked ~104s on a wedged daemon. 51s in, reapStale took its
      // OWN Date.now(): the guard (tick start) had passed and the cutoff (tick end) covered every row,
      // including three live sockets whose heartbeats were sitting unread in the socket buffer.
      const tickNow = Date.now() - 51_000; // the tick began 51s ago by the wall clock
      const watchedSince = tickNow - 60_000; // and the loop was entitled to judge when it began
      await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [tickNow - 1_000, a.id]);

      // By the tick's clock the row spoke one second before the tick began: live.
      expect(await reapStale(db, 45_000, watchedSince, tickNow)).toEqual([]);
      expect(await presenceById(db, a.id)).toBeDefined();
    });

    it('every removal path names its reason; release into grace is not a detach; reap of the grace is', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const a = await attach(db, ada.row.id, 'claude-code', 'c1');
      await release(db, a.id, 0);
      expect(
        await db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'"),
      ).toEqual({ n: 0 });
      await reapStale(db, 45_000); // held_until already passed
      const b = await attach(db, ada.row.id, 'claude-code', 'c2');
      await clearPresenceById(db, b.id);
      await attach(db, ada.row.id, 'claude-code', 'c3');
      await clearMemberPresence(db, ada.row.id);
      const reasons = (
        await db.all(
          "SELECT detail FROM audit WHERE action = 'presence.detached' ORDER BY origin_seq",
        )
      ).map((r) => JSON.parse(r.detail).reason);
      expect(reasons).toEqual(['reaped', 'displaced', 'cleared']);
    });

    it('an ambient touch emits attached when it creates a row and nothing when it refreshes one', async () => {
      const { db, team } = await freshTeam();
      const cy = await addMember(db, team, { name: 'Cy', kind: 'agent' });
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
      expect(
        await db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.attached'"),
      ).toEqual({ n: 1 });
    });

    it('a remote row is never the subject of a locally emitted transition', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await db.run(
        "INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES ('nB', ?, 'B', 1, 0)",
        [team.id],
      );
      await db.run(
        "INSERT INTO presence (id, member_id, team_id, surface, status, conn_id, last_seen_at, created_at, node) VALUES ('rB', ?, ?, 'codex', 'online', NULL, 1, 1, 'nB')",
        [ada.row.id, team.id],
      );
      await clearMemberPresence(db, ada.row.id);
      await reapStale(db, 45_000);
      expect(
        await db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'presence.detached'"),
      ).toEqual({ n: 0 });
      // The stale-node sweep removed it silently.
      expect(await db.get("SELECT COUNT(*) AS n FROM presence WHERE id = 'rB'")).toEqual({
        n: 0,
      });
    });

    it('a remote row is live while its node is, and reads its node label (presence replication §3)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const now = Date.now();
      await db.run(
        'INSERT INTO nodes (id, team_id, label, next_seq, last_seen_at) VALUES (?, ?, ?, 1, ?)',
        ['nB', team.id, 'laptop-b', now],
      );
      await db.run(
        "INSERT INTO presence (id, member_id, team_id, surface, status, conn_id, last_seen_at, created_at, node, model, driver, workspace) VALUES ('rB', ?, ?, 'codex', 'online', NULL, ?, ?, 'nB', 'gpt-5', 'nick', '~/b')",
        [ada.row.id, team.id, now - 10 * 60_000, now - 10 * 60_000],
      ); // a stale heartbeat would be dead locally
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
      const p = (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')!;
      expect(p.status).toBe('online');
      expect(p.presences[0]).toMatchObject({
        node: 'nB',
        node_label: 'laptop-b',
        model: 'gpt-5',
        driver: 'nick',
        workspace: '~/b',
      });
      expect((await listLiveDrivers(db, team.id, 45_000)).has('nick')).toBe(true);
      expect(await countLivePresences(db, 45_000)).toBe(1);
      // The node goes quiet past the TTL: the same row is not live.
      await db.run('UPDATE nodes SET last_seen_at = ? WHERE id = ?', [
        now - REMOTE_PRESENCE_TTL_MS - 1,
        'nB',
      ]);
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
      expect(
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')!.status,
      ).toBe('offline');
      // A local row folded nowhere still reads node: null on the roster.
      await attach(db, ada.row.id, 'claude-code', 'c1');
      const local = (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')!;
      expect(local.presences[0]).toMatchObject({ node: null, node_label: null });
    });

    it('reports online while fresh and offline after reap', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1');
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
      expect(
        (await listPresence(db, team.id, 45_000)).find((p) => p.member.name === 'Ada')?.status,
      ).toBe('online');
      // reap with a 0ms timeout removes everything
      const removed = await reapStale(db, 0);
      expect(removed.length).toBe(1);
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
    });

    it('round-trips the attested feature epoch, sticky across an ambient touch (ADR 148)', async () => {
      const { db, team } = await freshTeam();
      const epochOf = async (name: string) =>
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === name)?.presences[0]
          ?.epoch;

      // Claim path: attach attests epoch 3; listPresence surfaces it on the presence entry.
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1', { epoch: 3 });
      expect(await epochOf('Ada')).toBe(3);

      // Ambient path: a fire-and-exit CLI touch attests epoch 2, then a later touch carrying no epoch must
      // NOT clear it — the UPDATE's COALESCE keeps the value attested first, exactly like build/model.
      const cy = await addMember(db, team, { name: 'Cy', kind: 'agent' });
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, { epoch: 2 });
      expect(await epochOf('Cy')).toBe(2);
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
      expect(await epochOf('Cy')).toBe(2);

      // An absent epoch (older client) simply reads null — never blocks, never guesses.
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await attach(db, bo.row.id, 'claude-code', 'c2');
      expect(await epochOf('Bo')).toBeNull();
    });

    /**
     * ADR 417. `guidance_epoch` is the sibling of `epoch` with one difference that matters: `epoch` is
     * a compiled-in constant, so it cannot change inside an occupancy, while this one is a filesystem
     * read of the seat's own workspace and CAN — a mid-session refresh rewrites the guidance files
     * under a session that is still running. So the round-trip has to prove both halves: a heartbeat
     * carrying a NEW epoch must move the row forward, and a heartbeat carrying NONE must not clear it.
     */
    it('round-trips the attested guidance epoch, movable forward and sticky when absent (ADR 417)', async () => {
      const { db, team } = await freshTeam();
      const guidanceOf = async (name: string) =>
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === name)?.presences[0]
          ?.guidance_epoch;

      // Claim path: attach attests epoch 23; listPresence surfaces it on the presence entry.
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const adaPresence = await attach(db, ada.row.id, 'claude-code', 'c1', { guidance_epoch: 23 });
      expect(await guidanceOf('Ada')).toBe(23);

      // A heartbeat carrying a NEWER epoch moves the row — the seat refreshed mid-session and said so.
      // This is the half `epoch` never needs and the reason the field exists at all.
      await reattestGuidanceEpoch(db, adaPresence.id, 25);
      expect(await guidanceOf('Ada')).toBe(25);

      // A heartbeat carrying NONE must not clear the attested one: silence is not an assertion, and
      // a client too old to attest would otherwise erase what the claim stored on its first tick.
      await reattestGuidanceEpoch(db, adaPresence.id, undefined);
      await reattestGuidanceEpoch(db, adaPresence.id, null);
      expect(await guidanceOf('Ada')).toBe(25);

      // The ambient path is sticky the same way — a fire-and-exit CLI touch carries no guidance.
      const cy = await addMember(db, team, { name: 'Cy', kind: 'agent' });
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, { guidance_epoch: 24 });
      expect(await guidanceOf('Cy')).toBe(24);
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
      expect(await guidanceOf('Cy')).toBe(24);

      // An unstamped workspace (or an older client) reads null — never 0, which would read as the
      // staleest possible workspace rather than as an absent answer.
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await attach(db, bo.row.id, 'claude-code', 'c2');
      expect(await guidanceOf('Bo')).toBeNull();
    });

    /**
     * ADR 241. The token is the one presence field that IDENTIFIES rather than describes, so its
     * stickiness rule is deliberately the opposite of model/build/epoch's: it travels with
     * `provenance`, not with attestation. A touch that re-writes provenance re-writes the token in the
     * same breath, because a sticky token under a fresh provenance would keep asserting a lease the
     * session no longer belongs to — and a verifier reads that assertion as proof it spawned the
     * session.
     */
    it('round-trips the wake correlation token, and clears it with provenance (ADR 241)', async () => {
      const { db, team } = await freshTeam();
      const leaseOf = async (name: string) =>
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === name)?.presences[0]
          ?.wake_lease;

      // Claim path: the woken adapter attests the lease that spawned it.
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await attach(db, ada.row.id, 'codex', 'c1', { provenance: 'wake', wake_lease: 'L-1' });
      expect(await leaseOf('Ada')).toBe('L-1');

      // Ambient path: the woken session's hook one-shots carry it too — often BEFORE the adapter
      // claims, which is why the header exists at all.
      const cy = await addMember(db, team, { name: 'Cy', kind: 'agent' });
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {
        provenance: 'wake',
        wake_lease: 'L-2',
      });
      expect(await leaseOf('Cy')).toBe('L-2');

      // …and a later touch that declares nothing takes the row over completely: no provenance AND no
      // lease. Keeping the token here would leave the row claiming a wake it is no longer part of —
      // a row that lies is worse than a row that says nothing.
      await touchAmbientPresence(db, cy.row.id, 'cli', 45_000, {});
      expect(await leaseOf('Cy')).toBeNull();

      // An occupancy no wake caused simply has none. This is the overwhelmingly common case.
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await attach(db, bo.row.id, 'claude-code', 'c2');
      expect(await leaseOf('Bo')).toBeNull();
    });

    /**
     * ADR 246. The gap this closes, measured live on 2026-08-05: seat miley's session released
     * cleanly (ADR 010 leaves the row HELD, attestation intact), a hook one-shot touched fifteen
     * seconds later, `touchAmbientPresence`'s reuse query skipped the held row because it requires
     * `held_until IS NULL`, and so a BRAND NEW row was attached attesting nothing. `latestAttestedModel`
     * reads the newest non-held row and returns its null, so she left the ADR 188 review pool — and
     * the audit table had no row anywhere saying it happened. 1214 `occupancy.model_attested` rows
     * existed at the time and not one carried `new: null`, though `review.ts` has always read that
     * shape ("a de-attestation proves nothing").
     */
    it('records a de-attestation when an occupancy is born unattested after an attested one (ADR 246)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const attested = await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-fable-5',
      });
      await release(db, attested.id, 45_000); // clean disconnect: held, attestation intact

      const born = await attach(db, ada.row.id, 'cli', null); // the hook's ambient touch — attests nothing
      expect(await recordUnattestedOccupancy(db, team.id, ada.row, born.id, 'ambient')).toBe(true);

      const rows = (await listAudit(db, team.id, { limit: 10 })).filter(
        (r) => r.action === 'occupancy.model_attested',
      );
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail ?? '{}') as Record<string, unknown>;
      expect(detail).toMatchObject({
        occupancy: born.id,
        old: 'claude-fable-5',
        new: null,
        source: 'ambient',
      });
    });

    it('a seat that never attested drops nothing — silence is not a de-attestation (ADR 246)', async () => {
      // The guard on the guard. `unknown` from the start is a different fact from `was X, now
      // nothing`, and only the second is an event. Emitting for the first would fill the ledger with
      // rows about seats that have simply never been able to attest (ADR 158: Codex, today).
      const { db, team } = await freshTeam();
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      const born = await attach(db, bo.row.id, 'cli', null);
      expect(await recordUnattestedOccupancy(db, team.id, bo.row, born.id, 'claim')).toBe(false);
      // The attach itself is a replicated `presence.attached` row; the de-attestation is what's absent.
      expect(
        (await listAudit(db, team.id, { limit: 10 })).filter(
          (r) => !r.action.startsWith('presence.'),
        ),
      ).toHaveLength(0);
    });

    it('the de-attestation never resurrects the old model as evidence (ADR 187)', async () => {
      // `new: null` is load-bearing: review.ts skips these rows when building the durable attestation
      // map, so recording the drop can never become a way for a dead session's model to certify a
      // live review. The row is a RECORD of a loss, never a claim about what is running.
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const attested = await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-fable-5',
      });
      await release(db, attested.id, 45_000);
      const born = await attach(db, ada.row.id, 'cli', null);
      await recordUnattestedOccupancy(db, team.id, ada.row, born.id, 'ambient');

      const detail = JSON.parse(
        (await listAudit(db, team.id, { limit: 10 })).find(
          (r) => r.action === 'occupancy.model_attested',
        )?.detail ?? '{}',
      ) as { new: unknown };
      expect(detail.new).toBeNull();
    });

    it('countLivePresences counts distinct live members across all teams, ignoring offline/held (ADR 047)', async () => {
      const { db, team } = await freshTeam();
      const other = await createTeam(db, { slug: 'dusk' });
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const bo = await addMember(db, other, { name: 'Bo', kind: 'human' });

      expect(await countLivePresences(db, 45_000)).toBe(0);

      // a member fanned out over two surfaces still counts once
      await attach(db, ada.row.id, 'claude-code', 'c1');
      await attach(db, ada.row.id, 'cli', 'c2');
      expect(await countLivePresences(db, 45_000)).toBe(1);

      // a second member on another team adds to the cross-team count
      const boP = await attach(db, bo.row.id, 'cli', 'c3');
      expect(await countLivePresences(db, 45_000)).toBe(2);

      // a release hold no longer counts as live
      await release(db, boP.id, 45_000);
      expect(await countLivePresences(db, 45_000)).toBe(1);

      // an expired (stale) heartbeat doesn't count
      expect(await countLivePresences(db, 0)).toBe(0);
    });

    it('single-active: a live attachment is active; releasing frees the slot but keeps a reclaim hold', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1');
      expect(await hasActivePresence(db, ada.row.id)).toBe(true);

      await release(db, p.id, 45_000);
      // the active slot is free (a reclaim is allowed) but the hold row still exists...
      expect(await hasActivePresence(db, ada.row.id)).toBe(false);
      expect(await presenceById(db, p.id)).toBeDefined();
      // ...and is excluded from the live roster, so the member reads offline immediately.
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(false);
      expect(
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')?.status,
      ).toBe('offline');
    });

    it('sticky offline reason: release stamps disconnected; re-attach clears; leave stamps left_team (ADR 141 + presence-honesty split)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBeNull();

      const p = await attach(db, ada.row.id, 'claude-code', 'c1');
      await release(db, p.id, 45_000);
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBe('disconnected');

      await attach(db, ada.row.id, 'claude-code', 'c2');
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBeNull();

      await leaveMember(db, ada.row.id);
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBe('left_team');
    });

    it('deliberate-exit stamps: unbind stamps seat_released; clean session end stamps session_ended', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });

      await markSeatReleased(db, ada.row.id);
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBe('seat_released');

      await markSessionEnded(db, ada.row.id);
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBe('session_ended');
    });

    it('a said goodbye survives the socket close: release does not overwrite a deliberate-exit stamp', async () => {
      // The SessionEnd hook stamps session_ended, then the WS drops moments later. If release()
      // stamped unconditionally, every clean exit would still end up wearing crash clothing.
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1');
      await markSessionEnded(db, ada.row.id);
      await release(db, p.id, 45_000);
      expect((await getMemberById(db, ada.row.id))?.last_offline_reason).toBe('session_ended');
    });

    it('listReclaimableMemberIds: a held-within-grace seat is reclaimable though it reads offline (ADR 105)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      const pa = await attach(db, ada.row.id, 'claude-code', 'c1');
      await attach(db, bo.row.id, 'cli', 'c2'); // Bo stays live

      // Nothing held while both are live.
      expect(await listReclaimableMemberIds(db, team.id, Date.now())).toEqual(new Set());

      // Ada releases → held within grace: a reservation, reads offline on the roster but IS reclaimable.
      await release(db, pa.id, 45_000);
      const set = await listReclaimableMemberIds(db, team.id, Date.now());
      expect(set.has(ada.row.id)).toBe(true); // held within grace
      expect(set.has(bo.row.id)).toBe(false); // live, not a hold
      expect(
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')?.status,
      ).toBe('offline');

      // Past grace (held_until in the past): no longer a reservation.
      await release(db, pa.id, -1);
      expect((await listReclaimableMemberIds(db, team.id, Date.now())).has(ada.row.id)).toBe(false);
    });

    it('a reclaim hold survives the grace window, then the reaper frees it', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1');

      await release(db, p.id, 45_000);
      // within grace: a normal reap leaves the hold in place
      expect(await reapStale(db, 45_000)).toHaveLength(0);
      expect(await presenceById(db, p.id)).toBeDefined();

      // past grace (held_until in the past): the reaper sweeps it
      await release(db, p.id, -1);
      expect(await reapStale(db, 45_000)).toHaveLength(1);
      expect(await presenceById(db, p.id)).toBeUndefined();
    });

    it('a fresh hello reclaims by clearing any prior holds for the member', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const first = await attach(db, ada.row.id, 'claude-code', 'c1');
      await release(db, first.id, 45_000);

      await clearMemberPresence(db, ada.row.id);
      const second = await attach(db, ada.row.id, 'cli', 'c2');
      const rows = (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada');
      expect(rows?.presences).toHaveLength(1);
      expect(rows?.presences[0]?.surface).toBe('cli');
      expect(await presenceById(db, second.id)).toBeDefined();
      expect(await presenceById(db, first.id)).toBeUndefined();
    });
  });

  describe('model attestation (ADR 101)', async () => {
    it('attach records the attested model; absent attestation reads null (unknown)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-opus-4-8' });
      const summary = (await listPresence(db, team.id, 45_000)).find(
        (s) => s.member.name === 'Ada',
      );
      expect(summary?.presences[0]?.model).toBe('claude-opus-4-8');
      expect(await currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');

      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await attach(db, bo.row.id, 'cli', 'c2'); // no attestation — legal, never blocks
      expect(await currentAttestedModel(db, bo.row.id)).toBeNull();
    });

    it('reattestModel updates on a real change, no-ops on same value / missing row', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1', { model: 'claude-sonnet-5' });

      // Same value — no write, no audit noise.
      expect(await reattestModel(db, p.id, 'claude-sonnet-5')).toBeUndefined();
      // A real switch — returns the previous value for the audit trail.
      expect(await reattestModel(db, p.id, 'claude-opus-4-8')).toEqual({
        previous: 'claude-sonnet-5',
      });
      expect(await currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');
      // Missing row — undefined, never throws.
      expect(await reattestModel(db, 'nope', 'claude-opus-4-8')).toBeUndefined();
    });

    it('reattestSurface updates on a real change, no-ops on same value / missing row', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1');

      expect(await reattestSurface(db, p.id, 'claude-code')).toBeUndefined();
      expect(await reattestSurface(db, p.id, 'cursor')).toEqual({ previous: 'claude-code' });
      expect((await presenceById(db, p.id))?.surface).toBe('cursor');
      expect(await reattestSurface(db, 'nope', 'codex')).toBeUndefined();
    });

    it('currentAttestedModel keyed on a presence id reads that occupancy only (no cross-session bleed)', async () => {
      const { db, team } = await freshTeam();
      // A human fans out (ADR 042): two live sessions, different attested models.
      const nick = await addMember(db, team, { name: 'nick', kind: 'human' });
      const older = await attach(db, nick.row.id, 'cli', 'c1', { model: 'gpt-5.2' });
      const newer = await attach(db, nick.row.id, 'web', 'c2', { model: 'claude-opus-4-8' });
      // Keyed on the specific occupancy — each stamps its own model, not the newest.
      expect(await currentAttestedModel(db, nick.row.id, older.id)).toBe('gpt-5.2');
      expect(await currentAttestedModel(db, nick.row.id, newer.id)).toBe('claude-opus-4-8');
      // An unattested occupancy stamps nothing even if a sibling session attests.
      const bare = await attach(db, nick.row.id, 'ios', 'c3');
      expect(await currentAttestedModel(db, nick.row.id, bare.id)).toBeNull();
      // No presence id → best-effort newest-*attested* fallback (the stateless HTTP path): it never
      // returns the unattested session's null, only one of the attested models.
      expect(['gpt-5.2', 'claude-opus-4-8']).toContain(await currentAttestedModel(db, nick.row.id));
    });

    it('ambient touch preserves the attested model (sticky across authed HTTP requests)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      // An HTTP claim attaches a connectionless presence that attested a model.
      await attach(db, ada.row.id, 'cli', null, { model: 'claude-opus-4-8' });
      // A later authed request touches ambient presence with no model in context.
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000, {});
      // The attestation must survive — COALESCE keeps it, so per-act stamping still works.
      expect(await currentAttestedModel(db, ada.row.id)).toBe('claude-opus-4-8');
    });

    it('ambient touch after the attested row is reaped re-attests when the client carries a model (ADR 119 / #172)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      // Claim attested a model on a connectionless occupancy…
      await attach(db, ada.row.id, 'cli', null, { model: 'qwen2.5:3b-instruct' });
      expect(await currentAttestedModel(db, ada.row.id)).toBe('qwen2.5:3b-instruct');
      // …then the reaper clears it (presence aged past the timeout).
      expect(await reapStale(db, 0)).toHaveLength(1);
      expect(await currentAttestedModel(db, ada.row.id)).toBeNull();
      // A later one-shot without a model attaches a bare ambient row — the pre-119 hole.
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000, {});
      expect(await currentAttestedModel(db, ada.row.id)).toBeNull();
      // With the model in AttachContext (authTouch from x-musterd-model), ambient re-attests.
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000, { model: 'qwen2.5:3b-instruct' });
      expect(await currentAttestedModel(db, ada.row.id)).toBe('qwen2.5:3b-instruct');
    });
  });

  describe('ambient presence (ADR 057)', async () => {
    async function presenceRows(db: ReturnType<typeof freshTeam>['db'], memberId: string) {
      return (await db.all(
        'SELECT id, surface, conn_id, status, provenance FROM presence WHERE member_id = ?',
        [memberId],
      )) as {
        id: string;
        surface: string;
        conn_id: string | null;
        status: string;
        provenance: string | null;
      }[];
    }

    it('a touch on an offline member flips it present, and reports the transition', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(false);

      const flipped = await touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
      expect(flipped).toBe(true);
      expect(await hasLivePresence(db, ada.row.id, 45_000)).toBe(true);
      expect(
        (await listPresence(db, team.id, 45_000)).find((s) => s.member.name === 'Ada')?.status,
      ).toBe('online');
      const rows = await presenceRows(db, ada.row.id);
      expect(rows).toHaveLength(1);
      // Ambient rows are connectionless, and they record provenance only when the client declared
      // one. SPEC.md §"Attach context" — the server MUST NOT guess it.
      expect(rows[0]?.conn_id).toBeNull();
      expect(rows[0]?.provenance).toBeNull();
    });

    /**
     * SPEC.md §"Attach context — provenance & workspace" (ADR 014): provenance is a fact known only
     * to the attaching client, and the server "MUST NOT guess" it. `touchAmbientPresence` guessed it
     * anyway — `ctx.provenance ?? 'session'` — and the guess landed on humans hardest, because
     * `ambientTouch` reads `x-musterd-provenance` only for agent seats (ADR 121). Measured on the
     * live daemon 2026-09-05: 1174 of nick's `presence.attached` rows in 24h recorded `session`, a
     * word his client never sent, and 0 recorded anything else.
     *
     * The cost is epistemic rather than operational — nothing reads a human's provenance to decide
     * anything, and the actuators test `!== 'wake'`, so the default failed safe. What it destroyed
     * was the difference between "the client said session" and "the client said nothing", which is
     * the only question the column exists to answer. `wokenSeat.ts` already states the rule this
     * restores: absence is not an assertion (ADR 236).
     */
    it('records no provenance when the client declared none — the server must not guess (SPEC, ADR 014)', async () => {
      const { db, team } = await freshTeam();

      // A human seat: `ambientTouch` gates the header off entirely, so ctx never carries provenance.
      const nick = await addMember(db, team, { name: 'Nick', kind: 'human' });
      await touchAmbientPresence(db, nick.row.id, 'cli', 45_000, {});
      expect((await presenceRows(db, nick.row.id))[0]?.provenance).toBeNull();

      // An agent that declares one still records it — the fix drops the default, not the field.
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000, { provenance: 'hook' });
      expect((await presenceRows(db, ada.row.id))[0]?.provenance).toBe('hook');

      // And an agent that declares none is in exactly the same position as the human: silent, not
      // `session`. The gate is on what the client said, never on who the client is.
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await touchAmbientPresence(db, bo.row.id, 'cli', 45_000, {});
      expect((await presenceRows(db, bo.row.id))[0]?.provenance).toBeNull();

      // The re-write arm too (an existing ambient row is UPDATEd rather than attached): a declared
      // provenance must not stick once the next touch stops declaring it.
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000, {});
      expect((await presenceRows(db, ada.row.id))[0]?.provenance).toBeNull();
    });

    it('upserts a single row — many commands never accumulate rows', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      for (let i = 0; i < 5; i++) {
        const flipped = await touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
        // only the first touch is a transition; the rest just refresh the one row
        expect(flipped).toBe(i === 0);
      }
      expect(await presenceRows(db, ada.row.id)).toHaveLength(1);
    });

    it('is a no-op when a resident (connected) session already owns liveness', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1'); // a real watch socket

      const flipped = await touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
      expect(flipped).toBe(false);
      // no second row was added — the resident session is left alone
      const rows = await presenceRows(db, ada.row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.surface).toBe('claude-code');
      expect(rows[0]?.conn_id).toBe('c1');
    });

    it('refreshes a stale ambient row (the reaper later sweeps it like any live row)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await touchAmbientPresence(db, ada.row.id, 'cli', 45_000);

      // the member went idle past the window: it now reads offline...
      expect(await hasLivePresence(db, ada.row.id, 0)).toBe(false);
      // ...and a fresh command re-flips it present (a transition again), still one row
      const flipped = await touchAmbientPresence(db, ada.row.id, 'cli', 0);
      expect(flipped).toBe(true);
      expect(await presenceRows(db, ada.row.id)).toHaveLength(1);

      // and a 0ms reap removes the connectionless ambient row (held_until is null → a real offline)
      const removed = await reapStale(db, 0);
      expect(removed).toHaveLength(1);
      expect(removed[0]?.held_until).toBeNull();
    });

    it('does not displace or touch a reclaim hold (newest-session-wins stays the only eviction)', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const p = await attach(db, ada.row.id, 'claude-code', 'c1');
      await release(db, p.id, 45_000); // a hold during the grace window

      // a one-shot command must not resurrect or overwrite the hold; it adds its own ambient row
      const flipped = await touchAmbientPresence(db, ada.row.id, 'cli', 45_000);
      expect(flipped).toBe(true);
      const hold = await presenceById(db, p.id);
      expect(hold?.held_until).not.toBeNull(); // the hold is intact, untouched
      const ambient = (await presenceRows(db, ada.row.id)).find((r) => r.id !== p.id);
      expect(ambient?.conn_id).toBeNull();
    });
  });

  describe('observer seat reaping (ADR 064)', async () => {
    it('reaps idle observer seats but keeps fresh, live, message-referenced, and participant seats', async () => {
      const { db, team } = await freshTeam();
      const now = Date.now();
      const old = now - 100_000;

      const nick = await addMember(db, team, { name: 'nick', kind: 'human' }); // participant, never reaped
      const obOld = await addMember(db, team, { name: 'web-old', kind: 'human', observer: true });
      await addMember(db, team, { name: 'web-fresh', kind: 'human', observer: true }); // fresh updated_at → kept
      const obLive = await addMember(db, team, { name: 'web-live', kind: 'human', observer: true });
      const obRef = await addMember(db, team, { name: 'web-ref', kind: 'human', observer: true });

      // Age out everyone except the freshly-created observer.
      for (const id of [nick.row.id, obOld.row.id, obLive.row.id, obRef.row.id]) {
        await db.run('UPDATE members SET updated_at = ? WHERE id = ?', [old, id]);
      }
      // web-live holds a live presence → protected despite an old updated_at.
      await attach(db, obLive.row.id, 'web', 'conn-live', {
        provenance: null,
        workspace: null,
        driver: null,
      });
      // web-ref was sent a directed message → no to_member cascade, so it must be skipped (FK safety).
      await insertMessage(
        db,
        team.id,
        nick.row.id,
        obRef.row.id,
        makeEnvelope({
          id: 'r1',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'web-ref' },
          act: 'message',
          body: 'hi',
          ts: 100,
        }),
      );

      const reaped = await reapStaleObservers(db, now - 5_000, now - 45_000);

      expect(reaped.map((m) => m.name)).toEqual(['web-old']);
      const remaining = (await listMembers(db, team.id)).map((m) => m.name).sort();
      expect(remaining).toEqual(['nick', 'web-fresh', 'web-live', 'web-ref'].sort());
    });

    it('reapExcessIdleObservers keeps the freshest N idle seats per team (ADR 196)', async () => {
      const { db, team } = await freshTeam();
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const m = await addMember(db, team, { name: `web-${i}`, kind: 'human', observer: true });
        await db.run('UPDATE members SET updated_at = ? WHERE id = ?', [
          now - (5 - i) * 1_000,
          m.row.id,
        ]);
      }
      // Cap of 2 → keep web-4, web-3 (freshest); reap web-0..web-2.
      const reaped = await reapExcessIdleObservers(db, 2, now - 45_000);
      expect(reaped.map((m) => m.name).sort()).toEqual(['web-0', 'web-1', 'web-2']);
      expect(
        (await listMembers(db, team.id))
          .filter((m) => m.observer)
          .map((m) => m.name)
          .sort(),
      ).toEqual(['web-3', 'web-4']);
    });
  });

  describe('listTeamMessages (firehose backfill window)', async () => {
    // Seed `count` team messages at ts = 1..count (id `m<ts>`, zero-padded so id order == ts order).
    async function seed(
      db: ReturnType<typeof freshTeam>['db'],
      team: ReturnType<typeof freshTeam>['team'],
      count: number,
    ) {
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      for (let ts = 1; ts <= count; ts++) {
        const env = makeEnvelope({
          id: `m${String(ts).padStart(4, '0')}`,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'message',
          body: `#${ts}`,
          ts,
        });
        await insertMessage(db, team.id, ada.row.id, null, env);
      }
    }

    it('returns the NEWEST `limit` messages (not the oldest) in ascending order when over cap', async () => {
      const { db, team } = await freshTeam();
      await seed(db, team, 217); // over a 200 cap, like the busy team that surfaced this
      const rows = await listTeamMessages(db, team.id, { limit: 200 });
      expect(rows).toHaveLength(200);
      // Ascending display order…
      expect(rows[0]!.ts).toBe(18); // 217 - 200 + 1 — the oldest 17 are dropped, not the newest
      expect(rows[rows.length - 1]!.ts).toBe(217); // …and the very newest IS present (the bug was that it wasn't)
    });

    it('returns everything ascending when under the cap', async () => {
      const { db, team } = await freshTeam();
      await seed(db, team, 5);
      const rows = await listTeamMessages(db, team.id, { limit: 200 });
      expect(rows.map((r) => r.ts)).toEqual([1, 2, 3, 4, 5]);
    });

    it('pages forward from a `since` cursor: oldest-after-since first, no gap skipped', async () => {
      const { db, team } = await freshTeam();
      await seed(db, team, 10);
      const rows = await listTeamMessages(db, team.id, { since: 3, limit: 2 });
      // strictly after ts=3, oldest first, capped at 2 — so a cursor holder walks forward without skipping
      expect(rows.map((r) => r.ts)).toEqual([4, 5]);
    });
  });

  describe('model_source reaches the surfaces that show a model (lane 01M2PAFNAS)', async () => {
    it('the roster projection carries model_source beside model, per occupancy — and null beside a model whose tier is unknown', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const bo = await addMember(db, team, { name: 'Bo', kind: 'agent' });
      const lin = await addMember(db, team, { name: 'Lin', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-opus-5',
        model_source: 'observed',
      });
      await attach(db, bo.row.id, 'cursor', 'c2', { model: 'grok-4.6', model_source: 'binding' });
      // An older client: a model with no tier. Absence stays absence — never defaulted to `binding`.
      await attach(db, lin.row.id, 'codex', 'c3', { model: 'gpt-5.6' });
      const byName = new Map(
        (await listPresence(db, team.id, 45_000)).map((s) => [s.member.name, s]),
      );
      expect(byName.get('Ada')!.presences[0]).toMatchObject({
        model: 'claude-opus-5',
        model_source: 'observed',
      });
      expect(byName.get('Bo')!.presences[0]).toMatchObject({
        model: 'grok-4.6',
        model_source: 'binding',
      });
      expect(byName.get('Lin')!.presences[0]).toMatchObject({
        model: 'gpt-5.6',
        model_source: null,
      });
    });

    it('an audit row that names an actor is stamped with the model that actor is attesting right now, and its source', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await addMember(db, team, { name: 'Bo', kind: 'agent' });
      await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-opus-5',
        model_source: 'observed',
      });

      await appendAudit(db, team.id, {
        actor: 'Ada',
        action: 'memory.save',
        target: null,
        result: 'allow',
      });
      await appendAudit(db, team.id, {
        actor: 'Bo',
        action: 'memory.save',
        target: null,
        result: 'allow',
      });
      await appendAudit(db, team.id, {
        actor: null,
        action: 'claim.refused',
        target: 'x',
        result: 'deny',
      });

      const rows = (await listAudit(db, team.id, { limit: 10 })).filter(
        (r) => !r.action.startsWith('presence.'),
      );
      const of = (actor: string | null) => rows.find((r) => r.actor === actor)!;
      // Ada attests: both land on the row, read from the presence at WRITE time.
      expect(of('Ada')).toMatchObject({
        actor_model: 'claude-opus-5',
        actor_model_source: 'observed',
      });
      // Bo is a named seat with no live attestation: null, not a guess.
      expect(of('Bo')).toMatchObject({ actor_model: null, actor_model_source: null });
      // A system row has no actor and nothing to stamp.
      expect(of(null)).toMatchObject({ actor_model: null, actor_model_source: null });
    });

    it('the stamp is what the actor attested WHEN the row was written — a later re-attestation does not rewrite history', async () => {
      const { db, team } = await freshTeam();
      const ada = await addMember(db, team, { name: 'Ada', kind: 'agent' });
      const row = await attach(db, ada.row.id, 'claude-code', 'c1', {
        model: 'claude-opus-5',
        model_source: 'observed',
      });
      await appendAudit(db, team.id, {
        actor: 'Ada',
        action: 'memory.save',
        target: null,
        result: 'allow',
      });
      await reattestModel(db, row.id, 'claude-sonnet-5', 'observed');
      await appendAudit(db, team.id, {
        actor: 'Ada',
        action: 'memory.clear',
        target: null,
        result: 'allow',
      });
      const rows = await listAudit(db, team.id, { limit: 10 });
      expect(rows.find((r) => r.action === 'memory.save')!.actor_model).toBe('claude-opus-5');
      expect(rows.find((r) => r.action === 'memory.clear')!.actor_model).toBe('claude-sonnet-5');
    });

    it('a replicated entry that already carries its stamp keeps it — the origin saw the model, this node did not', async () => {
      const { db, team } = await freshTeam();
      await addMember(db, team, { name: 'Ada', kind: 'agent' });
      await appendReplicatedEvent(db, team.id, {
        actor: 'Ada',
        action: 'residency.woke',
        target: null,
        result: 'allow',
        actor_model: 'claude-opus-5',
        actor_model_source: 'observed',
      });
      const row = (await listAudit(db, team.id, { limit: 10 })).find(
        (r) => r.action === 'residency.woke',
      )!;
      expect(row).toMatchObject({ actor_model: 'claude-opus-5', actor_model_source: 'observed' });
    });
  });
});
