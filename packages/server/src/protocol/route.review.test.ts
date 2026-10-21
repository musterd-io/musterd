import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { PRESENCE_TIMEOUT_MS } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: PRESENCE_TIMEOUT_MS } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

const PR = { kind: 'pr', repo: 'org/repo', number: 42 } as const;

/**
 * ADR 490 — a typed review request's thread is its own id. The accept that creates the promise and
 * the `resolve` that closes it both land on that thread, and the close is Team-addressed so the
 * requester and the owner both see it. Ordinary request_help routing is untouched.
 */
withDrivers('route.review', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human', role: '' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent', role: '' })).row;
    const ctx = stubCtx(db);
    const row = (id: string) =>
      db.get<{ thread_id: string | null; to_kind: string }>(
        'SELECT thread_id, to_kind FROM messages WHERE id = ?',
        [id],
      );
    /** nick asks ada for a review; `typed` attaches the ADR 490 artifact reference. */
    const request = (id: string, typed: boolean) =>
      routeEnvelope(
        ctx,
        team,
        nick,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'nick',
          to: { kind: 'member', name: 'ada' },
          act: 'request_help',
          body: 'please review',
          meta: typed ? { review: PR } : null,
        }),
      );
    const accept = (id: string, ref: string, thread?: string) =>
      routeEnvelope(
        ctx,
        team,
        ada,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'ada',
          to: { kind: 'member', name: 'nick' },
          act: 'accept',
          body: 'on it',
          ...(thread ? { thread } : {}),
          meta: { in_reply_to: ref },
        }),
      );
    const resolve = (id: string, thread: string, to: 'team' | 'nick' | 'ada', from = nick) =>
      routeEnvelope(
        ctx,
        team,
        from,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: to === 'team' ? { kind: 'team' } : { kind: 'member', name: to },
          act: 'resolve',
          body: 'done',
          thread,
        }),
      );
    return { db, team, nick, ada, row, request, accept, resolve };
  }

  describe('the accept that makes the promise', () => {
    it('takes the request id as its thread when it carries none', async () => {
      const { request, accept, row } = await seed();
      await request('req1', true);
      await accept('ok1', 'req1');
      expect((await row('ok1'))?.thread_id).toBe('req1');
    });

    it('keeps an explicit thread that already names the request', async () => {
      const { request, accept, row } = await seed();
      await request('req1', true);
      await accept('ok1', 'req1', 'req1');
      expect((await row('ok1'))?.thread_id).toBe('req1');
    });

    it('is refused on any other thread, and nothing is persisted', async () => {
      const { request, accept, row } = await seed();
      await request('req1', true);
      await request('other', true);
      await expect(accept('ok1', 'req1', 'other')).rejects.toThrowError(
        new MusterdError(
          'validation',
          'an accept of typed review request req1 must be on its thread, not other',
        ),
      );
      expect(await row('ok1')).toBeUndefined();
    });

    it('leaves an untyped request alone: its accept keeps whatever thread it carried', async () => {
      const { request, accept, row } = await seed();
      await request('plain', false);
      await accept('ok1', 'plain');
      expect((await row('ok1'))?.thread_id).toBeNull();
    });
  });

  describe('the resolve that closes it', () => {
    it('lands when Team-addressed, from the owner or the requester', async () => {
      const { request, accept, resolve, row, ada } = await seed();
      await request('req1', true);
      await accept('ok1', 'req1');
      await resolve('done1', 'req1', 'team', ada);
      expect((await row('done1'))?.to_kind).toBe('team');
      await request('req2', true);
      await resolve('done2', 'req2', 'team');
      expect((await row('done2'))?.to_kind).toBe('team');
    });

    it('is refused when sent to one Member — a private close would reach one party only', async () => {
      const { request, accept, resolve, row } = await seed();
      await request('req1', true);
      await accept('ok1', 'req1');
      await expect(resolve('done1', 'req1', 'ada')).rejects.toThrowError(
        new MusterdError(
          'validation',
          'a typed review request is resolved to @team, so requester and owner both see the close',
        ),
      );
      expect(await row('done1')).toBeUndefined();
    });

    it('does not reach an untyped request: a private resolve of an ordinary thread still lands', async () => {
      const { request, resolve, row } = await seed();
      await request('plain', false);
      await resolve('done1', 'plain', 'ada');
      expect((await row('done1'))?.to_kind).toBe('member');
    });
  });
});
