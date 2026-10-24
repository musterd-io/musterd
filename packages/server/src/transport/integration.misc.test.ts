import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERALIST_CAPABILITIES, PROTOCOL_VERSION, SEALED_NOTE_HEADLINE } from '@musterd/protocol';
import { generateNoteKey, openNote, sealNote } from '@musterd/protocol/note-seal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { listAudit } from '../store/audit.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

withDrivers('integration · misc', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, authHeaders, get, pollUntil, post, req, standingGrant } = h;

  describe('declared Goals + next_goal (ADR 048/084)', () => {
    it('declares Goals over HTTP, derives status from lanes, and surfaces the next one in the brief', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // Two Goals: 'engine', and 'surface' which depends on it.
      const g1 = await post(
        '/teams/dawn/goals',
        { id: 'engine', title: 'Insight engine' },
        nickTok,
      );
      expect(g1.status).toBe(201);
      expect(g1.json.goal.status).toBe('planned');
      await post(
        '/teams/dawn/goals',
        { id: 'surface', title: 'CLI surface', depends_on: ['engine'] },
        nickTok,
      );

      // GET /goals lists both, newest-declaration-per-id, with derived status.
      const goals = await get('/teams/dawn/goals', ada);
      expect(goals.json.goals.map((g: { id: string }) => g.id).sort()).toEqual([
        'engine',
        'surface',
      ]);

      // next_goal = engine — 'surface' is newer but blocked on it (deps outrank recency, ADR 257).
      let brief = await get('/teams/dawn/next', ada);
      expect(brief.json.next_goal.id).toBe('engine');

      // Ada opens + resolves a lane on 'engine' → engine ships → next_goal advances to 'surface'.
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'build engine', goal_id: 'engine', claim: true },
        ada,
      );
      await fetch(h.base + `/teams/dawn/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'done' }),
      });

      const engineNow = (await get('/teams/dawn/goals', ada)).json.goals.find(
        (g: { id: string }) => g.id === 'engine',
      );
      expect(engineNow.status).toBe('shipped');
      brief = await get('/teams/dawn/next', ada);
      expect(brief.json.next_goal.id).toBe('surface');
    });
  });

  describe('insight report (ADR 050/084)', () => {
    it('GET /report projects flow metrics, waiting-on, goals, and blocked lanes', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // A shipped lane (throughput + goal status) and a blocked lane (the exception).
      await post('/teams/dawn/goals', { id: 'engine', title: 'Engine' }, nickTok);
      const shipped = await post(
        '/teams/dawn/lanes',
        { title: 'built', goal_id: 'engine', claim: true },
        ada,
      );
      await fetch(h.base + `/teams/dawn/lanes/${shipped.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'done' }),
      });
      const stuck = await post('/teams/dawn/lanes', { title: 'stuck work', claim: true }, ada);
      await fetch(h.base + `/teams/dawn/lanes/${stuck.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'blocked' }),
      });

      // nick directs a request_help at Ada → Ada owes → waiting-on Ada.
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'rh1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'Ada' },
            act: 'request_help',
            body: 'need a hand',
            ts: Date.now() - 60_000,
          },
        },
        nickTok,
      );

      const report = await get('/teams/dawn/report', ada);
      expect(report.status).toBe(200);
      expect(report.json.team).toBe('dawn');
      expect(report.json.flow.throughput_7d).toBe(1);
      expect(report.json.flow.wip).toBe(1); // the blocked lane contends
      expect(report.json.goals.find((g: { id: string }) => g.id === 'engine').status).toBe(
        'shipped',
      );
      expect(report.json.blocked.map((b: { id: string }) => b.id)).toEqual([stuck.json.lane.id]);
      expect(report.json.waiting_on).toEqual([
        expect.objectContaining({ member: 'Ada', threads: 1 }),
      ]);
      // Coordination-density is present; a tiny sample never flags.
      expect(report.json.coordination).toMatchObject({ window_days: 7, flag: false });
    });
  });

  describe('seat memory endpoints + occupy envelope (ADR 093)', () => {
    async function dawn() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      const ada: Auth = { key: team.json.agent_key as string, seat: 'Ada' };
      return { team, nickTok, ada };
    }

    it('PUT saves for the authenticated seat; GET returns the body; DELETE clears', async () => {
      const { ada } = await dawn();
      const put = await req(
        'PUT',
        '/teams/dawn/memory',
        { headline: 'mid-refactor', body: 'ws.ts' },
        ada,
      );
      expect(put.status).toBe(204);

      const got = await get('/teams/dawn/memory', ada);
      expect(got.status).toBe(200);
      expect(got.json).toMatchObject({ headline: 'mid-refactor', body: 'ws.ts' });
      expect(typeof got.json.saved_at).toBe('number');

      const del = await req('DELETE', '/teams/dawn/memory', undefined, ada);
      expect(del.status).toBe(204);
      expect((await get('/teams/dawn/memory', ada)).status).toBe(404);
      // idempotent — a second DELETE still 204s
      expect((await req('DELETE', '/teams/dawn/memory', undefined, ada)).status).toBe(204);
    });

    it("GET /memory is self-scoped: it reads the caller's own seat, admin included (cross-seat reads are ADR 651's route)", async () => {
      const { nickTok, ada } = await dawn();
      await req('PUT', '/teams/dawn/memory', { headline: "ada's note", body: 'secret' }, ada);

      // nick (an admin/human) hitting /memory reads NICK's own memory (none) — never Ada's. There is no
      // URL that names another seat, so the note cannot leak across seats (ADR 093 §4).
      const asAdmin = await get('/teams/dawn/memory', nickTok);
      expect(asAdmin.status).toBe(404);

      // and Ada still sees her own
      expect((await get('/teams/dawn/memory', ada)).json.body).toBe('secret');
    });

    // ADR 651 (nick 2026-10-17): humans see everything except another human's personal stuff.
    it("who reads a note: any human reads an agent seat's note; a human seat's note is its owner's alone; no agent reads another's", async () => {
      const { nickTok, ada, team } = await dawn();
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
      const lin: Auth = { key: team.json.agent_key as string, seat: 'Lin' };
      const bo = await post('/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential as string;
      await req('PUT', '/teams/dawn/memory', { headline: 'ada plan', body: 'agent note' }, ada);
      // Bo is a human seat: his note is sealed to his machine before it is saved (ADR 657).
      const boKey = generateNoteKey();
      const boSealed = sealNote({ headline: 'bo private', body: 'human note' }, [
        { node: 'n-bo', pk: boKey.public_key },
      ]);
      await req(
        'PUT',
        '/teams/dawn/memory',
        { headline: SEALED_NOTE_HEADLINE, body: boSealed },
        boTok,
      );

      // Any human reads an agent seat's note — admin or not.
      const nickReadsAda = await get('/teams/dawn/members/Ada/memory', nickTok);
      expect(nickReadsAda.status).toBe(200);
      expect(nickReadsAda.json).toMatchObject({ member: 'Ada', body: 'agent note' });
      expect((await get('/teams/dawn/members/Ada/memory', boTok)).json.body).toBe('agent note');
      // A human seat's note: another human (here the admin) is refused, the owner is not.
      expect((await get('/teams/dawn/members/Bo/memory', nickTok)).status).toBe(403);
      const boOwn = (await get('/teams/dawn/members/Bo/memory', boTok)).json.body as string;
      expect(openNote(boOwn, boKey)?.body).toBe('human note');
      // No agent reads another seat's note through this route.
      expect((await get('/teams/dawn/members/Ada/memory', lin)).status).toBe(403);
      expect((await get('/teams/dawn/members/Bo/memory', ada)).status).toBe(403);

      // /audit (human admins only) applies the same rule to the replicated rows.
      const audit = await get('/teams/dawn/audit', nickTok);
      const saved = (audit.json.audit as { action: string; target: string; detail: any }[]).filter(
        (r) => r.action === 'continuity.memory_saved',
      );
      expect(saved.find((r) => r.target === 'Ada')!.detail).toMatchObject({ body: 'agent note' });
      const boRow = saved.find((r) => r.target === 'Bo')!.detail;
      expect(boRow).not.toHaveProperty('body');
      expect(boRow).not.toHaveProperty('headline');
      expect(boRow).toMatchObject({
        headline_len: SEALED_NOTE_HEADLINE.length,
        body_len: Buffer.byteLength(boSealed),
      });
      // The stored row is untouched — it is the replicated event (ADR 366).
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const stored = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'continuity.memory_saved' && r.target === 'Bo',
      )!;
      expect(JSON.parse(stored.detail!)).toMatchObject({ body: boSealed });
    });

    it('GET ?envelope=1 returns headline + age + size, never the body (the status one-liner read)', async () => {
      const { ada } = await dawn();
      // Nothing saved → same 404 as the body read.
      expect((await get('/teams/dawn/memory?envelope=1', ada)).status).toBe(404);

      await req('PUT', '/teams/dawn/memory', { headline: 'mid-refactor', body: '€€' }, ada);
      const env = await get('/teams/dawn/memory?envelope=1', ada);
      expect(env.status).toBe(200);
      expect(env.json).toEqual({
        headline: 'mid-refactor',
        saved_at: expect.any(Number),
        size_bytes: 6, // '€€' = 6 UTF-8 bytes
        provenance: expect.objectContaining({ suspect: false }), // ADR 654
      });
      expect(env.json.body).toBeUndefined();
    });

    it('a note says who saved it (ADR 654): the save stamps its place, the read and the replicated row carry it', async () => {
      const { nickTok, ada } = await dawn();
      await req('PUT', '/teams/dawn/memory', { headline: 'stamped', body: 'b' }, ada);
      const own = await get('/teams/dawn/memory', ada);
      expect(own.status).toBe(200);
      expect(own.json).not.toHaveProperty('writer');
      const prov = own.json.provenance as { writer: any; suspect: boolean; line: string };
      expect(prov.suspect).toBe(false);
      expect(prov.writer).toMatchObject({ node: expect.any(String) });
      expect(prov.line).toMatch(/^last saved from /);
      // A human reading the agent seat's note gets the fact, never a verdict.
      const human = await get('/teams/dawn/members/Ada/memory', nickTok);
      expect(human.json.provenance).toMatchObject({ suspect: false, writer: prov.writer });
      // The replicated row carries the stamp, so a peer folding it knows who saved it.
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const stored = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'continuity.memory_saved' && r.target === 'Ada',
      )!;
      expect(JSON.parse(stored.detail!).writer).toEqual(prov.writer);
    });

    it('banned = inert: a disabled seat cannot read, write, or clear its memory (defense-in-depth)', async () => {
      const { ada } = await dawn();
      await req('PUT', '/teams/dawn/memory', { headline: 'before', body: 'note' }, ada);

      const setStatus = async (status: string | null) => {
        const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
        const m = (await getMemberByName(h.server.store, teamRow.id, 'Ada'))!;
        await setMemberGovernance(
          h.server.store,
          m.id,
          status,
          JSON.stringify(GENERALIST_CAPABILITIES),
        );
      };
      await setStatus('disabled');
      expect((await get('/teams/dawn/memory', ada)).status).toBe(403);
      expect((await get('/teams/dawn/memory?envelope=1', ada)).status).toBe(403);
      expect((await req('PUT', '/teams/dawn/memory', { headline: 'after' }, ada)).status).toBe(403);
      expect((await req('DELETE', '/teams/dawn/memory', undefined, ada)).status).toBe(403);

      // Re-enabling restores access and the note survived untouched.
      await setStatus('active');
      expect((await get('/teams/dawn/memory', ada)).json.headline).toBe('before');
    });

    it('an occupied frame (WS claim) carries the envelope when memory exists, null when not', async () => {
      const { team, nickTok, ada } = await dawn();

      // First claim with no saved memory → occupied.memory is null.
      const w1 = new TestWs();
      await w1.open();
      const occ1 = (await w1.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'cli',
        await standingGrant(nickTok, 'Ada'),
      )) as any;
      expect(occ1.memory).toBeNull();
      w1.close();
      await w1.closed();

      // Reclaim first: closing w1 revoked its Presence-bound lease. The new claim mints a lease that
      // authorizes the memory save, and the following claim must carry the saved envelope.
      Object.assign(ada as Exclude<Auth, string>, {
        key: occ1.seat_credential,
        sessionLease: occ1.session_lease,
      });
      const w2 = new TestWs();
      await w2.open();
      const occ2 = (await w2.claim(
        'dawn',
        (ada as Exclude<Auth, string>).key,
        'Ada',
        'cli',
      )) as any;
      Object.assign(ada as Exclude<Auth, string>, {
        key: occ2.seat_credential ?? (ada as Exclude<Auth, string>).key,
        sessionLease: occ2.session_lease,
      });
      const saved = await req(
        'PUT',
        '/teams/dawn/memory',
        { headline: 'left off at eviction', body: '€€' },
        ada,
      );
      expect(saved.status).toBe(204);
      const w3 = new TestWs();
      await w3.open();
      const occ3 = (await w3.claim(
        'dawn',
        (ada as Exclude<Auth, string>).key,
        'Ada',
        'cli',
      )) as any;
      expect(occ3.memory).toEqual({
        headline: 'left off at eviction',
        saved_at: expect.any(Number),
        size_bytes: 6, // '€€' = 6 UTF-8 bytes
      });
      w2.close();
      expect(occ3.memory.body).toBeUndefined();
      w3.close();
    });

    it('oversize body → 400 naming the 8192 limit; missing headline → 400', async () => {
      const { ada } = await dawn();
      const big = await req(
        'PUT',
        '/teams/dawn/memory',
        { headline: 'h', body: 'x'.repeat(8193) },
        ada,
      );
      expect(big.status).toBe(400);
      expect(big.json.error.message).toContain('8192');

      const noHeadline = await req('PUT', '/teams/dawn/memory', { body: 'x' }, ada);
      expect(noHeadline.status).toBe(400);
    });

    it('a save writes ONE stamped continuity.memory_saved row that carries the note (ADR 366 overturns ADR 093 hard rule 5)', async () => {
      // Until ADR 366 this test asserted the opposite — `memory.save` with sizes only, never the
      // text. That rule was overturned by decision (nick, 2026-09-03): a headline is not continuity,
      // and a human on a second machine (ADR 358) needs the note itself, so the replicated row IS the
      // note. Daemon-side only, never git; bounded by the 8 KiB cap. The old verbs write nothing now.
      const { ada } = await dawn();
      await req(
        'PUT',
        '/teams/dawn/memory',
        { headline: 'sensitive subject', body: 'PASSWORD=hunter2' },
        ada,
      );

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      expect(
        (await listAudit(h.server.store, teamId)).filter((r) => r.action === 'memory.save'),
      ).toHaveLength(0);
      const rows = (await listAudit(h.server.store, teamId)).filter(
        (r) => r.action === 'continuity.memory_saved',
      );
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail!);
      expect(detail).toMatchObject({ headline: 'sensitive subject', body: 'PASSWORD=hunter2' });
      expect(typeof detail.saved_at).toBe('number');
      // Stamped for replication — the whole point of carrying the body.
      expect(rows[0]!.origin_seq).toBeGreaterThan(0);

      await req('DELETE', '/teams/dawn/memory', undefined, ada);
      expect(
        (await listAudit(h.server.store, teamId)).filter((r) => r.action === 'memory.clear'),
      ).toHaveLength(0);
      const clears = (await listAudit(h.server.store, teamId)).filter(
        (r) => r.action === 'continuity.memory_cleared',
      );
      expect(clears).toHaveLength(1);
      expect(JSON.parse(clears[0]!.detail!)).toMatchObject({ had_memory: true });
    });
  });

  /**
   * Lane 01M52Z987280: the broadcast's last words. The stream posts its exit reason before the
   * machine's teardown can take it; the row outlives the machine. The writer is the stream's own
   * observer seat (read-only for SPEECH — this is an audit artifact, not an act), the reader any
   * readable seat (the streamwatch service seat, or an operator).
   */
  /** Lane 01M5GDACC0: a queued `stream stop`'s deadline, read by /broadcast's wind-down card. */
  describe('stream wind-down (lane 01M5GDACC0)', () => {
    it('the newest row is the answer: a deadline, then a cancel', async () => {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      const stream = await post(
        '/teams/dusk/members',
        { name: 'broadcast-t1', kind: 'human', observer: true, observer_scope: 'broadcast' },
        nickTok,
      );
      const streamTok = stream.json.human_credential as string;

      expect((await get('/teams/dusk/stream/winddown', streamTok)).json).toEqual({ stop_at: null });
      const stopAt = 1_787_001_800_000;
      expect((await post('/teams/dusk/stream/winddown', { stop_at: stopAt }, nickTok)).status).toBe(
        202,
      );
      expect((await get('/teams/dusk/stream/winddown', streamTok)).json).toEqual({
        stop_at: stopAt,
      });
      await post('/teams/dusk/stream/winddown', { stop_at: null }, nickTok);
      expect((await get('/teams/dusk/stream/winddown', streamTok)).json).toEqual({ stop_at: null });
      expect((await post('/teams/dusk/stream/winddown', { stop_at: 'soon' }, nickTok)).status).toBe(
        400,
      );
    });
  });

  describe('stream epitaph (lane 01M52Z987280)', () => {
    async function seed() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      const stream = await post(
        '/teams/dawn/members',
        { name: 'broadcast-t1', kind: 'human', observer: true, observer_scope: 'broadcast' },
        nickTok,
      );
      return { nickTok, streamTok: stream.json.human_credential as string };
    }

    it('an observer seat posts its epitaph and any readable seat reads it back', async () => {
      const t = await seed();
      const res = await post(
        '/teams/dawn/stream/epitaph',
        { reason: 'ffmpeg ended (code 1) — the sink dropped', code: 75, ran_ms: 1_477_000 },
        t.streamTok,
      );
      expect(res.status, JSON.stringify(res.json)).toBe(202);

      // The row is the audit record: actor is the observer seat, detail carries the exit.
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const rows = (await listAudit(h.server.store, teamId)).filter(
        (r) => r.action === 'stream.exit',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('broadcast-t1');
      expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
        reason: 'ffmpeg ended (code 1) — the sink dropped',
        code: 75,
        ran_ms: 1_477_000,
      });

      // Read back as an ordinary member — the streamwatch/operator path — newest first. (A
      // human credential here: an agent seat's GET would need its ADR 337 session lease, which
      // this route deliberately does not special-case.)
      const view = await get('/teams/dawn/stream/epitaph', t.nickTok);
      expect(view.status).toBe(200);
      expect(view.json.epitaphs).toHaveLength(1);
      expect(view.json.epitaphs[0]).toMatchObject({
        seat: 'broadcast-t1',
        code: 75,
        reason: 'ffmpeg ended (code 1) — the sink dropped',
      });
      // The observer seat itself can read too — it is a readable seat like any other.
      const self = await get('/teams/dawn/stream/epitaph', t.streamTok);
      expect(self.status).toBe(200);
    });

    it('returns the newest few with ?limit, newest first', async () => {
      const t = await seed();
      await post(
        '/teams/dawn/stream/epitaph',
        { reason: 'first', code: 1, ran_ms: 10 },
        t.streamTok,
      );
      await post(
        '/teams/dawn/stream/epitaph',
        { reason: 'second', code: 75, ran_ms: 20 },
        t.streamTok,
      );
      const view = await get('/teams/dawn/stream/epitaph?limit=2', t.nickTok);
      expect(view.json.epitaphs.map((e: { reason: string }) => e.reason)).toEqual([
        'second',
        'first',
      ]);
    });

    it('refuses a malformed body and the unauthenticated', async () => {
      const t = await seed();
      const bad = await post(
        '/teams/dawn/stream/epitaph',
        { reason: '', code: 1, ran_ms: 10 },
        t.streamTok,
      );
      expect(bad.status).toBe(400);
      const noAuth = await post('/teams/dawn/stream/epitaph', {
        reason: 'x',
        code: 1,
        ran_ms: 10,
      });
      expect(noAuth.status).toBe(401);
      const noRow = await get('/teams/dawn/stream/epitaph', t.nickTok);
      expect(noRow.json.epitaphs).toHaveLength(0);
    });
  });

  /**
   * Seat provisioning is localhost-trust — and now actually enforces it.
   *
   * `POST /members` mints a seat and returns its secret, and an `{observer:true}` seat reads every
   * directed message on the team (GET /messages and the firehose both exempt observers, ADR 128). The
   * route always *described* itself as localhost-trust but never checked the peer, so on an ADR 040
   * off-loopback bind anyone who could reach the port could mint a DM-reading credential.
   *
   * These tests bind on loopback (so the peer really is 127.0.0.1) and flip `trustProxy` to model the
   * off-loopback deployment: with a proxy in front, the peer address stops being evidence of anything,
   * which is exactly the case a naive `remoteAddress === '127.0.0.1'` check would get catastrophically
   * wrong.
   */
  describe('provisioning is localhost-trust, enforced (observer DM disclosure)', () => {
    let proxied: RunningServer;
    let pbase: string;

    beforeEach(async () => {
      proxied = createServer({ db: await openTestDriver(kind), port: 0, trustProxy: true });
      const { port } = await proxied.listen();
      pbase = `http://127.0.0.1:${port}`;
    });
    afterEach(async () => {
      await proxied.close();
    });

    async function ppost(path: string, body: unknown, auth?: string) {
      const res = await fetch(pbase + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
    }

    it('refuses to mint an observer for an unauthenticated non-local caller', async () => {
      await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });

      const res = await ppost('/teams/dawn/members', {
        name: 'watcher',
        kind: 'human',
        observer: true,
      });

      expect(res.status).toBe(401);
      // The refusal has to explain *where they are*, not just "unauthorized" — the caller is a browser.
      expect(res.json.error.message).toMatch(/directed messages|admin credential/i);
    });

    it('refuses an ordinary seat too — the mint itself is the privilege', async () => {
      await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const res = await ppost('/teams/dawn/members', { name: 'Ada', kind: 'agent' });
      expect(res.status).toBe(401);
    });

    it('an admin credential still provisions from anywhere', async () => {
      const team = await ppost('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      const nickTok = team.json.human_credential as string;
      expect(team.json.member.capabilities.is_admin).toBe(true);

      const res = await ppost(
        '/teams/dawn/members',
        { name: 'watcher', kind: 'human', observer: true },
        nickTok,
      );
      expect(res.status).toBe(201);
      expect(res.json.human_credential).toMatch(/^mscr_/);
    });

    it('a non-admin seat cannot mint — no privilege laundering through an ordinary credential', async () => {
      const team = await ppost('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      const nickTok = team.json.human_credential as string;
      const ada = await ppost('/teams/dawn/members', { name: 'Ada', kind: 'human' }, nickTok);
      const adaTok = ada.json.human_credential as string;

      const res = await ppost(
        '/teams/dawn/members',
        { name: 'watcher', kind: 'human', observer: true },
        adaTok,
      );
      expect(res.status).toBe(403);
    });

    it('loopback trust provisions agent seats, while human credentials require an admin', async () => {
      const team = await post('/teams', {
        slug: 'dusk',
        creator: { name: 'nick', kind: 'human' },
      });

      const agent = await post('/teams/dusk/members', { name: 'worker', kind: 'agent' });
      expect(agent.status).toBe(201);
      expect(agent.json.human_credential).toBeUndefined();

      const refusedHuman = await post('/teams/dusk/members', {
        name: 'web-1',
        kind: 'human',
        observer: true,
      });
      expect(refusedHuman.status).toBe(401);
      expect(refusedHuman.json.human_credential).toBeUndefined();

      const refusedObserverAgent = await post('/teams/dusk/members', {
        name: 'observer-agent',
        kind: 'agent',
        observer: true,
      });
      expect(refusedObserverAgent.status).toBe(401);
      expect(refusedObserverAgent.json.token).toBeUndefined();

      const human = await post(
        '/teams/dusk/members',
        { name: 'web-1', kind: 'human', observer: true },
        team.json.human_credential,
      );
      expect(human.status).toBe(201);
      expect(human.json.human_credential).toMatch(/^mscr_/);
    });

    it('local agent provisioning cannot add or demote a human admin through roster reconciliation', async () => {
      const root = mkdtempSync(join(tmpdir(), 'musterd-local-trust-roster-'));
      const roster = join(root, '.musterd');
      mkdirSync(join(roster, 'seats'), { recursive: true });
      mkdirSync(join(roster, 'roles'), { recursive: true });

      const server = createServer({
        db: await openTestDriver(kind),
        port: 0,
        rosterRoots: [root],
      });
      try {
        const { port } = await server.listen();
        const base = `http://127.0.0.1:${port}`;
        const postRoster = async (body: unknown, credential?: string) => {
          const res = await fetch(`${base}/teams/dawn/members`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(credential ? { authorization: `Bearer ${credential}` } : {}),
            },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
        };
        const rosterView = async (credential: string) => {
          const res = await fetch(`${base}/teams/dawn/members`, {
            headers: { authorization: `Bearer ${credential}` },
          });
          return (await res.json()) as any;
        };

        const created = await fetch(`${base}/teams`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
        });
        expect(created.status).toBe(201);
        const team = (await created.json()) as any;
        const nickCred = team.human_credential as string;

        // Create the DB-backed founder first so the test has a real admin credential; adding the
        // roster afterward turns the next member request into a file-backed projection.
        writeFileSync(join(roster, 'team.toml'), 'slug = "dawn"\n');
        writeFileSync(join(roster, 'roles', 'admin.toml'), '[capabilities]\nis_admin = true\n');
        writeFileSync(join(roster, 'seats', 'nick.toml'), 'kind = "human"\nrole = "admin"\n');
        writeFileSync(join(roster, 'seats', 'worker.toml'), 'kind = "agent"\n');

        writeFileSync(join(roster, 'seats', 'intruder.toml'), 'kind = "human"\nrole = "admin"\n');
        const addAdmin = await postRoster({ name: 'worker', kind: 'agent' });
        expect(addAdmin.status).toBe(401);
        expect(addAdmin.json.token).toBeUndefined();
        expect(addAdmin.json.human_credential).toBeUndefined();
        expect((await rosterView(nickCred)).members.some((m: any) => m.name === 'intruder')).toBe(
          false,
        );

        rmSync(join(roster, 'seats', 'intruder.toml'));
        rmSync(join(roster, 'seats', 'nick.toml'));
        const removeAdmin = await postRoster({ name: 'worker', kind: 'agent' });
        expect(removeAdmin.status).toBe(401);
        expect(
          (await rosterView(nickCred)).members.find((m: any) => m.name === 'nick').capabilities
            .is_admin,
        ).toBe(true);

        writeFileSync(join(roster, 'roles', 'member.toml'), '[capabilities]\nis_admin = false\n');
        writeFileSync(join(roster, 'seats', 'nick.toml'), 'kind = "human"\nrole = "member"\n');
        const demoteAdmin = await postRoster({ name: 'worker', kind: 'agent' });
        expect(demoteAdmin.status).toBe(401);
        expect(
          (await rosterView(nickCred)).members.find((m: any) => m.name === 'nick').capabilities
            .is_admin,
        ).toBe(true);

        const provisioned = await postRoster({ name: 'worker', kind: 'agent' }, nickCred);
        expect(provisioned.status, JSON.stringify(provisioned.json)).toBe(201);
        expect(
          (await rosterView(nickCred)).members.find((m: any) => m.name === 'nick').capabilities
            .is_admin,
        ).toBe(false);
      } finally {
        await server.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  /**
   * Observer grades (ADR 136) — a shared watch-link sees only public traffic.
   *
   * `members.observer` said *that* a seat was a read-only watcher but not *how much it may see*, so
   * every observer was full-visibility and a shared watch-link carried the team's DMs. A link now mints
   * a **public-grade** observer of its own.
   *
   * The enforcement is deliberately *not* a new query: a public observer is simply no longer exempt from
   * the ADR 128 recipient-scoping, and for an observer that predicate collapses to exactly the public
   * timeline — it can never be a sender (read-only), and team/broadcast fanout excludes it.
   */
  describe('observer grades: a public-grade observer sees only public traffic (ADR 136)', () => {
    async function seedTeam() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      return { team, tok, key: team.json.agent_key as string };
    }

    /** Ada→Lin DM (private), then Ada→team (public). */
    async function seedTraffic(key: string) {
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'dm1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'Lin' },
            act: 'message',
            body: 'private',
            ts: Date.now(),
          },
        },
        { key, seat: 'Ada' },
      );
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'pub1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'team' },
            act: 'status_update',
            body: 'public',
            ts: Date.now() + 1,
          },
        },
        { key, seat: 'Ada' },
      );
    }

    it('GET /messages: the public observer gets team traffic, never the DM — the full one gets both', async () => {
      const { tok, key } = await seedTeam();
      const shared = await post(
        '/teams/dawn/members',
        { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
        tok,
      );
      const local = await post(
        '/teams/dawn/members',
        { name: 'web-1', kind: 'human', observer: true },
        tok,
      );
      await seedTraffic(key);

      const sharedView = await get('/teams/dawn/messages', shared.json.human_credential);
      expect(sharedView.json.messages.map((m: any) => m.id)).toEqual(['pub1']);

      // The local dashboard is unchanged — grade defaults to full, so it still sees the coordination.
      const localView = await get('/teams/dawn/messages', local.json.human_credential);
      expect(localView.json.messages.map((m: any) => m.id)).toEqual(['dm1', 'pub1']);
    });

    it('firehose: the public observer is not pushed a DM between two others, but does get team acts', async () => {
      const { team, tok, key } = await seedTeam();
      const shared = await post(
        '/teams/dawn/members',
        { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
        tok,
      );
      expect(shared.status).toBe(201);

      const a = new TestWs();
      const w = new TestWs();
      await Promise.all([a.open(), w.open()]);
      await a.claim('dawn', key, 'Ada', 'claude-code', await standingGrant(tok, 'Ada'));
      await w.claim('dawn', key, 'watch-1', 'web', await standingGrant(tok, 'watch-1'));
      await w.subscribe('team-all');

      // A DM between two other seats must NOT reach the shared link …
      a.send({
        type: 'send',
        envelope: {
          id: 'dm1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'message',
          body: 'private',
          ts: Date.now(),
        },
      });
      // … while a team act, sent after it, must. Asserting on the *next* frame is what makes this a real
      // test: if the DM leaked it would arrive first, and the public act would not be frame #1.
      a.send({
        type: 'send',
        envelope: {
          id: 'pub1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'public',
          ts: Date.now() + 1,
        },
      });

      const frame = await w.waitFor('deliver');
      expect((frame as any).envelope.id).toBe('pub1');
      expect((frame as any).envelope.body).toBe('public');

      a.close();
      w.close();
      expect(team.status).toBe(201);
    });

    it('a DM addressed TO the public observer still reaches it — it is that seat’s own mail', async () => {
      const { tok, key } = await seedTeam();
      const shared = await post(
        '/teams/dawn/members',
        { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
        tok,
      );
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'toWatcher',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'member', name: 'watch-1' },
            act: 'message',
            body: 'for the watcher',
            ts: Date.now(),
          },
        },
        { key, seat: 'Ada' },
      );

      const view = await get('/teams/dawn/messages', shared.json.human_credential);
      expect(view.json.messages.map((m: any) => m.id)).toEqual(['toWatcher']);
    });

    it('existing observers are unaffected by the migration — no silent downgrade of a live dashboard', async () => {
      const { tok, key } = await seedTeam();
      // A seat minted with no grade at all — the pre-ADR-135 shape, and what v17 backfills to 'full'.
      const legacy = await post(
        '/teams/dawn/members',
        { name: 'web-legacy', kind: 'human', observer: true },
        tok,
      );
      await seedTraffic(key);
      const view = await get('/teams/dawn/messages', legacy.json.human_credential);
      expect(view.json.messages.map((m: any) => m.id)).toEqual(['dm1', 'pub1']);
    });
  });

  describe('tool-call telemetry ingest (ADR 144 inc 1)', () => {
    it('folds a flush into the report, stamps role at ingest, and 400s malformed batches', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent', role: 'ux' }, nickTok);

      // Malformed: an outcome outside the enum bounces the whole batch (parseOrBadRequest).
      const bad = await post(
        '/teams/dawn/telemetry/tool-calls',
        {
          events: [
            { tool: 't', outcome: 'meh', calls: 1, total_duration_ms: 0, max_duration_ms: 0 },
          ],
        },
        ada,
      );
      expect(bad.status).toBe(400);

      const ok = await post(
        '/teams/dawn/telemetry/tool-calls',
        {
          events: [
            {
              tool: 'team_send',
              outcome: 'ok',
              calls: 2,
              total_duration_ms: 90,
              max_duration_ms: 60,
            },
            {
              tool: 'team_send',
              outcome: 'invalid_input',
              calls: 1,
              total_duration_ms: 3,
              max_duration_ms: 3,
            },
          ],
          surface: { tools: 18, bytes: 40_000, est_tokens: 10_000 },
        },
        ada,
      );
      expect(ok.status).toBe(200);

      const report = await get('/teams/dawn/report', nickTok);
      const t = report.json.tool_calls;
      expect(t.calls).toBe(3);
      expect(t.bounces).toBe(1);
      // Role was stamped server-side from the member row — the wire carries no role field.
      expect(t.tools[0].by_role).toEqual({ ux: 3 });
      expect(t.surface).toEqual([
        expect.objectContaining({ seat: 'Ada', tools: 18, bytes: 40_000, est_tokens: 10_000 }),
      ]);
      // The attestation is an ordinary append-only audit row (the wake_cost precedent).
      const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const audit = (await listAudit(h.server.store, teamRow.id)).filter(
        (r) => r.action === 'mcp.surface_rendered',
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor).toBe('Ada');
    });
  });

  describe('dogfood re-seat (ADR 146)', () => {
    it('re-occupies a held agent seat over WS with no grant when the policy is on', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

      // First occupancy stamps the durable `bound_at` marker — the "already held it" signal.
      const a1 = new TestWs();
      await a1.open();
      await a1.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'cli',
        await standingGrant(nickCred, 'Ada'),
      );
      a1.close();

      // The team opts into dogfood-mode re-seat.
      const pol = await post(
        '/teams/dawn/policy',
        { standing_reseat_known_agents: true },
        nickCred,
      );
      expect(pol.json.policy.standing_reseat_known_agents).toBe(true);

      // A fresh session re-claims with only the team agent key — occupies immediately, no pending gate.
      const a2 = new TestWs();
      await a2.open();
      const occ = await a2.claim('dawn', team.json.agent_key, 'Ada', 'cli');
      expect(occ.type).toBe('occupied');
      expect((occ as any).seat.name).toBe('Ada');

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      await pollUntil(async () =>
        (await listAudit(h.server.store, teamId)).some((x) => x.action === 'claim.reseated'),
      );
      a2.close();
    });

    it('still opens a pending request for a never-bound seat even with the policy on', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);
      await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, nickCred);

      // Ada was never occupied — admission, not a re-seat: the server opens a pending request.
      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        surface: 'cli',
      });
      const pending = await a.waitFor('pending');
      expect(pending.type).toBe('pending');
      a.close();
    });
  });

  /**
   * ADR 442 (the wall) retires ADR 167 increment 2 whole: no seat relays into another session, so the
   * daemon never invites one. Every directed act to every recipient kind — live agent, live human —
   * acks without a `delivery_hint`, and the `nudge.decision` audit row is no longer written. An old
   * adapter is unaffected: the field was always optional.
   */
  describe('no delivery hint on POST /messages (ADR 442)', () => {
    function env(
      from: string,
      to: unknown,
      act: string,
      id: string,
      meta: Record<string, unknown> | null = null,
    ) {
      return {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act,
        body: '',
        meta,
        ts: Date.now(),
      };
    }

    it('never issues delivery_hint, for any recipient kind, and writes no nudge.decision row', async () => {
      const created = await post('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      const nick = created.json.human_credential as string;
      for (const name of ['Ada', 'Bob'])
        await post('/teams/dawn/members', { name, kind: 'agent' }, nick);
      const key = created.json.agent_key as string;
      const ada = { key, seat: 'Ada' };
      await get('/teams/dawn/inbox', { key, seat: 'Bob' }); // Bob live (ADR 057)
      await get('/teams/dawn/inbox', nick); // nick live
      let n = 0;
      for (const to of ['Bob', 'nick']) {
        for (const act of ['handoff', 'ask', 'steer', 'request_help'] as const) {
          const meta = act === 'ask' ? { species: 'consult', tier: 'standard' } : null;
          const res = await post(
            '/teams/dawn/messages',
            { envelope: env('Ada', { kind: 'member', name: to }, act, `nh-${n++}`, meta) },
            ada,
          );
          expect(res.status).toBe(201);
          expect(res.json).not.toHaveProperty('delivery_hint');
        }
      }
      const rows = (await get('/teams/dawn/audit?limit=200', nick)).json.audit.filter(
        (e: any) => e.action === 'nudge.decision',
      );
      expect(rows).toHaveLength(0);
    });
  });

  /** ADR 580: human credential rotation always needs an authenticated human admin. */
  describe('human credential rotation', () => {
    const rotatePath = (slug: string, name: string) =>
      `/teams/${slug}/members/${encodeURIComponent(name)}/credential/rotate`;

    it('loopback locality alone cannot rotate or receive a human credential', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const current = team.json.human_credential as string;
      const res = await post(rotatePath('dawn', 'nick'), {});
      expect(res.status).toBe(401);
      expect(res.json.credential).toBeUndefined();
      expect((await get('/teams/dawn/inbox', current)).status).toBe(200);
    });

    it('a human admin rotates a human seat and the old credential stops authenticating', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const current = team.json.human_credential as string;
      const res = await post(rotatePath('dawn', 'nick'), {}, current);
      expect(res.status).toBe(200);
      expect(res.json.member).toBe('nick');
      expect(res.json.credential).toMatch(/^mscr_/);
      expect(res.json.credential).not.toBe(current);

      expect((await get('/teams/dawn/inbox', current)).status).toBe(401);
      expect((await get('/teams/dawn/inbox', res.json.credential as string)).status).toBe(200);
      const roster = await get('/teams/dawn/members', res.json.credential as string);
      expect(roster.json.members.find((m: any) => m.name === 'nick').capabilities.is_admin).toBe(
        true,
      );
    });

    it('writes one `credential.rotate` audit row — and never the secret', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const res = await post(rotatePath('dawn', 'nick'), {}, team.json.human_credential);
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const rows = (await listAudit(h.server.store, teamId)).filter(
        (r) => r.action === 'credential.rotate',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.target).toBe('nick');
      expect(rows[0]!.result).toBe('allow');
      expect(rows[0]!.actor).toBe('nick');
      expect(JSON.parse(rows[0]!.detail!)).toEqual({ via: 'admin' });
      expect(rows[0]!.detail).not.toContain(res.json.credential);
      expect(JSON.stringify(rows[0])).not.toContain((res.json.credential as string).slice(5));
    });

    it('refuses to rotate an AGENT through the human credential route', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);

      const res = await post(rotatePath('dawn', 'Ada'), {}, tok);
      expect(res.status).toBe(400);
      expect(res.json.error.message).toMatch(/agent seat/i);
      // Nothing was minted: Ada still has no credential, so nothing new authenticates as her.
      const ada = (await getMemberByName(
        h.server.store,
        (await getTeamBySlug(h.server.store, 'dawn'))!.id,
        'Ada',
      ))!;
      expect(ada.credential_hash).toBeNull();
      const rows = (
        await listAudit(h.server.store, (await getTeamBySlug(h.server.store, 'dawn'))!.id)
      ).filter((r) => r.action === 'credential.rotate');
      expect(rows).toHaveLength(0);
    });

    it('404s for an unknown seat and for one that has left', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'Lin', kind: 'human' }, tok);
      // The message matters: a bare route-miss 404 would pass a status-only assertion, so pin the
      // route's own refusal — it names the seat and the team.
      const ghost = await post(rotatePath('dawn', 'ghost'), {}, tok);
      expect(ghost.status).toBe(404);
      expect(ghost.json.error.message).toBe('no member "ghost" in dawn');

      await post('/teams/dawn/members/Lin/remove', {}, tok);
      const res = await post(rotatePath('dawn', 'Lin'), {}, tok);
      expect(res.status).toBe(404);
      expect(res.json.error.message).toBe('no member "Lin" in dawn');
    });
  });

  /** The off-host half of the same route: `authProvision`'s admin bar, exercised behind a proxy. */
  describe('human credential rotate: off-host requires an admin credential', () => {
    let proxied: RunningServer;
    let pbase: string;

    beforeEach(async () => {
      proxied = createServer({ db: await openTestDriver(kind), port: 0, trustProxy: true });
      const { port } = await proxied.listen();
      pbase = `http://127.0.0.1:${port}`;
    });
    afterEach(async () => {
      await proxied.close();
    });

    async function ppost(path: string, body: unknown, auth?: string) {
      const res = await fetch(pbase + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
    }

    it('refuses an unauthenticated off-host caller', async () => {
      await ppost('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const res = await ppost('/teams/dawn/members/nick/credential/rotate', {});
      expect(res.status).toBe(401);
      expect(res.json.credential).toBeUndefined();
    });

    it('refuses a non-admin member off-host, and allows an admin', async () => {
      const team = await ppost('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      const nickTok = team.json.human_credential as string;
      const lin = await ppost('/teams/dawn/members', { name: 'Lin', kind: 'human' }, nickTok);
      const linTok = lin.json.human_credential as string;

      expect((await ppost('/teams/dawn/members/nick/credential/rotate', {}, linTok)).status).toBe(
        403,
      );

      const byAdmin = await ppost('/teams/dawn/members/Lin/credential/rotate', {}, nickTok);
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.json.credential).toMatch(/^mscr_/);
      expect(byAdmin.json.credential).not.toBe(linTok);

      const teamId = (await getTeamBySlug(proxied.store, 'dawn'))!.id;
      const rows = (await listAudit(proxied.store, teamId)).filter(
        (r) => r.action === 'credential.rotate',
      );
      expect(rows).toHaveLength(1);
      // The audit names the human admin who proved authority; the secret never enters its detail.
      expect(rows[0]!.actor).toBe('nick');
      expect(JSON.parse(rows[0]!.detail!)).toEqual({ via: 'admin' });
    });
  });

  /** ADR 580: a local browser can receive only the authenticated human's own identity.
   *
   * Locality still narrows the route to this daemon. The bearer is the authority, so the server never
   * scans a machine-wide vault or exposes another human's credential.
   */
  describe('local sign-in identity requires an authenticated human (ADR 580)', () => {
    it('refuses a loopback caller without an admin credential and returns no identity', async () => {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const res = await get('/teams/dusk/local-identity');

      expect(res.status).toBe(401);
      expect(res.json.credential).toBeUndefined();
      expect(JSON.stringify(res.json)).not.toContain(team.json.human_credential);
    });

    it('returns only the caller identity, even when other human credentials exist', async () => {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential as string;
      const ada = await post('/teams/dusk/members', { name: 'Ada', kind: 'human' }, nickCred);
      const adaCred = ada.json.human_credential as string;

      const res = await get('/teams/dusk/local-identity', nickCred);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        available: true,
        as: 'nick',
        credential: nickCred,
        identities: [{ as: 'nick', credential: nickCred }],
      });
      expect(JSON.stringify(res.json)).not.toContain(adaCred);
    });

    it('a non-admin human receives only its own identity, not another human credential', async () => {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential as string;
      const ada = await post('/teams/dusk/members', { name: 'Ada', kind: 'human' }, nickCred);
      const adaCred = ada.json.human_credential as string;

      const res = await get('/teams/dusk/local-identity', adaCred);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ as: 'Ada', credential: adaCred });
      expect(res.json.identities).toEqual([{ as: 'Ada', credential: adaCred }]);
      expect(JSON.stringify(res.json)).not.toContain(nickCred);
    });

    it('refuses a cross-origin browser request even with an admin bearer', async () => {
      const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
      const nickCred = team.json.human_credential as string;

      const res = await get('/teams/dusk/local-identity', nickCred, {
        origin: 'https://evil.example',
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.json)).not.toContain(nickCred);
    });
  });

  describe('local sign-in identity is refused off this machine (ADR 580)', () => {
    let proxied: RunningServer;
    let pbase: string;

    beforeEach(async () => {
      proxied = createServer({ db: await openTestDriver(kind), port: 0, trustProxy: true });
      const { port } = await proxied.listen();
      pbase = `http://127.0.0.1:${port}`;
    });
    afterEach(async () => {
      await proxied.close();
    });

    it('refuses and records an off-machine attempt even with a human-admin bearer', async () => {
      const created = await fetch(`${pbase}/teams`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'dusk', creator: { name: 'nick', kind: 'human' } }),
      });
      const team = (await created.json()) as any;
      const res = await fetch(`${pbase}/teams/dusk/local-identity`, {
        headers: { authorization: `Bearer ${team.human_credential}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toContain(team.human_credential);

      const audit = await fetch(`${pbase}/teams/dusk/audit`, {
        headers: { authorization: `Bearer ${team.human_credential}` },
      });
      const rows = (await audit.json()) as any;
      const miss = rows.audit.find((r: any) => r.action === 'signin.handoff_missed');
      expect(miss.detail.reason).toBe('off_machine');
    });
  });

  /**
   * ADR 227 increment 2 — the warn-only infra-touch gate. The daemon owns both halves: it resolves
   * whether the calling seat holds `platform` AND writes the audit row, so the CLI never supplies
   * audit content and the check degrades to silence when the daemon is unreachable (the CLI side).
   * Watcher, never gatekeeper: the response carries a warning or null; nothing here blocks anything.
   */
  describe('infra-touch gate (ADR 227 inc 2): GET /teams/:slug/infra-gate', () => {
    async function seedTeam() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'izzo', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'dolly', kind: 'agent' }, tok);
      return { tok, key: team.json.agent_key as string };
    }

    async function holdPlatform(name: string) {
      const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const m = (await getMemberByName(h.server.store, team.id, name))!;
      await setMemberGovernance(
        h.server.store,
        m.id,
        null,
        JSON.stringify(GENERALIST_CAPABILITIES),
        ['platform'],
      );
    }

    it('warns a non-holder agent seat, naming the current holders, and audits infra.touch.warned', async () => {
      const { key } = await seedTeam();
      await holdPlatform('izzo');
      const r = await get('/teams/dawn/infra-gate?verb=restart', { key, seat: 'dolly' });
      expect(r.status).toBe(200);
      expect(r.json.warn.holders).toEqual(['izzo']);
      expect(r.json.warn.text).toContain('izzo holds platform');
      expect(r.json.warn.text).toContain('route an ask');
      const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const rows = (await h.server.store.all(
        "SELECT actor, action, detail FROM audit WHERE team_id = ? AND action = 'infra.touch.warned'",
        [team.id],
      )) as Array<{ actor: string; detail: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('dolly');
      expect(JSON.parse(rows[0]!.detail)).toMatchObject({ verb: 'restart', holders: ['izzo'] });
    });

    it('agrees with itself about number — two holders HOLD platform, one HOLDS it', async () => {
      // ADR 227 §4 already names a platform alternate, so the plural is a real roster state and not a
      // hypothetical: the moment a second seat is assigned, a singular verb here reads as a typo in
      // the one message whose whole job is to be trusted enough to redirect someone.
      const { key, tok } = await seedTeam();
      await post('/teams/dawn/members', { name: 'stanley', kind: 'agent' }, tok);
      await holdPlatform('izzo');
      await holdPlatform('stanley');
      const r = await get('/teams/dawn/infra-gate?verb=restart', { key, seat: 'dolly' });
      expect(r.status).toBe(200);
      expect(r.json.warn.holders).toEqual(['izzo', 'stanley']);
      expect(r.json.warn.text).toContain('izzo, stanley hold platform');
      expect(r.json.warn.text).not.toContain('holds platform');
    });

    it('stays silent for a platform holder — no warn, no audit row', async () => {
      const { key } = await seedTeam();
      await holdPlatform('izzo');
      const r = await get('/teams/dawn/infra-gate?verb=refresh', { key, seat: 'izzo' });
      expect(r.status).toBe(200);
      expect(r.json.warn).toBeNull();
      const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const rows = await h.server.store.all(
        "SELECT id FROM audit WHERE team_id = ? AND action = 'infra.touch.warned'",
        [team.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('stays silent for a human seat — the audience is agents, not the operator in their own shell', async () => {
      const { tok } = await seedTeam();
      await holdPlatform('izzo');
      const r = await get('/teams/dawn/infra-gate?verb=install', tok);
      expect(r.status).toBe(200);
      expect(r.json.warn).toBeNull();
    });

    it('with no platform holder, says the team has none yet (still warn-shaped, still audited)', async () => {
      const { key } = await seedTeam();
      const r = await get('/teams/dawn/infra-gate?verb=restart', { key, seat: 'dolly' });
      expect(r.status).toBe(200);
      expect(r.json.warn.holders).toEqual([]);
      expect(r.json.warn.text).toContain('no seat holds platform');
    });

    it('unauthenticated → silent null (never a prerequisite for the command that fixes health)', async () => {
      await seedTeam();
      const r = await get('/teams/dawn/infra-gate?verb=restart');
      expect(r.status).toBe(200);
      expect(r.json.warn).toBeNull();
    });
  });

  describe('goal outcome + ship nudge (value-layer design)', () => {
    async function setup() {
      const team = await post('/teams', {
        slug: 'valyr',
        creator: { name: 'nick', kind: 'human' },
      });
      return team.json.human_credential as Auth;
    }
    async function patchLane(id: string, body: unknown, auth: Auth) {
      const r = await fetch(h.base + `/teams/valyr/lanes/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(auth) },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    }

    it('POST /goals/outcome records a note and the goal projection carries it', async () => {
      const nickTok = await setup();
      await post('/teams/valyr/goals', { id: 'g1', title: 'G1' }, nickTok);
      const res = await post(
        '/teams/valyr/goals/outcome',
        { goal_id: 'g1', outcome: 'users can now X' },
        nickTok,
      );
      expect(res.status).toBe(201);
      expect(res.json.goal.outcome.text).toBe('users can now X');
      expect(res.json.goal.outcome.by).toBe('nick');
      const goals = await get('/teams/valyr/goals', nickTok);
      expect(goals.json.goals[0].outcome.text).toBe('users can now X');
    });

    it('POST /goals/retract withdraws the goal and a re-declaration revives it', async () => {
      const nickTok = await setup();
      await post('/teams/valyr/goals', { id: 'gr1', title: 'Scratch' }, nickTok);
      const res = await post('/teams/valyr/goals/retract', { goal_id: 'gr1' }, nickTok);
      expect(res.status).toBe(201);
      expect(res.json.goal.retracted.by).toBe('nick');
      const goals = await get('/teams/valyr/goals', nickTok);
      expect(goals.json.goals[0].retracted.by).toBe('nick');
      // Re-declaring the same id un-retracts — the signal fold, not a delete.
      await post('/teams/valyr/goals', { id: 'gr1', title: 'Back on' }, nickTok);
      const after = await get('/teams/valyr/goals', nickTok);
      expect(after.json.goals[0].retracted).toBeUndefined();
    });

    it('POST /goals/retract for an undeclared goal returns goal: null (queued, not lost)', async () => {
      const nickTok = await setup();
      const res = await post('/teams/valyr/goals/retract', { goal_id: 'ghost' }, nickTok);
      expect(res.status).toBe(201);
      expect(res.json.goal).toBeNull();
    });

    it('closing the last lane on a goal appends the ship nudge to the closer result only', async () => {
      const nickTok = await setup();
      await post('/teams/valyr/goals', { id: 'g2', title: 'G2' }, nickTok);
      const lane = await post(
        '/teams/valyr/lanes',
        { title: 'only lane', goal_id: 'g2', claim: true },
        nickTok,
      );
      const res = await patchLane(lane.json.lane.id, { state: 'done' }, nickTok);
      expect(res.status).toBe(200);
      expect(res.json.notices).toHaveLength(1);
      expect(res.json.notices[0]).toContain('team_goal_outcome');
      expect(res.json.notices[0]).toContain('g2');
    });

    it('closing a lane while the goal still has live lanes appends no nudge', async () => {
      const nickTok = await setup();
      await post('/teams/valyr/goals', { id: 'g3', title: 'G3' }, nickTok);
      const a = await post(
        '/teams/valyr/lanes',
        { title: 'first', goal_id: 'g3', claim: true },
        nickTok,
      );
      await post('/teams/valyr/lanes', { title: 'second', goal_id: 'g3', claim: true }, nickTok);
      const res = await patchLane(a.json.lane.id, { state: 'done' }, nickTok);
      expect(res.status).toBe(200);
      expect(res.json.notices).toBeUndefined();
    });

    it('a goal-less close carries no nudge', async () => {
      const nickTok = await setup();
      const lane = await post('/teams/valyr/lanes', { title: 'free', claim: true }, nickTok);
      const res = await patchLane(lane.json.lane.id, { state: 'done' }, nickTok);
      expect(res.json.notices).toBeUndefined();
    });
  });

  describe('incident convergence (spec 2026-08-14 inc 1)', () => {
    const GATE = 'ci:gates/A11y contrast';
    let nickTok: string;
    const toks: Record<string, string> = {};

    /** Team of one human + three human reporter seats (human creds keep the auth setup minimal). */
    async function seedTeam() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      nickTok = team.json.human_credential;
      for (const name of ['izzo', 'dolly', 'stanley']) {
        const m = await post('/teams/dawn/members', { name, kind: 'human' }, nickTok);
        toks[name] = m.json.human_credential;
      }
    }

    let seq = 0;
    async function reportBlocked(fromSeat: string, ref: string, sig: string) {
      const env = {
        id: `inc-${++seq}`,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: fromSeat,
        to: { kind: 'team' },
        act: 'status_update',
        body: 'red on a check my diff cannot touch',
        meta: { blocked_by: { gate: GATE, ref, sig } },
        ts: Date.now(),
      };
      const sent = await post('/teams/dawn/messages', { envelope: env }, toks[fromSeat]);
      expect(sent.status).toBe(201);
    }

    it('second reporter opens an incident lane and both reporters are told the lane', async () => {
      await seedTeam();
      await reportBlocked('izzo', 'pr#828', 'lc 2.83');
      await reportBlocked('dolly', 'pr#829', 'lc 2.85');
      const lanes = await get('/teams/dawn/lanes', nickTok);
      const incident = lanes.json.lanes.find((l: any) => l.kind === 'incident');
      expect(incident).toBeDefined();
      expect(incident.title).toBe(`incident: ${GATE}`);
      expect(incident.owner_seat).toBeNull();
      const izzoInbox = await get('/teams/dawn/inbox', toks['izzo']);
      expect(JSON.stringify(izzoInbox.json)).toContain(incident.id);
      const dollyInbox = await get('/teams/dawn/inbox', toks['dolly']);
      expect(JSON.stringify(dollyInbox.json)).toContain(incident.id);
      // ADR 649: the board announces, not a reporter.
      const announcements = [...izzoInbox.json.messages, ...dollyInbox.json.messages].filter(
        (m: any) => typeof m.body === 'string' && m.body.startsWith('[incident] opened'),
      );
      expect(announcements).toHaveLength(2);
      expect(announcements.every((m: any) => m.from === 'board')).toBe(true);
    });

    it('third reporter gets the park-behind-it auto-reply and no second lane opens', async () => {
      await seedTeam();
      await reportBlocked('izzo', 'pr#828', 'lc 2.83');
      await reportBlocked('dolly', 'pr#829', 'lc 2.85');
      await reportBlocked('stanley', 'pr#830', 'lc 2.11');
      const lanes = await get('/teams/dawn/lanes', nickTok);
      expect(lanes.json.lanes.filter((l: any) => l.kind === 'incident')).toHaveLength(1);
      const stanleyInbox = await get('/teams/dawn/inbox', toks['stanley']);
      expect(JSON.stringify(stanleyInbox.json)).toContain('park behind it');
      const reply = stanleyInbox.json.messages.find((m: any) => m.body?.includes('park behind it'));
      expect(reply.from).toBe('board');
    });

    it('a status_update without blocked_by opens nothing', async () => {
      await seedTeam();
      const env = {
        id: 'plain-1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'izzo',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'shipping',
        ts: Date.now(),
      };
      await post('/teams/dawn/messages', { envelope: env }, toks['izzo']);
      const lanes = await get('/teams/dawn/lanes', nickTok);
      expect((lanes.json.lanes ?? []).filter((l: any) => l.kind === 'incident')).toHaveLength(0);
    });
  });

  describe('model_source on the roster and the audit log (lane 01M2PAFNAS)', () => {
    it('GET /members carries model_source per occupancy and GET /audit stamps the actor row with model + source', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const a = new TestWs();
      const b = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), b.open(), l.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(tok, 'Ada'),
        'claude-opus-4-8',
        undefined,
        'observed',
      );
      await b.claim(
        'dawn',
        team.json.agent_key,
        'Bo',
        'cursor',
        await standingGrant(tok, 'Bo'),
        'grok-4.6',
        undefined,
        'binding',
      );
      await l.claim(
        'dawn',
        team.json.agent_key,
        'Lin',
        'codex',
        await standingGrant(tok, 'Lin'),
        'gpt-5.6',
      );

      const roster = await get('/teams/dawn/members', tok);
      expect(roster.status).toBe(200);
      const occupancy = (name: string) =>
        (roster.json.members as any[]).find((m) => m.name === name).presences[0];
      expect(occupancy('Ada')).toMatchObject({
        model: 'claude-opus-4-8',
        model_source: 'observed',
      });
      expect(occupancy('Bo')).toMatchObject({ model: 'grok-4.6', model_source: 'binding' });
      // The tier-less attestation stays tier-less on the wire: the label has to read "unknown", not "said".
      expect(occupancy('Lin')).toMatchObject({ model: 'gpt-5.6', model_source: null });

      // An audited action carries what its actor was attesting when it happened. Dee occupies over
      // HTTP (the one-shot claim mirror), attesting an observed model, then opens a lane.
      await post('/teams/dawn/members', { name: 'Dee', kind: 'agent' }, tok);
      const dee: Auth = { key: team.json.agent_key, seat: 'Dee' };
      await get('/teams/dawn/members', dee); // resolves Dee's seat credential + lease
      const reattest = await post('/teams/dawn/claim', {
        key: dee.key,
        target: { seat: 'Dee' },
        surface: 'cli',
        model: 'claude-opus-4-8',
        model_source: 'observed',
      });
      expect(reattest.status).toBe(200);
      Object.assign(dee, {
        key: reattest.json.seat_credential ?? dee.key,
        sessionLease: reattest.json.session_lease,
      });
      const opened = await post('/teams/dawn/lanes', { title: 'stamped', claim: true }, dee);
      expect(opened.status).toBe(201);
      const audit = await get('/teams/dawn/audit', tok);
      const row = (audit.json.audit as any[]).find(
        (r) => r.actor === 'Dee' && r.action === 'lane.opened',
      );
      expect(row).toMatchObject({ actor_model: 'claude-opus-4-8', actor_model_source: 'observed' });
      // A system row names no actor and carries no stamp.
      const system = (audit.json.audit as any[]).find((r) => r.actor === null);
      if (system) expect(system).toMatchObject({ actor_model: null, actor_model_source: null });
      a.close();
      b.close();
      l.close();
    });
  });

  describe('review promises (ADR 490): GET /next arrays + GET /teams/:slug/review-promises?open=1', () => {
    const PR = { kind: 'pr', repo: 'org/repo', number: 42 };
    const envelope = (
      id: string,
      from: string,
      to: { kind: 'team' } | { kind: 'member'; name: string },
      act: string,
      extra: Record<string, unknown> = {},
    ) => ({
      envelope: {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act,
        body: `${act} ${id}`,
        ts: Date.now(),
        ...extra,
      },
    });

    /** nick, two agents, and one typed review request from nick that Ada accepted. */
    async function seedPromise() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      const lin = { key: team.json.agent_key, seat: 'Lin' };
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
      const ask = await post(
        '/teams/dawn/messages',
        envelope('req1', 'nick', { kind: 'member', name: 'Ada' }, 'request_help', {
          body: 'please check the migration',
          meta: { review: PR },
        }),
        nickTok,
      );
      expect(ask.status).toBe(201);
      const ok = await post(
        '/teams/dawn/messages',
        envelope('ok1', 'Ada', { kind: 'member', name: 'nick' }, 'accept', {
          meta: { in_reply_to: 'req1' },
        }),
        ada,
      );
      expect(ok.status).toBe(201);
      return { nickTok, ada, lin };
    }

    it('the brief carries the promise for owner and requester, supported-empty for a bystander', async () => {
      const { nickTok, ada, lin } = await seedPromise();
      const owner = await get('/teams/dawn/next', ada);
      expect(owner.status).toBe(200);
      expect(owner.json.request_reviews).toHaveLength(1);
      expect(owner.json.request_reviews[0]).toMatchObject({
        request_id: 'req1',
        requester: 'nick',
        owner: 'Ada',
        context: 'please check the migration',
        review: PR,
      });
      expect(owner.json.requested_reviews).toEqual([]);
      expect(owner.json.review_closures).toEqual([]);
      const requester = await get('/teams/dawn/next', nickTok);
      expect(
        requester.json.requested_reviews.map((r: { request_id: string }) => r.request_id),
      ).toEqual(['req1']);
      const bystander = await get('/teams/dawn/next', lin);
      expect(bystander.json.request_reviews).toEqual([]);
      expect(bystander.json.requested_reviews).toEqual([]);
      expect(bystander.json.review_closures).toEqual([]);
    });

    it('the Team read lists every open promise, oldest first, with ids, names and time only', async () => {
      const { nickTok, ada, lin } = await seedPromise();
      // A second promise, accepted later: Lin asks Ada.
      await post(
        '/teams/dawn/messages',
        envelope('req2', 'Lin', { kind: 'member', name: 'Ada' }, 'request_help', {
          meta: { review: { kind: 'lane', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } },
        }),
        lin,
      );
      await post(
        '/teams/dawn/messages',
        envelope('ok2', 'Ada', { kind: 'member', name: 'Lin' }, 'accept', {
          meta: { in_reply_to: 'req2' },
        }),
        ada,
      );
      // Any active Member of the Team may read it — including one who holds no promise.
      const res = await get('/teams/dawn/review-promises?open=1', lin);
      expect(res.status).toBe(200);
      expect(res.json.review_promises.map((r: { request_id: string }) => r.request_id)).toEqual([
        'req1',
        'req2',
      ]);
      for (const row of res.json.review_promises) {
        expect(Object.keys(row).sort()).toEqual([
          'accepted_at',
          'owner',
          'request_id',
          'requester',
        ]);
      }
      expect(res.json.review_promises[0]).toMatchObject({ requester: 'nick', owner: 'Ada' });
      expect(res.json.review_promises[1]).toMatchObject({ requester: 'Lin', owner: 'Ada' });
      // The human's credential reads the same population.
      const asNick = await get('/teams/dawn/review-promises?open=1', nickTok);
      expect(asNick.json).toEqual(res.json);
    });

    it('a Team with nothing open answers a supported empty list, never absence', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const res = await get('/teams/dawn/review-promises?open=1', team.json.human_credential);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ review_promises: [] });
    });

    it('a Team resolve closes both rows; a non-owner close leaves the owner one notice', async () => {
      const { nickTok, ada } = await seedPromise();
      const withdrawn = await post(
        '/teams/dawn/messages',
        envelope('done1', 'nick', { kind: 'team' }, 'resolve', { thread: 'req1' }),
        nickTok,
      );
      expect(withdrawn.status).toBe(201);
      const audit = await get('/teams/dawn/review-promises?open=1', nickTok);
      expect(audit.json).toEqual({ review_promises: [] });
      const owner = await get('/teams/dawn/next', ada);
      expect(owner.json.request_reviews).toEqual([]);
      expect(owner.json.review_closures).toMatchObject([
        { request_id: 'req1', resolve_id: 'done1', closer: 'nick' },
      ]);
      expect((await get('/teams/dawn/next', nickTok)).json.review_closures).toEqual([]);
    });

    it('refuses an unsupported query, an unauthenticated read, and a cross-Team credential', async () => {
      const { nickTok } = await seedPromise();
      const other = await post('/teams', { slug: 'dusk', creator: { name: 'kim', kind: 'human' } });
      expect((await get('/teams/dawn/review-promises', nickTok)).status).toBe(400);
      expect((await get('/teams/dawn/review-promises?open=all', nickTok)).status).toBe(400);
      expect((await get('/teams/dawn/review-promises?open=1')).status).toBe(401);
      const crossTeam = await get(
        '/teams/dawn/review-promises?open=1',
        other.json.human_credential,
      );
      expect([401, 403]).toContain(crossTeam.status);
      expect(crossTeam.json.review_promises).toBeUndefined();
    });
  });
});
