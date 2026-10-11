import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug, mintBootstrapCredential } from '../store/teams.js';
import { integrationHarness } from './integration.helpers.js';

withDrivers('integration · ws', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, post, standingGrant } = h;

  describe('WebSocket', async () => {
    it('/health connections reflects a live session (ADR 047)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      expect((await get('/health')).json.connections).toBe(0);

      const a = new TestWs();
      await a.open();
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
        'claude-opus-4-8',
      );
      expect((await get('/health')).json.connections).toBe(1);
      a.close();
    });

    /**
     * The silent-claim-failure regression (found 2026-08-12 during the ADR 251 live wake). A claim
     * whose presence write is refused by the storage layer must come back LOUD: the real cause on an
     * error frame, an audit row, and a closed socket — because the client cannot distinguish "still
     * thinking" from "already dead" on a socket that stays open.
     *
     * The trigger reproduces the exact shape without mocking: the protocol accepts the frame, the
     * storage layer refuses the row. That is enum-vs-storage drift, which is how this class of bug
     * always arrives (migration 39 was one: the surface CHECK predated the `musterd` enum value).
     */
    it('a claim whose presence write is refused fails loudly — error frame, audit row, closed socket', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');
      // The refusal is a trigger, spelled per engine (the one place this test writes DDL).
      await h.db.exec(
        h.db.dialect === 'sqlite'
          ? `CREATE TRIGGER refuse_ios BEFORE INSERT ON presence WHEN NEW.surface = 'ios'
             BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: surface'); END;`
          : `CREATE OR REPLACE FUNCTION refuse_ios_fn() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.surface = 'ios' THEN RAISE EXCEPTION 'CHECK constraint failed: surface'; END IF;
             RETURN NEW; END $$;
             DROP TRIGGER IF EXISTS refuse_ios ON presence;
             CREATE TRIGGER refuse_ios BEFORE INSERT ON presence FOR EACH ROW EXECUTE FUNCTION refuse_ios_fn();`,
      );

      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'ios',
      });

      // 1. The client learns WHY, in-band, without waiting for a timeout.
      const err = (await a.waitFor('error')) as { code: string; message: string };
      expect(err.code).toBe('server_error');
      expect(err.message).toContain('CHECK constraint failed');
      // 2. The socket is terminal: an unauthenticated connection whose claim died is not a waiting
      //    room. This is the second net — a client that ignores the frame still unblocks on close.
      await a.closed();
      // 3. The failure is in the ledger. A claim that fails left NO trace before this fix, so the
      //    only evidence of the four-round hunt was in the agent's own transcript.
      const audit = await listAudit(h.db, (await getTeamBySlug(h.db, 'dawn'))!.id, 50);
      const failed = audit.find((r) => r.action === 'claim.failed');
      expect(failed).toBeDefined();
      expect(failed!.result).toBe('deny');
    });

    it('delivers live to a present recipient and acks the sender', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, team.json.human_credential);

      const a = new TestWs();
      const l = new TestWs();
      await Promise.all([a.open(), l.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );
      await l.claim(
        'dawn',
        team.json.agent_key,
        'Lin',
        'codex',
        await standingGrant(team.json.human_credential, 'Lin'),
      );

      a.send({
        type: 'send',
        envelope: {
          id: 'mw1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'handoff',
          body: 'ready',
          ts: Date.now(),
        },
      });

      const ack = await a.waitFor('ack');
      expect((ack as any).id).toBe('mw1');
      const deliver = await l.waitFor('deliver');
      expect((deliver as any).envelope.body).toBe('ready');

      a.close();
      l.close();
    });

    it("firehose: a human's own CLI send reaches their open /live tab; only the sending connection is skipped (lane 01M4H7YKS5)", async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // nick has a /live tab on the firehose; Ada is an ordinary recipient.
      const tab = new TestWs();
      const a = new TestWs();
      await Promise.all([tab.open(), a.open()]);
      await tab.claim('dawn', nickTok, 'nick', 'web');
      await tab.subscribe('team-all');
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(nickTok, 'Ada'),
      );

      const envelope = (id: string) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'status_update',
        body: id,
        ts: Date.now(),
      });

      // 1. An HTTP send (the CLI's path) has no sending connection, so the tab — same member — gets it.
      const sent = await post('/teams/dawn/messages', { envelope: envelope('cli-1') }, nickTok);
      expect(sent.status).toBeLessThan(300);
      const echoed = await tab.waitFor('deliver');
      expect((echoed as any).envelope.id).toBe('cli-1');
      await a.waitFor('deliver');

      // 2. A send over the tab's own socket is acked there and NOT echoed back on the firehose.
      tab.send({ type: 'send', envelope: envelope('tab-1') });
      await tab.waitFor('ack');
      await new Promise((r) => setTimeout(r, 40));
      expect(tab.frames.filter((f) => f.type === 'deliver').map((f: any) => f.envelope.id)).toEqual(
        ['cli-1'],
      );
      // The recipient still gets each act exactly once.
      expect(a.frames.filter((f) => f.type === 'deliver').map((f: any) => f.envelope.id)).toEqual([
        'cli-1',
        'tab-1',
      ]);

      tab.close();
      a.close();
    });

    it('firehose (subscribe team-all): a regular member is pushed a DM between two others — visibility is team-wide (ADR 407)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Obs', kind: 'agent' }, tok);

      const a = new TestWs();
      const l = new TestWs();
      const o = new TestWs();
      await Promise.all([a.open(), l.open(), o.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );
      await l.claim(
        'dawn',
        team.json.agent_key,
        'Lin',
        'codex',
        await standingGrant(team.json.human_credential, 'Lin'),
      );
      await o.claim(
        'dawn',
        team.json.agent_key,
        'Obs',
        'web',
        await standingGrant(team.json.human_credential, 'Obs'),
      );

      // Lin is the recipient AND a firehose subscriber (tests dedup); Obs is a regular (non-party,
      // non-observer, non-admin) member watching the firehose. Under ADR 128 recipient-scoping applied
      // to it; under ADR 407 it reads the same stream the history read serves.
      const linSub = await l.subscribe('team-all');
      const obsSub = await o.subscribe('team-all');
      expect((linSub as any).scope).toBe('team-all');
      expect((obsSub as any).scope).toBe('team-all');

      a.send({
        type: 'send',
        envelope: {
          id: 'fh1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'request_help',
          body: 'firehose ping',
          ts: Date.now(),
        },
      });
      await a.waitFor('ack');

      // The recipient gets the DM exactly once, despite also being on the firehose (dedup via skip set).
      await l.waitFor('deliver');
      // ADR 128 asserted `o.countFrames('deliver')` was 0 here: a regular member must NOT see a DM it
      // is not party to. ADR 407 inverts that on purpose — a claimed seat reads every act on its team,
      // and the firehose applies the same grade the history read does. The old assertion stays in
      // this comment so the flip is a recorded decision, not a silent one. (Waited for, not slept
      // for: a zero can be asserted after a nap, a one cannot.)
      const obsDm = await o.waitFor('deliver');
      expect((obsDm as any).envelope.id).toBe('fh1');
      await new Promise((r) => setTimeout(r, 40));
      expect(l.countFrames('deliver')).toBe(1);
      expect(o.countFrames('deliver')).toBe(1);

      // A team broadcast is public and arrives as the second frame.
      a.send({
        type: 'send',
        envelope: {
          id: 'fh2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: 'team ping',
          ts: Date.now(),
        },
      });
      await a.waitFor('ack');
      const deadline = Date.now() + 1000;
      while (o.countFrames('deliver') < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const obsDelivers = o.frames.filter((f) => f.type === 'deliver');
      expect(obsDelivers).toHaveLength(2);
      expect((obsDelivers[1] as any).envelope.body).toBe('team ping');

      a.close();
      l.close();
      o.close();
    });

    it('GET /messages returns the whole team timeline incl. DMs between others, with since/limit (ADR 061)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);

      const mk = (id: string, from: string, to: any, body: string, ts: number) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act: 'message',
        body,
        ts,
      });
      // A directed Ada→Lin DM (nick is neither sender nor recipient) + a team broadcast from Lin.
      await post(
        '/teams/dawn/messages',
        { envelope: await mk('t1', 'Ada', { kind: 'member', name: 'Lin' }, 'dm', 1000) },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      await post(
        '/teams/dawn/messages',
        { envelope: await mk('t2', 'Lin', { kind: 'team' }, 'all', 2000) },
        { key: team.json.agent_key, seat: 'Lin' },
      );

      // nick is the team admin, so — party to neither — still sees BOTH via the full team timeline.
      const all = await get('/teams/dawn/messages', tok);
      expect(all.json.messages.map((m: any) => m.id)).toEqual(['t1', 't2']);

      // `since` pages forward (exclusive), oldest-after-first.
      const since = await get('/teams/dawn/messages?since=1000', tok);
      expect(since.json.messages.map((m: any) => m.id)).toEqual(['t2']);
      // A bare `limit` caps to the NEWEST N (not the oldest) so a busy team's backfill shows what just
      // happened, not its first N messages ever — the ADR 107 backfill fix.
      const limited = await get('/teams/dawn/messages?limit=1', tok);
      expect(limited.json.messages).toHaveLength(1);
      expect(limited.json.messages[0].id).toBe('t2');
    });

    it('GET /messages: a regular member reads every act on its team, including a DM between two others (ADR 407)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Bo', kind: 'agent' }, tok);
      const key = team.json.agent_key;

      const mk = (id: string, from: string, to: any, body: string, ts: number) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to,
        act: 'message',
        body,
        ts,
      });
      // m1 Ada→Lin (Bo not party) · m2 Bo→Ada (Bo party) · m3 Lin→team (public).
      await post(
        '/teams/dawn/messages',
        { envelope: await mk('m1', 'Ada', { kind: 'member', name: 'Lin' }, 'ada->lin', 1000) },
        { key, seat: 'Ada' },
      );
      await post(
        '/teams/dawn/messages',
        { envelope: await mk('m2', 'Bo', { kind: 'member', name: 'Ada' }, 'bo->ada', 2000) },
        { key, seat: 'Bo' },
      );
      await post(
        '/teams/dawn/messages',
        { envelope: await mk('m3', 'Lin', { kind: 'team' }, 'all', 3000) },
        { key, seat: 'Lin' },
      );

      // ADR 128 asserted Bo saw exactly ['m2', 'm3'] here — its own DM and the broadcast, never
      // Ada→Lin. ADR 407 inverts it: a claimed seat reads every act on its team. The old assertion is
      // kept in this comment so the flip is visible in the record rather than silent.
      const boView = await get('/teams/dawn/messages', { key, seat: 'Bo' });
      expect(boView.json.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);

      // The admin sees the same timeline — there is no longer a wider one.
      const adminView = await get('/teams/dawn/messages', tok);
      expect(adminView.json.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    });

    // ADR 407 §2–§3. Visibility widened; DELIVERY did not, and one act stays hidden. These are the
    // assertions the ADR's Observability section names, written before the enforcement so each one
    // was watched fail.
    describe('the hidden class and the untouched inbox (ADR 407)', () => {
      async function team() {
        const t = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
        const tok = t.json.human_credential as string;
        const key = t.json.agent_key as string;
        for (const name of ['Ada', 'Lin', 'Bo']) {
          await post('/teams/dawn/members', { name, kind: 'agent' }, tok);
        }
        // A human who is NOT the admin, so "the addressee sees it" is tested apart from "admins do".
        const dee = await post('/teams/dawn/members', { name: 'Dee', kind: 'human' }, tok);
        return { tok, key, deeTok: dee.json.human_credential as string };
      }
      const confidential = (id: string, ts: number) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'member', name: 'Dee' },
        act: 'ask',
        body: 'Bo keeps forging submits',
        meta: { species: 'escalate', tier: 'standard', about: 'Bo' },
        ts,
      });

      it('an ask carrying meta.about is read by sender, addressee and admin — and by nobody else', async () => {
        const { tok, key, deeTok } = await team();
        await post(
          '/teams/dawn/messages',
          { envelope: confidential('c1', 1000) },
          { key, seat: 'Ada' },
        );
        // A plain act after it, so every negative below asserts on a non-empty timeline.
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: 'p1',
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'Lin',
              to: { kind: 'team' },
              act: 'status_update',
              body: 'public',
              ts: 2000,
            },
          },
          { key, seat: 'Lin' },
        );
        const ids = async (auth: unknown) =>
          (await get('/teams/dawn/messages', auth)).json.messages.map((m: any) => m.id);

        // The subject cannot read what is said about it; an uninvolved seat cannot either.
        expect(await ids({ key, seat: 'Bo' })).toEqual(['p1']);
        expect(await ids({ key, seat: 'Lin' })).toEqual(['p1']);
        // Sender, human addressee, admin.
        expect(await ids({ key, seat: 'Ada' })).toEqual(['c1', 'p1']);
        expect(await ids(deeTok)).toEqual(['c1', 'p1']);
        expect(await ids(tok)).toEqual(['c1', 'p1']);
      });

      it('the firehose applies the same rule: a regular subscriber is not pushed it, a full observer is', async () => {
        const { tok, key } = await team();
        const wall = await post(
          '/teams/dawn/members',
          { name: 'wall', kind: 'human', observer: true },
          tok,
        );
        expect(wall.status).toBe(201);

        const a = new TestWs();
        const o = new TestWs();
        const w = new TestWs();
        await Promise.all([a.open(), o.open(), w.open()]);
        await a.claim('dawn', key, 'Ada', 'claude-code', await standingGrant(tok, 'Ada'));
        await o.claim('dawn', key, 'Lin', 'codex', await standingGrant(tok, 'Lin'));
        await w.claim('dawn', key, 'wall', 'web', await standingGrant(tok, 'wall'));
        await o.subscribe('team-all');
        await w.subscribe('team-all');

        a.send({ type: 'send', envelope: confidential('c2', Date.now()) });
        await a.waitFor('ack');
        // The public act AFTER it is what makes the negative real: if the confidential ask leaked to
        // Lin it would be Lin's first deliver frame, and 'public' would not be.
        a.send({
          type: 'send',
          envelope: {
            id: 'p2',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'team' },
            act: 'status_update',
            body: 'public',
            ts: Date.now() + 1,
          },
        });
        await a.waitFor('ack');

        const linFirst = await o.waitFor('deliver');
        expect((linFirst as any).envelope.id).toBe('p2');
        const wallFirst = await w.waitFor('deliver');
        expect((wallFirst as any).envelope.id).toBe('c2');

        a.close();
        o.close();
        w.close();
      });

      it('a DM between two others is READ by a third seat but never DELIVERED to it — inbox and cursor untouched', async () => {
        const { key } = await team();
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: 'dm-1',
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'Ada',
              to: { kind: 'member', name: 'Lin' },
              act: 'request_help',
              body: 'ada→lin',
              ts: 1000,
            },
          },
          { key, seat: 'Ada' },
        );
        // Visible on the timeline …
        const timeline = await get('/teams/dawn/messages', { key, seat: 'Bo' });
        expect(timeline.json.messages.map((m: any) => m.id)).toContain('dm-1');
        // … and absent from the inbox, which is a delivery surface. A request_help is exactly the act
        // the inbox would pin if it were delivered, so an empty inbox here is the assertion that
        // reading did not become receiving.
        const inbox = await get('/teams/dawn/inbox', { key, seat: 'Bo' });
        expect(inbox.json.messages.map((m: any) => m.id)).not.toContain('dm-1');
        expect(inbox.json.total).toBe(0);
      });
    });

    it('observer seat: watches the firehose but is hidden from roster/count and cannot send (ADR 063)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const tok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, tok);
      const obs = await post(
        '/teams/dawn/members',
        { name: 'wall', kind: 'human', observer: true },
        tok,
      );
      expect(obs.status).toBe(201);

      const a = new TestWs();
      const o = new TestWs();
      await Promise.all([a.open(), o.open()]);
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );
      await o.claim(
        'dawn',
        team.json.agent_key,
        'wall',
        'web',
        await standingGrant(team.json.human_credential, 'wall'),
      );
      await o.subscribe('team-all');

      // The observer is NOT on the roster and does NOT count as a live session, even though connected:
      // Ada + the observer are both connected, but only Ada (a participant) is counted.
      const roster = await get('/teams/dawn', tok);
      expect(roster.json.members.map((m: any) => m.name)).not.toContain('wall');
      expect((await get('/health')).json.connections).toBe(1);

      // A **full-grade** observer (the default, and what the trusted local dashboard mints — ADR 136)
      // has full visibility, so it still receives a directed DM between two others via the firehose.
      // Regular members are recipient-scoped (see the recipient-scoping tests above), and so is a
      // public-grade observer — see the observer-grades block below.
      a.send({
        type: 'send',
        envelope: {
          id: 'obs1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'member', name: 'Lin' },
          act: 'message',
          body: 'seen by the wall',
          ts: Date.now(),
        },
      });
      const deliver = await o.waitFor('deliver');
      expect((deliver as any).envelope.body).toBe('seen by the wall');

      // And it cannot send — observers are read-only.
      const denied = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'obs2',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'wall',
            to: { kind: 'team' },
            act: 'message',
            body: 'should be refused',
            ts: Date.now(),
          },
        },
        obs.json.human_credential, // wall is a human observer — auth with its credential, not the agent key
      );
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe('forbidden');

      a.close();
      o.close();
    });

    it('a message to an offline member surfaces via inbox', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // nick present, Ada offline.
      const n = new TestWs();
      await n.open();
      await n.claim('dawn', nickTok, 'nick', 'cli');
      n.send({
        type: 'send',
        envelope: {
          id: 'mw2',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'Ada' },
          act: 'request_help',
          body: 'help',
          ts: Date.now(),
        },
      });
      await n.waitFor('ack');

      const inbox = await get('/teams/dawn/inbox?unread=1', {
        key: team.json.agent_key,
        seat: 'Ada',
      });
      expect(inbox.json.messages).toHaveLength(1);
      expect(inbox.json.messages[0].act).toBe('request_help');
      n.close();
    });

    it('roster activity reflects working from a status_update, idle when present, offline otherwise', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok); // never connects → offline

      // nick present but idle; Ada present and working.
      const n = new TestWs();
      const a = new TestWs();
      await Promise.all([n.open(), a.open()]);
      await n.claim('dawn', nickTok, 'nick', 'cli');
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      a.send({
        type: 'send',
        envelope: {
          id: 'su1',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from: 'Ada',
          to: { kind: 'team' },
          act: 'status_update',
          body: '',
          meta: { state: 'refactoring auth' },
          ts: Date.now(),
        },
      });
      await a.waitFor('ack');

      const roster = await get('/teams/dawn/members', nickTok);
      const by = (name: string) => roster.json.members.find((m: any) => m.name === name);
      expect((await by('Ada')).activity).toBe('working');
      expect((await by('Ada')).state).toBe('refactoring auth');
      expect((await by('Ada')).posture).toBe('working');
      expect((await by('nick')).activity).toBe('active');
      expect((await by('nick')).state).toBeNull();
      expect((await by('nick')).posture).toBe('active');
      expect((await by('Lin')).activity).toBe('offline');
      expect((await by('Lin')).posture).toBe('offline');
      expect((await by('Lin')).offline_reason).toBe('unknown');

      n.close();
      a.close();
    });

    it('steering marks the driving human working + present without their own heartbeat (ADR 155 Inc 1)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok); // a human who never steers

      // nick does NOT open his own presence. Ada connects, driven by nick.
      const a = new TestWs();
      await a.open();
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
        undefined,
        'nick', // driver
      );

      const roster = await get('/teams/dawn/members', nickTok);
      const by = (name: string) => roster.json.members.find((m: any) => m.name === name);
      // Steering nick reads working + online, derived from Ada's live driver link — no presence row of his own.
      expect((await by('nick')).activity).toBe('working');
      expect((await by('nick')).presence).toBe('online');
      expect((await by('nick')).posture).toBe('working');
      expect((await by('nick')).offline_reason).toBeUndefined();
      // bo, a human who is not steering anyone, still reads offline.
      expect((await by('bo')).activity).toBe('offline');
      expect((await by('bo')).presence).toBe('offline');

      a.close();
    });

    it('an authenticated /live web tab marks the human online (ADR 155 Inc 3)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;

      // The advanced sign-in path: the browser claims nick's own seat with his mscr_ credential,
      // surface 'web' — self-authorizing (ADR 077), fanning out like any human presence (ADR 042).
      const tab = new TestWs();
      await tab.open();
      await tab.claim('dawn', nickTok, 'nick', 'web');

      const roster = await get('/teams/dawn/members', nickTok);
      const nickRow = roster.json.members.find((m: any) => m.name === 'nick');
      expect(nickRow.presence).toBe('online');
      expect(nickRow.presences[0].surface).toBe('web');
      // Tab open, nothing reported → idle, not working (the ladder's online-but-no-task read).
      expect(nickRow.activity).toBe('active');
      expect(nickRow.posture).toBe('active');

      tab.close();
    });

    it("working decays to active past each kind's window — presence timeout for humans, agentIdleMs for agents (ADR 155 Inc 3, presence-honesty §2.1)", async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const tab = new TestWs();
      const a = new TestWs();
      await Promise.all([tab.open(), a.open()]);
      await tab.claim('dawn', nickTok, 'nick', 'web');
      await a.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      const status = (id: string, from: string) => ({
        type: 'send',
        envelope: {
          id,
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from,
          to: { kind: 'team' },
          act: 'status_update',
          body: '',
          meta: { state: 'shipping inc 3' },
          ts: Date.now(),
        },
      });
      tab.send(status('su-nick', 'nick'));
      await tab.waitFor('ack');
      a.send(status('su-ada', 'Ada'));
      await a.waitFor('ack');

      // Fresh status: both read working.
      let roster = await get('/teams/dawn/members', nickTok);
      const by = (r: any, name: string) => r.json.members.find((m: any) => m.name === name);
      expect((await by(roster, 'nick')).activity).toBe('working');
      expect((await by(roster, 'Ada')).activity).toBe('working');

      // Age both statuses past the presence timeout while the presences stay live (the persistent-tab
      // shape: heartbeats keep the human online for hours after the last thing they reported).
      await h.server.store.run("UPDATE messages SET ts = ? WHERE act = 'status_update'", [
        Date.now() - 60_000,
      ]);

      roster = await get('/teams/dawn/members', nickTok);
      // The human decays to active — still online, and the claim is kept with its age
      // (presence-honesty §2.1): state + last_status_at survive for the `last: …` render.
      expect((await by(roster, 'nick')).presence).toBe('online');
      expect((await by(roster, 'nick')).activity).toBe('active');
      expect((await by(roster, 'nick')).state).toBe('shipping inc 3');
      expect((await by(roster, 'nick')).last_status_at).not.toBeNull();
      expect((await by(roster, 'nick')).posture).toBe('active');
      // The agent's window is minutes, not seconds — 60s stale is still fresh evidence.
      expect((await by(roster, 'Ada')).activity).toBe('working');
      expect((await by(roster, 'Ada')).state).toBe('shipping inc 3');

      // Past the agent window (15 min default) the agent decays too, claim kept.
      await h.server.store.run("UPDATE messages SET ts = ? WHERE act = 'status_update'", [
        Date.now() - 16 * 60_000,
      ]);
      roster = await get('/teams/dawn/members', nickTok);
      expect((await by(roster, 'Ada')).activity).toBe('active');
      expect((await by(roster, 'Ada')).state).toBe('shipping inc 3');
      expect((await by(roster, 'Ada')).last_status_at).not.toBeNull();

      tab.close();
      a.close();
    });

    it('sets and exposes a member’s self-declared availability on the roster (ADR 044)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const by = async (name: string) =>
        (await get('/teams/dawn/members', nickTok)).json.members.find((m: any) => m.name === name);

      // default: no availability set (implicit-available).
      expect((await by('nick')).availability).toBeNull();

      // away_until: until rides only `away`.
      const until = Date.now() + 3_600_000;
      const set = await post('/teams/dawn/availability', { status: 'away', until }, nickTok);
      expect(set.status).toBe(200);
      expect(set.json.member.availability).toEqual({ status: 'away', until });
      expect((await by('nick')).availability).toEqual({ status: 'away', until });

      // dnd drops any until (the stored shape stays honest).
      await post('/teams/dawn/availability', { status: 'dnd', until }, nickTok);
      expect((await by('nick')).availability).toEqual({ status: 'dnd' });

      // available returns to the implicit default shape.
      await post('/teams/dawn/availability', { status: 'available' }, nickTok);
      expect((await by('nick')).availability).toEqual({ status: 'available' });

      // a bad status is a 400 bad_request.
      const bad = await post('/teams/dawn/availability', { status: 'vacation' }, nickTok);
      expect(bad.status).toBe(400);

      // unauthenticated is refused.
      const noauth = await post('/teams/dawn/availability', { status: 'away' });
      expect(noauth.status).toBe(401);
    });

    it('WS claim: the team agent key cannot occupy a HUMAN seat, on either branch', async () => {
      // The WS path resolves its target the same way HTTP does, and only the ADR 146 re-seat branch
      // checked seat kind — so both the grant branch and the request branch were open. This asserts
      // the refusal lands before either, i.e. no admin request is ever opened for a poisoned claim.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;

      // Branch 1: WITH a grant (would otherwise occupy immediately).
      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'nick' },
        grant: await standingGrant(nickTok, 'nick'),
        surface: 'claude-code',
      });
      const refusedA = await a.waitFor('refused');
      expect(refusedA.code).toBe('forbidden');
      expect(refusedA.message).toMatch(/human seat "nick" is not reachable/i);
      a.close();

      // Branch 2: WITHOUT a grant (would otherwise open a claim request and hold the socket).
      const b = new TestWs();
      await b.open();
      b.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'nick' },
        surface: 'claude-code',
      });
      const refusedB = await b.waitFor('refused');
      expect(refusedB.code).toBe('forbidden');
      b.close();

      // Neither branch queued anything for an admin.
      const reqs = await get('/teams/dawn/requests', nickTok);
      expect((reqs.json.requests ?? []).length).toBe(0);
    });

    it('WS claim: a seat-scoped bootstrap credential only claims its recorded seat', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
      const scoped = await mintBootstrapCredential(h.server.store, {
        teamId: (await getTeamBySlug(h.server.store, 'dawn'))!.id,
        useKind: 'claim_seat',
        target: 'Ada',
      });
      expect(scoped.credential.first_used_at).toBeNull();

      const mismatch = new TestWs();
      await mismatch.open();
      mismatch.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: scoped.agent_key,
        target: { seat: 'Lin' },
        surface: 'cli',
      });
      expect((await mismatch.waitFor('refused')).message).toMatch(/only claim.*Ada/i);
      mismatch.close();

      const matched = new TestWs();
      await matched.open();
      await matched.claim(
        'dawn',
        scoped.agent_key,
        'Ada',
        'cli',
        await standingGrant(nickTok, 'Ada'),
      );
      expect(
        (
          await h.server.store.get(
            'SELECT first_used_at FROM agent_bootstrap_credentials WHERE id = ?',
            [scoped.credential.id],
          )
        )?.first_used_at,
      ).toEqual(expect.any(Number));
      matched.close();
    });

    it('records provenance + workspace from the claim and surfaces them on the roster (ADR 014)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(team.json.human_credential, 'Ada'),
        surface: 'claude-code',
        provenance: 'session',
        workspace: 'movetrail@feat/login',
      });
      await a.waitFor('occupied');

      const roster = await get('/teams/dawn/members', nickTok);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences[0].provenance).toBe('session');
      expect(adaRow.presences[0].workspace).toBe('movetrail@feat/login');

      a.close();
    });

    // ADR 121/131 §6. `ambientTouch` and (since #1309) the stateless claim both stamp provenance on
    // AGENT seats only; the WS claim was the last path without that gate, so a human frame could
    // declare itself `wake` — the word the wake actuators read to decide a seat is their own child.
    it('a HUMAN seat cannot stamp its own WS occupancy `wake`, while an agent seat records it', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // The human claims their own seat over WS and declares `wake`.
      const h = new TestWs();
      await h.open();
      h.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: nickTok,
        target: { seat: 'nick' },
        surface: 'cli',
        provenance: 'wake',
        workspace: 'repo@main',
      });
      await h.waitFor('occupied');

      // The agent seat declares the same thing, and it IS recorded — the gate is on kind, not on the
      // word, so this test fails if someone "fixes" it by blanket-dropping provenance.
      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(nickTok, 'Ada'),
        surface: 'cli',
        provenance: 'wake',
        workspace: 'repo@main',
      });
      await a.waitFor('occupied');

      const roster = await get('/teams/dawn/members', nickTok);
      const human = roster.json.members.find((m: any) => m.name === 'nick');
      const agent = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(human.presences[0].provenance).toBeNull();
      // The workspace is not gated — it is a location, not an assertion about what animates it.
      expect(human.presences[0].workspace).toBe('repo@main');
      expect(agent.presences[0].provenance).toBe('wake');

      h.close();
      a.close();
    });

    it('records the driver from the claim and surfaces it on the roster (ADR 021)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const a = new TestWs();
      await a.open();
      a.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(team.json.human_credential, 'Ada'),
        surface: 'claude-code',
        provenance: 'session',
        driver: 'nick',
      });
      await a.waitFor('occupied');

      const roster = await get('/teams/dawn/members', nickTok);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences[0].driver).toBe('nick');

      a.close();
    });

    it('a second live session for the same member takes over; the first is superseded (ADR 017)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);

      const a1 = new TestWs();
      await a1.open();
      await a1.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      // The newer session wins: it gets `welcome`, and the older one is told it was superseded.
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

      const superseded = await a1.waitFor('error');
      expect((superseded as any).code).toBe('superseded');

      // Exactly one live presence remains — the new one (single-active still holds).
      const roster = await get('/teams/dawn/members', team.json.human_credential);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences).toHaveLength(1);
      expect(adaRow.presences[0].surface).toBe('cli');

      a1.close();
      a2.close();
    });

    it('a same-workspace claim does NOT supersede the live session (ADR 068)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const live = new TestWs();
      await live.open();
      live.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
      });
      expect((await live.waitFor('occupied')).type).toBe('occupied');

      // A health-check probe (or a reload) briefly spawns the MCP server from the SAME workspace.
      const probe = new TestWs();
      await probe.open();
      probe.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
      });
      expect((await probe.waitFor('occupied')).type).toBe('occupied');

      // The live session must NOT be told it was superseded — the seat doesn't flap.
      await expect(live.waitFor('error', 300)).rejects.toThrow(/timeout/);

      probe.close(); // the probe disconnects, as a real health check does
      live.close();
    });

    it('a re-attach whose LABEL changed but whose workspace_key did not is the same workspace (a branch switch must not evict the live session — lane 01M1JQYYAC)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const live = new TestWs();
      await live.open();
      live.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
        workspace_key: '/Users/x/repo',
      });
      expect((await live.waitFor('occupied')).type).toBe('occupied');

      // The seat detaches HEAD to review a merge SHA. Same folder, same session's worktree — but the
      // label loses its branch qualifier, which is exactly what used to read as a foreign workspace.
      const afterDetach = new TestWs();
      await afterDetach.open();
      afterDetach.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo',
        workspace_key: '/Users/x/repo',
      });
      expect((await afterDetach.waitFor('occupied')).type).toBe('occupied');

      await expect(live.waitFor('error', 300)).rejects.toThrow(/timeout/);
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      expect(
        (await listAudit(h.server.store, teamId)).some(
          (r) => r.action === 'claim.superseded' && JSON.parse(r.detail ?? '{}').via === 'ws',
        ),
      ).toBe(false);

      afterDetach.close();
      live.close();
    });

    it('two different work trees whose folders share a name are still different workspaces (the key sees the collision the label could not)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const first = new TestWs();
      await first.open();
      first.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
        workspace_key: '/Users/x/one/repo',
      });
      expect((await first.waitFor('occupied')).type).toBe('occupied');

      const second = new TestWs();
      await second.open();
      second.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main', // identical label, genuinely different checkout
        workspace_key: '/Users/x/two/repo',
      });
      expect((await second.waitFor('occupied')).type).toBe('occupied');

      const superseded = await first.waitFor('error');
      expect((superseded as any).code).toBe('superseded');

      first.close();
      second.close();
    });

    it("falls back to label equality when a client sends no workspace_key (an old dist keeps exactly today's behaviour)", async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const live = new TestWs();
      await live.open();
      live.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
      });
      expect((await live.waitFor('occupied')).type).toBe('occupied');

      const probe = new TestWs();
      await probe.open();
      probe.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
      });
      expect((await probe.waitFor('occupied')).type).toBe('occupied');
      await expect(live.waitFor('error', 300)).rejects.toThrow(/timeout/);

      probe.close();
      live.close();
    });

    it('a different-workspace claim still supersedes (newest-wins across real sessions, ADR 017/068)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const first = new TestWs();
      await first.open();
      first.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@main',
      });
      expect((await first.waitFor('occupied')).type).toBe('occupied');

      const second = new TestWs();
      await second.open();
      second.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant,
        surface: 'claude-code',
        workspace: 'repo@other', // a genuinely different session
      });
      expect((await second.waitFor('occupied')).type).toBe('occupied');

      const superseded = await first.waitFor('error');
      expect((superseded as any).code).toBe('superseded');
      // Cross-workspace supersession is NOT flagged same_workspace (ADR 092) — the displaced session is a
      // genuinely different one (another machine / branch) and stays dormant rather than self-exiting.
      expect((superseded as any).same_workspace).toBeFalsy();

      // ADR 237: the displacement itself is a ledger fact — this branch used to evict silently,
      // leaving only the winner's claim.occupied (the 2026-08-05 ryder incident's diagnostic gap).
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const row = (await listAudit(h.server.store, teamId)).find(
        (r) => r.action === 'claim.superseded',
      );
      expect(row).toBeDefined();
      const detail = JSON.parse(row!.detail ?? '{}');
      expect(detail).toMatchObject({ same_workspace: false, evicted: 1, via: 'ws' });

      first.close();
      second.close();
    });

    it.each(['missing', 'invalid', 'wrong-target'] as const)(
      'a WS claim with a %s grant leaves the live incumbent attached',
      async (grantCase) => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );

        const incumbent = new TestWs();
        await incumbent.open();
        await incumbent.claim(
          'dawn',
          team.json.agent_key,
          'Ada',
          'claude-code',
          await standingGrant(team.json.human_credential, 'Ada'),
        );

        let grant: string | undefined;
        if (grantCase === 'invalid') grant = 'msgr_invalid';
        if (grantCase === 'wrong-target') {
          await post(
            '/teams/dawn/members',
            { name: 'Bob', kind: 'agent' },
            team.json.human_credential,
          );
          grant = await standingGrant(team.json.human_credential, 'Bob');
        }

        const challenger = new TestWs();
        await challenger.open();
        challenger.send({
          type: 'claim',
          v: PROTOCOL_VERSION,
          team: 'dawn',
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          ...(grant ? { grant } : {}),
          surface: 'cli',
        });
        await challenger.waitFor(grantCase === 'missing' ? 'pending' : 'refused');

        const roster = await get('/teams/dawn/members', team.json.human_credential);
        const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(adaRow.presences).toHaveLength(1);
        expect(adaRow.presences[0].surface).toBe('claude-code');

        incumbent.close();
        challenger.close();
      },
    );

    it.each(['missing', 'invalid', 'wrong-target'] as const)(
      'an HTTP claim with a %s grant leaves the live incumbent attached',
      async (grantCase) => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        await post(
          '/teams/dawn/members',
          { name: 'Ada', kind: 'agent' },
          team.json.human_credential,
        );

        const incumbent = new TestWs();
        await incumbent.open();
        await incumbent.claim(
          'dawn',
          team.json.agent_key,
          'Ada',
          'claude-code',
          await standingGrant(team.json.human_credential, 'Ada'),
        );

        let grant: string | undefined;
        if (grantCase === 'invalid') grant = 'msgr_invalid';
        if (grantCase === 'wrong-target') {
          await post(
            '/teams/dawn/members',
            { name: 'Bob', kind: 'agent' },
            team.json.human_credential,
          );
          grant = await standingGrant(team.json.human_credential, 'Bob');
        }

        const claim = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          ...(grant ? { grant } : {}),
          surface: 'cli',
        });
        expect(claim.status).toBe(grantCase === 'missing' ? 202 : 403);

        const roster = await get('/teams/dawn/members', team.json.human_credential);
        const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(adaRow.presences).toHaveLength(1);
        expect(adaRow.presences[0].surface).toBe('claude-code');

        incumbent.close();
      },
    );

    it('an approved pending WS claim supersedes a live incumbent', async () => {
      const team = await post('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);

      const incumbent = new TestWs();
      await incumbent.open();
      await incumbent.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
        'claude-opus-4-8',
      );

      const challenger = new TestWs();
      await challenger.open();
      challenger.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        surface: 'cli',
      });
      const pending = await challenger.waitFor('pending');

      const decided = await post(
        `/teams/dawn/requests/${pending.request_id}/decide`,
        { decision: 'approve', lifetime: 'standing' },
        team.json.human_credential,
      );
      expect(decided.status).toBe(200);
      expect((await challenger.waitFor('occupied')).type).toBe('occupied');
      expect(await incumbent.waitFor('error')).toMatchObject({ code: 'superseded' });
      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      expect(
        (await listAudit(h.server.store, teamId))
          .filter((row) => row.action === 'occupancy.model_attested')
          .map((row) => JSON.parse(row.detail ?? '{}')),
      ).toContainEqual(
        expect.objectContaining({ old: 'claude-opus-4-8', new: null, source: 'claim' }),
      );

      const roster = await get('/teams/dawn/members', team.json.human_credential);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences).toHaveLength(1);
      expect(adaRow.presences[0].surface).toBe('cli');

      incumbent.close();
      challenger.close();
    });

    it('approving a disconnected pending WS claim preserves the live incumbent', async () => {
      const team = await post('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human' },
      });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);

      const incumbent = new TestWs();
      await incumbent.open();
      await incumbent.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      const challenger = new TestWs();
      await challenger.open();
      challenger.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        surface: 'cli',
      });
      const pending = await challenger.waitFor('pending');
      challenger.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const decided = await post(
        `/teams/dawn/requests/${pending.request_id}/decide`,
        { decision: 'approve', lifetime: 'standing' },
        team.json.human_credential,
      );
      expect(decided.status).toBe(200);
      await expect(incumbent.waitFor('error', 100)).rejects.toThrow(/timeout/);

      const roster = await get('/teams/dawn/members', team.json.human_credential);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences).toHaveLength(1);
      expect(adaRow.presences[0].surface).toBe('claude-code');

      incumbent.close();
    });

    it('an HTTP claim that displaces a live WS session audits the eviction (ADR 237)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const grant = await standingGrant(team.json.human_credential, 'Ada');

      const first = new TestWs();
      await first.open();
      await first.claim('dawn', team.json.agent_key, 'Ada', 'claude-code', grant);

      // A stateless HTTP claim (CLI-style) displaces the live WS incumbent — the other transport's
      // copy of the same silent branch.
      const r = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(team.json.human_credential, 'Ada'),
        surface: 'cli',
      });
      expect(r.json).toMatchObject({ type: 'occupied' });

      const superseded = await first.waitFor('error');
      expect((superseded as any).code).toBe('superseded');

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const row = (await listAudit(h.server.store, teamId)).find(
        (a) => a.action === 'claim.superseded',
      );
      expect(row).toBeDefined();
      const detail = JSON.parse(row!.detail ?? '{}');
      expect(detail).toMatchObject({ same_workspace: false, evicted: 1, via: 'http' });

      first.close();
    });

    it('a repeated authorized HTTP claim replaces its stateless Presence and audits it', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);

      for (let claim = 0; claim < 2; claim++) {
        const response = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(team.json.human_credential, 'Ada'),
          surface: 'cli',
        });
        expect(response.status).toBe(200);
      }

      const roster = await get('/teams/dawn/members', team.json.human_credential);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow.presences).toHaveLength(1);

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const eviction = (await listAudit(h.server.store, teamId)).find(
        (row) => row.action === 'claim.superseded',
      );
      expect(JSON.parse(eviction!.detail ?? '{}')).toMatchObject({
        same_workspace: false,
        evicted: 1,
        via: 'http',
      });
    });

    // The stateless mirror records what animates the session, on EVERY branch that occupies.
    //
    // Two gaps, one route. The 2026-09-04 workspace repair (#1289) added `workspace`/`workspace_key`
    // to this body but edited only the FIRST of three `attach` calls, so its own stated consequences
    // — no location on the roster, and ADR 379's `own_unattested` unable to match a null — survived
    // on the credential and re-seat branches, the latter being the ordinary path for an agent
    // re-claiming its own bound seat. `provenance` was never in the body at all, so every row born
    // here read null while every WS-claimed and ambient-touched row carried a value.
    describe('the stateless claim records provenance and workspace on every occupy branch (ADR 131 §6)', () => {
      it('the grant branch records both', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

        const claimed = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(nickCred, 'Ada'),
          surface: 'cli',
          workspace: 'repo@main',
          provenance: 'wake',
        });
        expect(claimed.status).toBe(200);

        const roster = await get('/teams/dawn/members', nickCred);
        const ada = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(ada.presences[0].provenance).toBe('wake');
        expect(ada.presences[0].workspace).toBe('repo@main');
      });

      it('the credential self-authorize branch records both — it used to hardcode workspace null', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

        // First claim mints Ada's own seat credential (ADR 337).
        const first = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(nickCred, 'Ada'),
          surface: 'cli',
        });
        expect(first.status).toBe(200);

        // Ada reconnects on her OWN credential — no grant, so this is the self-authorize branch.
        const again = await post('/teams/dawn/claim', {
          key: first.json.seat_credential,
          target: { seat: 'Ada' },
          surface: 'cli',
          workspace: 'repo@main',
          provenance: 'wake',
        });
        expect(again.status).toBe(200);

        const roster = await get('/teams/dawn/members', nickCred);
        const ada = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(ada.presences[0].provenance).toBe('wake');
        expect(ada.presences[0].workspace).toBe('repo@main');
      });

      it('the dogfood re-seat branch records both — the ordinary path for an agent re-claiming its own seat (ADR 146)', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

        // Bind the seat, then opt the team into re-seat.
        await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(nickCred, 'Ada'),
          surface: 'cli',
        });
        await post('/teams/dawn/policy', { standing_reseat_known_agents: true }, nickCred);

        // A fresh session, team agent key only, no grant and no credential.
        const reseat = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          surface: 'cli',
          workspace: 'repo@main',
          provenance: 'wake',
        });
        expect(reseat.status).toBe(200);
        expect(reseat.json.type).toBe('occupied');

        const roster = await get('/teams/dawn/members', nickCred);
        const ada = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(ada.presences[0].provenance).toBe('wake');
        expect(ada.presences[0].workspace).toBe('repo@main');
      });

      it('a human seat cannot stamp its own occupancy `wake` (the ADR 121 gate the ambient path already applies)', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;

        // nick self-authorizes on his own credential and claims `wake` — the word the actuators read
        // to conclude a seat is their own spawned child. A human shell must never be able to say it.
        const claimed = await post('/teams/dawn/claim', {
          key: nickCred,
          target: { seat: 'nick' },
          surface: 'cli',
          workspace: 'repo@main',
          provenance: 'wake',
        });
        expect(claimed.status).toBe(200);

        const roster = await get('/teams/dawn/members', nickCred);
        const row = roster.json.members.find((m: any) => m.name === 'nick');
        expect(row.presences[0].provenance).toBeNull();
        // The workspace is not gated — it is a location, not an assertion about what animates it.
        expect(row.presences[0].workspace).toBe('repo@main');
      });

      it('a client that sends no provenance still lands null — additive, not a new default', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

        const claimed = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(nickCred, 'Ada'),
          surface: 'cli',
        });
        expect(claimed.status).toBe(200);

        const roster = await get('/teams/dawn/members', nickCred);
        const ada = roster.json.members.find((m: any) => m.name === 'Ada');
        expect(ada.presences[0].provenance).toBeNull();
      });

      it('refuses a provenance that is not in the vocabulary', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickCred = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickCred);

        const claimed = await post('/teams/dawn/claim', {
          key: team.json.agent_key,
          target: { seat: 'Ada' },
          grant: await standingGrant(nickCred, 'Ada'),
          surface: 'cli',
          provenance: 'definitely-not-a-provenance',
        });
        expect(claimed.status).toBe(400);
      });
    });

    it('a WS claim audits its eviction of a stateless incumbent', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, team.json.human_credential);
      const httpClaim = await post('/teams/dawn/claim', {
        key: team.json.agent_key,
        target: { seat: 'Ada' },
        grant: await standingGrant(team.json.human_credential, 'Ada'),
        surface: 'cli',
      });
      expect(httpClaim.status).toBe(200);

      const ws = new TestWs();
      await ws.open();
      await ws.claim(
        'dawn',
        team.json.agent_key,
        'Ada',
        'claude-code',
        await standingGrant(team.json.human_credential, 'Ada'),
      );

      const teamId = (await getTeamBySlug(h.server.store, 'dawn'))!.id;
      const eviction = (await listAudit(h.server.store, teamId)).find(
        (row) => row.action === 'claim.superseded' && JSON.parse(row.detail ?? '{}').via === 'ws',
      )!;
      expect(JSON.parse(eviction.detail ?? '{}')).toMatchObject({ evicted: 1 });

      ws.close();
    });
  });
});
