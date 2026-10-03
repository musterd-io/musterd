import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { type Envelope, FEATURE_EPOCH, PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { integrationHarness } from './integration.helpers.js';

withDrivers('integration · http', (_o, kind) => {
  const h = integrationHarness(kind);
  const { TestWs, authHeaders, get, pollUntil, post, rawHttpGet, resolveAuth } = h;

  describe('HTTP API', async () => {
    it('health responds with the protocol version, db path, schema version, and live-session count', async () => {
      const r = await get('/health');
      expect(r.json).toMatchObject({ ok: true, v: PROTOCOL_VERSION });
      expect(typeof r.json.db).toBe('string');
      expect(typeof r.json.schema).toBe('number');
      // ADR 047: derived cross-team count of live sessions; zero on a fresh daemon.
      expect(r.json.connections).toBe(0);
      // ADR 130: no buildRef configured → the build field is omitted, never null/empty.
      expect(r.json).not.toHaveProperty('build');
      // Guardian (2026-08-13 spec §3): recency classification needs the daemon's boot instant —
      // log lines older than this are evidence of nothing.
      expect(typeof r.json.booted_at).toBe('number');
      expect(r.json.booted_at).toBeLessThanOrEqual(Date.now());
      // ADR 148: the daemon always names its own feature epoch — the roster's skew reference.
      expect(r.json.epoch).toBe(FEATURE_EPOCH);
      // Quiescence (2026-08-03): a fresh daemon has no live agent action to age, so the field is
      // OMITTED — unknown must read as absence, never as 0 (0 would mean "someone acted just now",
      // the exact opposite, and would hold the auto-refresher's quiet-floor open forever).
      expect(r.json).not.toHaveProperty('quietest_busy_ms');
    });

    it('health names the boot commit when the embedder passes buildRef (ADR 130)', async () => {
      const sha = 'b'.repeat(40);
      const s = createServer({ db: await openTestDriver(kind), port: 0, buildRef: sha });
      const { port } = await s.listen();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(((await res.json()) as { build?: string }).build).toBe(sha);
      } finally {
        await s.close();
      }
    });

    it('creates a team + creator token; duplicate slug is 409', async () => {
      const r = await post('/teams', {
        slug: 'dawn',
        creator: { name: 'nick', kind: 'human', role: 'lead' },
      });
      expect(r.status).toBe(201);
      expect(r.json.token).toMatch(/^mskd_/);
      // v0.3 P3 composite mint (SPEC A.7): agent key + creator credential + policy, each shown once.
      expect(r.json.agent_key).toMatch(/^mskey_/);
      expect(r.json.human_credential).toMatch(/^mscr_/);
      // Policy mints with defaults for every block — inc 5 added the residency knobs (ADR 131).
      expect(r.json.policy).toMatchObject({ allow_pre_issued_grants: false });
      expect(r.json.policy.residency.hourly_cap).toBe(2);
      expect(r.json.seat.name).toBe('nick');
      const dup = await post('/teams', { slug: 'dawn', creator: { name: 'x', kind: 'human' } });
      expect(dup.status).toBe(409);
      expect(dup.json.error.code).toBe('conflict');
    });

    it('sends and reads an inbox over HTTP with unread accounting', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      const boTok = bo.json.human_credential; // a human seat authenticates with its own mscr_ credential

      const env = {
        id: 'mh1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'member', name: 'bo' },
        act: 'message',
        body: 'hi bo',
        ts: Date.now(),
      };
      const sent = await post('/teams/dawn/messages', { envelope: env }, nickTok);
      expect(sent.status).toBe(201);

      const inbox1 = await get('/teams/dawn/inbox?unread=1', boTok);
      expect(inbox1.json.messages).toHaveLength(1);
      await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'mh1' }, boTok);
      const inbox2 = await get('/teams/dawn/inbox?unread=1', boTok);
      expect(inbox2.json.messages).toHaveLength(0);
    });

    it('a second human member is minted a credential that authenticates (ADR 069 cutover gap)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      // A non-creator human seat gets its own mscr_ credential, returned once (parallel to the creator).
      const bo = await post(
        '/teams/dawn/members',
        { name: 'bo', kind: 'human' },
        team.json.human_credential,
      );
      expect(bo.json.human_credential).toMatch(/^mscr_/);
      // …and it authenticates as bo (the credential is self-identifying).
      const inbox = await get('/teams/dawn/inbox', bo.json.human_credential);
      expect(inbox.status).toBe(200);
      // An agent member gets NO credential — it claims with the team agent key + a grant.
      const ada = await post(
        '/teams/dawn/members',
        { name: 'Ada', kind: 'agent' },
        team.json.human_credential,
      );
      expect(ada.json.human_credential).toBeUndefined();
    });

    it('rejects an invalid act with 422 validation', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, team.json.human_credential);
      const bad = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            id: 'x',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'bo' },
            act: 'yell',
            body: '',
            ts: 1,
          },
        },
        team.json.human_credential,
      );
      expect(bad.status).toBe(422);
      expect(bad.json.error.code).toBe('validation');
    });

    // ADR 254: the eligible set. The roster half of validation — `actMetaRules` proved the shape, only
    // the daemon can prove the names.
    describe('meta.eligible roster validation', async () => {
      const sendEligible = async (
        tok: unknown,
        eligible: string[],
        from = 'nick',
        id = 'el' + Math.random().toString(36).slice(2, 8),
      ) =>
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from,
              to: { kind: 'team' },
              act: 'message',
              body: 'either of you know why the daemon pinned?',
              ts: Date.now(),
              meta: { eligible },
            },
          },
          tok,
        );

      const teamOfThree = async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const tok = team.json.human_credential;
        await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, tok);
        await post('/teams/dawn/members', { name: 'cy', kind: 'human' }, tok);
        return tok;
      };

      it('stores ONE team-addressed row carrying the set — no fan-out, no new to_kind', async () => {
        const tok = await teamOfThree();
        const sent = await sendEligible(tok, ['bo', 'cy'], 'nick', 'el-ok');
        expect(sent.status).toBe(201);

        const timeline = await get('/teams/dawn/messages', tok);
        const row = timeline.json.messages.find((m: { id: string }) => m.id === 'el-ok');
        expect(row.to).toEqual({ kind: 'team' });
        expect(row.meta.eligible).toEqual(['bo', 'cy']);
      });

      it('rejects a name that is not on the roster', async () => {
        const tok = await teamOfThree();
        const res = await sendEligible(tok, ['bo', 'nobody-here']);
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('not_found');
        expect(res.json.error.message).toContain('nobody-here');
      });

      it('rejects a set naming the sender — you cannot owe yourself an answer', async () => {
        const tok = await teamOfThree();
        const res = await sendEligible(tok, ['nick', 'bo']);
        expect(res.status).toBe(422);
        expect(res.json.error.code).toBe('validation');
        expect(res.json.error.message).toContain('sender');
      });

      it('rejects a set naming an observer — observers receive, they do not owe (ADR 063)', async () => {
        const tok = await teamOfThree();
        await post('/teams/dawn/members', { name: 'eye', kind: 'human', observer: true }, tok);
        const res = await sendEligible(tok, ['bo', 'eye']);
        expect(res.status).toBe(422);
        expect(res.json.error.code).toBe('validation');
        expect(res.json.error.message).toContain('observer');
      });

      it('rejects a seat that has left the team', async () => {
        const tok = await teamOfThree();
        await h.server.store.run("UPDATE members SET left_at = 1 WHERE name = 'cy'");
        const res = await sendEligible(tok, ['bo', 'cy']);
        expect(res.status).toBe(404);
      });
    });

    /**
     * ADR 254: stand-down needs a trace. A seat whose obligation just vanished may be mid-draft — it
     * has to learn the question was taken, and by whom, so it can drop the work or disagree with what
     * landed. A stand-down that says nothing is the same defect as an instrument going quiet.
     */
    describe('GET /inbox is bounded even when the caller names no limit', () => {
      /**
       * This was the last unbounded read on the request path: a seat returning after time away pulled
       * its entire unread history in one reply. The bound has to be a PREFIX, not the newest tail —
       * a reader that advances its cursor to the newest row it received after a tail-truncated read
       * steps over everything that was cut, which is ADR 287's loss reintroduced as a latency fix.
       */
      /**
       * `tieFrom`: every row from that index on carries the ts of the row before it, so a millisecond
       * tie straddles the 200-row bound. Every other fixture in this file seeds `ts: Date.now() + i`,
       * strictly increasing — which makes a tie unconstructible and is exactly why no existing test
       * can see the defect below.
       */
      const teamWithBacklog = async (n: number, tieFrom?: number) => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential;
        const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
        // Pinned ONCE: `Date.now()` per iteration drifts, so tied rows would not actually tie —
        // the fixture would encode the same strictly-increasing assumption it exists to break.
        const t0 = Date.now();
        // Seeded IN PROCESS through the same store function the route calls, not over HTTP. These
        // tests are about the GET, and the backlog they need is large by construction — the bound
        // under test is 200, so every fixture must exceed it. Built one POST at a time this block
        // spent 1830ms of round-trips per test against 33ms in the call it exists to measure
        // (measured 2026-08-28), because POST /messages is a heavy path — routeEnvelope, delivery
        // hints, nudge-decision counting, audit rows — and none of it is this describe's subject.
        // Linear in n and paid six times, that crossed the 30s timeout under a loaded parallel run
        // while passing alone, which is the shape that teaches people to re-run a suite instead of
        // reading it. `unreadOnly` filters the caller's cursor against `messages`, so nothing
        // asserted below depends on the POST route having run; the route keeps its own coverage
        // elsewhere in this file.
        const teamRow = (await getTeamBySlug(h.server.store, 'dawn'))!;
        const nick = (await getMemberByName(h.server.store, teamRow.id, 'nick'))!;
        const boRow = (await getMemberByName(h.server.store, teamRow.id, 'bo'))!;
        for (let i = 0; i < n; i++) {
          const envelope: Envelope = {
            id: `b${String(i).padStart(4, '0')}`,
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'nick',
            to: { kind: 'member', name: 'bo' },
            act: 'message',
            body: 'x',
            ts: t0 + (tieFrom !== undefined && i >= tieFrom ? tieFrom - 1 : i),
          };
          // Receipt order is what the cursor walks; pin created_at to the same shape as ts so the
          // tie the fixture constructs is a tie in the order that matters.
          await insertMessage(h.server.store, teamRow.id, nick.id, boRow.id, envelope, {
            now: envelope.ts,
          });
        }
        return { boTok: bo.json.human_credential as unknown };
      };

      it('caps an unbounded read at the default and says it truncated', async () => {
        const { boTok } = await teamWithBacklog(220);
        const r = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        expect(r.json.messages).toHaveLength(200);
        expect(r.json.truncated).toBe(true);
        expect(r.json.total).toBe(220);
      });

      it('returns the OLDEST messages, so advancing to the last one seen skips nothing', async () => {
        const { boTok } = await teamWithBacklog(220);
        const r = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        const ids = (r.json.messages as { id: string }[]).map((m) => m.id);
        expect(ids[0]).toBe('b0000');
        expect(ids[199]).toBe('b0199');

        // A reader does the only safe thing after a truncated read: advance to the last row it saw.
        await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'b0199' }, boTok);
        const rest = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        const restIds = (rest.json.messages as { id: string }[]).map((m) => m.id);
        // The remainder is still there, contiguous with what was already read — nothing stepped over.
        expect(restIds).toHaveLength(20);
        expect(restIds[0]).toBe('b0200');
        expect(rest.json.truncated).toBeUndefined();
      });

      it('says nothing about truncation when everything waiting fits', async () => {
        const { boTok } = await teamWithBacklog(3);
        const r = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        expect(r.json.messages).toHaveLength(3);
        expect(r.json.truncated).toBeUndefined();
      });

      /**
       * `unread_remaining` is stated as a count, so it has to be one on every page — not just the
       * first. A paging caller walks with `since` and does NOT advance its cursor mid-drain (advancing
       * past a row it has not rendered is the very loss the prefix exists to prevent), so counting
       * from the cursor alone re-counts everything the earlier pages already delivered.
       *
       * Needs page two to be FULL: on a partial last page the field is suppressed entirely, which is
       * why a 220-message fixture cannot see this and a 420-message one can.
       */
      it('counts what remains after the page it is on, not from the cursor', async () => {
        const { boTok } = await teamWithBacklog(420);
        const p1 = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        expect(p1.json.messages).toHaveLength(200);
        expect(p1.json.unread_remaining).toBe(220);

        const last = (p1.json.messages as { received_at: number }[])[199]!.received_at;
        const p2 = await get(`/teams/dawn/inbox?unread=1&since=${last}`, boTok, {
          'x-musterd-no-touch': '1',
        });
        expect(p2.json.messages).toHaveLength(200);
        // 420 total − 400 delivered across the two pages. Counting from the cursor says 220 again.
        expect(p2.json.unread_remaining).toBe(20);
      });

      /**
       * The bound is safe; the CURSOR that walks it has to be too. `listInbox` orders by `ts ASC,
       * id ASC`, but `since` filters `ts >` strictly and `id` — the declared tiebreak — has no
       * expression in it. A tie straddling the page boundary therefore strands the WHOLE remainder,
       * not one row: page two comes back empty, the drain loop reads that as "caught up", and the
       * caller is told nothing. Found by izzo re-reviewing #943 (lane 01M0GT12W8).
       */
      it('reaches every message when a ts tie straddles the page boundary', async () => {
        const { boTok } = await teamWithBacklog(220, 200);
        const p1 = await get('/teams/dawn/inbox?unread=1', boTok, { 'x-musterd-no-touch': '1' });
        const seen = [...(p1.json.messages as { id: string; received_at: number }[])];
        let page = p1;
        while (page.json.truncated && (page.json.messages as unknown[]).length > 0) {
          const last = seen[seen.length - 1]!;
          page = await get(`/teams/dawn/inbox?unread=1&since=${last.received_at}`, boTok, {
            'x-musterd-no-touch': '1',
          });
          seen.push(...(page.json.messages as { id: string; received_at: number }[]));
        }
        // Nothing may be stranded by the walk: every message, each exactly once.
        expect(new Set(seen.map((m) => m.id)).size).toBe(220);
      });

      /**
       * The same root cause one layer down, and worse: the read cursor is a ts, the unread filter is
       * `ts > last_read_ts`, so a message sharing the cursor row's millisecond is not merely stranded
       * mid-walk — it can never appear as unread again. The cursor row already stores
       * `last_read_message_id`, so the tiebreak is persisted; it just isn't consulted.
       */
      it('still shows an unread message that shares the cursor row millisecond', async () => {
        const { boTok } = await teamWithBacklog(3, 2); // b0002 carries b0001's ts
        const all = await get('/teams/dawn/inbox', boTok, { 'x-musterd-no-touch': '1' });
        const ids = (all.json.messages as { id: string }[]).map((m) => m.id);
        expect(ids).toEqual(['b0000', 'b0001', 'b0002']);

        // Read up to b0001 — the honest thing after seeing it, and b0002 shares its ts.
        await post('/teams/dawn/inbox/cursor', { last_read_message_id: 'b0001' }, boTok);
        const unread = await get('/teams/dawn/inbox?unread=1', boTok, {
          'x-musterd-no-touch': '1',
        });
        expect((unread.json.messages as { id: string }[]).map((m) => m.id)).toEqual(['b0002']);
      });

      /**
       * The tail read has the same boundary, cut from the other end. It does not page (`truncated` is
       * never set for an explicit limit), so nothing can be stranded — but "the newest 5" must still
       * be a well-defined five when twenty rows share the newest millisecond, or two identical
       * requests disagree about what the recent tail is.
       */
      it('takes the newest by (ts, id) when a tie sits on an explicit ?limit= boundary', async () => {
        const { boTok } = await teamWithBacklog(220, 200); // b0199..b0219 all share one ts
        const r = await get('/teams/dawn/inbox?unread=1&limit=5', boTok, {
          'x-musterd-no-touch': '1',
        });
        const ids = (r.json.messages as { id: string }[]).map((m) => m.id);
        expect(ids).toEqual(['b0215', 'b0216', 'b0217', 'b0218', 'b0219']);
        const again = await get('/teams/dawn/inbox?unread=1&limit=5', boTok, {
          'x-musterd-no-touch': '1',
        });
        expect((again.json.messages as { id: string }[]).map((m) => m.id)).toEqual(ids);
      });

      it('leaves an explicit ?limit= alone — that caller asked for the recent tail', async () => {
        const { boTok } = await teamWithBacklog(220);
        const r = await get('/teams/dawn/inbox?unread=1&limit=5', boTok, {
          'x-musterd-no-touch': '1',
        });
        const ids = (r.json.messages as { id: string }[]).map((m) => m.id);
        expect(ids).toEqual(['b0215', 'b0216', 'b0217', 'b0218', 'b0219']);
        expect(r.json.truncated).toBeUndefined();
      });

      it('pins an old unread handoff into an explicit ?limit= page of newer team broadcasts', async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential;
        const bo = await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
        const t0 = Date.now();
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: 'handoff-old',
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'nick',
              to: { kind: 'member', name: 'bo' },
              act: 'handoff',
              body: 'take this',
              ts: t0,
            },
          },
          nickTok,
        );
        for (let i = 0; i < 20; i++) {
          await post(
            '/teams/dawn/messages',
            {
              envelope: {
                id: `t${String(i).padStart(4, '0')}`,
                v: PROTOCOL_VERSION,
                team: 'dawn',
                from: 'nick',
                to: { kind: 'team' },
                act: 'message',
                body: 'noise',
                ts: t0 + 10 + i,
              },
            },
            nickTok,
          );
        }
        const r = await get('/teams/dawn/inbox?unread=1&limit=5', bo.json.human_credential, {
          'x-musterd-no-touch': '1',
        });
        const ids = (r.json.messages as { id: string }[]).map((m) => m.id);
        expect(ids).toContain('handoff-old');
        expect(ids).toEqual(expect.arrayContaining(['t0016', 't0017', 't0018', 't0019']));
      });
    });

    describe('meta.eligible stand-down trace on GET /inbox', async () => {
      /** nick (sender) + bo, cy (eligible) + dee (not eligible), each with its own credential. */
      const teamOfFour = async () => {
        const team = await post('/teams', {
          slug: 'dawn',
          creator: { name: 'nick', kind: 'human' },
        });
        const nickTok = team.json.human_credential;
        const toks: Record<string, unknown> = { nick: nickTok };
        for (const name of ['bo', 'cy', 'dee']) {
          const m = await post('/teams/dawn/members', { name, kind: 'human' }, nickTok);
          toks[name] = m.json.human_credential;
        }
        return toks;
      };

      const ask = async (tok: unknown, id: string, eligible: string[]) =>
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'nick',
              to: { kind: 'team' },
              act: 'message',
              body: 'either of you know why the daemon pinned?',
              ts: Date.now(),
              meta: { eligible },
            },
          },
          tok,
        );

      const answer = async (tok: unknown, from: string, id: string, ref: string, act = 'accept') =>
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from,
              to: { kind: 'member', name: 'nick' },
              act,
              body: 'the lockfile predicate self-heals',
              ts: Date.now() + 1,
              meta: { in_reply_to: ref },
            },
          },
          tok,
        );

      it('names the seat that took the act I no longer owe', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-a', ['bo', 'cy']);
        await answer(t['cy'], 'cy', 'ans-a', 'el-a');

        const inbox = await get('/teams/dawn/inbox', t['bo']);
        expect(inbox.json.discharged).toContainEqual({ id: 'el-a', by: 'cy', reason: 'answered' });
      });

      it('a decline discharges it too — "not me" is an answer', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-b', ['bo', 'cy']);
        await answer(t['cy'], 'cy', 'ans-b', 'el-b', 'decline');

        const inbox = await get('/teams/dawn/inbox', t['bo']);
        expect(inbox.json.discharged).toContainEqual({ id: 'el-b', by: 'cy', reason: 'answered' });
      });

      it('the discharging act is on the timeline bo can read — and the trace is still the inbox saying so', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-c', ['bo', 'cy']);
        await answer(t['cy'], 'cy', 'ans-c', 'el-c');

        // Under ADR 128 this asserted `not.toContain('ans-c')`: cy→nick was a DM, bo was not a party,
        // and need-to-know scoping hid it — "without the trace, bo could not derive who answered at
        // any price". ADR 407 inverts the premise: bo READS every act on its team, so the answer is
        // on the timeline. The trace does not retire with the premise. The inbox is a DELIVERY
        // surface, and a seat mid-draft on an act it no longer owes must be told so where it is
        // looking, not sent to go and correlate a timeline it was never handed (ADR 254 stand-down).
        const timeline = await get('/teams/dawn/messages', t['bo']);
        expect(timeline.json.messages.map((m: { id: string }) => m.id)).toContain('ans-c');
        const inbox = await get('/teams/dawn/inbox', t['bo']);
        expect(inbox.json.discharged).toContainEqual({ id: 'el-c', by: 'cy', reason: 'answered' });
      });

      it('reports the FIRST answer when two land', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-d', ['bo', 'cy']);
        await answer(t['cy'], 'cy', 'ans-d1', 'el-d');
        await answer(t['bo'], 'bo', 'ans-d2', 'el-d');

        const inbox = await get('/teams/dawn/inbox', t['bo']);
        const rows = inbox.json.discharged.filter((d: { id: string }) => d.id === 'el-d');
        expect(rows).toEqual([{ id: 'el-d', by: 'cy', reason: 'answered' }]);
      });

      it('says nothing to a seat outside the set — it never owed the act', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-e', ['bo', 'cy']);
        await answer(t['cy'], 'cy', 'ans-e', 'el-e');

        const inbox = await get('/teams/dawn/inbox', t['dee']);
        expect(inbox.json.discharged).toEqual([]);
      });

      it('stays empty while the act is still open', async () => {
        const t = await teamOfFour();
        await ask(t['nick'], 'el-f', ['bo', 'cy']);
        const inbox = await get('/teams/dawn/inbox', t['bo']);
        expect(inbox.json.discharged).toEqual([]);
      });

      it('is an empty list, never a missing key, on an ordinary inbox', async () => {
        const t = await teamOfFour();
        const inbox = await get('/teams/dawn/inbox', t['dee']);
        expect(inbox.json.discharged).toEqual([]);
      });
    });

    it('ambient presence: a one-shot authenticated command flips the agent present (ADR 057)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      const adaTok = { key: team.json.agent_key, seat: 'Ada' };

      // Ada has never opened a socket → offline.
      const before = await get('/teams/dawn/members', nickTok);
      expect(before.json.members.find((m: any) => m.name === 'Ada')?.activity).toBe('offline');

      // A single one-shot read command is enough to read present — no watch socket.
      await get('/teams/dawn/inbox', adaTok);
      const after = await get('/teams/dawn/members', nickTok);
      const adaRow = after.json.members.find((m: any) => m.name === 'Ada');
      expect(adaRow?.activity).toBe('active'); // present, but no status_update → not "working"
      expect(adaRow?.presence).toBe('online');
      // the ambient row is connectionless and carries the surface header
      expect(adaRow?.presences?.[0]?.surface).toBe('cli');
    });

    it('ambient presence: x-musterd-no-touch suppresses the touch (the notifier opt-out, ADR 057)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);

      // Claiming establishes the lease-bound Presence. A later no-touch read must not alter it.
      const ada = { key: team.json.agent_key, seat: 'Ada' };
      await get('/teams/dawn/inbox', ada);
      const before = await get('/teams/dawn/members', nickTok);
      const beforeAda = before.json.members.find((m: any) => m.name === 'Ada');
      await get('/teams/dawn/inbox', ada, { 'x-musterd-no-touch': '1' });
      const after = await get('/teams/dawn/members', nickTok);
      expect(after.json.members.find((m: any) => m.name === 'Ada')?.presences).toEqual(
        beforeAda.presences,
      );
    });

    it('ambient presence: a status_update reads working, and the surface header is honored (ADR 057)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      const ada = (await resolveAuth('/teams/dawn/messages', {
        key: team.json.agent_key,
        seat: 'Ada',
      }))!;
      const res = await fetch(h.base + '/teams/dawn/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(ada),
          'x-musterd-surface': 'claude-code',
        },
        body: JSON.stringify({
          envelope: {
            id: 'su1',
            v: PROTOCOL_VERSION,
            team: 'dawn',
            from: 'Ada',
            to: { kind: 'team' },
            act: 'status_update',
            body: 'refactoring the reaper',
            ts: Date.now(),
          },
        }),
      });
      expect(res.status).toBe(201);

      const roster = await get('/teams/dawn/members', nickTok);
      const adaRow = roster.json.members.find((m: any) => m.name === 'Ada');
      // posting a status both flips present (ambient) and sets the working label (two-clocks rule)
      expect(adaRow?.activity).toBe('working');
      expect(adaRow?.state).toBe('refactoring the reaper');
      expect(adaRow?.presences?.[0]?.surface).toBe('claude-code');
    });

    it('the roster carries quiescence beside the display fields, unknown when unevidenced (ADR 219)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'Lin', kind: 'agent' }, nickTok);
      // Claiming a lane IS audited (`lane.claimed`); Lin has done nothing audited at all.
      await post(
        '/teams/dawn/lanes',
        { title: 'the thing ada is mid-doing', claim: true },
        { key: team.json.agent_key, seat: 'Ada' },
      );

      const roster = await get('/teams/dawn/members', nickTok);
      const rowFor = (n: string) => roster.json.members.find((m: any) => m.name === n);

      // A seat that has never acted is UNKNOWABLE, not quiet — and `quiet_for_ms` is null rather
      // than a large number, so no consumer can read "very quiet" off an absence of evidence.
      expect(rowFor('Lin')?.quiescence).toEqual({
        state: 'unknown',
        quiet_for_ms: null,
        source: 'audit',
      });

      // Ada just acted, so the audit tier can answer for her.
      expect(rowFor('Ada')?.quiescence?.state).toBe('busy');
      expect(rowFor('Ada')?.quiescence?.source).toBe('audit');
      expect(rowFor('Ada')?.quiescence?.quiet_for_ms).toBeLessThan(120_000);
    });

    it('ambient presence: a live watcher sees the offline→online transition event (ADR 057)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      const adaTok = { key: team.json.agent_key, seat: 'Ada' };

      // nick watches the team roster live.
      const watcher = new TestWs();
      await watcher.open();
      await watcher.claim('dawn', nickTok, 'nick');
      watcher.send({ type: 'subscribe', scope: 'team' });

      // Ada runs a one-shot; the watcher should receive a presence online event for Ada.
      await get('/teams/dawn/inbox', adaTok);
      await pollUntil(() =>
        watcher.frames.some(
          (f) =>
            f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'online',
        ),
      );
      watcher.ws.close();
    });

    it('a live watcher hears a new member the moment it is added (lane 01M3F81DD9)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const watcher = new TestWs();
      await watcher.open();
      await watcher.claim('dawn', nickTok, 'nick');
      watcher.send({ type: 'subscribe', scope: 'team' });

      await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
      await pollUntil(() =>
        watcher.frames.some(
          (f) =>
            f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'offline',
        ),
      );
      watcher.ws.close();
    });

    it('an observer seat is not announced (lane 01M3F81DD9)', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential;
      const watcher = new TestWs();
      await watcher.open();
      await watcher.claim('dawn', nickTok, 'nick');
      watcher.send({ type: 'subscribe', scope: 'team' });

      const r = await post(
        '/teams/dawn/members',
        { name: 'eye', kind: 'agent', observer: true },
        nickTok,
      );
      expect(r.status).toBe(201);
      await new Promise((res) => setTimeout(res, 150));
      expect(watcher.frames.some((f) => f.type === 'presence' && (f as any).member === 'eye')).toBe(
        false,
      );
      watcher.ws.close();
    });
  });

  describe('static web serving (ADR 062)', () => {
    it('serves index + assets, falls back to index for client routes, and keeps API paths as JSON 404', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'musterd-web-'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>musterd live</title>');
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');

      const s = createServer({ db: await openTestDriver(kind), port: 0, webRoot: dir });
      const { port } = await s.listen();
      const b = `http://127.0.0.1:${port}`;
      try {
        const root = await fetch(`${b}/`);
        expect(root.status).toBe(200);
        expect(root.headers.get('content-type')).toMatch(/text\/html/);
        expect(await root.text()).toMatch(/musterd live/);

        const asset = await fetch(`${b}/assets/app.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get('content-type')).toMatch(/javascript/);

        // A client route (no file) falls back to the app shell so deep links / refresh work.
        const spa = await fetch(`${b}/live`);
        expect(spa.status).toBe(200);
        expect(await spa.text()).toMatch(/musterd live/);

        // A missing *asset* (has an extension) is a real 404, not the shell.
        expect((await fetch(`${b}/assets/missing.js`)).status).toBe(404);

        // API namespaces still answer as JSON — static serving never shadows them.
        const api = await fetch(`${b}/teams/none`);
        expect(api.status).toBe(404);
        expect((await api.json()).error.code).toBe('not_found');
      } finally {
        await s.close();
      }
    });

    // Raw http client: unlike undici's fetch it never auto-decompresses, so we can assert on the exact
    // content-encoding the daemon negotiated and diff the raw body ourselves.
    function rawGet(
      url: string,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
      return new Promise((res, rej) => {
        httpGet(url, { headers }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c as Buffer));
          r.on('end', () =>
            res({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
          );
        }).on('error', rej);
      });
    }

    it('compresses text assets per Accept-Encoding, caches immutably, and revalidates the shell', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'musterd-web-'));
      const html = '<!doctype html><title>musterd live</title>';
      writeFileSync(join(dir, 'index.html'), html);
      mkdirSync(join(dir, 'assets'));
      const js = `console.log(${JSON.stringify('x'.repeat(4096))})`;
      writeFileSync(join(dir, 'assets', 'app-abc123.js'), js);
      // A pre-compressed format must be served identity — gzipping it is wasted CPU.
      const png = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...Array(64).fill(0),
      ]);
      writeFileSync(join(dir, 'assets', 'logo-def456.png'), png);

      const s = createServer({ db: await openTestDriver(kind), port: 0, webRoot: dir });
      const { port } = await s.listen();
      const b = `http://127.0.0.1:${port}`;
      try {
        // brotli preferred when offered; the decoded bytes round-trip to the original.
        const br = await rawGet(`${b}/assets/app-abc123.js`, { 'accept-encoding': 'gzip, br' });
        expect(br.headers['content-encoding']).toBe('br');
        expect(br.headers['vary']).toMatch(/accept-encoding/i);
        expect(br.body.length).toBeLessThan(Buffer.byteLength(js));
        expect(brotliDecompressSync(br.body).toString()).toBe(js);
        // Content-hashed asset → cache forever.
        expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');

        // gzip when brotli isn't on the table.
        const gz = await rawGet(`${b}/assets/app-abc123.js`, { 'accept-encoding': 'gzip' });
        expect(gz.headers['content-encoding']).toBe('gzip');
        expect(gunzipSync(gz.body).toString()).toBe(js);

        // No Accept-Encoding → identity, with a real Content-Length.
        const id = await rawGet(`${b}/assets/app-abc123.js`);
        expect(id.headers['content-encoding']).toBeUndefined();
        expect(id.headers['content-length']).toBe(String(Buffer.byteLength(js)));
        expect(id.body.toString()).toBe(js);

        // Binary asset is never compressed even when the client offers it.
        const img = await rawGet(`${b}/assets/logo-def456.png`, { 'accept-encoding': 'gzip, br' });
        expect(img.headers['content-encoding']).toBeUndefined();
        expect(img.body.equals(png)).toBe(true);

        // The app shell revalidates: weak ETag + no-cache, and If-None-Match ⇒ 304.
        const shell = await rawGet(`${b}/`);
        expect(shell.headers['cache-control']).toBe('no-cache');
        const etag = shell.headers['etag'];
        expect(etag).toMatch(/^W\//);
        const revalidated = await rawGet(`${b}/`, { 'if-none-match': etag as string });
        expect(revalidated.status).toBe(304);
        expect(revalidated.body.length).toBe(0);
      } finally {
        await s.close();
      }
    });

    it('stays API-only (404s the web root) when no webRoot is configured', async () => {
      const s = createServer({ db: await openTestDriver(kind), port: 0 });
      const { port } = await s.listen();
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        expect(r.status).toBe(404);
      } finally {
        await s.close();
      }
    });
  });

  describe('API response compression', () => {
    it('compresses large JSON reads per Accept-Encoding and leaves small ones identity', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'bo', kind: 'human' }, nickTok);
      // Seed a backfill well past the 1400-byte threshold.
      for (let i = 0; i < 40; i++) {
        await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: `m${i}`,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'nick',
              to: { kind: 'member', name: 'bo' },
              act: 'message',
              body: `status update ${i} — ${'detail '.repeat(12)}`,
              ts: 1000 + i,
            },
          },
          nickTok,
        );
      }
      const auth = { authorization: `Bearer ${nickTok}` };

      // brotli preferred; the decoded body round-trips to the full timeline.
      const br = await rawHttpGet('/teams/dawn/messages', { ...auth, 'accept-encoding': 'br' });
      expect(br.status).toBe(200);
      expect(br.headers['content-encoding']).toBe('br');
      expect(br.headers['vary']).toMatch(/accept-encoding/i);
      expect(JSON.parse(brotliDecompressSync(br.body).toString()).messages).toHaveLength(40);

      // gzip when brotli isn't offered.
      const gz = await rawHttpGet('/teams/dawn/messages', { ...auth, 'accept-encoding': 'gzip' });
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(JSON.parse(gunzipSync(gz.body).toString()).messages).toHaveLength(40);

      // No Accept-Encoding → identity, and the compressed form is materially smaller.
      const id = await rawHttpGet('/teams/dawn/messages', auth);
      expect(id.headers['content-encoding']).toBeUndefined();
      expect(br.body.length).toBeLessThan(id.body.length / 2);

      // A small response stays identity even when compression is on the table (below threshold).
      const health = await rawHttpGet('/health', { 'accept-encoding': 'br, gzip' });
      expect(health.headers['content-encoding']).toBeUndefined();
    });
  });
});
