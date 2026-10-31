import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERALIST_CAPABILITIES, parseSeatFile, parseTeamFile } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { appendAudit } from '../store/audit.js';
import { boardSeat } from '../store/boardSeat.js';
import { getLane, openLane } from '../store/lanes.js';
import {
  addMember,
  getMemberByName,
  isHeld,
  listMembers,
  markBound,
  setMemberGovernance,
} from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { hostMayServe, TEAM_WIDE_HOST } from '../store/residency.js';
import { getRoleSkill, listRoleNames, roleSummariesMap } from '../store/roles.js';
import { toMember } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { loadTeamSpec } from './load.js';
import { reconcileAll, reconcileTeam } from './reconcile.js';
import { projectTeamToFiles, serializeProjectedTeam } from './serialize.js';

let openStore: () => Promise<Driver>;

withDrivers('reconcile', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  let dir: string;
  let db: Database;

  async function writeRoster(team: string, seats: Record<string, string>): Promise<void> {
    const m = join(dir, '.musterd');
    mkdirSync(join(m, 'seats'), { recursive: true });
    writeFileSync(join(m, 'team.toml'), team);
    for (const [name, body] of Object.entries(seats)) {
      writeFileSync(join(m, 'seats', `${name}.toml`), body);
    }
  }

  async function writeRole(name: string, body: string): Promise<void> {
    const rolesDir = join(dir, '.musterd', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, `${name}.toml`), body);
  }

  async function reconcile() {
    const spec = loadTeamSpec(dir);
    if (!spec) throw new Error('no spec');
    return await reconcileTeam(db, spec);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-roster-'));
    db = await openStore();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('reconcile — match-by-name delta', async () => {
    it('ADDs new seats and mints a token for each', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
        david: 'kind = "human"\nrole = "lead"\n',
      });
      const r = await reconcile();
      expect(r.added.sort()).toEqual(['david', 'olive']);
      expect(Object.keys(r.minted).sort()).toEqual(['david', 'olive']);
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await listMembers(db, team.id)).map((m) => m.name).sort()).toEqual([
        'david',
        'olive',
      ]);
    });

    it('is idempotent — a second pass changes nothing and mints nothing', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await reconcile();
      const r2 = await reconcile();
      expect(r2.added).toEqual([]);
      expect(r2.updated).toEqual([]);
      expect(r2.minted).toEqual({});
    });

    it('projects Team and Member working hours, preserving the Member override', async () => {
      await writeRoster(
        `slug = "alpha"

[working_hours]
timezone = "America/Los_Angeles"
days = ["mon", "tue", "wed", "thu", "fri"]
start = "11:00"
end = "15:00"
`,
        {
          inherited: 'kind = "agent"\n',
          custom: `kind = "agent"

[working_hours]
timezone = "America/New_York"
days = ["mon", "wed", "fri"]
start = "09:00"
end = "12:00"
`,
        },
      );
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect(team.working_hours).toBe(
        JSON.stringify({
          timezone: 'America/Los_Angeles',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          start: '11:00',
          end: '15:00',
        }),
      );
      expect((await getMemberByName(db, team.id, 'inherited'))?.working_hours).toBeNull();
      expect((await getMemberByName(db, team.id, 'custom'))?.working_hours).toBe(
        JSON.stringify({
          timezone: 'America/New_York',
          days: ['mon', 'wed', 'fri'],
          start: '09:00',
          end: '12:00',
        }),
      );
    });

    it('UPDATEs a role in place, preserving id + token_hash + bound_at', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const before = (await getMemberByName(db, team.id, 'olive'))!;
      // Hold the seat (first occupancy stamps bound_at; ADR 058).
      await markBound(db, before.id);
      const held = (await getMemberByName(db, team.id, 'olive'))!;
      expect(isHeld(held)).toBe(true);

      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "approver"\n' });
      const r = await reconcile();
      expect(r.updated).toEqual(['olive']);
      const after = (await getMemberByName(db, team.id, 'olive'))!;
      expect(after.id).toBe(before.id); // id preserved → message log continuity
      expect(after.token_hash).toBe(before.token_hash); // token_hash preserved → reconcile UPDATEs in place
      expect(after.bound_at).toBe(held.bound_at); // still held
      expect(after.role).toBe('approver');
    });

    it('REMOVEs a seat whose file is deleted via soft-tombstone (left_at), never hard-delete', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
        david: 'kind = "human"\nrole = "lead"\n',
      });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const oliveId = (await getMemberByName(db, team.id, 'olive'))!.id;

      await writeRoster('slug = "alpha"\n', { david: 'kind = "human"\nrole = "lead"\n' });
      rmSync(join(dir, '.musterd', 'seats', 'olive.toml'));
      const r = await reconcile();
      expect(r.removed).toEqual(['olive']);
      // Soft-tombstoned: row persists (FK + history) but is excluded from the live roster.
      expect((await listMembers(db, team.id)).map((m) => m.name)).toEqual(['david']);
      expect((await getMemberByName(db, team.id, 'olive'))!.id).toBe(oliveId);
      expect((await getMemberByName(db, team.id, 'olive'))!.left_at).not.toBeNull();
    });

    it("never retires the daemon's own board seat, which has no file, and the board revives a retired one (lane 01M69N8GR2)", async () => {
      await writeRoster('slug = "alpha"\n', { david: 'kind = "human"\nrole = "lead"\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const board = (await boardSeat(db, team))!;
      expect((await reconcile()).removed).toEqual([]);
      expect((await getMemberByName(db, team.id, 'board'))!.left_at).toBeNull();
      // A hub retired before this fix: the board's next send brings the same row back.
      await db.run('UPDATE members SET left_at = 1 WHERE id = ?', [board.id]);
      expect((await boardSeat(db, team))!).toMatchObject({ id: board.id, left_at: null });
    });

    it("on an enrolled joiner, a REMOVE leaves the seat's lanes to the hub — no lane.released as musterd (lane 01M3ZBTJKD)", async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
        david: 'kind = "human"\nrole = "lead"\n',
      });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const lane = await openLane(db, team.id, 'alpha', 'olive', { title: 'held', claim: true });
      const { id: node_id } = await localNodeForTeam(db, team.id);
      const stateDir = mkdtempSync(join(tmpdir(), 'musterd-reconcile-joiner-'));
      const prior = process.env['MUSTERD_NODE_STATE'];
      process.env['MUSTERD_NODE_STATE'] = join(stateDir, 'node.json');
      try {
        saveNodeEnrollment({
          team: 'alpha',
          hub_url: 'http://hub',
          credential: 'x',
          node_id,
          enrolled_at: 1,
        });
        rmSync(join(dir, '.musterd', 'seats', 'olive.toml'));
        expect((await reconcile()).removed).toEqual(['olive']);
      } finally {
        if (prior === undefined) delete process.env['MUSTERD_NODE_STATE'];
        else process.env['MUSTERD_NODE_STATE'] = prior;
        rmSync(stateDir, { recursive: true, force: true });
      }
      const after = await getLane(db, team.id, lane.id, 'alpha');
      expect(after).toMatchObject({ owner_seat: 'olive', state: 'claimed' });
      const released = await db.all(
        "SELECT id FROM audit WHERE action = 'lane.released' AND target = ?",
        [lane.id],
      );
      expect(released).toEqual([]);
    });

    it('REVIVEs a re-added seat with the same id but a fresh token (deletion = revocation)', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const firstSeat = (await getMemberByName(db, team.id, 'olive'))!;
      const firstId = firstSeat.id;
      const firstHash = firstSeat.token_hash;
      await markBound(db, firstId); // hold it

      // Delete then re-add the seat.
      rmSync(join(dir, '.musterd', 'seats', 'olive.toml'));
      await reconcile(); // tombstone
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      const r = await reconcile();

      expect(r.revived).toEqual(['olive']);
      const revived = (await getMemberByName(db, team.id, 'olive'))!;
      expect(revived.id).toBe(firstId); // same identity → log continuity
      expect(revived.left_at).toBeNull();
      expect(isHeld(revived)).toBe(false); // back to declared
      // Deletion = revocation: the seat got a fresh token_hash (the old one is gone).
      expect(revived.token_hash).not.toBe(firstHash);
    });

    it('resolves an omitted seat lifecycle from the team default', async () => {
      await writeRoster('slug = "alpha"\nlifecycle = "session"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
      });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await getMemberByName(db, team.id, 'olive'))!.lifecycle).toBe('session');
    });
  });

  describe('reconcile — guard 1: db projection round-trips to the files', async () => {
    it('preserves a human Slack identity through files → db → files', async () => {
      await writeRoster('slug = "alpha"\n', {
        nick: 'kind = "human"\nslack_user_id = "U123"\n',
      });
      await reconcile();

      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await getMemberByName(db, team.id, 'nick'))?.slack_user_id).toBe('U123');

      const projected = (await projectTeamToFiles(db, 'alpha'))!;
      const { seatFiles } = serializeProjectedTeam(projected);
      expect(parseSeatFile(seatFiles['nick.toml']!, 'nick').slack_user_id).toBe('U123');
    });

    it('projectTeamToFiles → serialize → parse deep-equals the on-disk spec', async () => {
      await writeRoster('slug = "alpha"\ndisplay = "Team Alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
        temp: 'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
      });
      await reconcile();

      const projected = (await projectTeamToFiles(db, 'alpha'))!;
      const { teamToml, seatFiles } = serializeProjectedTeam(projected);

      // Parsed structure of the *serialized projection* equals the parsed structure of the live files.
      expect(parseTeamFile(teamToml)).toEqual(
        parseTeamFile('slug = "alpha"\ndisplay = "Team Alpha"\n'),
      );
      expect(parseSeatFile(seatFiles['olive.toml']!, 'olive')).toEqual(
        parseSeatFile('kind = "agent"\nrole = "reviewer"\n', 'olive'),
      );
      expect(parseSeatFile(seatFiles['temp.toml']!, 'temp')).toEqual(
        parseSeatFile(
          'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
          'temp',
        ),
      );
    });
  });

  // Guard 1 above only proves files → db → files: it seeds from files that never had capabilities, so
  // the round trip is faithful by construction. `team export` runs the OTHER direction — a LIVE db
  // whose capabilities were written by paths that have no file (the ADR 071 creator-admin grant is
  // written straight to the member row at team create). Nothing guarded that direction, and the
  // projection dropped capabilities entirely: exporting revive's roster on 2026-08-01 rebuilt its only
  // admin as a plain generalist, leaving the team with ZERO admins, silently and unrecoverably through
  // the API (every admin-gated route was then closed to everyone).
  describe('reconcile — guard 1b: a LIVE db round-trips through files without losing authority', async () => {
    it('projects per-seat capabilities so db → files → db is a fixed point', async () => {
      await writeRole(
        'lead',
        'charter = "x"\n\n[capabilities]\nis_admin = true\nvisibility_level = "admin"\n',
      );
      await writeRoster('slug = "alpha"\n', {
        boss: 'kind = "human"\nrole = "lead"\n',
        quiet: 'kind = "agent"\nrole = ""\n',
      });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;

      // A narrowing written straight to the row, as governance ops do — no file says this.
      const quiet = (await getMemberByName(db, team.id, 'quiet'))!;
      await setMemberGovernance(
        db,
        quiet.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, can_message: 'none' }),
      );

      // Export: project the LIVE db back to files, then reconcile those files into a fresh db.
      const { seatFiles, teamToml } = serializeProjectedTeam(
        (await projectTeamToFiles(db, 'alpha'))!,
      );
      await writeRoster(teamToml, {
        boss: seatFiles['boss.toml']!,
        quiet: seatFiles['quiet.toml']!,
      });
      await reconcile();

      // Authority survives the round trip — this is the bug: it used to come back is_admin false.
      const bossAfter = toMember((await getMemberByName(db, team.id, 'boss'))!);
      expect(bossAfter.capabilities.is_admin).toBe(true);
      expect(bossAfter.capabilities.visibility_level).toBe('admin');
      // …and so does a per-seat narrowing that no role expresses.
      const quietAfter = toMember((await getMemberByName(db, team.id, 'quiet'))!);
      expect(quietAfter.capabilities.can_message).toBe('none');
    });

    it('reports a seat whose capabilities no role can express, instead of dropping them', async () => {
      await writeRoster('slug = "alpha"\n', { solo: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const solo = (await getMemberByName(db, team.id, 'solo'))!;
      // Admin with no admin ROLE: unrepresentable, because a seat override can only narrow. This is
      // exactly revive's creator — the shape that got silently downgraded.
      await setMemberGovernance(
        db,
        solo.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );

      const projected = (await projectTeamToFiles(db, 'alpha'))!;
      expect(projected.unrepresentable).toHaveLength(1);
      expect(projected.unrepresentable[0]).toContain('solo');
      expect(projected.unrepresentable[0]).toMatch(/is_admin/);
    });
  });

  describe('reconcile — a projection must not silently leave a team with no admin', async () => {
    it('errors when the roster would strip the last admin', async () => {
      await writeRole('lead', 'charter = "x"\n\n[capabilities]\nis_admin = true\n');
      await writeRoster('slug = "alpha"\n', { boss: 'kind = "human"\nrole = "lead"\n' });
      expect((await reconcile()).errors).toHaveLength(0); // healthy: one admin

      // The roster is rewritten with the role dropped — the exact shape `team export` produced.
      await writeRoster('slug = "alpha"\n', { boss: 'kind = "human"\nrole = ""\n' });
      const r = await reconcile();
      expect(r.errors.some((e) => /no admin/i.test(e))).toBe(true);
    });

    it('stays quiet for a team that never had an admin — this reports a LOSS, not a lint', async () => {
      await writeRoster('slug = "beta"\n', { hand: 'kind = "agent"\nrole = ""\n' });
      expect((await reconcile()).errors).toHaveLength(0);
      expect((await reconcile()).errors).toHaveLength(0); // and stays quiet on re-reconcile
    });
  });

  describe('reconcile — fail-closed: a corrupt seat is skipped, siblings intact', async () => {
    it('keeps good seats and records the bad one in errors', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
        broken: 'this is not = valid toml = at all\n',
      });
      const r = await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await listMembers(db, team.id)).map((m) => m.name)).toEqual(['olive']);
      expect(r.errors.length).toBe(1);
      expect(r.errors[0]).toContain('broken.toml');
    });
  });

  describe('reconcile — unknown keys warn, never fail (nick 2026-08-21)', async () => {
    it('warns about a key no schema knows, and still projects the seat', async () => {
      // The live instance: seats/autorefresh.toml carries an authored `charter`, which is in
      // RoleFileSchema but not SeatFileSchema. Reconcile has silently dropped it since 2026-08-05.
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
      });
      const r = await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      // WARN, not fail — the seat still lands. Failing would refuse autorefresh's seat on the live
      // roster today, which is why this is a warning and nick decided it explicitly.
      expect((await listMembers(db, team.id)).map((m) => m.name)).toEqual(['olive']);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([
        'seats/olive.toml: dropped unknown key(s) charter — not in the schema, so reconcile ignores them',
      ]);
    });

    it('warns on team.toml and roles/*.toml too — every durable class, not just seats', async () => {
      await writeRoster('slug = "alpha"\nnot_a_team_key = "x"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n',
      });
      await writeRole('platform', 'summary = "P"\ncharter = "C"\nnot_a_role_key = "y"\n');
      const r = await reconcile();
      expect(r.warnings).toEqual([
        'team.toml: dropped unknown key(s) not_a_team_key — not in the schema, so reconcile ignores them',
        'roles/platform.toml: dropped unknown key(s) not_a_role_key — not in the schema, so reconcile ignores them',
      ]);
    });

    it('a clean roster warns about nothing', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      expect((await reconcile()).warnings).toEqual([]);
    });
  });

  describe('reconcile — canonical drift is reported, because nothing else reads it', async () => {
    /**
     * `musterd fmt --check` has existed since ADR 058 and NOTHING RUNS IT. Measured 2026-08-24: two
     * role files on the live roster drifted from 2026-08-04 until a human happened to check by hand,
     * twenty days later. CI cannot cover it — the roster is not in this repo — so the reader has to be
     * the one process that already opens every roster file on every pass.
     */
    it('reports a file whose bytes are not what the serializer would write', async () => {
      // The exact live shape, inverted: a flush table header is now the non-canonical one (ADR 309).
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await writeRole('platform', 'summary = "P"\n[capabilities]\nis_admin = false\n');
      const r = await reconcile();
      expect(r.drift).toEqual(['roles/platform.toml']);
    });

    it('still projects the drifted entry — cosmetic drift is never fail-closed', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\n[capabilities]\ncan_message = "none"\n',
      });
      const r = await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await listMembers(db, team.id)).map((m) => m.name)).toEqual(['olive']);
      expect(r.errors).toEqual([]);
      expect(r.drift).toEqual(['seats/olive.toml']);
    });

    it('keeps drift separate from a dropped key — they mean different things', async () => {
      // ADR 304's own lesson: a reader must be able to tell data loss from tidiness. An unknown key
      // ALSO makes the bytes non-canonical, so this file is both — and says so twice, distinctly.
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
      });
      const r = await reconcile();
      expect(r.drift).toEqual(['seats/olive.toml']);
      expect(r.warnings).toEqual([
        'seats/olive.toml: dropped unknown key(s) charter — not in the schema, so reconcile ignores them',
      ]);
    });

    it('a canonical roster reports no drift — including the hand-authored blank-line shape', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await writeRole('platform', 'summary = "P"\n\n[capabilities]\nis_admin = false\n');
      const r = await reconcile();
      expect(r.drift).toEqual([]);
      expect(r.warnings).toEqual([]);
    });
  });

  describe('reconcileAll surfaces what a pass found (nothing did until 2026-08-21)', async () => {
    it('logs canonical drift as its own line, distinct from a dropped key', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await writeRole('platform', 'summary = "P"\n[capabilities]\nis_admin = false\n');
      const { log } = await import('../log.js');
      const seen: Array<Record<string, unknown>> = [];
      const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
        seen.push(f as Record<string, unknown>);
      });
      try {
        await reconcileAll(db, [dir]);
      } finally {
        spy.mockRestore();
      }
      const drifted = seen.find((f) => f['msg'] === 'reconcile_file_drifted');
      expect(drifted).toBeDefined();
      expect(String(drifted?.['detail'])).toContain('roles/platform.toml');
      expect(drifted?.['team']).toBe('alpha');
      // The instrument must not borrow ADR 304's channel — that would re-merge the two meanings.
      expect(seen.map((f) => f['msg'])).not.toContain('reconcile_key_dropped');
    });

    it('logs BOTH a skipped entry and a dropped key — collected-and-discarded was the old behaviour', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = "reviewer"\ncharter = "A paragraph a human wrote."\n',
        broken: 'this is not = valid toml = at all\n',
      });
      const { log } = await import('../log.js');
      const seen: Array<Record<string, unknown>> = [];
      const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
        seen.push(f as Record<string, unknown>);
      });
      try {
        await reconcileAll(db, [dir]);
      } finally {
        spy.mockRestore();
      }
      const kinds = seen.map((f) => f['msg']);
      // The skipped seat — load.ts calls this "never silently dropped", and until now it was.
      expect(kinds).toContain('reconcile_entry_error');
      // The dropped field — the case the promise never covered at all.
      expect(kinds).toContain('reconcile_key_dropped');
      const dropped = seen.find((f) => f['msg'] === 'reconcile_key_dropped');
      expect(String(dropped?.['detail'])).toContain('charter');
      expect(dropped?.['team']).toBe('alpha');
    });

    it('says nothing about a clean roster', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      const { log } = await import('../log.js');
      const seen: string[] = [];
      const spy = vi.spyOn(log, 'warn').mockImplementation((f) => {
        seen.push(String((f as Record<string, unknown>)['msg']));
      });
      try {
        await reconcileAll(db, [dir]);
      } finally {
        spy.mockRestore();
      }
      expect(seen).toEqual([]);
    });
  });

  describe('reconcile — governance projection (ADR 070, v0.3 P1)', async () => {
    async function memberView(name: string) {
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const row = (await getMemberByName(db, team.id, name))!;
      return toMember(row, 'alpha');
    }

    it('a seat with no role gets the generalist default + derived provisioned status', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = ""\n' });
      await reconcile();
      const m = await memberView('olive');
      expect(m.capabilities).toEqual(GENERALIST_CAPABILITIES);
      expect(m.account_status).toBe('provisioned'); // never held
    });

    it('derives active once the seat has been held (authenticated)', async () => {
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      await markBound(db, (await getMemberByName(db, team.id, 'olive'))!.id); // first occupancy stamps bound_at (ADR 058)
      expect((await memberView('olive')).account_status).toBe('active');
    });

    it("projects a role's default capabilities onto its seat", async () => {
      await writeRole(
        'reviewer',
        '[capabilities]\ncan_flag_urgent = false\nvisibility_level = "admin"\nis_admin = true\n',
      );
      // A HUMAN seat: an admin role projects fully onto a human (agents get is_admin clamped below).
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "human"\nrole = "reviewer"\n' });
      await reconcile();
      const caps = (await memberView('olive')).capabilities!;
      expect(caps.can_flag_urgent).toBe(false);
      expect(caps.visibility_level).toBe('admin');
      expect(caps.is_admin).toBe(true);
      expect(caps.can_observe).toBe(true); // unset role field falls back to generalist
    });

    it('clamps is_admin on an AGENT seat, loudly — admins can only be humans (ADR 172)', async () => {
      // This exact shape used to project cleanly: an agent handed an admin role read is_admin=true,
      // so a seat file could quietly manufacture the authority every admin gate exists to check
      // (governance ops, audit reads, risky-lane human review). Now the single writer clamps it and
      // says so; every other capability of the role still projects.
      await writeRole('ops', '[capabilities]\ncan_flag_urgent = false\nis_admin = true\n');
      await writeRoster('slug = "alpha"\n', { botty: 'kind = "agent"\nrole = "ops"\n' });
      const result = await reconcile();
      const caps = (await memberView('botty')).capabilities!;
      expect(caps.is_admin).toBe(false);
      expect(caps.can_flag_urgent).toBe(false); // the rest of the role projects untouched
      expect(result.errors.some((e) => e.includes('botty') && e.includes('human-only'))).toBe(true);
    });

    it('clamps is_admin on a SERVICE seat exactly as on an agent (ADR 232 / ADR 172)', async () => {
      // The service kind must not inherit a softer gate by being new: a cron declaring an admin role
      // is the same manufactured authority, one identity further from a keyboard.
      await writeRole('ops', '[capabilities]\nis_admin = true\n');
      await writeRoster('slug = "alpha"\n', { autorefresh: 'kind = "service"\nrole = "ops"\n' });
      const result = await reconcile();
      expect((await memberView('autorefresh')).kind).toBe('service');
      expect((await memberView('autorefresh')).capabilities!.is_admin).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes('autorefresh') && e.includes('a service') && e.includes('human-only'),
        ),
      ).toBe(true);
    });

    it('a per-seat override narrows the role default but cannot widen it', async () => {
      await writeRole('reviewer', '[capabilities]\ncan_flag_urgent = true\n');
      await writeRoster('slug = "alpha"\n', {
        // narrows urgent off, and tries to self-promote is_admin (role default false) → clamped
        olive:
          'kind = "agent"\nrole = "reviewer"\n[capabilities]\ncan_flag_urgent = false\nis_admin = true\n',
      });
      await reconcile();
      const caps = (await memberView('olive')).capabilities!;
      expect(caps.can_flag_urgent).toBe(false); // narrowed
      expect(caps.is_admin).toBe(false); // widening clamped
    });

    it('honours an admin-set account_status override from the file', async () => {
      await writeRoster('slug = "alpha"\n', {
        olive: 'kind = "agent"\nrole = ""\naccount_status = "banned"\n',
      });
      await reconcile();
      expect((await memberView('olive')).account_status).toBe('banned');
    });

    it('projects a multi-role seat: roles[] on the member, capabilities merged restrictively (ADR 227)', async () => {
      await writeRole('designer', 'summary = "Owns the design surfaces"\n');
      await writeRole(
        'observer',
        '[capabilities]\ncan_flag_urgent = false\ncan_message = "none"\n',
      );
      await writeRoster('slug = "alpha"\n', {
        miley: 'kind = "agent"\nrole = "designer"\nroles = ["designer", "observer"]\n',
      });
      await reconcile();
      const m = await memberView('miley');
      expect(m.roles).toEqual(['designer', 'observer']);
      expect(m.role).toBe('designer'); // display label = first entry
      // the observer role's explicit restrictions hold across the pair
      expect(m.capabilities!.can_message).toBe('none');
      expect(m.capabilities!.can_flag_urgent).toBe(false);
    });

    it('warns on an unknown role name in the roles array without dropping the seat (ADR 227 roster truth)', async () => {
      await writeRoster('slug = "alpha"\n', {
        izzo: 'kind = "agent"\nrole = "platfrom"\nroles = ["platfrom"]\n', // typo'd, no roles/platfrom.toml
      });
      const r = await reconcile();
      expect(r.errors.some((e) => e.includes('izzo') && e.includes('platfrom'))).toBe(true);
      // the seat itself is projected — a typo is a warning, not an outage
      expect((await memberView('izzo')).capabilities).toEqual(GENERALIST_CAPABILITIES);
    });

    it('a legacy bare role label stays unvalidated (back-compat — "tester" is a label, not drift)', async () => {
      await writeRoster('slug = "alpha"\n', { tinybot: 'kind = "agent"\nrole = "tester"\n' });
      const r = await reconcile();
      expect(r.errors).toEqual([]);
      expect((await memberView('tinybot')).roles).toEqual(['tester']);
    });

    it('a roleless seat stays the generalist and warns nothing (roles are optional)', async () => {
      await writeRoster('slug = "alpha"\n', { dolly: 'kind = "agent"\nrole = ""\n' });
      const r = await reconcile();
      expect(r.errors).toEqual([]);
      const m = await memberView('dolly');
      expect(m.roles).toEqual([]);
      expect(m.capabilities).toEqual(GENERALIST_CAPABILITIES);
    });

    it('projects the role summary into the roles table (ADR 227)', async () => {
      await writeRole(
        'designer',
        'summary = "Owns the design surfaces"\ncharter = "The standing rule."\n',
      );
      await writeRoster('slug = "alpha"\n', { miley: 'kind = "agent"\nrole = "designer"\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect((await roleSummariesMap(db, team.id)).get('designer')).toBe(
        'Owns the design surfaces',
      );
    });

    it('projects the skill a role names, and the name stands in when it names none (ADR 586 §3)', async () => {
      await writeRole('designer', 'summary = "Draws"\nskill = "brand-design"\n');
      await writeRole('planner', 'summary = "Plans"\n');
      await writeRoster('slug = "alpha"\n', { miley: 'kind = "agent"\nrole = "designer"\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect(await getRoleSkill(db, team.id, 'designer')).toBe('brand-design');
      expect(await getRoleSkill(db, team.id, 'planner')).toBe('planner');

      await writeRole('designer', 'summary = "Draws"\n');
      await reconcile();
      expect(await getRoleSkill(db, team.id, 'designer')).toBe('designer');
    });

    it('an agent reaching admin through ANY held role is clamped, multi-role included (ADR 172)', async () => {
      await writeRole('admin', '[capabilities]\nis_admin = true\n');
      await writeRole('designer', 'summary = "Owns the design surfaces"\n');
      await writeRoster('slug = "alpha"\n', {
        sneaky: 'kind = "agent"\nrole = "designer"\nroles = ["designer", "admin"]\n',
      });
      const r = await reconcile();
      expect((await memberView('sneaky')).capabilities!.is_admin).toBe(false);
      expect(r.errors.some((e) => e.includes('sneaky'))).toBe(true);
    });

    it('drops a role from the projection when its file is removed', async () => {
      await writeRole('reviewer', '[capabilities]\ncan_flag_urgent = false\n');
      await writeRoster('slug = "alpha"\n', { olive: 'kind = "agent"\nrole = "reviewer"\n' });
      await reconcile();
      expect((await memberView('olive')).capabilities!.can_flag_urgent).toBe(false);

      // remove the role file → seat falls back to generalist on the next reconcile
      rmSync(join(dir, '.musterd', 'roles', 'reviewer.toml'));
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      expect(await listRoleNames(db, team.id)).toEqual([]);
      expect((await memberView('olive')).capabilities!.can_flag_urgent).toBe(true); // generalist again
    });
  });

  describe('reconcile — the seat file owns the hue (ADR 374)', async () => {
    const team = 'slug = "acme"\n';

    it('projects a file hue on ADD and again on UPDATE, and NULLs it when the file drops it', async () => {
      await writeRoster(team, { miley: 'kind = "agent"\nrole = "designer"\nhue = 212\n' });
      await reconcile();
      const t = (await getTeamBySlug(db, 'acme'))!;
      expect((await getMemberByName(db, t.id, 'miley'))!.hue).toBe(212);

      await writeRoster(team, { miley: 'kind = "agent"\nrole = "designer"\nhue = 40\n' });
      expect((await reconcile()).updated).toEqual(['miley']);
      expect((await getMemberByName(db, t.id, 'miley'))!.hue).toBe(40);

      await writeRoster(team, { miley: 'kind = "agent"\nrole = "designer"\n' });
      expect((await reconcile()).updated).toEqual(['miley']);
      expect((await getMemberByName(db, t.id, 'miley'))!.hue).toBeNull();
    });

    /* Lane 01M2P43WQ7: reconcile creates a seat through `addMember`, which used to refuse a
     colliding explicit hue — so ONE seat file whose colour sat within 12° of a teammate's aborted
     the whole team's reconcile, every seat included. The file's word is stored, never refused. */
    it('a seat file whose hue collides with a teammate does not abort the team — the file is the writer', async () => {
      await writeRoster(team, {
        ryder: 'kind = "agent"\nrole = ""\nhue = 214\n',
        miley: 'kind = "agent"\nrole = "designer"\nhue = 212\n',
      });
      const result = await reconcile();
      expect(result.added.sort()).toEqual(['miley', 'ryder']);
      const t = (await getTeamBySlug(db, 'acme'))!;
      expect((await getMemberByName(db, t.id, 'miley'))!.hue).toBe(212);
      expect((await getMemberByName(db, t.id, 'ryder'))!.hue).toBe(214);
    });

    it('never invents a hue for a file-backed seat — a file without one projects null on ADD', async () => {
      await writeRoster(team, { dolly: 'kind = "agent"\nrole = ""\n' });
      await reconcile();
      const t = (await getTeamBySlug(db, 'acme'))!;
      expect((await getMemberByName(db, t.id, 'dolly'))!.hue).toBeNull();
      expect(toMember((await getMemberByName(db, t.id, 'dolly'))!, 'acme').hue).toBeNull();
    });

    it('REVIVE takes the hue from the file, like every other identity field', async () => {
      await writeRoster(team, { ryder: 'kind = "agent"\nrole = ""\nhue = 100\n' });
      await reconcile();
      rmSync(join(dir, '.musterd', 'seats', 'ryder.toml'));
      await reconcile();
      await writeRoster(team, { ryder: 'kind = "agent"\nrole = ""\nhue = 130\n' });
      expect((await reconcile()).revived).toEqual(['ryder']);
      const t = (await getTeamBySlug(db, 'acme'))!;
      expect((await getMemberByName(db, t.id, 'ryder'))!.hue).toBe(130);
    });

    it('two daemons reconciling the same seat files report the same hue per name', async () => {
      await writeRoster(team, {
        miley: 'kind = "agent"\nrole = ""\nhue = 212\n',
        nick: 'kind = "human"\nrole = "admin"\n',
      });
      await reconcile();
      const other = await openStore();
      try {
        const spec = loadTeamSpec(dir)!;
        await reconcileTeam(other, spec);
        for (const name of ['miley', 'nick']) {
          const a = (await getMemberByName(db, (await getTeamBySlug(db, 'acme'))!.id, name))!.hue;
          const b = (await getMemberByName(other, (await getTeamBySlug(other, 'acme'))!.id, name))!
            .hue;
          expect(b).toBe(a);
        }
      } finally {
        await other.close();
      }
    });
  });

  describe('sponsored agents on a seat-file team (ADR 700)', () => {
    /** The hub's own record that `sponsor` minted `agent` — what the mint route writes. */
    async function mintFact(teamId: string, sponsor: string, agent: string): Promise<void> {
      await appendAudit(db, teamId, {
        actor: sponsor,
        action: 'member.sponsored_agent_created',
        target: agent,
        result: 'allow',
      });
    }

    async function cascadeRows(teamId: string): Promise<Array<{ target: string; detail: string }>> {
      return await db.all<{ target: string; detail: string }>(
        "SELECT target, detail FROM audit WHERE team_id = ? AND action = 'member.revoked_cascade'",
        [teamId],
      );
    }

    it('a file sponsor the hub vouched for projects; a forged one projects unsponsored and warns', async () => {
      await writeRoster('slug = "alpha"\n', { dana: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await mintFact(team.id, 'dana', 'scout');
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\n',
        scout: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
        forged: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
      });
      const r = await reconcile();
      expect((await getMemberByName(db, team.id, 'scout'))!.sponsored_by).toBe(dana.id);
      expect((await getMemberByName(db, team.id, 'forged'))!.sponsored_by).toBeNull();
      expect(r.warnings.join('\n')).toMatch(/"forged" names sponsor "dana" with no mint/);
    });

    it('a file that drops the line keeps the vouched sponsor (big-body, ADR 700 d2)', async () => {
      await writeRoster('slug = "alpha"\n', { dana: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await addMember(db, team, { name: 'scout', kind: 'agent', sponsoredBy: dana.id });
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\n',
        scout: 'kind = "agent"\nrole = ""\n',
      });
      const r = await reconcile();
      expect((await getMemberByName(db, team.id, 'scout'))!.sponsored_by).toBe(dana.id);
      expect(r.warnings.join('\n')).toMatch(
        /"scout" omits sponsored_by — its vouched sponsor dana stands/,
      );
      // The reason it stands: unsponsored, any team-wide host key could run it (big-body, eval i).
      expect(hostMayServe(TEAM_WIDE_HOST, (await getMemberByName(db, team.id, 'scout'))!)).toBe(
        false,
      );
    });

    it('a sponsor disabled in its file disables the agent on the same pass and cascades', async () => {
      await writeRoster('slug = "alpha"\n', { dana: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await addMember(db, team, { name: 'scout', kind: 'agent', sponsoredBy: dana.id });
      const files = {
        dana: 'kind = "human"\nrole = ""\naccount_status = "disabled"\n',
        scout: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
      };
      await writeRoster('slug = "alpha"\n', files);
      await reconcile();
      expect((await getMemberByName(db, team.id, 'dana'))!.account_status).toBe('disabled');
      expect((await getMemberByName(db, team.id, 'scout'))!.account_status).toBe('disabled');
      const rows = await cascadeRows(team.id);
      expect(rows.map((r) => r.target)).toEqual(['scout']);
      expect(JSON.parse(rows[0]!.detail)).toMatchObject({ root: 'dana', trigger: 'reconcile' });
      // A second pass neither re-enables the agent from its own file nor cascades again.
      await reconcile();
      expect((await getMemberByName(db, team.id, 'scout'))!.account_status).toBe('disabled');
      expect(await cascadeRows(team.id)).toHaveLength(1);
    });

    it('a sponsor whose file is removed cascades to its agent', async () => {
      await writeRoster('slug = "alpha"\n', { dana: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await addMember(db, team, { name: 'scout', kind: 'agent', sponsoredBy: dana.id });
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\n',
        scout: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
      });
      await reconcile();
      rmSync(join(dir, '.musterd', 'seats', 'dana.toml'));
      await reconcile();
      expect((await getMemberByName(db, team.id, 'dana'))!.left_at).not.toBeNull();
      expect((await getMemberByName(db, team.id, 'scout'))!.account_status).toBe('disabled');
      expect((await cascadeRows(team.id)).map((r) => r.target)).toEqual(['scout']);
    });

    it("an agent's until is clamped to its sponsor's", async () => {
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\nlifecycle = "until"\nuntil = "2030-01-01T00:00:00.000Z"\n',
      });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await addMember(db, team, { name: 'scout', kind: 'agent', sponsoredBy: dana.id });
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\nlifecycle = "until"\nuntil = "2030-01-01T00:00:00.000Z"\n',
        scout: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
      });
      await reconcile();
      const scout = (await getMemberByName(db, team.id, 'scout'))!;
      expect(scout.lifecycle).toBe('until');
      expect(scout.lifecycle_until).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
    });

    it('export then reconcile is a fixed point for a team holding a sponsored agent', async () => {
      await writeRoster('slug = "alpha"\n', { dana: 'kind = "human"\nrole = ""\n' });
      await reconcile();
      const team = (await getTeamBySlug(db, 'alpha'))!;
      const dana = (await getMemberByName(db, team.id, 'dana'))!;
      await mintFact(team.id, 'dana', 'scout');
      await writeRoster('slug = "alpha"\n', {
        dana: 'kind = "human"\nrole = ""\n',
        scout: 'kind = "agent"\nrole = ""\nsponsored_by = "dana"\n',
      });
      await reconcile();
      const projected = (await projectTeamToFiles(db, 'alpha'))!;
      const { teamToml, seatFiles } = serializeProjectedTeam(projected);
      expect(seatFiles['scout.toml']).toMatch(/sponsored_by = "dana"/);
      await writeRoster(
        teamToml,
        Object.fromEntries(
          Object.entries(seatFiles).map(([f, body]) => [f.replace(/\.toml$/, ''), body]),
        ),
      );
      const r = await reconcile();
      expect(r.updated).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect((await getMemberByName(db, team.id, 'scout'))!.sponsored_by).toBe(dana.id);
    });
  });
});
