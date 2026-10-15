import { LaneDetailSchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

/**
 * ADR 582 §4 over the wire: `GET /lanes/:id` is one lane in full — what reviewing a lane meant reading
 * the DB for. Done when an acceptor can review and reply from this read alone: the brief, the owner
 * and state history, the merge, and the standing acceptance ask's id to `reply_to`.
 */
withDrivers('integration · lane detail', (_o, kind) => {
  const h = integrationHarness(kind);
  const { authHeaders, get, post, reattestAgentModel, resolveAuth } = h;

  async function setup(slug: string) {
    const team = await post('/teams', { slug, creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    await post(`/teams/${slug}/members`, { name: 'ada', kind: 'agent' }, nickTok);
    await post(`/teams/${slug}/members`, { name: 'gee', kind: 'agent' }, nickTok);
    const seat = async (name: string) =>
      (await resolveAuth(`/teams/${slug}/inbox`, { key: team.json.agent_key, seat: name }))!;
    const ada = await seat('ada');
    const gee = await seat('gee');
    await reattestAgentModel(slug, ada, 'claude-opus-5');
    await reattestAgentModel(slug, gee, 'gpt-5.2-codex');
    await get(`/teams/${slug}/inbox`, nickTok);
    return { nickTok, ada, gee };
  }

  const patch = async (slug: string, id: string, body: unknown, auth: Auth) => {
    const r = await fetch(h.base + `/teams/${slug}/lanes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(auth) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  describe('GET /lanes/:id (ADR 582 §4)', () => {
    it('returns the lane, its history oldest first, and no ask while it is open work', async () => {
      const { ada } = await setup('show');
      const lane = (
        await post(
          '/teams/show/lanes',
          { title: 'one lane', detail: 'the brief', claim: true },
          ada,
        )
      ).json.lane;
      await patch('show', lane.id, { state: 'active', branch: 'feat/x' }, ada);

      const res = await get(`/teams/show/lanes/${lane.id.slice(0, 10)}`, ada);
      expect(res.status).toBe(200);
      const body = LaneDetailSchema.parse(res.json);
      expect(body.lane.id).toBe(lane.id);
      expect(body.lane.detail).toBe('the brief');
      expect(body.acceptance_ask).toBeNull();
      const actions = body.history.map((e) => e.action);
      expect(actions[0]).toBe('lane.opened');
      expect(actions).toContain('lane.claimed');
      expect(body.history.find((e) => e.action === 'lane.claimed')?.owner).toBe('ada');
      const moved = body.history.find(
        (e) => e.action === 'lane.state_changed' && e.to === 'active',
      );
      expect(moved?.from).toBe('claimed');
      const ts = body.history.map((e) => e.ts);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    });

    it('names the standing acceptance ask by id once the lane is submitted', async () => {
      const { ada } = await setup('ask');
      const lane = (await post('/teams/ask/lanes', { title: 'review me', claim: true }, ada)).json
        .lane;
      const ready = await patch('ask', lane.id, { state: 'ready_for_review' }, ada);
      const reviewer = ready.json.review?.reviewer as string;
      expect(reviewer).toBeDefined();

      const body = LaneDetailSchema.parse((await get(`/teams/ask/lanes/${lane.id}`, ada)).json);
      expect(body.acceptance_ask?.to).toBe(reviewer);
      expect(body.acceptance_ask?.id).toMatch(/^[0-9A-Z]{26}$/);
      expect(body.history.map((e) => e.action)).toContain('lane.ready_for_review');
    });

    it('refuses an ambiguous or short prefix the way PATCH does, and 404s a miss', async () => {
      const { ada } = await setup('miss');
      const lane = (await post('/teams/miss/lanes', { title: 'x' }, ada)).json.lane;
      expect((await get(`/teams/miss/lanes/${lane.id.slice(0, 7)}`, ada)).status).toBe(400);
      expect((await get('/teams/miss/lanes/7ZZZZZZZZZ', ada)).status).toBe(404);
    });
  });
});
