import { describe, expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { listAuditByAction } from '../store/audit.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness } from './integration.helpers.js';

/** ADR 721: a human's own status line over the wire — who may set it, the push, the refusals. */
withDrivers('integration · status line', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, get, post, req, standingGrant } = h;

  async function team() {
    const t = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const tok = t.json.human_credential as string;
    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, tok);
    const by = async (name: string) =>
      (await get('/teams/dawn/members', tok)).json.members.find((m: any) => m.name === name);
    return { tok, key: t.json.agent_key as string, by };
  }

  describe('status line (ADR 721)', () => {
    it('a human sets their own, the roster carries it for an hour, and they clear it', async () => {
      const { tok, by } = await team();
      expect((await by('nick')).status_line ?? null).toBeNull();

      const set = await post(
        '/teams/dawn/status-line',
        { text: 'assembling a new dresser for the nursery' },
        tok,
      );
      expect(set.status).toBe(200);
      const line = set.json.member.status_line;
      expect(line.text).toBe('assembling a new dresser for the nursery');
      expect(line.expires_at - line.set_at).toBe(3_600_000);
      expect((await by('nick')).status_line).toEqual(line);

      const cleared = await req('DELETE', '/teams/dawn/status-line', undefined, tok);
      expect(cleared.status).toBe(200);
      expect((await by('nick')).status_line ?? null).toBeNull();
    });

    it('pushes member_updated to the team, so /live and /broadcast update at once', async () => {
      const { tok, key } = await team();
      const a = new TestWs();
      await a.open();
      await a.claim('dawn', key, 'Ada', 'claude-code', await standingGrant(tok, 'Ada'));
      await post('/teams/dawn/status-line', { text: 'out for lunch' }, tok);
      const f = (await a.waitFor('member_updated')) as any;
      expect(f.member.name).toBe('nick');
      expect(f.member.status_line.text).toBe('out for lunch');
      a.close();
    });

    it('an agent cannot set one — not its own, not anyone’s', async () => {
      const { key } = await team();
      const r = await post('/teams/dawn/status-line', { text: 'thinking' }, { key, seat: 'Ada' });
      expect(r.status).toBe(403);
      expect(r.json.error.code ?? r.json.code).toMatch(/status_line_humans_only|forbidden/);
    });

    it('refuses 49 characters and an empty status, naming the limit', async () => {
      const { tok } = await team();
      const long = await post('/teams/dawn/status-line', { text: 'x'.repeat(49) }, tok);
      expect(long.status).toBe(400);
      expect(JSON.stringify(long.json)).toMatch(/48/);
      expect((await post('/teams/dawn/status-line', { text: '   ' }, tok)).status).toBe(400);
    });

    it('audits the set and the clear with the length, never the words', async () => {
      const { tok } = await team();
      await post('/teams/dawn/status-line', { text: 'at the vet' }, tok);
      await req('DELETE', '/teams/dawn/status-line', undefined, tok);
      const t = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const rows = (await listAuditByAction(h.server.store, t.id, 'member.status_line', 10)).map(
        (r: any) => ({
          ...r,
          detail: JSON.parse(r.detail ?? '{}'),
        }),
      );
      expect(rows.map((r) => r.detail.action).sort()).toEqual(['clear', 'set']);
      expect(rows.find((r) => r.detail.action === 'set')!.detail.length).toBe(10);
      expect(JSON.stringify(rows)).not.toContain('at the vet');
    });
  });
});
