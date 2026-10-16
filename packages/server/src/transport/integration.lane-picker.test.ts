import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

/**
 * ADR 624 / 626 over the wire — the daemon side of the lane picker (lane 01M5162MTC):
 *  - a pick is recorded verbatim on `lane.claimed`, and only its requester may call it attested;
 *  - a release that says why becomes the lane's `declined` note, which any later claim clears.
 */
withDrivers('integration · lane picker', (_o, kind) => {
  const h = integrationHarness(kind);
  const { authHeaders, get, post, resolveAuth } = h;

  async function setup() {
    const team = await post('/teams', { slug: 'pick', creator: { name: 'nick', kind: 'human' } });
    const nick = team.json.human_credential as string;
    await post('/teams/pick/members', { name: 'ada', kind: 'agent' }, nick);
    await post('/teams/pick/members', { name: 'gee', kind: 'agent' }, nick);
    const ada = (await resolveAuth('/teams/pick/inbox', {
      key: team.json.agent_key,
      seat: 'ada',
    }))!;
    const gee = (await resolveAuth('/teams/pick/inbox', {
      key: team.json.agent_key,
      seat: 'gee',
    }))!;
    const lane = (await post('/teams/pick/lanes', { title: 'the work' }, nick)).json.lane;
    return { nick, ada, gee, laneId: lane.id as string };
  }

  async function patch(id: string, body: unknown, auth: Auth) {
    const r = await fetch(h.base + `/teams/pick/lanes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(auth) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  }

  async function rows(nick: string, action: string, laneId: string) {
    const audit = await get('/teams/pick/audit', nick);
    return (audit.json.audit as { action: string; target: string; detail: any }[]).filter(
      (a) => a.action === action && a.target === laneId,
    );
  }

  const terminalPick = { via: 'terminal', requested_by: 'nick', attested: false, at: 1 };

  describe('pick (ADR 624)', () => {
    it('a terminal pick is recorded verbatim on lane.claimed', async () => {
      const { nick, ada, laneId } = await setup();
      const r = await patch(laneId, { owner_seat: 'ada', pick: terminalPick }, ada);
      expect(r.status).toBe(200);
      expect(r.json.lane.owner_seat).toBe('ada');
      const claimed = await rows(nick, 'lane.claimed', laneId);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.detail.pick).toEqual(terminalPick);
      expect(claimed[0]!.detail.kind).toBe('claim');
    });

    it('a seat cannot attest that a human asked — the honest-label rule', async () => {
      const { ada, laneId } = await setup();
      const r = await patch(
        laneId,
        { owner_seat: 'ada', pick: { ...terminalPick, attested: true } },
        ada,
      );
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/attested only when its requester sends it/);
    });

    it('the requester may attest: a human handing the lane over from /live', async () => {
      const { nick, laneId } = await setup();
      const live = { via: 'live', requested_by: 'nick', attested: true, at: 2 };
      const r = await patch(laneId, { owner_seat: 'ada', pick: live }, nick);
      expect(r.status).toBe(200);
      const claimed = await rows(nick, 'lane.claimed', laneId);
      expect(claimed[0]!.detail).toMatchObject({ kind: 'handoff', pick: live });
    });

    it('a pick without owner_seat is refused', async () => {
      const { ada, laneId } = await setup();
      const r = await patch(laneId, { detail: 'x', pick: terminalPick }, ada);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/pick rides a claim or handoff/);
    });

    it('picking a lane the seat already owns changes nothing and records no second claim', async () => {
      const { nick, ada, laneId } = await setup();
      await patch(laneId, { owner_seat: 'ada', pick: terminalPick }, ada);
      const again = await patch(laneId, { owner_seat: 'ada', pick: terminalPick }, ada);
      expect(again.status).toBe(200);
      expect(await rows(nick, 'lane.claimed', laneId)).toHaveLength(1);
    });
  });

  describe('release reason and the decline note (ADR 624)', () => {
    it('a release that says why sets declined; the next claim clears it', async () => {
      const { nick, ada, gee, laneId } = await setup();
      await patch(laneId, { owner_seat: 'ada' }, ada);
      const released = await patch(
        laneId,
        { state: 'open', release_reason: 'needs a second machine' },
        ada,
      );
      expect(released.status).toBe(200);
      expect(released.json.lane.owner_seat).toBeNull();
      expect(released.json.lane.declined).toMatchObject({
        by: 'ada',
        reason: 'needs a second machine',
      });
      expect((await rows(nick, 'lane.released', laneId))[0]!.detail.reason).toBe(
        'needs a second machine',
      );
      // The board carries it, so the picker reads it without a per-lane call.
      const board = await get('/teams/pick/lanes', nick);
      const onBoard = (board.json.lanes as { id: string; declined?: unknown }[]).find(
        (l) => l.id === laneId,
      );
      expect(onBoard?.declined).toMatchObject({ reason: 'needs a second machine' });

      const claimed = await patch(laneId, { owner_seat: 'gee' }, gee);
      expect(claimed.status).toBe(200);
      expect(claimed.json.lane.declined ?? null).toBeNull();
    });

    it('a release without a reason leaves no note', async () => {
      const { ada, laneId } = await setup();
      await patch(laneId, { owner_seat: 'ada' }, ada);
      const r = await patch(laneId, { state: 'open' }, ada);
      expect(r.status).toBe(200);
      expect(r.json.lane.declined ?? null).toBeNull();
    });

    it('release_reason rides a release only', async () => {
      const { ada, laneId } = await setup();
      // On an unowned lane there is nothing to release.
      const unowned = await patch(laneId, { state: 'open', release_reason: 'no' }, ada);
      expect(unowned.status).toBe(400);
      await patch(laneId, { owner_seat: 'ada' }, ada);
      const notRelease = await patch(laneId, { state: 'active', release_reason: 'no' }, ada);
      expect(notRelease.status).toBe(400);
      expect(JSON.stringify(notRelease.json)).toMatch(/release_reason rides a release only/);
    });
  });
});
