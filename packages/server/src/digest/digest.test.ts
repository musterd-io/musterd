import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam, setPolicy } from '../store/teams.js';
import {
  buildDigest,
  type Digest,
  formatDigestSlackText,
  postDigest,
  renderDigestMarkdown,
} from './digest.js';

let openStore: () => Promise<Driver>;

withDrivers('digest', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const dana = (await addMember(db, team, { name: 'dana', kind: 'human' })).row;
    return { db, team, nick, dana };
  }

  async function send(
    db: Driver,
    teamId: string,
    from: { id: string; name: string },
    act: 'insight' | 'ask' | 'accept' | 'message',
    body: string,
    to?: { id: string; name: string } | 'team',
    meta?: Record<string, unknown>,
    ts = Date.now(),
  ) {
    return insertMessage(
      db,
      teamId,
      from.id,
      to === undefined || to === 'team' ? null : to.id,
      makeEnvelope({
        id: ulid(),
        team: 'dawn',
        from: from.name,
        to:
          to === undefined || to === 'team' ? { kind: 'team' } : { kind: 'member', name: to.name },
        act,
        body,
        ts,
        ...(meta ? { meta } : {}),
      }),
      // The receipt clock matches the envelope stamp: the fixture acts as its own daemon,
      // so the digest's receipt-clock reads and the origin-clock `waitingOn` agree on the night.
      { now: ts },
    );
  }

  describe('buildDigest (dreaming lane 4)', () => {
    it('collects the night-learned insights, the waiting-on, and the unanswered asks', async () => {
      const { db, team, nick, dana } = await seed();
      // A fixed real-scale clock: deterministic, and far from the wall clock so a stray
      // default stamp (which would read ~now) can never land inside the night by accident.
      const now = 2_000_000_000_000;
      const nightStart = now - 6 * 3_600_000;
      // One insight before the night (excluded), two during (included).
      // Insight acts require meta.headline (protocol) — the digest reads it there.
      await send(
        db,
        team.id,
        dana,
        'insight',
        'yesterday: old news',
        'team',
        { headline: 'old news' },
        nightStart - 1_000,
      );
      await send(
        db,
        team.id,
        dana,
        'insight',
        'the tunnel drops idle peers',
        'team',
        { headline: 'the tunnel drops idle peers' },
        nightStart + 1_000,
      );
      await send(
        db,
        team.id,
        nick,
        'insight',
        'cap the mint bucket',
        'team',
        { headline: 'mint bucket cap' },
        nightStart + 2_000,
      );
      // One answered ask (excluded from unanswered, still owed in waitingOn — only a
      // resolve closes a thread there), one open ask to dana (waiting + unanswered).
      // Ask acts require meta.species + meta.tier (protocol).
      const askMeta = { species: 'approve', tier: 'standard' };
      const answered = await send(
        db,
        team.id,
        nick,
        'ask',
        'ship it?',
        dana,
        askMeta,
        nightStart + 3_000,
      );
      await send(
        db,
        team.id,
        dana,
        'accept',
        'yes',
        nick,
        { in_reply_to: answered.id },
        nightStart + 4_000,
      );
      await send(db, team.id, nick, 'ask', 'review the digest?', dana, askMeta, nightStart + 5_000);

      const digest = await buildDigest(db, team.id, { day: '2033-05-18', nightStart, now });
      expect(digest.day).toBe('2033-05-18');
      expect(digest.learned.map((l) => l.headline)).toEqual([
        'the tunnel drops idle peers',
        'mint bucket cap',
      ]);
      // waitingOn counts every directed act whose thread carries no resolve — the answered
      // ask still names dana, and the accept itself names nick.
      expect(digest.waiting).toEqual([
        { member: 'dana', threads: 2, oldest_age_ms: now - (nightStart + 3_000) },
        { member: 'nick', threads: 1, oldest_age_ms: now - (nightStart + 4_000) },
      ]);
      expect(digest.unanswered).toHaveLength(1);
      expect(digest.unanswered[0]).toMatchObject({ from: 'nick', to: 'dana' });
      expect(digest.unanswered[0]!.age_ms).toBe(now - (nightStart + 5_000));
    });

    it('renders an empty night without empty sections', async () => {
      const { db, team } = await seed();
      const digest = await buildDigest(db, team.id, {
        day: '2033-05-18',
        nightStart: 1_999_000_000_000,
        now: 2_000_000_000_000,
      });
      const { body, meta } = renderDigestMarkdown(digest);
      expect(meta).toEqual({ digest: { day: '2033-05-18' } });
      expect(body).toContain('# Overnight — 2033-05-18');
      expect(body).toContain('Nothing saved overnight.');
      expect(body).toContain('Nobody is waiting on anyone.');
      expect(body).toContain('Every ask got an answer.');
    });

    it('formats the Slack glance: counts, first headlines, /live footer', () => {
      const digest: Digest = {
        day: '2033-05-18',
        nightStart: 1_999_000_000_000,
        learned: [
          { id: 'a', headline: 'the tunnel drops idle peers', body: 'b', ts: 1 },
          { id: 'b', headline: 'cap the mint bucket', body: 'b', ts: 2 },
          { id: 'c', headline: 'third thing', body: 'b', ts: 3 },
          { id: 'd', headline: 'fourth thing', body: 'b', ts: 4 },
        ],
        waiting: [{ member: 'dana', threads: 2, oldest_age_ms: 60_000 }],
        unanswered: [{ id: 'u', from: 'nick', to: 'dana', thread: null, age_ms: 30_000 }],
      };
      const text = formatDigestSlackText({ team: 'dawn', digest });
      expect(text).toContain('[dawn] Overnight — 2033-05-18: 4 learned · 1 waiting · 1 unanswered');
      expect(text).toContain('- the tunnel drops idle peers');
      expect(text).toContain('- …and 1 more');
      expect(text).not.toContain('fourth thing');
      expect(text).toContain('/live');
    });

    it('posts the digest as an ordinary team message, once per day', async () => {
      const { db, team, dana } = await seed();
      const now = 2_000_000_000_000;
      const nightStart = now - 6 * 3_600_000;
      await send(
        db,
        team.id,
        dana,
        'insight',
        'the tunnel drops idle peers',
        'team',
        { headline: 'the tunnel drops idle peers' },
        nightStart + 1_000,
      );

      const poster = { id: dana.id, name: dana.name };
      const first = await postDigest(db, { id: team.id, slug: team.slug }, poster, {
        day: '2033-05-18',
        nightStart,
        now,
      });
      expect(first).not.toBeNull();
      // An ordinary message to the team — the Stream pin keys on meta.digest presence.
      expect(first!.act).toBe('message');
      expect(first!.to_kind).toBe('team');
      expect(first!.to_member).toBeNull();
      expect(JSON.parse(first!.meta!)).toEqual({ digest: { day: '2033-05-18' } });
      expect(first!.body).toContain('# Overnight — 2033-05-18');
      expect(first!.body).toContain('the tunnel drops idle peers');

      // A retried schedule posts once: the second call for the same day is a no-op.
      const second = await postDigest(db, { id: team.id, slug: team.slug }, poster, {
        day: '2033-05-18',
        nightStart,
        now: now + 60_000,
      });
      expect(second).toBeNull();
      const count = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages
          WHERE team_id = ? AND meta IS NOT NULL AND json_extract(meta, '$.digest.day') = ?`,
        [team.id, '2033-05-18'],
      );
      expect(count!.n).toBe(1);
    });

    it('posts the short form to the team Slack sink, once per day, never failing the post', async () => {
      const { db, team, dana } = await seed();
      // The legacy knob reads through as the team's Slack sink (doorbell §6).
      await setPolicy(db, team.id, { ask_slack_webhook: 'https://hooks.slack.test/T/B/digest' });
      // Intercept only the Slack host; the drivers under test share the global fetch.
      const calls: { url: string; text: string }[] = [];
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://hooks.slack.test/')) {
          calls.push({ url, text: (JSON.parse(String(init?.body)) as { text: string }).text });
          return new Response('ok', { status: 200 });
        }
        return realFetch(input as never, init);
      });
      try {
        const now = 2_000_000_000_000;
        const nightStart = now - 6 * 3_600_000;
        await send(
          db,
          team.id,
          dana,
          'insight',
          'the tunnel drops idle peers',
          'team',
          { headline: 'the tunnel drops idle peers' },
          nightStart + 1_000,
        );
        const poster = { id: dana.id, name: dana.name };
        const first = await postDigest(db, { id: team.id, slug: team.slug }, poster, {
          day: '2033-05-18',
          nightStart,
          now,
        });
        expect(first).not.toBeNull();
        // The Slack POST is detached — wait for it, then pin the text.
        const deadline = Date.now() + 5_000;
        while (calls.length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.text).toContain(
          '[dawn] Overnight — 2033-05-18: 1 learned · 0 waiting · 0 unanswered',
        );
        expect(calls[0]!.text).toContain('the tunnel drops idle peers');

        // A retried schedule posts once on the record — and once to Slack.
        const second = await postDigest(db, { id: team.id, slug: team.slug }, poster, {
          day: '2033-05-18',
          nightStart,
          now: now + 60_000,
        });
        expect(second).toBeNull();
        await new Promise((r) => setTimeout(r, 50));
        expect(calls).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
