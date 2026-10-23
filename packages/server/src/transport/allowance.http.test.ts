import { describe, expect, it } from 'vitest';
import { clearAllowance } from '../allowanceReadings.js';
import { withDrivers } from '../db/testing.js';
import { integrationHarness } from './integration.helpers.js';

const ACCOUNT = 'abcdef0123456789';

withDrivers('POST /teams/:slug/allowance', (_open, kind) => {
  const h = integrationHarness(kind);
  const { get, post } = h;

  const body = {
    accounts: [
      {
        provider: 'claude',
        account: ACCOUNT,
        label: 'Claude Max',
        readAt: 1_700_000_000_000,
        windows: [{ name: '5h', left: 0.38, resetsAt: null, kind: 'percent' }],
      },
    ],
  };

  describe('the posting human', () => {
    it('shows on that human, not the other, and the account key stays off the roster', async () => {
      clearAllowance();
      const slug = `alw-${kind}`;
      const created = await post('/teams', {
        slug,
        creator: { name: 'nick', kind: 'human' },
      });
      const nick = created.json.human_credential as string;
      await post(`/teams/${slug}/members`, { name: 'bo', kind: 'human' }, nick);
      const posted = await post(`/teams/${slug}/allowance`, body, nick);
      expect(posted.status).toBe(200);
      expect(posted.json).toEqual({ ok: true });

      const roster = await get(`/teams/${slug}`, nick);
      const members = roster.json.members as { name: string; allowance?: unknown }[];
      const nickRow = members.find((member) => member.name === 'nick');
      const boRow = members.find((member) => member.name === 'bo');
      expect(nickRow?.allowance).toMatchObject({
        accounts: [{ provider: 'claude', label: 'Claude Max' }],
      });
      expect(boRow?.allowance).toBeUndefined();
      expect(JSON.stringify(roster.json)).not.toContain(ACCOUNT);

      const open = await get(`/teams/${slug}`);
      expect(JSON.stringify(open.json)).toContain('Claude Max');
      expect(JSON.stringify(open.json)).not.toContain(ACCOUNT);
    });

    it('rejects a token field and accepts a local post with no bearer', async () => {
      clearAllowance();
      const slug = `alw-open-${kind}`;
      await post('/teams', { slug, creator: { name: 'nick', kind: 'human' } });
      const extra = await post(`/teams/${slug}/allowance`, {
        accounts: [{ ...body.accounts[0], accessToken: 'sk-nope' }],
      });
      expect(extra.status).toBe(400);
      expect(extra.json.error.code).toBe('bad_request');
      const open = await post(`/teams/${slug}/allowance`, body);
      expect(open.status).toBe(200);
      expect(JSON.stringify(open.json)).not.toContain('sk-nope');
    });
  });
});
