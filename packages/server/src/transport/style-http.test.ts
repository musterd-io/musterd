import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { listAudit } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

/**
 * Agent style, server half (ADR 514, spec §4.5): a human's own dials through
 * `GET`/`PUT /members/me/style`, resolved against the team floor and defaults; `style` on human
 * roster rows; agents refused. Runs on both drivers.
 */
withDrivers('style-http', (_o, kind) => {
  const h = integrationHarness(kind);
  const { get, post, req } = h;
  const put = (path: string, body: unknown, auth?: Auth) => req('PUT', path, body, auth);

  const SHIPPED = {
    pushback: 'when-it-matters',
    bluntness: 'plain',
    length: 'normal',
    format: 'prose',
  };

  async function team() {
    const created = await post('/teams', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    const nick: Auth = created.json.human_credential;
    const dee: Auth = (await post('/teams/dawn/members', { name: 'dee', kind: 'human' }, nick)).json
      .human_credential;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nick);
    const ada: Auth = { key: created.json.agent_key, seat: 'Ada' };
    return { nick, dee, ada };
  }

  describe('GET/PUT /members/me/style', () => {
    it('a human reads team defaults before setting anything, and the block names them', async () => {
      const t = await team();
      const got = await get('/teams/dawn/members/me/style', t.dee);
      expect(got.status).toBe(200);
      expect(got.json.prefs).toEqual({});
      expect(got.json.resolved.dials).toEqual(SHIPPED);
      expect(got.json.block).toContain('For dee (in chat, and in any act addressed to dee)');
    });

    it('a human sets dials and prose and reads them back', async () => {
      const t = await team();
      const set = await put(
        '/teams/dawn/members/me/style',
        { length: 'concise', prose: 'Lead with the result.' },
        t.dee,
      );
      expect(set.status).toBe(200);
      expect(set.json.resolved.dials.length).toBe('concise');
      expect(set.json.block).toContain('dee adds: "Lead with the result."');
      const got = await get('/teams/dawn/members/me/style', t.dee);
      expect(got.json.prefs).toEqual({ length: 'concise', prose: 'Lead with the result.' });
    });

    it('six-line prose is refused 422 with the count (Focus 2)', async () => {
      const t = await team();
      const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
      const set = await put('/teams/dawn/members/me/style', { prose: six }, t.dee);
      expect(set.status).toBe(422);
      expect(set.json.error.message).toBe('prose is 6 lines; the cap is 5');
    });

    it('a floor key in prefs is refused: the floor is not a preference', async () => {
      const t = await team();
      const set = await put(
        '/teams/dawn/members/me/style',
        { assess_before_agreeing: false },
        t.dee,
      );
      expect(set.status).toBe(400);
    });

    it('an agent has no style preferences (Focus 1)', async () => {
      const t = await team();
      const got = await get('/teams/dawn/members/me/style', t.ada);
      expect(got.status).toBe(403);
      const set = await put('/teams/dawn/members/me/style', { length: 'concise' }, t.ada);
      expect(set.status).toBe(403);
    });

    it("an admin's default moves a human who never set that dial and not one who did (Focus 3)", async () => {
      const t = await team();
      await put('/teams/dawn/members/me/style', { length: 'concise' }, t.dee);
      const policy = await post(
        '/teams/dawn/policy',
        { style: { defaults: { length: 'thorough', bluntness: 'direct' } } },
        t.nick,
      );
      expect(policy.status).toBe(200);
      const dee = await get('/teams/dawn/members/me/style', t.dee);
      expect(dee.json.resolved.dials).toMatchObject({ length: 'concise', bluntness: 'direct' });
      const nick = await get('/teams/dawn/members/me/style', t.nick);
      expect(nick.json.resolved.dials).toMatchObject({ length: 'thorough', bluntness: 'direct' });
    });

    it('the roster carries style on human rows only (Focus 5)', async () => {
      const t = await team();
      await put('/teams/dawn/members/me/style', { length: 'concise' }, t.dee);
      const roster = await get('/teams/dawn/members', t.nick);
      const byName = Object.fromEntries(
        (roster.json.members as { name: string; style: unknown }[]).map((m) => [m.name, m]),
      );
      expect(byName['dee']!.style).toMatchObject({ length: 'concise' });
      expect(byName['nick']!.style).toMatchObject({ length: 'normal' });
      expect(byName['Ada']!.style).toBeNull();
    });

    it('GET /style-block names the driver passed, their dials, and the team line (inc 3)', async () => {
      const t = await team();
      await put('/teams/dawn/members/me/style', { length: 'concise' }, t.dee);
      const got = await get('/teams/dawn/style-block?driver=dee', t.ada);
      expect(got.status).toBe(200);
      expect(got.json.driver).toBe('dee');
      expect(got.json.dials.length).toBe('concise');
      expect(got.json.block).toContain(
        'For dee (in chat, and in any act addressed to dee): pushback when it matters · plain · concise · prose.',
      );
      expect(got.json.epoch).toMatch(/^[0-9a-f]{8}$/);
    });

    it('no driver and two humans ⇒ team defaults, and the block says so (Focus 2)', async () => {
      const t = await team();
      const got = await get('/teams/dawn/style-block', t.ada);
      expect(got.status).toBe(200);
      expect(got.json.driver).toBeNull();
      expect(got.json.block).toContain('No driver bound and this team has several humans');
    });

    it('no driver and ONE human ⇒ that human is the driver (Focus 2)', async () => {
      const created = await post('/teams', {
        slug: 'solo',
        creator: { name: 'nick', kind: 'human' },
      });
      const nick = created.json.human_credential;
      await post('/teams/solo/members', { name: 'Ada', kind: 'agent' }, nick);
      const got = await get('/teams/solo/style-block', {
        key: created.json.agent_key,
        seat: 'Ada',
      });
      expect(got.status).toBe(200);
      expect(got.json.driver).toBe('nick');
      expect(got.json.block).toContain('For nick (in chat, and in any act addressed to nick)');
    });

    it('GET /inbox carries the current style_epoch for the seat, and it moves with policy (Focus 3)', async () => {
      const t = await team();
      const before = (await get('/teams/dawn/inbox?unread=1', t.ada)).json.style_epoch;
      expect(before).toMatch(/^[0-9a-f]{8}$/);
      await post('/teams/dawn/policy', { style: { defaults: { length: 'thorough' } } }, t.nick);
      const after = (await get('/teams/dawn/inbox?unread=1', t.ada)).json.style_epoch;
      expect(after).toMatch(/^[0-9a-f]{8}$/);
      expect(after).not.toBe(before);
    });

    it('a set writes an audit row naming the dials, never the prose', async () => {
      const t = await team();
      await put('/teams/dawn/members/me/style', { length: 'concise', prose: 'secretish' }, t.dee);
      const teamRow = (await getTeamBySlug(h.db, 'dawn'))!;
      const rows = await listAudit(h.db, teamRow.id);
      const row = rows.find((r) => r.action === 'style.prefs_set')!;
      expect(row).toBeDefined();
      expect(row.actor).toBe('dee');
      const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
      expect(detail).toEqual({ dials: ['length'], prose_lines: 1 });
      expect(JSON.stringify(row)).not.toContain('secretish');
    });
  });
});
