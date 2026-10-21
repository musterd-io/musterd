import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { integrationHarness } from './integration.helpers.js';

/**
 * ADR 692 — /live's "who is here" row reads the roster for `web` rows a /live tab labelled
 * `workspace: '/live'`. The row is only honest if the roster never carries such a row for the
 * /broadcast capture seat, an anonymous watcher or a watch link, even when one of them sends the
 * label, and does carry it for a signed-in member until their tab closes.
 */
withDrivers('who is here (ADR 692)', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, post, standingGrant, pollUntil } = h;
  const LIVE = '/live';

  async function seedTeam() {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential as string;
    const key = team.json.agent_key as string;
    const bo = await post('/teams/dawn/members', { name: 'Bo', kind: 'human' }, nickTok);
    for (const [name, scope] of [
      ['broadcast-1', 'broadcast'],
      ['web-1', undefined],
      ['watch-1', 'public'],
    ] as const) {
      const r = await post(
        '/teams/dawn/members',
        { name, kind: 'human', observer: true, ...(scope ? { observer_scope: scope } : {}) },
        nickTok,
      );
      expect(r.status).toBe(201);
    }
    return { key, nickTok, boTok: bo.json.human_credential as string };
  }

  /** A socket that claims exactly as /live's LiveClient does, label included. */
  async function liveTab(key: string, seat: string, grant?: string) {
    const s = new TestWs();
    await s.open();
    s.send({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key,
      target: { seat },
      ...(grant ? { grant } : {}),
      surface: 'web',
      provenance: 'session',
      workspace: LIVE,
    });
    await s.waitFor('occupied');
    return s;
  }

  async function hereRows(tok: string) {
    const roster = await get('/teams/dawn', tok);
    return (roster.json.members as any[]).flatMap((m) =>
      (m.presences as any[])
        .filter((p) => p.surface === 'web' && p.workspace === LIVE)
        .map((p) => ({ name: m.name as string, status: p.status as string })),
    );
  }

  describe('the roster behind the row', () => {
    it('the broadcast seat, an anonymous watcher and a watch link never put a /live row on it', async () => {
      const t = await seedTeam();
      const tabs = [
        await liveTab(t.key, 'broadcast-1', await standingGrant(t.nickTok, 'broadcast-1')),
        await liveTab(t.key, 'web-1', await standingGrant(t.nickTok, 'web-1')),
        await liveTab(t.key, 'watch-1', await standingGrant(t.nickTok, 'watch-1')),
      ];
      expect(await hereRows(t.nickTok)).toEqual([]);
      const names = ((await get('/teams/dawn', t.nickTok)).json.members as any[]).map(
        (m) => m.name,
      );
      expect(names).not.toContain('broadcast-1');
      expect(names).not.toContain('web-1');
      expect(names).not.toContain('watch-1');
      for (const s of tabs) s.close();
    });

    it('a signed-in member with /live open is on it, and leaves it when the tab closes', async () => {
      const t = await seedTeam();
      const tab = await liveTab(t.boTok, 'Bo');
      expect(await hereRows(t.nickTok)).toEqual([{ name: 'Bo', status: 'online' }]);

      tab.close();
      await pollUntil(async () => (await hereRows(t.nickTok)).length === 0, 3000);
    });

    it('a member on the board page, without the label, is not on it', async () => {
      const t = await seedTeam();
      const s = new TestWs();
      await s.open();
      await s.claim('dawn', t.boTok, 'Bo', 'web');
      expect(await hereRows(t.nickTok)).toEqual([]);
      s.close();
    });
  });
});
