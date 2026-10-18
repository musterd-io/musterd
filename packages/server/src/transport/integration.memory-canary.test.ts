import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

/**
 * The seat-memory canary, API half (docs/design/seat-memory-isolation.md §"The test that proves it",
 * lane 01M561YJYQ). One agent seat tries every API path against another seat's note — to READ it and
 * to OVERWRITE it — and one human tries to read another human's note. It fails if any response
 * carries the note's text, or if a write lands without the owner's next read flagging it.
 *
 * The rules under test: ADR 093 (own-seat routes), ADR 651 (who reads a note), ADR 654 (a note says
 * who saved it). The sweep scans every GET route a seat can reach, so a new route that leaks a note
 * fails here without anyone having to remember to add it. The OS half (the database file and the
 * binding on disk) is lane 01M561ZCDS, on the hosted image.
 */
withDrivers('integration · memory canary', (_o, kind) => {
  const h = integrationHarness(kind);
  const { get, post, req, standingGrant } = h;

  /** Every GET route under /teams/:slug (http.ts), plus the query forms that change what a route
   *  returns. `/stream/epitaph` is left out: it holds the connection open. */
  const GET_ROUTES = [
    '',
    '/agent-bootstrap-credentials',
    '/agent-bootstrap-cutover',
    '/audit',
    '/calendar',
    '/dream',
    '/enforcement',
    '/footprint',
    '/goals',
    '/governed/policy',
    '/grants',
    '/guardian-tiers',
    '/holds',
    '/host/provisions',
    '/inbox',
    '/inbox?unread=1',
    '/inbox/interrupt-check',
    '/invites',
    '/lanes',
    '/local-identity',
    '/members',
    '/members/Ada/memory',
    '/members/Bo/memory',
    '/memory',
    '/memory?envelope=1',
    '/memory/search?q=canary',
    '/messages',
    '/next',
    '/next/summary',
    '/nodes',
    '/policy',
    '/report',
    '/report/trace',
    '/requests',
    '/residency',
    '/review-promises',
    '/seeds',
    '/style-block',
    '/sync/lanes',
    '/sync/pull',
  ];

  const ADA_HEADLINE = 'ADA-HEADLINE-CANARY';
  const ADA_BODY = 'ada-body-canary-7f3e';
  const BO_HEADLINE = 'BO-HEADLINE-CANARY';
  const BO_BODY = 'bo-body-canary-91c2';

  /** Claim `seat` as a session in `workspace`, the way a harness does, and return its auth. A seat's
   *  credential is shown once, on its first claim; a later claim returns only a fresh lease, used
   *  with the credential already held (`heldKey`) — for path 4, the copied one. */
  async function claimFrom(
    nickTok: string,
    agentKey: string,
    seat: string,
    workspace: string,
    heldKey?: string,
  ) {
    const grant = await standingGrant(nickTok, seat);
    const claim = await post('/teams/dawn/claim', {
      key: agentKey,
      target: { seat },
      grant,
      surface: 'claude-code',
      workspace,
    });
    expect(claim.status, `claim ${seat} from ${workspace}`).toBe(200);
    return {
      key: (claim.json.seat_credential as string | undefined) ?? heldKey!,
      seat,
      sessionLease: claim.json.session_lease as string,
    } satisfies Auth;
  }

  /** A team with two agent seats (Ada the owner, Lin the prober), two humans (nick the admin, Bo),
   *  and a note on Ada and on Bo. Ada also owns a lane and holds a directed act, so the wake packet
   *  routes have something of hers to be asked for. */
  async function seed() {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    const agentKey = team.json.agent_key as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
    const bo = await post('/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickTok);
    const boTok = bo.json.human_credential as string;

    const ada = await claimFrom(nickTok, agentKey, 'Ada', 'ada');
    const lin = await claimFrom(nickTok, agentKey, 'Lin', 'lin');
    expect(
      (await req('PUT', '/teams/dawn/memory', { headline: ADA_HEADLINE, body: ADA_BODY }, ada))
        .status,
    ).toBe(204);
    expect(
      (await req('PUT', '/teams/dawn/memory', { headline: BO_HEADLINE, body: BO_BODY }, boTok))
        .status,
    ).toBe(204);
    const lane = await post('/teams/dawn/lanes', { title: 'ada work', claim: true }, ada);
    const act = await post(
      '/teams/dawn/messages',
      { to: 'Ada', act: 'request_help', body: 'need a hand' },
      nickTok,
    );
    return {
      nickTok,
      boTok,
      agentKey,
      ada,
      lin,
      laneId: lane.json.lane.id as string,
      actId: act.json.id as string | undefined,
    };
  }

  /** The whole response text — status and body — so a leak in an error message counts too. */
  async function sweep(auth: Auth): Promise<{ route: string; status: number; text: string }[]> {
    const out: { route: string; status: number; text: string }[] = [];
    for (const route of GET_ROUTES) {
      const r = await get(`/teams/dawn${route}`, auth);
      out.push({ route, status: r.status, text: JSON.stringify(r.json) });
    }
    return out;
  }

  function leaks(
    rows: { route: string; text: string }[],
    needles: string[],
  ): { route: string; needle: string }[] {
    return rows.flatMap((r) =>
      needles.filter((n) => r.text.includes(n)).map((needle) => ({ route: r.route, needle })),
    );
  }

  describe('an agent seat probing another seat', () => {
    it('reads no other note by any GET route, by the wake packet, or by naming the seat', async () => {
      const s = await seed();
      const needles = [ADA_HEADLINE, ADA_BODY, BO_HEADLINE, BO_BODY];
      expect(leaks(await sweep(s.lin), needles)).toEqual([]);

      // The wake packet carries the caller's own note only, and refuses a target that is Ada's.
      const byLane = await post('/teams/dawn/wake-context', { lane_id: s.laneId }, s.lin);
      expect(byLane.status).toBe(403);
      if (s.actId) {
        const byAct = await post('/teams/dawn/wake-context', { act_id: s.actId }, s.lin);
        expect(byAct.status).toBe(403);
        expect(JSON.stringify(byAct.json)).not.toContain(ADA_BODY);
      }
      expect(JSON.stringify(byLane.json)).not.toContain(ADA_BODY);

      // Naming Ada with Lin's credential is refused, not answered with Ada's note.
      const named = await fetch(h.base + '/teams/dawn/memory', {
        headers: {
          authorization: `Bearer ${s.lin.key}`,
          'x-musterd-session-lease': s.lin.sessionLease,
          'x-musterd-seat': 'Ada',
        },
      });
      expect(named.status).toBe(403);
      expect(await named.text()).not.toContain(ADA_BODY);
    });

    it("cannot overwrite or clear another seat's note: every write path is refused or lands on its own seat", async () => {
      const s = await seed();
      const asAda = {
        authorization: `Bearer ${s.lin.key}`,
        'x-musterd-session-lease': s.lin.sessionLease,
        'x-musterd-seat': 'Ada',
        'content-type': 'application/json',
      };
      const put = await fetch(h.base + '/teams/dawn/memory', {
        method: 'PUT',
        headers: asAda,
        body: JSON.stringify({ headline: 'pwned', body: 'pwned' }),
      });
      expect(put.status).toBe(403);
      const del = await fetch(h.base + '/teams/dawn/memory', { method: 'DELETE', headers: asAda });
      expect(del.status).toBe(403);
      // No route takes a member name for a write.
      for (const method of ['PUT', 'DELETE'] as const) {
        const r = await req(method, '/teams/dawn/members/Ada/memory', { headline: 'pwned' }, s.lin);
        expect(r.status, `${method} /members/Ada/memory`).toBeGreaterThanOrEqual(400);
      }
      // Lin's own save is Lin's.
      await req('PUT', '/teams/dawn/memory', { headline: 'lin own', body: 'lin' }, s.lin);

      const mine = await get('/teams/dawn/memory', s.ada);
      expect(mine.json).toMatchObject({ headline: ADA_HEADLINE, body: ADA_BODY });
      expect(mine.json.provenance.suspect).toBe(false);
    });

    it("a write through a credential fresh-claimed from another folder lands, and the owner's next read flags it (path 4)", async () => {
      const s = await seed();
      // Something that copied Ada's credential claims a fresh lease from Lin's folder and saves.
      const intruder = await claimFrom(s.nickTok, s.agentKey, 'Ada', 'lin', s.ada.key);
      expect(
        (await req('PUT', '/teams/dawn/memory', { headline: 'do X now', body: 'pwned' }, intruder))
          .status,
      ).toBe(204);

      // Ada's next session, back in her own folder, is told before it acts on the note.
      const back = await claimFrom(s.nickTok, s.agentKey, 'Ada', 'ada', s.ada.key);
      const read = await get('/teams/dawn/memory', back);
      expect(read.json.body).toBe('pwned');
      expect(read.json.provenance).toMatchObject({ suspect: true });
      expect(read.json.provenance.line).toMatch(
        /last saved from lin .*not this seat's folder \(ada\)/,
      );
      const env = await get('/teams/dawn/memory?envelope=1', back);
      expect(env.json.provenance.suspect).toBe(true);
      const lane = await post('/teams/dawn/wake-context', { lane_id: s.laneId }, back);
      expect(lane.json.context.context.memory.provenance.suspect).toBe(true);
    });

    it('an intruder who wipes its own folder first is still flagged: a save with no folder is not placeable', async () => {
      // A socketless session's ambient touch rewrites its Presence with no Workspace label, so one
      // ordinary GET before the save would have erased "lin" from the stamp. The canary found that;
      // ADR 654 decision 3 (amended 2026-10-18) reads a folderless writer as another place.
      const s = await seed();
      const intruder = await claimFrom(s.nickTok, s.agentKey, 'Ada', 'lin', s.ada.key);
      await get('/teams/dawn/inbox', intruder);
      await req('PUT', '/teams/dawn/memory', { headline: 'do X now', body: 'pwned' }, intruder);
      const back = await claimFrom(s.nickTok, s.agentKey, 'Ada', 'ada', s.ada.key);
      const read = await get('/teams/dawn/memory', back);
      expect(read.json.provenance.writer).not.toHaveProperty('workspace');
      expect(read.json.provenance).toMatchObject({ suspect: true });
      expect(read.json.provenance.line).toMatch(
        /an unnamed folder .*not this seat's folder \(ada\)/,
      );
    });

    it("the known gap: a lease replayed from the owner's own session is not flagged (ADR 654 decision 5)", async () => {
      // Copying binding.json's credential and lease and replaying them looks exactly like Ada's own
      // session, so nothing can flag it at the API. This pins the gap so it stays stated: the day it
      // flips, ADR 654's "not suspect never means verified" can be revisited. The hosted tier (one OS
      // user per seat, lane 01M561Z0W3) is what stops the copy.
      const s = await seed();
      const replay = { ...s.ada };
      await req('PUT', '/teams/dawn/memory', { headline: 'replayed', body: 'pwned' }, replay);
      const read = await get('/teams/dawn/memory', s.ada);
      expect(read.json.body).toBe('pwned');
      expect(read.json.provenance.suspect).toBe(false);
    });
  });

  describe("a human probing another human's note", () => {
    it("reads no other human's note by any GET route, admin or not; /audit keeps only its sizes", async () => {
      const s = await seed();
      // nick is an admin, which is the stronger case: /audit, /grants and /requests answer him.
      const asNick = await sweep(s.nickTok);
      expect(leaks(asNick, [BO_HEADLINE, BO_BODY])).toEqual([]);
      expect(asNick.find((r) => r.route === '/members/Bo/memory')!.status).toBe(403);
      // Humans DO read agent notes (ADR 651), so the agent canary is expected for him — the sweep is
      // only blind to it by construction, not by accident.
      expect(asNick.find((r) => r.route === '/members/Ada/memory')!.text).toContain(ADA_BODY);

      const audit = await get('/teams/dawn/audit', s.nickTok);
      const boRow = (audit.json.audit as { action: string; target: string; detail: any }[]).find(
        (r) => r.action === 'continuity.memory_saved' && r.target === 'Bo',
      )!;
      expect(boRow.detail).toMatchObject({ headline_len: BO_HEADLINE.length });
      expect(boRow.detail).not.toHaveProperty('writer');
    });

    it("cannot overwrite another human's note: a save lands on the caller's own seat", async () => {
      const s = await seed();
      await req('PUT', '/teams/dawn/memory', { headline: 'nick own', body: 'nick' }, s.nickTok);
      const bo = await get('/teams/dawn/memory', s.boTok);
      expect(bo.json).toMatchObject({ headline: BO_HEADLINE, body: BO_BODY });
    });
  });
});
