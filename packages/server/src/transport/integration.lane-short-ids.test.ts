import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { getLane, insertLaneSnapshot } from '../store/lanes.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness } from './integration.helpers.js';

/**
 * ADR 582 §2 over the wire: a seat types the lane id it reads, and acts, `report` and the launcher
 * print 10 characters. `lane_claim 01M4VA7NQG` said `no lane` on 2026-10-13. Every caller-supplied
 * lane id — the `/lanes/:id` path, and the ids a body names in `depends_on` / `follows_up` — now
 * resolves a unique prefix, and refuses an ambiguous or too-short one with the reason.
 */
withDrivers('integration · lane short ids', (_o, kind) => {
  const h = integrationHarness(kind);
  const { authHeaders, post } = h;

  const patch = (slug: string, id: string, body: unknown, tok: string) =>
    fetch(h.base + `/teams/${slug}/lanes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders(tok) },
      body: JSON.stringify(body),
    });

  async function team(slug: string) {
    const t = await post('/teams', { slug, creator: { name: 'nick', kind: 'human' } });
    return t.json.human_credential as string;
  }

  describe('the /lanes/:id path (ADR 582)', () => {
    it('claims a lane by the 10-character prefix a seat reads', async () => {
      const tok = await team('short');
      const lane = (await post('/teams/short/lanes', { title: 'by prefix' }, tok)).json.lane;
      const res = await patch('short', lane.id.slice(0, 10), { owner_seat: 'nick' }, tok);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lane: { id: string; owner_seat: string } };
      expect(body.lane.id).toBe(lane.id);
      expect(body.lane.owner_seat).toBe('nick');
    });

    it('refuses an ambiguous prefix with 409 and names both lanes', async () => {
      const tok = await team('twins');
      const base = (await post('/teams/twins/lanes', { title: 'base' }, tok)).json.lane;
      const t = (await getTeamBySlug(h.server.store, 'twins'))!;
      await insertLaneSnapshot(h.server.store, t.id, {
        ...base,
        id: '01AAAAAAAAB000000000000000',
        title: 'twin a',
      });
      await insertLaneSnapshot(h.server.store, t.id, {
        ...base,
        id: '01AAAAAAAAC000000000000000',
        title: 'twin b',
      });
      const res = await patch('twins', '01AAAAAAAA', { owner_seat: 'nick' }, tok);
      expect(res.status).toBe(409);
      const msg = ((await res.json()) as { error: { message: string } }).error.message;
      expect(msg).toContain('twin a');
      expect(msg).toContain('twin b');
      // Neither lane moved.
      expect(
        (await getLane(h.server.store, t.id, '01AAAAAAAAB000000000000000', 'twins'))?.owner_seat,
      ).toBeNull();
    });

    it('refuses a prefix under 8 characters with 400, and a miss with 404', async () => {
      const tok = await team('tiny');
      const lane = (await post('/teams/tiny/lanes', { title: 'x' }, tok)).json.lane;
      const short = await patch('tiny', lane.id.slice(0, 7), { owner_seat: 'nick' }, tok);
      expect(short.status).toBe(400);
      expect(((await short.json()) as { error: { message: string } }).error.message).toContain(
        'at least 8 characters',
      );
      expect((await patch('tiny', 'ZZZZZZZZZZ', { owner_seat: 'nick' }, tok)).status).toBe(404);
    });
  });

  describe('lane ids a body names (ADR 582)', () => {
    it('stores depends_on and follows_up prefixes as full ids', async () => {
      const tok = await team('named');
      // A lane with a tail is a plan, and a plan is a Goal (ADR 487).
      await post('/teams/named/goals', { id: 'plan', title: 'the plan' }, tok);
      const dep = (await post('/teams/named/lanes', { title: 'dependency' }, tok)).json.lane;
      const next = (
        await post('/teams/named/lanes', { title: 'what is left', goal_id: 'plan' }, tok)
      ).json.lane;
      const opened = await post(
        '/teams/named/lanes',
        { title: 'part 1 of 2', depends_on: [dep.id.slice(0, 10)], claim: true, goal_id: 'plan' },
        tok,
      );
      expect(opened.json.lane.depends_on).toEqual([dep.id]);
      const closed = await patch(
        'named',
        opened.json.lane.id.slice(0, 10),
        { state: 'done', follows_up: [next.id.slice(0, 10)] },
        tok,
      );
      if (closed.status !== 200) throw new Error(await closed.text());
      expect(closed.status).toBe(200);
      const body = (await closed.json()) as { lane: { follows_up: string[] } };
      expect(body.lane.follows_up).toEqual([next.id]);
    });

    it('keeps an unknown depends_on id as written — the contention check warns about it', async () => {
      const tok = await team('unknown');
      const opened = await post(
        '/teams/unknown/lanes',
        { title: 'x', depends_on: ['NOTALANEID'] },
        tok,
      );
      expect(opened.json.lane.depends_on).toEqual(['NOTALANEID']);
    });
  });
});
