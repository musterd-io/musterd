import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness } from './integration.helpers.js';

withDrivers('integration · ws-supersede', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, pollUntil, post, standingGrant } = h;
  type TestWs = InstanceType<typeof TestWs>;

  describe('WebSocket', async () => {
    describe('a wake never displaces an attended session (ADR 444)', async () => {
      beforeEach(async () => {
        await h.server.close();
        process.env['MUSTERD_SUPERSEDE_GRACE_MS'] = '120';
        h.server = createServer({ db: await openTestDriver(kind), port: 0 });
        const { port } = await h.server.listen();
        h.base = `http://127.0.0.1:${port}`;
        h.wsUrl = `ws://127.0.0.1:${port}/ws`;
      });
      afterEach(() => {
        delete process.env['MUSTERD_SUPERSEDE_GRACE_MS'];
      });

      async function seatAda() {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');
        return { team, grant };
      }

      function claimFrame(
        agentKey: string,
        grant: string,
        workspace: string,
        provenance?: 'wake' | 'session',
      ) {
        return {
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: agentKey,
          target: { seat: 'Ada' },
          grant,
          surface: 'claude-code',
          workspace,
          ...(provenance ? { provenance } : {}),
        };
      }

      const refusals = async () =>
        (await listAudit(h.server.store, (await getTeamBySlug(h.server.store, 'dawn'))!.id)).filter(
          (r) => r.action === 'claim.refused',
        );

      it('refuses a same-workspace wake claim with claim_conflict and never reaps the attended session', async () => {
        const { team, grant } = await seatAda();
        const attended = new TestWs();
        await attended.open();
        attended.send(claimFrame(team.json.agent_key, grant, 'repo@main', 'session'));
        await attended.waitFor('occupied');

        const wake = new TestWs();
        await wake.open();
        wake.send(claimFrame(team.json.agent_key, grant, 'repo@main', 'wake'));
        expect(await wake.waitFor('refused')).toMatchObject({ code: 'claim_conflict' });

        // Well past the ADR 092 grace: the attended session is still the occupant.
        await expect(attended.waitFor('error', 400)).rejects.toThrow(/timeout/);
        const rows = await refusals();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.detail ?? '{}')).toMatchObject({
          code: 'claim_conflict',
          reason: 'attended_session',
        });
        attended.close();
        wake.close();
      });

      it('refuses a wake claim from another workspace, and one with no provenance is protected too', async () => {
        const { team, grant } = await seatAda();
        const attended = new TestWs();
        await attended.open();
        // An older adapter stamps nothing: absence is not `wake`, so it is protected.
        attended.send(claimFrame(team.json.agent_key, grant, 'repo@main'));
        await attended.waitFor('occupied');

        const wake = new TestWs();
        await wake.open();
        wake.send(claimFrame(team.json.agent_key, grant, 'other@main', 'wake'));
        expect(await wake.waitFor('refused')).toMatchObject({ code: 'claim_conflict' });
        await expect(attended.waitFor('error', 200)).rejects.toThrow(/timeout/);
        attended.close();
        wake.close();
      });

      it('refuses a wake HTTP claim with 409 claim_conflict and no side effects', async () => {
        const { team, grant } = await seatAda();
        const attended = new TestWs();
        await attended.open();
        attended.send(claimFrame(team.json.agent_key, grant, 'repo@main', 'session'));
        await attended.waitFor('occupied');

        const r = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(team.json.human_credential, 'Ada'),
          surface: 'cli',
          workspace: 'other@main',
          provenance: 'wake',
        });
        expect(r.status).toBe(409);
        expect(r.json).toMatchObject({ type: 'refused', code: 'claim_conflict' });
        await expect(attended.waitFor('error', 200)).rejects.toThrow(/timeout/);
        const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
        expect(
          (await listAudit(h.server.store, teamId)).some((a) => a.action === 'claim.superseded'),
        ).toBe(false);
        attended.close();
      });

      it('still lets an attended claim displace a wake, and a wake displace a wake', async () => {
        const { team, grant } = await seatAda();
        const wake1 = new TestWs();
        await wake1.open();
        wake1.send(claimFrame(team.json.agent_key, grant, 'repo@main', 'wake'));
        await wake1.waitFor('occupied');

        const wake2 = new TestWs();
        await wake2.open();
        wake2.send(claimFrame(team.json.agent_key, grant, 'other@main', 'wake'));
        await wake2.waitFor('occupied');
        expect(await wake1.waitFor('error')).toMatchObject({ code: 'superseded' });

        const attended = new TestWs();
        await attended.open();
        attended.send(claimFrame(team.json.agent_key, grant, 'repo@main', 'session'));
        await attended.waitFor('occupied');
        const taken = await wake2.waitFor('error');
        expect(taken).toMatchObject({ code: 'superseded' });
        // Lane 01M3TB3EY9: the loser is told WHAT took its seat, not only that something did.
        expect((taken as { message: string }).message).toMatch(/by a session on claude-code/);
        expect(await refusals()).toHaveLength(0);

        // Lane 01M3TB3EY9: the ledger row records both sides' provenance and how recently the
        // loser was active, so a wake landing on a live session is measurable from audit alone.
        const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
        const rows = (await listAudit(h.server.store, teamId))
          .filter((r) => r.action === 'claim.superseded')
          .map((r) => JSON.parse(String(r.detail)) as Record<string, unknown>);
        expect(rows).toHaveLength(2);
        const sessionOverWake = rows.find((r) => r['successor_provenance'] === 'session')!;
        const wakeOverWake = rows.find((r) => r['successor_provenance'] === 'wake')!;
        expect(sessionOverWake).toMatchObject({
          via: 'ws',
          successor_provenance: 'session',
          successor_surface: 'claude-code',
        });
        expect(sessionOverWake['displaced']).toEqual([
          expect.objectContaining({
            provenance: 'wake',
            surface: 'claude-code',
            workspace: 'other@main',
            last_active_ms: expect.any(Number),
          }),
        ]);
        expect(wakeOverWake).toMatchObject({ successor_provenance: 'wake' });
        wake1.close();
        wake2.close();
        attended.close();
      });
    });

    describe('durability-gated same-workspace eviction (ADR 092)', () => {
      // A short grace so the reap fires within a test's patience; the outer beforeEach already stood up a
      // default-grace server, so close it and stand up a short-grace one for these cases.
      const GRACE_MS = 120;
      // Receipt times carry a little jitter (two sockets, one event loop); never a whole grace.
      const RECEIPT_SLACK_MS = 30;
      /** Stand the server up again with `grace` (and optionally a wrapped driver). */
      async function restart(grace: number, db?: Driver): Promise<void> {
        await h.server.close();
        process.env['MUSTERD_SUPERSEDE_GRACE_MS'] = String(grace);
        h.server = createServer({ db: db ?? (await openTestDriver(kind)), port: 0 });
        const { port } = await h.server.listen();
        h.base = `http://127.0.0.1:${port}`;
        h.wsUrl = `ws://127.0.0.1:${port}/ws`;
      }
      beforeEach(async () => {
        await restart(GRACE_MS);
      });
      afterEach(() => {
        delete process.env['MUSTERD_SUPERSEDE_GRACE_MS'];
      });

      async function occupyAda(
        ws: TestWs,
        agentKey: string,
        grant: string,
        workspace: string,
        surface = 'claude-code',
      ) {
        ws.send({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: agentKey,
          target: { seat: 'Ada' },
          grant,
          surface,
          workspace,
        });
        expect((await ws.waitFor('occupied')).type).toBe('occupied');
      }

      it('a durable same-workspace CLI wait does NOT reap the live adapter — a different surface is not a reload (ADR 489)', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');

        const adapter = new TestWs();
        await adapter.open();
        await occupyAda(adapter, team.json.agent_key, grant, 'repo@main');

        // `musterd inbox --wait` from the same workspace: surface cli, and it stays past the grace.
        const wait = new TestWs();
        await wait.open();
        await occupyAda(wait, team.json.agent_key, grant, 'repo@main', 'cli');

        await expect(adapter.waitFor('error', 400)).rejects.toThrow(/timeout/);
        await expect(wait.waitFor('error', 50)).rejects.toThrow(/timeout/);
        const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
        expect(
          (await listAudit(h.server.store, teamId)).some(
            (r) => r.action === 'claim.duplicate_workspace' || r.action === 'claim.superseded',
          ),
        ).toBe(false);

        wait.close();
        adapter.close();
      });

      it('a durable same-workspace successor reaps its predecessor with same_workspace:true', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');

        const orphan = new TestWs();
        await orphan.open();
        await occupyAda(orphan, team.json.agent_key, grant, 'repo@main');

        // The reload successor: same workspace, and it STAYS connected past the grace.
        const successor = new TestWs();
        await successor.open();
        await occupyAda(successor, team.json.agent_key, grant, 'repo@main');

        // The orphan is reaped after the grace, and told same_workspace so its adapter exits.
        const superseded = await orphan.waitFor('error');
        expect((superseded as any).code).toBe('superseded');
        expect((superseded as any).same_workspace).toBe(true);

        // The duplicate was audited when the reap was armed (ADR 092 §C drift signal).
        const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
        expect(
          (await listAudit(h.server.store, teamId)).some(
            (r) => r.action === 'claim.duplicate_workspace',
          ),
        ).toBe(true);

        successor.close();
        orphan.close();
      });

      it('a transient same-workspace probe that disconnects within the grace does NOT reap the incumbent', async () => {
        // "Within the grace" has to hold on a loaded machine: the probe's close must reach the
        // server before the timer fires, and at 120 ms a starved test process could not promise
        // that (seen at load 23, PGlite, 2026-10-01) — so this case runs a grace a disconnect
        // comfortably beats, and watches past it. Production's grace is 10 s.
        const PROBE_GRACE_MS = 1_500;
        await restart(PROBE_GRACE_MS);
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');

        const live = new TestWs();
        await live.open();
        await occupyAda(live, team.json.agent_key, grant, 'repo@main');

        const probe = new TestWs();
        await probe.open();
        await occupyAda(probe, team.json.agent_key, grant, 'repo@main');
        probe.close(); // disconnects immediately, before the grace elapses — as a health check does

        // The live session is never superseded: the successor is gone before the reap fires (ADR 068 held).
        await expect(live.waitFor('error', PROBE_GRACE_MS + 500)).rejects.toThrow(/timeout/);

        live.close();
      });

      /**
       * The driver with reads matching `re` slowed by `delay.ms` (0 = off) — every handle derived
       * from it too, so the server's team-scoped and operator views are all slowed alike. Stands in
       * for a slow database (Postgres under load) without depending on the machine being slow.
       */
      function slowReads(d: Driver, re: RegExp, delay: { ms: number }): Driver {
        const slow = async () => {
          if (delay.ms > 0) await new Promise((r) => setTimeout(r, delay.ms));
        };
        const wrap = (h: Driver): Driver => ({
          ...(h.dialect === 'sqlite' ? { raw: (h as SqliteDriver).raw } : {}),
          dialect: h.dialect,
          get: async (sql, params) => {
            if (re.test(sql)) await slow();
            return h.get(sql, params);
          },
          all: async (sql, params) => {
            if (re.test(sql)) await slow();
            return h.all(sql, params);
          },
          run: (sql, params) => h.run(sql, params),
          exec: (sql) => h.exec(sql),
          tx: (fn) => h.tx((t) => fn(wrap(t))),
          connection: () => wrap(h.connection()),
          forTeam: (team) => wrap(h.forTeam(team)),
          asOperator: () => wrap(h.asOperator()),
          close: () => h.close(),
        });
        return wrap(d);
      }

      it('the grace of an approved pending claim runs from `occupied`, even when its frame is slow to build', async () => {
        // ADR 092: the successor proves durable by staying attached for the grace AFTER it is told
        // it is occupied. The approve path built that frame (role charter + seat memory reads) AFTER
        // arming the reap, so a slow database spent the grace before `occupied` was even sent.
        const delay = { ms: 0 };
        await restart(
          GRACE_MS,
          slowReads(await openTestDriver(kind), /FROM (roles|seat_memory)\b/, delay),
        );
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');
        const incumbent = new TestWs();
        await incumbent.open();
        await occupyAda(incumbent, team.json.agent_key, grant, 'repo@main');
        const challenger = new TestWs();
        await challenger.open();
        challenger.send({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          surface: 'claude-code',
          workspace: 'repo@main',
        });
        const pending = await challenger.waitFor('pending');

        delay.ms = 2 * GRACE_MS; // each of the frame's two reads alone outlasts the grace
        const decided = await post(
          `/teams/dawn/requests/${pending.request_id}/decide`,
          { decision: 'approve', lifetime: 'standing' },
          team.json.human_credential,
        );
        expect(decided.status).toBe(200);
        const occupied = await challenger.waitFor('occupied');
        const superseded = await incumbent.waitFor('error');
        delay.ms = 0;
        expect(superseded).toMatchObject({ code: 'superseded', same_workspace: true });
        expect(
          incumbent.receivedAt(superseded) - challenger.receivedAt(occupied),
        ).toBeGreaterThanOrEqual(GRACE_MS - RECEIPT_SLACK_MS);

        incumbent.close();
        challenger.close();
      });

      it('an approved same-workspace pending claim reaps only after the grace', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');

        const incumbent = new TestWs();
        await incumbent.open();
        await occupyAda(incumbent, team.json.agent_key, grant, 'repo@main');

        const challenger = new TestWs();
        await challenger.open();
        challenger.send({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          surface: 'claude-code',
          workspace: 'repo@main',
        });
        const pending = await challenger.waitFor('pending');

        const decided = await post(
          `/teams/dawn/requests/${pending.request_id}/decide`,
          { decision: 'approve', lifetime: 'standing' },
          team.json.human_credential,
        );
        expect(decided.status).toBe(200);
        const occupied = await challenger.waitFor('occupied');
        const superseded = await incumbent.waitFor('error');
        expect(superseded).toMatchObject({ code: 'superseded', same_workspace: true });
        // "Not yet" is a claim about the gap BETWEEN the two frames, so it is measured there — on
        // both drivers. (A wall-clock wait that starts after the test sees `occupied` raced the
        // grace on the PGlite double under CI load: main, 2026-10-01, run 36820631249.)
        expect(
          incumbent.receivedAt(superseded) - challenger.receivedAt(occupied),
        ).toBeGreaterThanOrEqual(GRACE_MS - RECEIPT_SLACK_MS);

        incumbent.close();
        challenger.close();
      });

      it('preserves the Workspace on an approved pending claim for its next reconnect', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );
        const grant = await standingGrant(team.json.human_credential, 'Ada');

        const incumbent = new TestWs();
        await incumbent.open();
        await occupyAda(incumbent, team.json.agent_key, grant, 'repo@main');

        const approved = new TestWs();
        await approved.open();
        approved.send({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          surface: 'claude-code',
          workspace: 'repo@main',
        });
        const pending = await approved.waitFor('pending');
        await post(
          `/teams/dawn/requests/${pending.request_id}/decide`,
          { decision: 'approve', lifetime: 'standing' },
          team.json.human_credential,
        );
        expect((await approved.waitFor('occupied')).type).toBe('occupied');

        const reconnect = new TestWs();
        await reconnect.open();
        await occupyAda(reconnect, team.json.agent_key, grant, 'repo@main');
        // The "not yet" half is a 50 ms race against the grace timer; the slower double can have
        // the grace elapse before the wait starts, so it is asserted on SQLite only.
        if (kind === 'sqlite')
          await expect(approved.waitFor('error', 50)).rejects.toThrow(/timeout/);
        expect(await approved.waitFor('error', 1000)).toMatchObject({
          code: 'superseded',
          same_workspace: true,
        });

        incumbent.close();
        approved.close();
        reconnect.close();
      });
    });

    it('a human seat fans out: two concurrent sessions both stay live, neither superseded (ADR 042)', async () => {
      // The team creator (nick) is a human seat.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;

      const phone = new TestWs();
      const laptop = new TestWs();
      await Promise.all([phone.open(), laptop.open()]);
      const w1 = await phone.claim('dawn', nickTok, 'nick', 'cli');
      const w2 = await laptop.claim('dawn', nickTok, 'nick', 'claude-code');
      expect(w1.type).toBe('occupied');
      expect(w2.type).toBe('occupied');

      // Neither human session is displaced — give a superseded frame a chance to arrive, then assert none did.
      await new Promise((r) => setTimeout(r, 50));
      expect(phone.frames.some((f) => f.type === 'error')).toBe(false);
      expect(laptop.frames.some((f) => f.type === 'error')).toBe(false);

      // Both presences are live; the roster collapses them to ONE member row carrying both surfaces.
      const roster = await get('/teams/dawn/members', nickTok);
      const nickRow = roster.json.members.find((m: any) => m.name === 'nick');
      expect(nickRow.activity).not.toBe('offline');
      expect(nickRow.presences).toHaveLength(2);
      expect(nickRow.presences.map((p: any) => p.surface).sort()).toEqual(['claude-code', 'cli']);
      expect(roster.json.members.filter((m: any) => m.name === 'nick')).toHaveLength(1);

      phone.close();
      laptop.close();
    });

    it('delivers a directed message AND a @team broadcast to BOTH of a human’s sessions (ADR 042)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // nick holds two live sessions; Ada is the sender.
      const phone = new TestWs();
      const laptop = new TestWs();
      const a = new TestWs();
      await Promise.all([phone.open(), laptop.open(), a.open()]);
      await phone.claim('dawn', nickTok, 'nick', 'cli');
      await laptop.claim('dawn', nickTok, 'nick', 'claude-code');
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      // Directed message to nick → both of nick's sessions receive the deliver.
      a.send({
        type: 'send',
        envelope: {
          id: 'mp1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'nick' },
          act: 'message',
          body: 'direct',
          ts: Date.now(),
        },
      });
      const d1 = await phone.waitFor('deliver');
      const d2 = await laptop.waitFor('deliver');
      expect((d1 as any).envelope.id).toBe('mp1');
      expect((d2 as any).envelope.id).toBe('mp1');

      // @team broadcast → both of nick's sessions receive it too.
      a.send({
        type: 'send',
        envelope: {
          id: 'mp2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'message',
          body: 'broadcast',
          ts: Date.now(),
        },
      });
      await pollUntil(
        () =>
          phone.frames.some((f) => f.type === 'deliver' && (f as any).envelope.id === 'mp2') &&
          laptop.frames.some((f) => f.type === 'deliver' && (f as any).envelope.id === 'mp2'),
      );

      phone.close();
      laptop.close();
      a.close();
    });

    it('reclaim drops a member’s live session and frees the seat (ADR 017 follow-up)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const a = new TestWs();
      await a.open();
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      const r = await post('/teams/dawn/members/Ada/reclaim', {}, nickTok);
      expect(r.status).toBe(200);
      expect(r.json.member).toBe('Ada');

      // The live session is told it was superseded ...
      const superseded = await a.waitFor('error');
      expect((superseded as any).code).toBe('superseded');
      // ... and the seat is freed (Ada reads offline on the roster).
      const roster = await get('/teams/dawn/members', nickTok);
      expect(roster.json.members.find((m: any) => m.name === 'Ada').activity).toBe('offline');

      // Reclaiming an unknown member is a 404.
      const miss = await post('/teams/dawn/members/Ghost/reclaim', {}, nickTok);
      expect(miss.status).toBe(404);

      a.close();
    });

    it('unbind releases the caller’s own seat: drops its session + presence, keeps it on the roster (ADR 058)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const a = new TestWs();
      await a.open();
      const occupied = (await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      )) as any;

      // Ada unbinds herself with her *own* token (self-only — no target name).
      const r = await post(
        '/teams/dawn/unbind',
        {},
        {
          key: occupied.seat_credential,
          seat: 'Ada',
          sessionLease: occupied.session_lease,
        },
      );
      expect(r.status).toBe(200);
      expect(r.json.member).toBe('Ada');

      // Her live session is dropped and she reads offline …
      await pollUntil(async () => {
        const roster = await get('/teams/dawn/members', nickTok);
        return roster.json.members.find((m: any) => m.name === 'Ada')?.activity === 'offline';
      });
      // … but the seat is still on the team (declared, not removed) and re-claimable by adoption.
      const roster = await get('/teams/dawn/members', nickTok);
      expect(roster.json.members.some((m: any) => m.name === 'Ada')).toBe(true);

      // The deliberate exit is stamped as seat_released, not crash clothing (presence-honesty §2.3).
      expect(roster.json.members.find((m: any) => m.name === 'Ada').offline_reason).toBe(
        'seat_released',
      );

      // Unbind requires a valid token (self-only); an anonymous call is unauthorized.
      const anon = await post('/teams/dawn/unbind', {}, undefined);
      expect(anon.status).toBe(401);

      a.close();
    });

    it('remove soft-deletes a member, drops its live session, and is idempotent (ADR 019)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const a = new TestWs();
      await a.open();
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      const r = await post('/teams/dawn/members/Ada/remove', {}, nickTok);
      expect(r.status).toBe(200);
      expect(r.json.member).toBe('Ada');
      expect(r.json.kind).toBe('agent');

      // The live session is told it was superseded (the seat is freed) ...
      const superseded = await a.waitFor('error');
      expect((superseded as any).code).toBe('superseded');
      // ... and Ada is gone from the roster entirely (left_at filters her out).
      const roster = await get('/teams/dawn/members', nickTok);
      expect(roster.json.members.find((m: any) => m.name === 'Ada')).toBeUndefined();

      // Idempotent: a second remove (now left_at-stamped) and an unknown member both 404.
      const again = await post('/teams/dawn/members/Ada/remove', {}, nickTok);
      expect(again.status).toBe(404);
      const miss = await post('/teams/dawn/members/Ghost/remove', {}, nickTok);
      expect(miss.status).toBe(404);

      a.close();
    });

    it('lets the same member reclaim its presence after disconnecting (within grace)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // nick stays present so we can observe Ada's offline event after she drops.
      const n = new TestWs();
      await n.open();
      await n.claim('dawn', nickTok, 'nick', 'cli');

      const a1 = new TestWs();
      await a1.open();
      await a1.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );
      a1.close();

      // Wait until the server has processed the close (released the hold + emitted offline).
      await pollUntil(() =>
        n.frames.some(
          (f) =>
            f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'offline',
        ),
      );

      const a2 = new TestWs();
      await a2.open();
      const occupied = await a2.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'cli',
        await standingGrant(team.json.human_credential, 'Ada'),
      );
      expect(occupied.type).toBe('occupied');

      n.close();
      a2.close();
    });

    it('rejects a claim whose credential does not match the target seat', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, team.json.human_credential);
      const w = new TestWs();
      await w.open();
      // nick's credential self-identifies as nick — it cannot occupy someone else's seat (Lin).
      w.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.human_credential,
        target: { seat: 'Lin' },
        surface: 'cli',
      });
      const err = await w.waitFor('refused');
      expect((err as any).code).toBe('forbidden');
      w.close();
    });
  });
});
