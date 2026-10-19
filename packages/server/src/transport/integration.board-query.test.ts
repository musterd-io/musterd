import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness } from './integration.helpers.js';

/**
 * ADR 582 §1 over the wire: one query string over the board. `GET /lanes?q=` and `GET /goals?q=`
 * take the same grammar, and an unknown key is a 400 that names the known ones — a query must
 * never quietly become a text search the seat did not mean.
 */
withDrivers('integration · board query', (_o, kind) => {
  const h = integrationHarness(kind);
  const { get, post, resolveAuth } = h;

  async function setup(slug: string) {
    const team = await post('/teams', { slug, creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    await post(`/teams/${slug}/members`, { name: 'ada', kind: 'agent' }, nickTok);
    const seat = async (name: string) =>
      (await resolveAuth(`/teams/${slug}/inbox`, { key: team.json.agent_key, seat: name }))!;
    const ada = await seat('ada');
    await get(`/teams/${slug}/inbox`, nickTok);
    return { nickTok, ada };
  }

  const open = async (
    slug: string,
    ada: Awaited<ReturnType<typeof setup>>['ada'],
    body: Record<string, unknown>,
  ) => (await post(`/teams/${slug}/lanes`, { claim: true, ...body }, ada)).json.lane;

  const laneIds = (res: { json: { lanes: { id: string }[] } }) => res.json.lanes.map((l) => l.id);

  describe('GET /lanes?q=', () => {
    it('matches bare words over the title and the detail', async () => {
      const { ada } = await setup('q1');
      const a = await open('q1', ada, { title: 'the seat pulse', detail: 'counts and kinds only' });
      const b = await open('q1', ada, {
        title: 'the away relay',
        detail: 'asks reach another machine',
      });

      const hits = await get('/teams/q1/lanes?q=pulse', ada);
      expect(hits.status).toBe(200);
      expect(laneIds(hits)).toEqual([a.id]);

      const both = await get('/teams/q1/lanes?q=machine', ada);
      expect(laneIds(both)).toEqual([b.id]);

      const none = await get('/teams/q1/lanes?q=absent', ada);
      expect(laneIds(none)).toEqual([]);
    });

    it('matches each keyed field', async () => {
      const { ada } = await setup('q2');
      await post('/teams/q2/goals', { id: 'find-work', title: 'Finding work' }, ada);
      const a = await open('q2', ada, {
        title: 'a lane',
        goal_id: 'find-work',
        scope: ['packages/web/src/**'],
        role: 'designer',
        risk: ['user-facing'],
      });
      const b = await open('q2', ada, {
        title: 'another lane',
        scope: ['packages/protocol/src/**'],
      });

      const byGoal = await get('/teams/q2/lanes?q=goal:find-work', ada);
      expect(laneIds(byGoal)).toEqual([a.id]);

      const byArea = await get('/teams/q2/lanes?q=area:ui', ada);
      expect(laneIds(byArea)).toEqual([a.id]);

      const byPath = await get('/teams/q2/lanes?q=path:packages/protocol/src/lanes.ts', ada);
      expect(laneIds(byPath)).toEqual([b.id]);

      const byRole = await get('/teams/q2/lanes?q=role:designer', ada);
      expect(laneIds(byRole)).toEqual([a.id]);

      const byRisk = await get('/teams/q2/lanes?q=risk:user-facing', ada);
      expect(laneIds(byRisk)).toEqual([a.id]);

      const byOwner = await get('/teams/q2/lanes?q=owner:ada', ada);
      expect(laneIds(byOwner).sort()).toEqual([a.id, b.id].sort());

      const byState = await get('/teams/q2/lanes?q=state:claimed', ada);
      expect(laneIds(byState).sort()).toEqual([a.id, b.id].sort());

      const byProject = await get(`/teams/q2/lanes?q=project:${a.project}`, ada);
      expect(laneIds(byProject).sort()).toEqual([a.id, b.id].sort());
    });

    it('ORs repeats of one key and ANDs across keys', async () => {
      const { ada } = await setup('q3');
      const claimed = await open('q3', ada, { title: 'claimed work' });
      const openLane = (await post('/teams/q3/lanes', { title: 'open work' }, ada)).json.lane;

      const only = await get('/teams/q3/lanes?q=state:claimed', ada);
      expect(laneIds(only)).toEqual([claimed.id]);

      const or = await get('/teams/q3/lanes?q=state:claimed state:open', ada);
      expect(laneIds(or).sort()).toEqual([claimed.id, openLane.id].sort());

      const and = await get('/teams/q3/lanes?q=state:claimed area:ui', ada);
      expect(laneIds(and)).toEqual([]);
    });

    it('refuses an unknown key by name, and a key with no value', async () => {
      const { ada } = await setup('q4');
      const unknown = await get('/teams/q4/lanes?q=nope:x', ada);
      expect(unknown.status).toBe(400);
      expect(String(unknown.json.error.message)).toContain('nope');
      expect(String(unknown.json.error.message)).toContain('goal');

      const empty = await get('/teams/q4/lanes?q=goal:', ada);
      expect(empty.status).toBe(400);
      expect(String(empty.json.error.message)).toContain('goal');
    });

    it('combines with the existing filters', async () => {
      const { ada } = await setup('q5');
      const a = await open('q5', ada, { title: 'the seat pulse' });
      await open('q5', ada, { title: 'the away relay' });

      const mine = await get('/teams/q5/lanes?q=pulse&mine=1', ada);
      expect(laneIds(mine)).toEqual([a.id]);

      const other = await get('/teams/q5/lanes?q=pulse&project=other', ada);
      expect(laneIds(other)).toEqual([]);
    });
  });

  describe('GET /goals?q=', () => {
    it('matches bare words over the id, the title and the story', async () => {
      const { ada } = await setup('g1');
      await post('/teams/g1/goals', { id: 'find-work', title: 'Finding work on the board' }, ada);
      await post(
        '/teams/g1/goals',
        { id: 'launch', title: 'Ship it', story: 'the public post' },
        ada,
      );

      const byId = await get('/teams/g1/goals?q=find-work', ada);
      expect(byId.json.goals.map((g: { id: string }) => g.id)).toEqual(['find-work']);

      const byStory = await get('/teams/g1/goals?q=public', ada);
      expect(byStory.json.goals.map((g: { id: string }) => g.id)).toEqual(['launch']);
    });

    it('refuses a lane-only key, naming the goal keys', async () => {
      const { ada } = await setup('g2');
      const res = await get('/teams/g2/goals?q=area:ui', ada);
      expect(res.status).toBe(400);
      expect(String(res.json.error.message)).toContain('area');
      expect(String(res.json.error.message)).toContain('status');
    });
  });
});
