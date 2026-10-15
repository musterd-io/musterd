import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness } from './integration.helpers.js';

/**
 * ADR 601 — the `broadcast` observer grade: everything `full` sees minus a DM between two human,
 * non-observer members, with every string a broadcast reader gets credential-scrubbed on the way
 * out; and the public-grade roster line no longer leaks a human-to-human `status_update`.
 */
withDrivers('broadcast grade (ADR 601)', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, post, standingGrant } = h;

  const SECRET = 'mscr_abcdefghijklmnopqrstuvwxyz0123456789';

  async function seedTeam() {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    const key = team.json.agent_key as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
    const bo = await post('/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickTok);
    const boTok = bo.json.human_credential as string;
    const stream = await post(
      '/teams/dawn/members',
      { name: 'stream-1', kind: 'human', observer: true, observer_scope: 'broadcast' },
      nickTok,
    );
    expect(stream.status).toBe(201);
    const full = await post(
      '/teams/dawn/members',
      { name: 'web-1', kind: 'human', observer: true },
      nickTok,
    );
    const watch = await post(
      '/teams/dawn/members',
      { name: 'watch-1', kind: 'human', observer: true, observer_scope: 'public' },
      nickTok,
    );
    return {
      key,
      nickTok,
      boTok,
      streamTok: stream.json.human_credential as string,
      fullTok: full.json.human_credential as string,
      watchTok: watch.json.human_credential as string,
    };
  }

  type Auth = string | { key: string; seat: string };
  let n = 0;
  async function send(
    auth: Auth,
    from: string,
    to: { kind: 'member'; name: string } | { kind: 'team' },
    act: string,
    body: string,
    meta?: Record<string, unknown>,
  ) {
    n += 1;
    const id = `${act}-${from}-${n}`;
    const res = await post(
      '/teams/dawn/messages',
      {
        envelope: {
          id,
          v: PROTOCOL_VERSION,
          team: 'dawn',
          from,
          to,
          act,
          body,
          ts: Date.now() + n,
          ...(meta ? { meta } : {}),
        },
      },
      auth,
    );
    expect(res.status, `${act} ${from} → ${JSON.stringify(to)}: ${JSON.stringify(res.json)}`).toBe(
      201,
    );
    return id;
  }

  const ids = (view: { json: { messages: { id: string }[] } }) =>
    view.json.messages.map((m) => m.id);

  describe('GET /messages — the grade matrix', () => {
    it('drops only the human-to-human DM; agent↔human, agent↔agent and a confidential ask stay', async () => {
      const t = await seedTeam();
      const ada = { key: t.key, seat: 'Ada' };
      const hh = await send(
        t.nickTok,
        'nick',
        { kind: 'member', name: 'Bo' },
        'message',
        'between humans',
      );
      const ha = await send(
        t.nickTok,
        'nick',
        { kind: 'member', name: 'Ada' },
        'message',
        'human to agent',
      );
      const ah = await send(
        ada,
        'Ada',
        { kind: 'member', name: 'nick' },
        'message',
        'agent to human',
      );
      const aa = await send(
        ada,
        'Ada',
        { kind: 'member', name: 'Lin' },
        'message',
        'agent to agent',
      );
      const conf = await send(ada, 'Ada', { kind: 'member', name: 'nick' }, 'ask', 'about Lin', {
        species: 'consult',
        tier: 'standard',
        about: 'Lin',
      });
      const pub = await send(ada, 'Ada', { kind: 'team' }, 'status_update', 'public');

      expect(ids(await get('/teams/dawn/messages', t.streamTok))).toEqual([ha, ah, aa, conf, pub]);
      expect(ids(await get('/teams/dawn/messages', t.fullTok))).toEqual([
        hh,
        ha,
        ah,
        aa,
        conf,
        pub,
      ]);
      expect(ids(await get('/teams/dawn/messages', t.watchTok))).toEqual([pub]);
    });

    it('a DM from a human to an observer, or to a service seat, is not a human pair', async () => {
      const t = await seedTeam();
      await post('/teams/dawn/members', { name: 'autorefresh', kind: 'service' }, t.nickTok);
      const toService = await send(
        t.nickTok,
        'nick',
        { kind: 'member', name: 'autorefresh' },
        'message',
        'x',
      );
      const toWatcher = await send(
        t.nickTok,
        'nick',
        { kind: 'member', name: 'watch-1' },
        'message',
        'y',
      );
      expect(ids(await get('/teams/dawn/messages', t.streamTok))).toEqual([toService, toWatcher]);
    });
  });

  describe('masking — every string a broadcast reader gets', () => {
    it('masks a planted credential in a body and in meta for the stream, not for the dashboard', async () => {
      const t = await seedTeam();
      const ada = { key: t.key, seat: 'Ada' };
      await send(
        ada,
        'Ada',
        { kind: 'team' },
        'message',
        `key is ${SECRET} and sk-abcdefghijklmnopqrstuvwxyz`,
      );
      await send(ada, 'Ada', { kind: 'team' }, 'insight', 'found it', {
        headline: `use ${SECRET}`,
      });
      const plain = await send(ada, 'Ada', { kind: 'team' }, 'message', 'nothing secret here');

      const stream = await get('/teams/dawn/messages', t.streamTok);
      const bodies = stream.json.messages.map((m: any) => m.body as string);
      expect(bodies[0]).toBe('key is <redacted:credential> and <redacted:sk>');
      expect(stream.json.messages[1].meta.headline).toBe('use <redacted:credential>');
      expect(stream.json.messages.find((m: any) => m.id === plain).body).toBe(
        'nothing secret here',
      );
      expect(JSON.stringify(stream.json)).not.toContain(SECRET);

      const full = await get('/teams/dawn/messages', t.fullTok);
      expect(full.json.messages[0].body).toContain(SECRET);
    });

    it('masks the roster status line, a lane title and a goal title for the stream', async () => {
      const t = await seedTeam();
      const ada = { key: t.key, seat: 'Ada' };
      await send(ada, 'Ada', { kind: 'team' }, 'status_update', `rotating ${SECRET}`);
      const lane = await post('/teams/dawn/lanes', { title: `rotate ${SECRET}`, claim: true }, ada);
      expect(lane.status).toBe(201);
      await post('/teams/dawn/goals', { id: 'g1', title: `ship ${SECRET}` }, t.nickTok);

      const roster = await get('/teams/dawn/members', t.streamTok);
      expect(roster.json.members.find((m: any) => m.name === 'Ada').state).toBe(
        'rotating <redacted:credential>',
      );
      const lanes = await get('/teams/dawn/lanes', t.streamTok);
      expect(lanes.json.lanes[0].title).toBe('rotate <redacted:credential>');
      const goals = await get('/teams/dawn/goals', t.streamTok);
      expect(JSON.stringify(goals.json)).toContain('ship <redacted:credential>');
      expect(JSON.stringify(goals.json)).not.toContain(SECRET);
      const report = await get('/teams/dawn/report', t.streamTok);
      expect(report.status).toBe(200);
      expect(JSON.stringify(report.json)).not.toContain(SECRET);

      // The dashboard is unchanged.
      const fullRoster = await get('/teams/dawn/members', t.fullTok);
      expect(fullRoster.json.members.find((m: any) => m.name === 'Ada').state).toContain(SECRET);
    });
  });

  describe('roster status follows the grade (decision 5)', () => {
    it('a human-to-human status_update is not the sender’s line for public or broadcast readers', async () => {
      const t = await seedTeam();
      await send(t.nickTok, 'nick', { kind: 'team' }, 'status_update', 'on the launch post');
      await send(
        t.nickTok,
        'nick',
        { kind: 'member', name: 'Bo' },
        'status_update',
        'private to Bo',
      );
      const line = async (tok: string) =>
        (await get('/teams/dawn/members', tok)).json.members.find((m: any) => m.name === 'nick')
          .state;
      expect(await line(t.fullTok)).toBe('private to Bo');
      expect(await line(t.watchTok)).toBe('on the launch post');
      expect(await line(t.streamTok)).toBe('on the launch post');
    });
  });

  describe('firehose', () => {
    it('the stream is pushed the agent-to-human DM, scrubbed, and never the human pair', async () => {
      const t = await seedTeam();
      const s = new TestWs();
      await s.open();
      await s.claim('dawn', t.key, 'stream-1', 'web', await standingGrant(t.nickTok, 'stream-1'));
      await s.subscribe('team-all');

      const ada = { key: t.key, seat: 'Ada' };
      await send(t.nickTok, 'nick', { kind: 'member', name: 'Bo' }, 'message', 'between humans');
      await send(ada, 'Ada', { kind: 'member', name: 'nick' }, 'message', `token ${SECRET}`);

      const frame = (await s.waitFor('deliver')) as any;
      expect(frame.envelope.body).toBe('token <redacted:credential>');
      expect(frame.envelope.to).toEqual({ kind: 'member', name: 'nick' });
      s.close();
    });
  });
});
