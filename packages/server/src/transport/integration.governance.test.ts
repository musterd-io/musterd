import { GENERALIST_CAPABILITIES, PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { listAudit } from '../store/audit.js';
import { getMemberByName, setMemberGovernance } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

withDrivers('integration · governance', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, post, req, standingGrant } = h;

  describe('v0.3 P2 governance enforcement (ADR 071)', () => {
    /** Narrow a seat's effective caps directly (in P1 reconcile is the only writer; tests stand in for it). */
    async function setCaps(
      slug: string,
      name: string,
      partial: Partial<typeof GENERALIST_CAPABILITIES>,
      accountStatus: string | null = null,
    ): void {
      const team = (await getTeamBySlug(h.server.store, slug))!;
      const m = (await getMemberByName(h.server.store, team.id, name))!;
      await setMemberGovernance(
        h.server.store,
        m.id,
        accountStatus,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, ...partial }),
      );
    }
    async function auditRows(slug: string) {
      return await listAudit(h.server.store, (await getTeamBySlug(h.server.store, slug))!.id);
    }
    function urgentEnv(from: string, to: string, id: string) {
      return {
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to: { kind: 'member', name: to },
        act: 'message',
        body: 'ping',
        meta: { urgent: true, urgent_reason: 'prod is down' },
        ts: Date.now(),
      };
    }

    it('creator seat is admin; a non-admin cannot reclaim/remove once an admin exists', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      // The creator-admin default (ADR 071) is on the returned member …
      expect(team.json.member.capabilities.is_admin).toBe(true);
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nickTok);

      // Ada (generalist, not admin) is refused governance now that nick is an admin.
      const denied = await post(
        '/teams/dawn/members/Bob/reclaim',
        {},
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe('forbidden');
      // The admin may.
      const ok = await post('/teams/dawn/members/Bob/reclaim', {}, nickTok);
      expect(ok.status).toBe(200);
      expect(
        (await auditRows('dawn')).some((r) => r.action === 'member.reclaim' && r.actor === 'nick'),
      ).toBe(true);
    });

    it('empty-admin fallback: with no admin on the team, any member may reclaim (no flag day)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Bob', kind: 'agent' }, nickTok);
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await get('/teams/dawn/inbox', ada);
      // Strip the only admin → the team has zero admins → governance falls back to v0.2 open behaviour.
      await setCaps('dawn', 'nick', { is_admin: false });

      const ok = await post('/teams/dawn/members/Bob/reclaim', {}, ada);
      expect(ok.status).toBe(200);
      const entry = (await auditRows('dawn')).find((r) => r.action === 'member.reclaim');
      expect(entry?.detail).toContain('no-admin');
    });

    it('GET /audit is admin-only', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members/Ada/reclaim', {}, nickTok); // write one entry

      const adminView = await get('/teams/dawn/audit', nickTok);
      expect(adminView.status).toBe(200);
      expect(adminView.json.audit.length).toBeGreaterThan(0);
      // nick's own touches write replicated `presence.*` rows beside the reclaim; the reclaim is the
      // entry this case is about.
      const nonPresence = (adminView.json.audit as { action: string }[]).filter(
        (r) => !r.action.startsWith('presence.'),
      );
      expect(nonPresence[0]).toMatchObject({ action: 'member.reclaim', result: 'allow' });

      const nonAdmin = await get('/teams/dawn/audit', { key: team.json.agent_key, seat: 'Ada' });
      expect(nonAdmin.status).toBe(403);
      const anon = await get('/teams/dawn/audit');
      expect(anon.status).toBe(401);
    });

    it('POST /archive soft-archives: admin-only, audited, then the team is invisible everywhere', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // A non-admin seat is refused; the team is untouched.
      const denied = await post(
        '/teams/dawn/archive',
        {},
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(denied.status).toBe(403);
      expect((await getTeamBySlug(h.server.store, 'dawn'))!.archived_at).toBeNull();

      // The admin archives — audited, archived_at lands.
      const ok = await post('/teams/dawn/archive', {}, nickTok);
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ ok: true, team: 'dawn' });
      expect((await getTeamBySlug(h.server.store, 'dawn'))!.archived_at).toBe(ok.json.archived_at);
      expect(
        (await auditRows('dawn')).some((r) => r.action === 'team.archive' && r.actor === 'nick'),
      ).toBe(true);

      // Every team-scoped surface now reads the team as gone — status, roster, even re-auth.
      const status = await get('/teams/dawn');
      expect(status.status).toBe(404);
      expect(status.json.error.message).toContain('archived');
      const roster = await get('/teams/dawn/members');
      expect(roster.status).toBe(404);
      // A second archive can't re-auth (requireTeam refuses) — the state is named, not a stack trace.
      const again = await post('/teams/dawn/archive', {}, nickTok);
      expect(again.status).toBe(404);
      expect(again.json.error.message).toContain('archived');

      // The slug stays taken: history keeps it, and the conflict says why.
      const recreate = await post('/teams', {
        slug: 'dawn',
        creator: { name: 'eve', kind: 'human' },
      });
      expect(recreate.status).toBe(409);
      expect(recreate.json.error.message).toContain('archived');
    });

    it('can_flag_urgent: an allowed seat keeps urgent + is audited; a denied seat is downgraded, not rejected', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential; // human seat → its own credential, not the agent key
      await post('/teams/dawn/members', { name: 'Mut', kind: 'agent' }, nickTok);

      // nick is generalist-ish (can_flag_urgent true) → urgent rides through.
      const allowed = await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-allow') },
        nickTok,
      );
      expect(allowed.status).toBe(201);

      // Mut is narrowed to can_flag_urgent:false → the message still lands, just downgraded.
      await setCaps('dawn', 'Mut', { can_flag_urgent: false });
      const downgraded = await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('Mut', 'Bob', 'u-deny') },
        { key: team.json.agent_key, seat: 'Mut' },
      );
      expect(downgraded.status).toBe(201); // delivered, not rejected

      const inbox = await get('/teams/dawn/inbox', bobTok, { 'x-musterd-no-touch': '1' });
      const msgs = inbox.json.messages as any[];
      const kept = msgs.find((m) => m.id === 'u-allow');
      const down = msgs.find((m) => m.id === 'u-deny');
      expect(kept.meta.urgent).toBe(true);
      expect(down.meta.urgent).toBeUndefined();
      expect(down.meta.wasnt_urgent).toBe(true);

      const audit = await auditRows('dawn');
      expect(audit.some((r) => r.action === 'urgent.flagged' && r.actor === 'nick')).toBe(true);
      expect(audit.some((r) => r.action === 'urgent.denied' && r.actor === 'Mut')).toBe(true);
    });

    it('ADR 225: a client-supplied meta.lane_review is stripped, so acceptance-class cannot be forged', async () => {
      // The interrupt line admits a routed acceptance without the urgent flag. `lane_review` is
      // therefore server-controlled: if a client could set it, any seat could mint an interrupt and
      // route around the scarce, audited can_flag_urgent gate (ADR 071) — the exact bypass that flag
      // exists to prevent. Asserted through the DB, not on the pure predicate, because the strip lives
      // on the send path and the predicate would happily trust a forged marker.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;
      await post('/teams/dawn/members', { name: 'Mut', kind: 'agent' }, nickTok);
      await setCaps('dawn', 'Mut', { can_flag_urgent: false });

      const forged = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            v: PROTOCOL_VERSION,
            id: 'forge-1',
            team: 'dawn',
            from: 'Mut',
            to: { kind: 'member', name: 'Bob' },
            act: 'ask',
            body: 'looks like an acceptance',
            meta: { species: 'approve', tier: 'standard', lane_review: { lane: 'L-fake' } },
            ts: Date.now(),
          },
        },
        { key: team.json.agent_key, seat: 'Mut' },
      );
      expect(forged.status).toBe(201); // delivered, not rejected — it just cannot promote itself

      const inbox = await get('/teams/dawn/inbox', bobTok, { 'x-musterd-no-touch': '1' });
      const forgedMsg = (inbox.json.messages as any[]).find((m) => m.id === 'forge-1');
      expect(forgedMsg.meta.lane_review).toBeUndefined(); // the marker did not survive the send path
      expect(forgedMsg.meta.species).toBe('approve'); // the rest of the meta is untouched

      const check = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(check.json.raised).toBe(false); // and so it never reached the interrupt line
    });

    // ADR 378, lane 01M1PWHGH6. A huddle turn is an ordinary `message` addressed to the room, so it
    // raised nothing at all before this — a participant learned of it at its next inbox check rather
    // than its next tool boundary. And when it did raise it borrowed `urgent`, the scarce flag, which
    // is false twice: the turn is not urgent, and the seat could not tell a huddle from any other act.
    it('interrupt line: a huddle turn raises on its OWN class and the line names the room, not "urgent"', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'human' }, nickTok);

      const root = {
        id: 'h-root',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'why we are huddling',
        meta: {
          eligible: ['Bob', 'Ada'],
          huddle: {
            topic: { kind: 'design', id: 'doorbells' },
            room: 'http://127.0.0.1:4851/b/huddle-h-root',
            anchor: 'docs/wiki/huddles.md',
          },
        },
        ts: Date.now(),
      };
      await post('/teams/dawn/messages', { envelope: root }, nickTok);
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            ...root,
            id: 'h-turn',
            body: 'a turn nobody should have to poll for',
            thread: 'h-root',
            meta: undefined,
            ts: Date.now() + 1,
          },
        },
        nickTok,
      );

      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.raised).toBe(true);
      expect(raised.json.act).toMatchObject({ id: 'h-turn', from: 'nick' });
      expect(raised.json.line).toContain('huddle design:doorbells');
      expect(raised.json.line).toContain('h-root'); // how to answer, in the room it came from
      expect(raised.json.line).not.toContain('urgent'); // it borrowed the scarce flag before
      expect(raised.json.line).not.toContain('nobody should have to poll'); // never the body
    });

    it('interrupt line (ADR 088): raises only for a waiting urgent directed act, composes without the body, audits once', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      // Nothing waiting → silent (raised:false), the free common path.
      const quiet = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(quiet.status).toBe(200);
      expect(quiet.json).toEqual({ raised: false });

      // A NON-urgent directed act does not clear the interrupt bar.
      await post(
        '/teams/dawn/messages',
        { envelope: { ...urgentEnv('nick', 'Bob', 'plain'), meta: undefined, body: 'just fyi' } },
        nickTok,
      );
      const stillQuiet = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(stillQuiet.json).toEqual({ raised: false });

      // An urgent directed act raises: the line is daemon-composed from structured fields, never the body.
      await post('/teams/dawn/messages', { envelope: urgentEnv('nick', 'Bob', 'u-1') }, nickTok);
      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.status).toBe(200);
      expect(raised.json.raised).toBe(true);
      expect(raised.json.count).toBe(1);
      expect(raised.json.act).toMatchObject({ id: 'u-1', from: 'nick', act: 'message' });
      // ADR 442: the line names its team (a multi-team machine is unambiguous) and says it is a
      // pointer — the receiver acts only on its own authenticated read of the act.
      expect(raised.json.line).toMatch(/^⚡ musterd \[dawn\]:/);
      expect(raised.json.line).toContain('pointer only — read it as yourself');
      expect(raised.json.line).toContain('nick');
      expect(raised.json.line).not.toContain('ping'); // §4: never the raw message body

      // Delivery is audited once per (recipient, act) — who grabbed the mic, when, at whom.
      const afterFirst = (await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised');
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]).toMatchObject({ actor: 'nick', target: 'Bob', result: 'allow' });
      expect(afterFirst[0]!.detail).toContain('u-1');

      // The probe re-fires at every tool boundary (cursor untouched), but the audit stays deduped to one.
      const again = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(again.json.raised).toBe(true);
      expect((await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised')).toHaveLength(
        1,
      );
    });

    it('steer act (ADR 103): persists through the DB and raises the interrupt line without an urgent flag', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      // A non-urgent steer — no meta.urgent. It must persist (the v14 migration widened messages.act
      // beyond the frozen v5 CHECK) and, being interrupt-class by definition, raise the line anyway.
      const steer = {
        id: 'st-1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'Bob' },
        act: 'steer',
        body: 'switch to the v2 schema',
        meta: undefined,
        ts: Date.now(),
      };
      const sent = await post('/teams/dawn/messages', { envelope: steer }, nickTok);
      expect(sent.status).toBe(201); // did not fail at the DB CHECK layer

      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.raised).toBe(true);
      expect(raised.json.act).toMatchObject({ id: 'st-1', act: 'steer' });
      expect(raised.json.line).toContain('steer'); // raise class named on the line
      expect(raised.json.line).not.toContain('v2 schema'); // §4: never the raw body

      // Audited with the steer raise class, not a hardcoded 'urgent'.
      const audit = (await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.detail).toContain('steer');
    });

    it('ADR 423 (lane 01M2NH5WT9): the delivery row carries the VERBATIM line and the rail that asked', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-verbatim') },
        nickTok,
      );

      const raised = await get('/teams/dawn/inbox/interrupt-check?rail=claude-code', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.raised).toBe(true);

      const audit = (await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised');
      expect(audit).toHaveLength(1);
      const detail = JSON.parse(audit[0]!.detail as string) as { line?: string; rail?: string };
      // The line is the only field that is NOT reconstructable later: it depends on the queue state
      // at this instant (count, class mix, which act was `latest`), and that state is gone the moment
      // the act discharges. Byte-for-byte against what the seat actually received.
      expect(detail.line).toBe(raised.json.line);
      // The rail is what the contract's clause-1 table needs to cite per harness. It is NOT in hand
      // at the server by construction — `--hook` shapes the CLI's stdout and was never sent.
      expect(detail.rail).toBe('claude-code');
    });

    it('ADR 423: an unparseable rail is recorded as explicitly null, never echoed into the audit log', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-badrail') },
        nickTok,
      );

      const raised = await get(
        '/teams/dawn/inbox/interrupt-check?rail=' + encodeURIComponent('Claude Code <script>'),
        bobTok,
        { 'x-musterd-no-touch': '1' },
      );
      expect(raised.json.raised).toBe(true);

      const audit = (await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised');
      const detail = JSON.parse(audit[0]!.detail as string) as {
        line?: string;
        rail?: string | null;
      };
      // Absence is written, not omitted: the key is present and null, so a reader can tell this
      // caller declared no usable rail from a pre-423 row that never carried the field at all.
      expect(detail.rail).toBeNull();
      expect('rail' in detail).toBe(true);
      expect(audit[0]!.detail).not.toContain('script');
      // The delivery itself is unaffected — a bad rail label must never cost the seat its bell.
      expect(detail.line).toBe(raised.json.line);
    });

    it('ADR 423: a probe run outside a hook records rail: null — the key is written, so "declared none" is not a pre-423 row', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-norail') },
        nickTok,
      );

      // No `?rail=` at all: the CLI omits it when the probe was not run from a hook.
      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.raised).toBe(true);

      const audit = (await auditRows('dawn')).filter((r) => r.action === 'interrupt.raised');
      const detail = JSON.parse(audit[0]!.detail as string) as { rail?: string | null };
      expect('rail' in detail).toBe(true);
      expect(detail.rail).toBeNull();
    });

    it('interrupt line (lane 01M2P69FHZ): names the act id and a by-id read, so the follow-up is one call at any inbox size', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-haystack') },
        nickTok,
      );
      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.raised).toBe(true);

      const line = raised.json.line as string;
      // The id is the payload: without it on the LINE the reader cannot fetch exactly this act, and
      // the line is the only part of the reply that reaches a model (the CLI prints `res.line` alone).
      expect(line).toContain('u-haystack');
      // Both spellings, each carrying the id verbatim so either is copy-pasteable as-is. A reader that
      // holds musterd MCP tools and one that holds only the CLI must each find a call it can make.
      expect(line).toContain('team_inbox_check {ids:["u-haystack"]}');
      expect(line).toContain('musterd inbox --id u-haystack');
      // The bare haystack spelling is what this lane removes: it sent a seat with thousands unread to
      // an unbounded read, and the steer that rang was rendered and never acted on.
      expect(line).not.toContain("run 'musterd inbox' to read it");
      expect(line).not.toContain('ping'); // ADR 088 §4 still holds: never the raw body
      // Lane 01M32WXS59: the line says the by-id read is not the orientation read, so a seat still
      // orienting does its plain read (which carries this act) instead of both.
      expect(line).toMatch(/orienting\? your plain inbox read or wake packet already carries it/);
      expect(line).toContain('do one, not both');
    });

    it('interrupt line (lane 01M2P69FHZ): a multi-act queue points the by-id read at the headline act', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post(
        '/teams/dawn/messages',
        { envelope: urgentEnv('nick', 'Bob', 'u-older') },
        nickTok,
      );
      await post(
        '/teams/dawn/messages',
        { envelope: { ...urgentEnv('nick', 'Bob', 'u-newer'), ts: Date.now() + 1 } },
        nickTok,
      );

      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      expect(raised.json.count).toBe(2);
      const line = raised.json.line as string;
      // The plural line still names ONE act to fetch — the headline the notice is about. Naming the
      // queue without naming a row is the haystack again, one size smaller.
      expect(line).toContain(`team_inbox_check {ids:["${raised.json.act.id}"]}`);
      expect(line).toContain(`musterd inbox --id ${raised.json.act.id}`);
      expect(line).not.toContain("run 'musterd inbox' to read them");
    });

    it('interrupt line (lane 01M2P69FHZ): a huddle turn gets the by-id read too, keeping its answer verb', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      await post('/teams/dawn/members', { name: 'Ada', kind: 'human' }, nickTok);
      const root = {
        id: 'hh-root',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'opening the room',
        meta: {
          eligible: ['Bob', 'Ada'],
          huddle: {
            topic: { kind: 'design', id: 'doorbells' },
            room: 'http://127.0.0.1:4851/b/huddle-hh-root',
            anchor: 'docs/wiki/huddles.md',
          },
        },
        ts: Date.now(),
      };
      await post('/teams/dawn/messages', { envelope: root }, nickTok);
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            ...root,
            id: 'hh-turn',
            body: 'a turn nobody should have to poll for',
            thread: 'hh-root',
            meta: undefined,
            ts: Date.now() + 1,
          },
        },
        nickTok,
      );

      const raised = await get('/teams/dawn/inbox/interrupt-check', bobTok, {
        'x-musterd-no-touch': '1',
      });
      const line = raised.json.line as string;
      // The room and the answer verb are what make a huddle line useful — they stay.
      expect(line).toContain('huddle design:doorbells');
      expect(line).toContain('musterd huddle say hh-root');
      // …but the READ half was the same haystack as every other class, so it gets the same repair.
      expect(line).toContain('team_inbox_check {ids:["hh-turn"]}');
      expect(line).not.toContain("read it with 'musterd inbox'");
      expect(line).not.toContain('nobody should have to poll'); // never the body
    });

    it('defer act (ADR 111, inc3): re-sequences the Goal, bumps its epoch, and wakes the stale lane owner', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const stan = await post('/teams/dawn/members', { name: 'stan', kind: 'human' }, nickTok);
      const stanTok = stan.json.human_credential;

      // Two declared Goals; `spine` is declared last so it leads (ADR 257: newest declaration first).
      await post('/teams/dawn/goals', { id: 'client', title: 'Client' }, nickTok);
      await post('/teams/dawn/goals', { id: 'spine', title: 'Spine' }, nickTok);

      // stan claims a lane on `spine` — building against epoch 0.
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'spine work', goal_id: 'spine', claim: true },
        stanTok,
      );
      expect(lane.status).toBe(201);

      // nick defers `spine` to the back (ts safely after the claim so the lane is provably stale).
      const deferEnv = {
        id: 'df-1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'defer',
        body: 'push spine behind client',
        meta: { goal_id: 'spine' },
        ts: Date.now() + 100_000,
      };
      const sent = await post('/teams/dawn/messages', { envelope: deferEnv }, nickTok);
      expect(sent.status).toBe(201);

      // Teeth #1 — the plan actually moved: `spine` is now `later` (sorts last) on epoch 1, so `next`
      // recommends `client` instead. Derived, no stored column touched.
      const goals = await get('/teams/dawn/goals', nickTok);
      const spine = goals.json.goals.find((g: { id: string }) => g.id === 'spine');
      expect(spine).toMatchObject({ wave: 'later', epoch: 1 });
      const next = await get('/teams/dawn/next', nickTok);
      expect(next.json.next_goal?.id).toBe('client');
      // Lane 01M2GTB0RA: the per-turn summary agrees with the brief it replaces on the hot path.
      const summary = await get('/teams/dawn/next/summary', nickTok);
      expect(summary.status).toBe(200);
      expect(summary.json.carrying).toBe(next.json.in_flight.length);
      expect(summary.json.incidents).toEqual(next.json.incidents.map((i: any) => i.lane));

      // Teeth #2 — targeted invalidation: stan (the stale lane's owner) got a directed stale_plan wake.
      const inbox = await get('/teams/dawn/inbox?unread=1', stanTok);
      const stale = inbox.json.messages.filter(
        (m: { meta?: { lane_warning?: { kind?: string } } }) =>
          m.meta?.lane_warning?.kind === 'stale_plan',
      );
      expect(stale).toHaveLength(1);
      expect(stale[0].meta.lane_warning.subject).toBe(lane.json.lane.id);

      // ...and the board reflects it live.
      const board = await get('/teams/dawn/lanes', stanTok);
      expect(
        board.json.warnings.filter((w: { kind: string }) => w.kind === 'stale_plan'),
      ).toHaveLength(1);
    });

    // ADR 391 (lane 01M1T424MN). During the 2026-09-05 bell check 26 of 102 interrupt probes were
    // refused with 401 and nobody could say WHOSE: `authByAgentSeatCredential` resolves the valid
    // `msac_` credential to a real Member and then throws a generic error on the dead `msls_` lease,
    // discarding the proven identity before the interrupt route can name it, and the request log
    // carries only method/path/status/ms. A deaf seat was identifiable only from its own side.
    describe('a refused interrupt probe names the seat it already proved (ADR 391)', () => {
      async function deafAda() {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential as string;
        await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
        const ada: Auth = { key: team.json.agent_key, seat: 'Ada' };
        // Claim the seat for real (the helper swaps in Ada's msac_ credential + msls_ lease)…
        const live = await get('/teams/dawn/inbox/interrupt-check', ada);
        expect(live.status).toBe(200);
        // …then kill the lease the way an autorefresh bounce does: the row stays, revoked.
        const adaRow = (await getMemberByName(
          h.db,
          (await getTeamBySlug(h.db, 'dawn'))!.id,
          'Ada',
        ))!;
        await h.db.run('UPDATE session_leases SET revoked_at = ? WHERE member_id = ?', [
          Date.now(),
          adaRow.id,
        ]);
        const teamId = (await getTeamBySlug(h.db, 'dawn'))!.id;
        const refusals = async () =>
          (await listAudit(h.db, teamId))
            .filter((r) => r.action === 'interrupt.refused')
            .map((r) => ({
              ...r,
              detail: typeof r.detail === 'string' ? (JSON.parse(r.detail) as unknown) : r.detail,
            }));
        return { nickTok, ada, teamId, refusals };
      }

      it('a valid credential with a dead lease is refused AND audited under the seat name', async () => {
        const { ada, refusals } = await deafAda();
        const probe = await get('/teams/dawn/inbox/interrupt-check', ada);
        expect(probe.status).toBe(401);
        // The caller learns nothing new — the body is the same generic sentence as before.
        expect(probe.json.error.message).toMatch(/agent session lease/);
        expect(JSON.stringify(probe.json)).not.toContain('msac_');
        const rows = await refusals();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.target).toBe('Ada');
        // Lane 01M3TAKT16: the row says WHY the lease is dead — this fixture revoked it.
        expect(rows[0]!.detail).toMatchObject({ lease: 'dead', reason: 'revoked' });
        // Never the credential, never the lease token — the row names a seat, not a secret.
        expect(JSON.stringify(rows[0]!.detail)).not.toMatch(/msac_|msls_/);
      });

      it('deduped: a deaf seat probing at every tool boundary writes one row, not one per probe', async () => {
        const { ada, refusals } = await deafAda();
        for (let i = 0; i < 5; i++) {
          expect((await get('/teams/dawn/inbox/interrupt-check', ada)).status).toBe(401);
        }
        expect(await refusals()).toHaveLength(1);
      });

      it('control: a spoofed x-musterd-seat on an INVALID credential names nobody', async () => {
        const { refusals } = await deafAda();
        const forged = { key: 'msac_definitely_not_a_real_credential', seat: 'Ada' };
        const probe = await get('/teams/dawn/inbox/interrupt-check', forged);
        expect(probe.status).toBe(401);
        // The header said Ada. The credential proved nothing. No row may take the header's word.
        expect(await refusals()).toHaveLength(0);
      });

      it('an expired lease is refused with reason expired, a presence-released one with its own', async () => {
        const { ada, refusals, teamId } = await deafAda();
        const adaRow = (await getMemberByName(h.db, teamId, 'Ada'))!;
        // Un-revoke the fixture's lease and expire it instead.
        await h.db.run(
          'UPDATE session_leases SET revoked_at = NULL, expires_at = ? WHERE member_id = ?',
          [Date.now() - 1000, adaRow.id],
        );
        expect((await get('/teams/dawn/inbox/interrupt-check', ada)).status).toBe(401);
        expect((await refusals())[0]!.detail).toMatchObject({ lease: 'dead', reason: 'expired' });
      });

      // ADR 511. A session start presents the previous session's lease from binding.json, and the
      // claim that cleared that session's Presence took the lease row with it (ON DELETE CASCADE).
      // Until the new adapter's first tool call claims, nobody holds the seat: that is a session
      // that has not joined, not a deaf one — measured 2026-10-05, every `unknown` row since #2036.
      it('a lease whose Presence is gone, with nobody holding the seat, is not_joined', async () => {
        const { ada, refusals, teamId } = await deafAda();
        const adaRow = (await getMemberByName(h.db, teamId, 'Ada'))!;
        await h.db.run('DELETE FROM session_leases WHERE member_id = ?', [adaRow.id]);
        await h.db.run('DELETE FROM presence WHERE member_id = ?', [adaRow.id]);
        expect((await get('/teams/dawn/inbox/interrupt-check', ada)).status).toBe(401);
        expect((await refusals())[0]!.detail).toMatchObject({
          lease: 'dead',
          reason: 'not_joined',
        });
      });

      it('control: an unminted lease while the seat IS held live stays unknown', async () => {
        const { ada, refusals, teamId } = await deafAda();
        const adaRow = (await getMemberByName(h.db, teamId, 'Ada'))!;
        // The live Presence stays; only the lease this caller presents is unknown to the daemon.
        await h.db.run('DELETE FROM session_leases WHERE member_id = ?', [adaRow.id]);
        expect((await get('/teams/dawn/inbox/interrupt-check', ada)).status).toBe(401);
        expect((await refusals())[0]!.detail).toMatchObject({ lease: 'dead', reason: 'unknown' });
      });

      it('control: a missing lease is refused with its own reason', async () => {
        const { ada, refusals } = await deafAda();
        const noLease = { key: ada.key, seat: ada.seat }; // credential valid, no msls_ header at all
        const probe = await get('/teams/dawn/inbox/interrupt-check', noLease);
        expect(probe.status).toBe(401);
        expect(await refusals()).toHaveLength(1);
        expect((await refusals())[0]!.detail).toMatchObject({
          lease: 'missing',
          reason: 'none_presented',
        });
        expect((await refusals())[0]!.detail).toMatchObject({ lease: 'missing' });
      });

      it('control: only the interrupt route audits — an ordinary read with a dead lease stays a plain 401', async () => {
        const { ada, refusals } = await deafAda();
        const read = await get('/teams/dawn/inbox', ada);
        expect(read.status).toBe(401);
        expect(await refusals()).toHaveLength(0);
      });
    });

    // ADR 231. The #653 fix taught the orientation `why` to skip a handoff whose lane had closed —
    // but its test used a SYNTHETIC handoff carrying meta.lane_handoff.lane, and the real instance
    // that motivated it carried none, so the test went green while the bug stayed live. These go
    // through the real send route with a real lane, which is the thing the fixture stood in for.
    describe('a handoff names the lane it hands off (ADR 231)', () => {
      async function twoSeats() {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential;
        const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
        return { nickTok, bobTok: bob.json.human_credential as string };
      }
      const handoff = (id: string) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'Bob' },
        act: 'handoff',
        body: 'over to you',
        ts: Date.now(),
      });

      it("attaches the sender's only live lane, and the stored message carries it", async () => {
        const { nickTok, bobTok } = await twoSeats();
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'the only live lane', branch: 'nick/work', claim: true },
          nickTok,
        );
        const sent = await post('/teams/dawn/messages', { envelope: handoff('h-231a') }, nickTok);
        expect(sent.status).toBe(201);
        expect(sent.json.handoff_lane).toMatchObject({
          lane: lane.json.lane.id,
          branch: 'nick/work',
          source: 'derived',
        });
        // The point of the whole exercise: the PERSISTED envelope carries the lane, so the `why` can
        // judge it. Asserting the ack alone would repeat #653's mistake at a different altitude.
        const inbox = await get('/teams/dawn/inbox', bobTok);
        const got = inbox.json.messages.find((m: { id: string }) => m.id === 'h-231a');
        expect(got.meta.lane_handoff).toMatchObject({
          lane: lane.json.lane.id,
          branch: 'nick/work',
        });
      });

      it('warns without attaching when the sender holds several — and still delivers the message', async () => {
        const { nickTok, bobTok } = await twoSeats();
        await post('/teams/dawn/lanes', { title: 'first', claim: true }, nickTok);
        await post('/teams/dawn/lanes', { title: 'second', claim: true }, nickTok);
        const sent = await post('/teams/dawn/messages', { envelope: handoff('h-231b') }, nickTok);
        expect(sent.status).toBe(201);
        expect(sent.json.handoff_lane.warning).toContain('you hold 2');
        // Warn-never-refuse: the words get through untouched. A message is worth more than a field.
        const inbox = await get('/teams/dawn/inbox', bobTok);
        const got = inbox.json.messages.find((m: { id: string }) => m.id === 'h-231b');
        expect(got.body).toBe('over to you');
        expect(got.meta?.lane_handoff).toBeUndefined();
      });

      it('leaves a genuinely lane-less handoff alone — no lane, no warning, no audit', async () => {
        const { nickTok } = await twoSeats();
        const sent = await post('/teams/dawn/messages', { envelope: handoff('h-231c') }, nickTok);
        expect(sent.status).toBe(201);
        expect(sent.json.handoff_lane).toBeUndefined();
        const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
        expect(
          (await listAudit(h.server.store, team.id, {})).filter((a) =>
            a.action.startsWith('handoff.lane_'),
          ),
        ).toHaveLength(0);
      });

      it('an explicit meta.lane_handoff always wins over the derivation', async () => {
        const { nickTok, bobTok } = await twoSeats();
        await post('/teams/dawn/lanes', { title: 'my live lane', claim: true }, nickTok);
        const env = { ...handoff('h-231d'), meta: { lane_handoff: { lane: 'chosen-by-hand' } } };
        const sent = await post('/teams/dawn/messages', { envelope: env }, nickTok);
        expect(sent.json.handoff_lane).toBeUndefined();
        const inbox = await get('/teams/dawn/inbox', bobTok);
        const got = inbox.json.messages.find((m: { id: string }) => m.id === 'h-231d');
        expect(got.meta.lane_handoff.lane).toBe('chosen-by-hand');
      });

      it('both branches are auditable (ADR 231 Observability)', async () => {
        const { nickTok } = await twoSeats();
        const lane = await post('/teams/dawn/lanes', { title: 'solo', claim: true }, nickTok);
        await post('/teams/dawn/messages', { envelope: handoff('h-231e') }, nickTok);
        await post('/teams/dawn/lanes', { title: 'second', claim: true }, nickTok);
        await post('/teams/dawn/messages', { envelope: handoff('h-231f') }, nickTok);
        const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
        const rows = (await listAudit(h.server.store, team.id, {})).filter((a) =>
          a.action.startsWith('handoff.lane_'),
        );
        expect(rows.map((r) => r.action).sort()).toEqual([
          'handoff.lane_ambiguous',
          'handoff.lane_derived',
        ]);
        const derived = rows.find((r) => r.action === 'handoff.lane_derived')!;
        expect(derived.target).toBe('h-231e');
        expect(JSON.parse(derived.detail!).lane).toBe(lane.json.lane.id);
      });

      it('a done lane is not what you are handing off', async () => {
        const { nickTok } = await twoSeats();
        const done = await post('/teams/dawn/lanes', { title: 'shipped', claim: true }, nickTok);
        await req('PATCH', `/teams/dawn/lanes/${done.json.lane.id}`, { state: 'done' }, nickTok);
        const sent = await post('/teams/dawn/messages', { envelope: handoff('h-231g') }, nickTok);
        expect(sent.json.handoff_lane).toBeUndefined();
      });

      // Doorbell contract clause 7, the shape the inbox had no clause for. MEASURED 2026-09-16 on the
      // laptop daemon: schmidt handed ryder a lane, the lane reached `abandoned` with ryder holding
      // it, and the handoff kept presenting as an open obligation on every check until answered by
      // hand. `handoffNamedLaneOutOfPlay` already decided this for wake candidacy, the orientation
      // `why` and the delivery ledger; GET /inbox was the one reader that never asked it. Its own
      // comment says every reader of a handoff-as-live-instruction must use the same test — #745 is
      // what a second opinion costs, and this is the same defect one surface further out.
      describe('a handoff whose lane has left play is discharged on the inbox', () => {
        it('names the retired lane as the reason, with no answerer invented', async () => {
          const { nickTok, bobTok } = await twoSeats();
          const lane = await post(
            '/teams/dawn/lanes',
            { title: 'handed over', claim: true },
            nickTok,
          );
          await post('/teams/dawn/messages', { envelope: handoff('h-settled') }, nickTok);
          await req('PATCH', `/teams/dawn/lanes/${lane.json.lane.id}`, { state: 'done' }, nickTok);

          const inbox = await get('/teams/dawn/inbox', bobTok);
          expect(inbox.json.discharged).toContainEqual({ id: 'h-settled', reason: 'lane_closed' });
        });

        it('an abandoned lane settles it too — terminal is terminal', async () => {
          const { nickTok, bobTok } = await twoSeats();
          const lane = await post('/teams/dawn/lanes', { title: 'dropped', claim: true }, nickTok);
          await post('/teams/dawn/messages', { envelope: handoff('h-dropped') }, nickTok);
          await req(
            'PATCH',
            `/teams/dawn/lanes/${lane.json.lane.id}`,
            { state: 'abandoned' },
            nickTok,
          );

          const inbox = await get('/teams/dawn/inbox', bobTok);
          expect(inbox.json.discharged).toContainEqual({ id: 'h-dropped', reason: 'lane_closed' });
        });

        // The direction this must never err. A handoff that stops asking is work dropped on the
        // floor; a handoff that asks twice costs a moment. Only one of those is recoverable, which is
        // why `handoffNamedLaneOutOfPlay` is deliberately narrow and why these two stay owed.
        it('a live lane keeps asking', async () => {
          const { nickTok, bobTok } = await twoSeats();
          await post('/teams/dawn/lanes', { title: 'still going', claim: true }, nickTok);
          await post('/teams/dawn/messages', { envelope: handoff('h-live') }, nickTok);

          const inbox = await get('/teams/dawn/inbox', bobTok);
          expect(inbox.json.discharged).toEqual([]);
        });

        it('a handoff naming no lane at all keeps asking', async () => {
          const { nickTok, bobTok } = await twoSeats();
          const bare = { ...handoff('h-bare'), meta: {} };
          await post('/teams/dawn/messages', { envelope: bare }, nickTok);

          const inbox = await get('/teams/dawn/inbox', bobTok);
          expect(inbox.json.discharged).toEqual([]);
        });
      });
    });

    it('delivery ledger (ADR 090): logged → seen (cursor) → answered, on the endpoint and the report', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bob = await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      const bobTok = bob.json.human_credential;

      // nick hands off to Bob.
      const env = { ...urgentEnv('nick', 'Bob', 'h-1'), act: 'handoff' };
      await post('/teams/dawn/messages', { envelope: env }, nickTok);

      // Unseen: the ledger shows logged, and the act sits on the report's open directed ledger.
      let ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
      expect(ledger.status).toBe(200);
      expect(ledger.json).toMatchObject({ id: 'h-1', act: 'handoff', urgent: true });
      expect(ledger.json.recipients).toEqual([
        expect.objectContaining({ seat: 'Bob', seat_id: 'bob', state: 'logged', seen_by: null }),
      ]);
      let report = await get('/teams/dawn/report', nickTok);
      expect(report.json.open_directed.map((d: { id: string }) => d.id)).toContain('h-1');

      // Bob's cursor crosses the act → seen (watermark timestamp, not a receipt).
      await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'h-1' }, bobTok);
      ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
      expect(ledger.json.recipients[0]).toMatchObject({ state: 'seen' });
      expect(ledger.json.recipients[0].seen_by).not.toBeNull();

      // Bob accepts → answered, and the open directed ledger empties.
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            ...urgentEnv('Bob', 'nick', 'a-1'),
            act: 'accept',
            meta: { in_reply_to: 'h-1' },
          },
        },
        bobTok,
      );
      ledger = await get('/teams/dawn/messages/h-1/delivery', bobTok);
      expect(ledger.json.recipients[0]).toMatchObject({ state: 'answered' });
      expect(ledger.json.recipients[0].answered).toMatchObject({ act: 'accept', id: 'a-1' });
      report = await get('/teams/dawn/report', nickTok);
      expect(report.json.open_directed).toHaveLength(0);

      // Unknown act id → 404.
      const missing = await get('/teams/dawn/messages/nope/delivery', bobTok);
      expect(missing.status).toBe(404);
    });

    it('account_status + can_message gate sends', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Bob', kind: 'human' }, nickTok);
      await post('/teams/dawn/members', { name: 'Dis', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Mute', kind: 'agent' }, nickTok);
      const disAuth = { key: team.json.agent_key, seat: 'Dis' };
      const muteAuth = { key: team.json.agent_key, seat: 'Mute' };
      await get('/teams/dawn/inbox', disAuth);
      await get('/teams/dawn/inbox', muteAuth);

      await setCaps('dawn', 'Dis', {}, 'disabled');
      await setCaps('dawn', 'Mute', { can_message: 'none' });

      const baseEnv = (from: string, id: string) => ({
        id,
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from,
        to: { kind: 'member', name: 'Bob' },
        act: 'message',
        body: 'hi',
        ts: Date.now(),
      });
      const disabled = await post(
        '/teams/dawn/messages',
        { envelope: baseEnv('Dis', 'd1') },
        disAuth,
      );
      expect(disabled.status).toBe(403);
      const muted = await post(
        '/teams/dawn/messages',
        { envelope: baseEnv('Mute', 'm1') },
        muteAuth,
      );
      expect(muted.status).toBe(403);
      const audit = await auditRows('dawn');
      // An inert account is refused at authentication, before the send route has an action to audit.
      expect(audit.filter((r) => r.action === 'send.denied').length).toBe(1);
    });

    it('banned = inert: a disabled/banned seat cannot READ the inbox or firehose either (defense-in-depth)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Dis', kind: 'agent' }, nickTok);
      const auth = { key: team.json.agent_key as string, seat: 'Dis' };

      // Active, it reads fine...
      expect((await get('/teams/dawn/inbox', auth)).status).toBe(200);
      expect((await get('/teams/dawn/messages', auth)).status).toBe(200);

      // ...then disabling it closes BOTH reads (the send gate already blocked its sends). Banned means out.
      await setCaps('dawn', 'Dis', {}, 'disabled');
      expect((await get('/teams/dawn/inbox', auth)).status).toBe(403);
      expect((await get('/teams/dawn/messages', auth)).status).toBe(403);
    });

    it.each(['disabled', 'banned', 'archived'])(
      'an %s agent credential cannot update availability',
      async (accountStatus) => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'Dis', kind: 'agent' }, nickTok);
        const disAuth = { key: team.json.agent_key as string, seat: 'Dis' };
        await get('/teams/dawn/inbox', disAuth);
        await setCaps('dawn', 'Dis', {}, accountStatus);

        const res = await post('/teams/dawn/availability', { status: 'away' }, disAuth);
        expect(res.status).toBe(403);
      },
    );

    it('a banned admin credential cannot change team policy', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await setCaps('dawn', 'nick', { is_admin: true }, 'banned');

      const res = await post('/teams/dawn/policy', { allow_pre_issued_grants: true }, nickTok);
      expect(res.status).toBe(403);
    });

    it('visibility_level: a non-admin viewer sees its own caps but not other seats’ authority map', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // Admin sees every seat's caps.
      const adminView = await get('/teams/dawn/members', nickTok);
      expect(adminView.json.members.find((m: any) => m.name === 'nick').capabilities).toBeDefined();
      expect(adminView.json.members.find((m: any) => m.name === 'Ada').capabilities).toBeDefined();

      // Ada (team-level) sees her own caps but not nick's.
      const adaView = await get('/teams/dawn/members', { key: team.json.agent_key, seat: 'Ada' });
      expect(adaView.json.members.find((m: any) => m.name === 'Ada').capabilities).toBeDefined();
      expect(adaView.json.members.find((m: any) => m.name === 'nick').capabilities).toBeUndefined();
      // Handles/roles/presence still visible — only the authority map is hidden.
      expect(adaView.json.members.find((m: any) => m.name === 'nick').name).toBe('nick');

      // Anonymous read → no caps at all.
      const anon = await get('/teams/dawn/members');
      expect(anon.json.members.every((m: any) => m.capabilities === undefined)).toBe(true);
    });

    it('can_observe: a seat narrowed to can_observe:false is refused the firehose', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      // An AGENT seat: this test is about capability narrowing, and it previously claimed a plain
      // human seat with the team agent key — which the install-topology L1 seat-kind guard now
      // refuses. The kind was incidental to what is being asserted here.
      await post('/teams/dawn/members', { name: 'Watcher', kind: 'agent' }, nickTok);
      await setCaps('dawn', 'Watcher', { can_observe: false });

      const w = new TestWs();
      await w.open();
      await w.claim(
        'dawn',
        team.json.agent_key,
        'Watcher',
        'cli',
        await standingGrant(team.json.human_credential, 'Watcher'),
      );
      w.send({ type: 'subscribe', scope: 'team-all' });
      const err = await w.waitFor('error');
      expect((err as any).code).toBe('forbidden');
      expect((await auditRows('dawn')).some((r) => r.action === 'observe.denied')).toBe(true);
      w.close();
    });

    // ── v0.3 P3.1 credential/grant admin endpoints (ADR 076) ───────────────────────────────────────
    it('issues a grant (msgr_, shown once), lists it without the secret, and revokes it', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;

      const issued = await post(
        '/teams/dawn/grants',
        { scope: 'seat', target: 'Ada', lifetime: 'once' },
        nickTok,
      );
      expect(issued.status).toBe(201);
      expect(issued.json.token).toMatch(/^msgr_/);
      expect(issued.json.grant.single_use).toBe(true);
      expect(
        (await auditRows('dawn')).some((r) => r.action === 'grant.issue' && r.actor === 'nick'),
      ).toBe(true);
      const issue = (await auditRows('dawn')).find((r) => r.action === 'grant.issue')!;
      expect(JSON.parse(issue.detail!).authorized_by).toBe('nick');

      // listed without the secret token/hash
      const list = await get('/teams/dawn/grants', nickTok);
      expect(list.status).toBe(200);
      expect(list.json.grants).toHaveLength(1);
      expect(JSON.stringify(list.json.grants[0])).not.toContain('msgr_');
      expect(list.json.grants[0]).not.toHaveProperty('token_hash');

      const id = issued.json.grant.id;
      const revoked = await fetch(`${h.base}/teams/dawn/grants/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${nickTok}` },
      });
      expect(revoked.status).toBe(200);
      expect((await auditRows('dawn')).some((r) => r.action === 'grant.revoke')).toBe(true);
      // a second revoke of the same id is a 404 (already revoked)
      const again = await fetch(`${h.base}/teams/dawn/grants/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${nickTok}` },
      });
      expect(again.status).toBe(404);
    });

    it('rotates the team agent key (mskey_, shown once) + sets policy — both audited', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;

      const key = await post('/teams/dawn/agent-key/rotate', {}, nickTok);
      expect(key.status).toBe(200);
      expect(key.json.agent_key).toMatch(/^mskey_/);
      expect((await auditRows('dawn')).some((r) => r.action === 'key.rotate')).toBe(true);

      const pol = await post('/teams/dawn/policy', { allow_pre_issued_grants: true }, nickTok);
      expect(pol.status).toBe(200);
      expect(pol.json.policy.allow_pre_issued_grants).toBe(true);
      expect((await auditRows('dawn')).some((r) => r.action === 'policy.change')).toBe(true);
    });

    it('the P3.1 admin endpoints are is_admin-only (a non-admin is 403)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      const denied = await post(
        '/teams/dawn/grants',
        { scope: 'seat', target: 'Ada', lifetime: 'standing' },
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe('forbidden');
      const key = await post(
        '/teams/dawn/agent-key/rotate',
        {},
        { key: team.json.agent_key, seat: 'Ada' },
      );
      expect(key.status).toBe(403);
    });
  });
});
