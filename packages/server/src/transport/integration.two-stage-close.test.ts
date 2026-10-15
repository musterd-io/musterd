import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAwaitingAcceptance, PROTOCOL_VERSION } from '@musterd/protocol';
import { ulid } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { handleFoldedMessages, retryPendingHumanAsks } from '../protocol/route.js';
import { appendAudit, listAudit } from '../store/audit.js';
import { localNodeForTeam } from '../store/messages.js';
import { REVIEW_LOOP_BREAKER_N } from '../store/review.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from './hub.js';
import { integrationHarness, type Auth } from './integration.helpers.js';

withDrivers('integration · two-stage-close', (_o, kind) => {
  const h = integrationHarness(kind);
  const { authHeaders, get, post, reattestAgentModel, req, resolveAuth } = h;

  describe('two-stage close (ADR 169)', () => {
    /** dawn with nick (human admin) + two agent seats; agents attest a model via ambient touches. */
    async function setup() {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'gee', kind: 'agent' }, nickTok);
      const ada = (await resolveAuth('/teams/dawn/inbox', {
        key: team.json.agent_key,
        seat: 'ada',
      }))!;
      const gee = (await resolveAuth('/teams/dawn/inbox', {
        key: team.json.agent_key,
        seat: 'gee',
      }))!;
      await reattestAgentModel('dawn', ada, 'claude-opus-5');
      await reattestAgentModel('dawn', gee, 'gpt-5.2-codex');
      await get('/teams/dawn/inbox', nickTok); // nick present too (ADR 057 ambient touch)
      return { nickTok, ada, gee, agentKey: team.json.agent_key as string };
    }

    async function patchLane(id: string, body: unknown, auth: Auth) {
      const r = await fetch(h.base + `/teams/dawn/lanes/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(auth) },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    }

    async function auditRows(nickTok: string, action: string) {
      return await auditRowsFor(nickTok, 'dawn', action);
    }
    /** Same, for a team other than the shared `dawn` fixture (the solo-team degradation cases). */
    async function auditRowsFor(tok: string, slug: string, action: string) {
      const audit = await get(`/teams/${slug}/audit`, tok);
      return (audit.json.audit as { action: string }[]).filter((a) => a.action === action);
    }

    // ADR 235. The daemon told the owner "wait <=5m; on silence, lane_resolve yourself", and 20 of 20
    // owners who obeyed had their acceptor come back online later — 55% within an hour, 100% within
    // the sweep's 24h grace, an average 106.8 minutes after the lane was already shut unverified. The
    // advice was right when nothing collected an unanswered lane; with a backstop armed it is what
    // destroys the verdict. So the submit response now reports whether a backstop exists, and the
    // clients advise from that fact rather than a fixed timer.
    describe('the self-close sanction follows the backstop (ADR 235)', () => {
      it('reports the backstop when the team armed the sweep AND an acceptor was asked', async () => {
        const { nickTok, ada } = await setup();
        await post('/teams/dawn/policy', { loops: { review: true, sweep: true } }, nickTok);
        const lane = await post('/teams/dawn/lanes', { title: 'armed', claim: true }, ada);
        const ready = await patchLane(
          lane.json.lane.id as string,
          { state: 'ready_for_review' },
          ada,
        );

        expect(ready.json.review.reviewer).toBeDefined();
        expect(ready.json.review.backstop).toEqual({ armed: true, grace_ms: 24 * 60 * 60 * 1000 });
      });

      // Absent, not `armed:false` — absent is also what an older daemon sends, so the clients have one
      // fallback for both and it is the pre-235 advice. Telling a seat to rely on a sweep that will
      // never run would strand the lane forever, which is the failure the sanction exists to prevent.
      it('omits it when the sweep is not armed — the pre-235 advice still stands', async () => {
        const { ada } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 'unarmed', claim: true }, ada);
        const ready = await patchLane(
          lane.json.lane.id as string,
          { state: 'ready_for_review' },
          ada,
        );

        expect(ready.json.review.reviewer).toBeDefined();
        expect(ready.json.review.backstop).toBeUndefined();
      });

      // The discriminator is `reviewer`, not the policy: with nobody asked there is no verdict coming,
      // so waiting out a 24h grace would be pure delay. This branch keeps its sanction regardless.
      it('omits it when no acceptor was asked, even with the sweep armed', async () => {
        const team = await post('/teams', {
          slug: 'solo',
          creator: { name: 'sol', kind: 'human' },
        });
        const tok = team.json.human_credential as string;
        await post('/teams/solo/policy', { loops: { sweep: true } }, tok);
        const lane = await post('/teams/solo/lanes', { title: 'alone', claim: true }, tok);
        const ready = await req(
          'PATCH',
          `/teams/solo/lanes/${lane.json.lane.id}`,
          { state: 'ready_for_review' },
          tok,
        );

        expect(ready.json.review?.reviewer).toBeUndefined();
        expect(ready.json.review?.backstop).toBeUndefined();
      });
    });

    it('ADR 487: a part-of-several lane is refused a submit until follows_up answers, then the ask carries it', async () => {
      const { ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'store fix 1/2', goal_id: 'store', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      const next = await post('/teams/dawn/lanes', { title: 'store fix, the rest' }, ada);
      const nextId = next.json.lane.id as string;

      const refused = await patchLane(laneId, { state: 'awaiting_acceptance' }, ada);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.json)).toContain('follows_up');

      const ok = await patchLane(
        laneId,
        { state: 'awaiting_acceptance', follows_up: [nextId], acceptor: 'gee' },
        ada,
      );
      expect(ok.status).toBe(200);
      expect(ok.json.lane.follows_up).toEqual([nextId]);
      const board = await req('GET', '/teams/dawn/lanes', undefined, ada);
      const attached = (board.json.lanes as { id: string; goal_id: string | null }[]).find(
        (l) => l.id === nextId,
      );
      expect(attached?.goal_id).toBe('store');
      const inbox = await req('GET', '/teams/dawn/inbox', undefined, gee);
      expect(JSON.stringify(inbox.json)).toContain(`Follows up: ${nextId} [open]`);
    });

    it('lane_ready persists the stage-one attestation, stays contending, and asks a cross-family reviewer', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'fix the store', branch: 'ada/fix', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;

      const ready = await patchLane(
        laneId,
        { state: 'ready_for_review', merged: { pr: 42, sha: 'abc123', authorized_by: 'nick' } },
        ada,
      );
      expect(ready.status).toBe(200);
      expect(ready.json.lane.state).toBe('awaiting_acceptance');
      // Stage-one attestation persisted on the lane; not terminal (resolved_at unset).
      expect(ready.json.lane.merged).toEqual({ pr: 42, sha: 'abc123', authorized_by: 'nick' });
      expect(ready.json.lane.resolved_at).toBeNull();
      // ADR 253: non-risky never asks a human. ada attests claude-*, so gpt-* gee is the acceptor —
      // nick is live and created the team, and is not asked.
      expect(ready.json.review.reviewer).toBe('gee');
      expect(ready.json.review.route).toBe('cross_family');
      expect(ready.json.review.grade).toBe('cross_family');

      // The reviewer got a standard-tier approve ask with structured lane_review meta.
      const inbox = await get('/teams/dawn/inbox?unread=1', gee);
      const ask = inbox.json.messages.find(
        (m: { act: string; meta?: { lane_review?: unknown } }) =>
          m.act === 'ask' && m.meta?.lane_review,
      );
      expect(ask).toBeDefined();
      expect(ask.meta.species).toBe('approve');
      expect(ask.meta.tier).toBe('standard');
      expect(ask.meta.lane_review.lane).toBe(laneId);
      expect(ask.meta.lane_review.branch).toBe('ada/fix');
      // ADR 192: ask body carries outcome-acceptance checklist (not "confirm or send back").
      expect(ask.body).toContain('acceptance requested');
      expect(ask.body).toContain('Intent');
      expect(ask.body).toContain('Principles');
      expect(ask.body).toContain('Usable');
      expect(ask.body).toContain('Feel');
      // goals-front-door design: close-time attribution nudge on a goal-less lane, never blocking.
      expect(ask.body).toContain('on no goal — if it advanced one, link it');

      // The audit recorded the worker's claim — and the achieved grade (ADR 188).
      const rows = await auditRows(nickTok, 'lane.ready_for_review');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail.merged.pr).toBe(42);
      expect(rows[0].detail.review_grade).toBe('cross_family');
      // ADR 303: this is the decision-time roster evidence, not a later reconstruction. `ada` was
      // rejected as self and `nick` was live but excluded from the agents-only peer ladder.
      expect(rows[0].detail.review_selection).toMatchObject({
        outcome: 'peer_selected',
        selected: { reviewer: 'gee', grade: 'cross_family' },
        candidates: expect.arrayContaining([
          { member: 'ada', family: 'claude', eligible: false, exclusion: 'self' },
          { member: 'gee', family: 'gpt', eligible: true, grade: 'cross_family' },
          { member: 'nick', family: 'human', eligible: false, exclusion: 'not_agent' },
        ]),
      });
      expect(ask.meta.lane_review.grade).toBe(rows[0].detail.review_grade);
      expect(ready.json.review.grade).toBe(rows[0].detail.review_grade);
      // No overlap notice when the acceptor never owned the lane — the common case must stay quiet,
      // or the warning becomes wallpaper and the one that matters is not read.
      expect(ask.body).not.toContain('you previously owned this lane');

      // ADR 518: the board says who the lane waits on — the open ask's holder and the route.
      const board = await get('/teams/dawn/lanes', nickTok);
      const shown = board.json.lanes.find((l: { id: string }) => l.id === laneId);
      expect(shown.acceptance_reviewer).toBe('gee');
      expect(shown.acceptance_route).toBe('peer_selected');
    });

    // Lane 01M1T42SBS (ADR 225 amendment, 2026-09-06). The line headlined by RECENCY: with six
    // pending and a routed acceptance the newest, stanley's huddle turn was "+5 more waiting" — a
    // count, not a sentence, and the room could not tell he was being spoken to. The headline is
    // chosen by CLASS (steer > urgent > huddle > acceptance) and recency only breaks ties inside a
    // class; the plural tail names the mix so the rest of the queue is legible too.
    it('ADR 585: the submitter files claims, the acceptor re-checks them, and the lane carries both readings', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'rail the store', branch: 'ada/rail', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      const filed = [
        {
          kind: 'commit_landed',
          ref: 'abc123',
          verdict: 'confirmed',
          checked_by: 'forged',
          checked_at: 1,
          evidence: 'reachable',
        },
        {
          kind: 'ci_green',
          ref: '42',
          verdict: 'unverifiable',
          checked_by: 'forged',
          checked_at: 1,
          evidence: 'gh unavailable',
        },
      ];
      const ready = await patchLane(
        laneId,
        { state: 'awaiting_acceptance', merged: { pr: 42, sha: 'abc123' }, claims: filed },
        ada,
      );
      expect(ready.status, JSON.stringify(ready.json)).toBe(200);
      // The checker is the authenticated sender, whatever the body said.
      expect(ready.json.lane.claims.map((c: { checked_by: string }) => c.checked_by)).toEqual([
        'ada',
        'ada',
      ]);
      const filedRows = await auditRows(nickTok, 'lane.claims_filed');
      expect(filedRows).toHaveLength(1);
      expect(filedRows[0].detail).toMatchObject({
        lane: laneId,
        by: 'ada',
        confirmed: 1,
        unverifiable: 1,
        unconfirmed: 0,
      });
      const readyRows = await auditRows(nickTok, 'lane.ready_for_review');
      expect(readyRows[0].detail.claims).toMatchObject({ confirmed: 1, unverifiable: 1 });

      const inbox = await get('/teams/dawn/inbox?unread=1', gee);
      const ask = inbox.json.messages.find(
        (m: { act: string; meta?: { lane_review?: unknown } }) =>
          m.act === 'ask' && m.meta?.lane_review,
      );
      expect(ask).toBeDefined();
      // gee's accept carries gee's own re-check: a confirmed CI read, and a REFUTED commit claim.
      const accept = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            v: 'musterd/0.3',
            id: 'railaccept000000000000000',
            team: 'dawn',
            from: 'gee',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'looks landed',
            ts: Date.now(),
            meta: {
              in_reply_to: ask.id,
              claims: [
                {
                  kind: 'commit_landed',
                  ref: 'abc123',
                  verdict: 'unconfirmed',
                  checked_by: 'forged',
                  checked_at: 2,
                  evidence: 'not reachable here',
                },
                {
                  kind: 'ci_green',
                  ref: '42',
                  verdict: 'confirmed',
                  checked_by: 'forged',
                  checked_at: 2,
                  evidence: 'every required check succeeded',
                },
              ],
            },
          },
        },
        gee,
      );
      expect(accept.status, JSON.stringify(accept.json)).toBe(201);
      const board = await get('/teams/dawn/lanes', nickTok);
      const afterLane = board.json.lanes.find((l: { id: string }) => l.id === laneId);
      expect(afterLane.state).toBe('done');
      const claims = afterLane.claims as {
        kind: string;
        verdict: string;
        checked_by: string;
      }[];
      expect(claims.map((c) => [c.kind, c.checked_by, c.verdict])).toEqual([
        ['commit_landed', 'ada', 'confirmed'],
        ['commit_landed', 'gee', 'unconfirmed'],
        ['ci_green', 'ada', 'unverifiable'],
        ['ci_green', 'gee', 'confirmed'],
      ]);
      const verifiedRows = await auditRows(nickTok, 'lane.claims_verified');
      expect(verifiedRows).toHaveLength(1);
      expect(verifiedRows[0].detail).toMatchObject({
        lane: laneId,
        by: 'gee',
        confirmed: 1,
        unconfirmed: 1,
      });
      const closed = await auditRows(nickTok, 'lane.closed');
      expect(closed[0].detail.verified).toBe(true);
      expect(closed[0].detail.claims).toMatchObject({
        confirmed: 2,
        unconfirmed: 1,
        unverifiable: 1,
        checkers: ['ada', 'gee'],
      });
    });

    it('interrupt line headlines by class, not recency: a huddle turn outranks a newer routed acceptance', async () => {
      const { nickTok, ada, gee } = await setup();

      // gee is a named participant of an open huddle, and nick takes a turn in it.
      const root = {
        id: 'h-root',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'why we are huddling',
        meta: {
          eligible: ['gee', 'ada'],
          huddle: {
            topic: { kind: 'design', id: 'doorbells' },
            room: 'http://127.0.0.1:4851/b/huddle-h-root',
            anchor: 'docs/wiki/huddles.md',
          },
        },
        ts: Date.now() - 1000,
      };
      await post('/teams/dawn/messages', { envelope: root }, nickTok);
      await post(
        '/teams/dawn/messages',
        {
          envelope: {
            ...root,
            id: 'h-turn',
            body: 'gee, are you there',
            thread: 'h-root',
            meta: undefined,
            ts: Date.now() - 500,
          },
        },
        nickTok,
      );

      // Then ada submits a lane, and the cross-family acceptance routes to gee — NEWER than the turn.
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'fix the store', branch: 'ada/fix', claim: true },
        ada,
      );
      const ready = await patchLane(
        lane.json.lane.id,
        { state: 'ready_for_review', merged: { pr: 42, sha: 'abc123', authorized_by: 'nick' } },
        ada,
      );
      expect(ready.json.review.reviewer).toBe('gee');

      const probe = await get('/teams/dawn/inbox/interrupt-check', gee, {
        'x-musterd-no-touch': '1',
      });
      expect(probe.status).toBe(200);
      expect(probe.json.raised).toBe(true);
      expect(probe.json.count).toBe(2);
      // The headline is the huddle turn, though the acceptance is the more recent act.
      expect(probe.json.act).toMatchObject({ id: 'h-turn', from: 'nick' });
      expect(probe.json.line).toContain('huddle design:doorbells');
      expect(probe.json.line).toContain('h-root');
      // The tail is a sentence: it names what else is waiting, by class, not just how many.
      expect(probe.json.line).toContain('+1 more waiting (1 acceptance)');
      expect(probe.json.line).not.toContain('gee, are you there'); // §4: never the body

      // The audit names the headlined act and its class, so "who grabbed the mic" stays legible.
      const raised = (
        await listAudit(h.server.store, (await getTeamBySlug(h.server.store, 'dawn'))!.id)
      ).filter((r) => r.action === 'interrupt.raised');
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ actor: 'nick', target: 'gee' });
      expect(raised[0]!.detail).toContain('"tier":"huddle"');
    });

    // ADR 234 increment 1 — the LABEL phase. The entire deliverable is that a declared tier reaches
    // the ledger at ready_for_review, so the Eval can later ask whether declared stakes predict the
    // answer rate. Nothing routes on it yet, and this test pins that too: the label must NOT move the
    // reviewer, the tier, or whether an ask is sent. If it did, the pre/post comparison the phase
    // exists to enable would be confounded by the phase itself.
    describe('ADR 234 — declared stakes reach the ledger and change nothing else', () => {
      it.each([
        ['low', 'low'],
        ['high', 'high'],
        [undefined, 'normal'], // undeclared reads as the default — absence IS the declaration
      ] as const)('records stakes=%s as %s at ready_for_review', async (declared, expected) => {
        // ADR 234 increment 2 landed after this test and made `low` route conditionally. The draw is
        // pinned INTO the sample here so all three tiers still route identically — which is what this
        // test is about. The label's own claim (recorded unconditionally, on every tier) is
        // orthogonal to the routing flip and must keep holding on a routed low lane.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const { nickTok, ada } = await setup();
        const lane = await post(
          '/teams/dawn/lanes',
          {
            title: 'fix the store',
            branch: 'ada/fix',
            claim: true,
            ...(declared ? { stakes: declared } : {}),
          },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        // Round-trips on the lane itself, so a client can show what was declared.
        expect(lane.json.lane.stakes).toBe(expected);

        const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        expect(ready.status).toBe(200);

        const rows = await auditRows(nickTok, 'lane.ready_for_review');
        expect(rows).toHaveLength(1);
        // Recorded UNCONDITIONALLY, including the default. A field that vanishes on its most common
        // value makes the largest bucket the one the Eval cannot count.
        expect(rows[0].detail.stakes).toBe(expected);

        // ...and routing is untouched: a `low` lane is still routed exactly like any other.
        expect(ready.json.lane.state).toBe('awaiting_acceptance');
        expect(ready.json.review?.reviewer).toBeDefined();
      });

      it('records stakes_provenance so a policy default is never mistaken for a judgement (ADR 244)', async () => {
        // The measurement trap miley named. ADR 234's rollback test asks whether DECLARED stakes
        // predict the answer rate; once an admin policy can write `low`, one bucket pools worker
        // judgement with policy assumption and the test silently stops being answerable. The ready row
        // has to carry the split, or the Eval cannot recover it.
        vi.spyOn(Math, 'random').mockReturnValue(0); // sample in, so a low lane still routes here
        const { nickTok, ada } = await setup();
        await post(
          '/teams/dawn/policy',
          { stakes_defaults: [{ surface: 'packages/web/**', stakes: 'low' }] },
          nickTok,
        );

        // (a) policy fired — defaulted.
        const auto = await post(
          '/teams/dawn/lanes',
          { title: 'a web tweak', claim: true, scope: ['packages/web/src/x.ts'] },
          ada,
        );
        expect(auto.json.lane.stakes).toBe('low');
        expect(auto.json.lane.stakes_provenance).toBe('defaulted');
        await patchLane(auto.json.lane.id as string, { state: 'ready_for_review' }, ada);

        // (b) same surface, worker overrode upward — declared, and the override is frictionless.
        const manual = await post(
          '/teams/dawn/lanes',
          {
            title: 'a web change that asserts a fact',
            claim: true,
            scope: ['packages/web/src/y.ts'],
            stakes: 'normal',
          },
          ada,
        );
        expect(manual.json.lane.stakes_provenance).toBe('declared');
        await patchLane(manual.json.lane.id as string, { state: 'ready_for_review' }, ada);

        const rows = await auditRows(nickTok, 'lane.ready_for_review');
        const byLane = Object.fromEntries(rows.map((r: any) => [r.detail.lane, r.detail]));
        expect(byLane[auto.json.lane.id].stakes).toBe('low');
        expect(byLane[auto.json.lane.id].stakes_provenance).toBe('defaulted');
        expect(byLane[manual.json.lane.id].stakes).toBe('normal');
        expect(byLane[manual.json.lane.id].stakes_provenance).toBe('declared');
      });

      it('is editable after open — what a change is worth is often clear only once it exists', async () => {
        const { ada } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 't', claim: true }, ada);
        const id = lane.json.lane.id as string;
        expect(lane.json.lane.stakes).toBe('normal');

        const up = await patchLane(id, { stakes: 'high' }, ada);
        expect(up.json.lane.stakes).toBe('high');
        // And back down again — a declaration you cannot revise is one people set defensively.
        const down = await patchLane(id, { stakes: 'low' }, ada);
        expect(down.json.lane.stakes).toBe('low');
        // An unrelated patch must not silently reset it.
        const other = await patchLane(id, { detail: 'unrelated' }, ada);
        expect(other.json.lane.stakes).toBe('low');
      });
    });

    // ADR 234 increment 2 — the ROUTING FLIP. A declared-`low` lane routes no acceptance ask, except
    // the 1-in-5 the sampling hole draws in. The load-bearing claims are not "no ask was sent" (that
    // is the easy half) but what the LEDGER says afterwards: an exempt submit must be distinguishable
    // from the sanctioned no-candidate degradation and from a plain self-close, or increment 2
    // corrupts the very measurement increment 1 shipped to protect.
    describe('ADR 234 increment 2 — declared-low routes no ask, and says so in its own words', () => {
      /** The draw, pinned. 0.99 misses the 1-in-5 hole; 0 falls into it. */
      const draw = (n: number) => vi.spyOn(Math, 'random').mockReturnValue(n);

      it('sends no ask, records acceptance_exempt at ready, and closes acceptance_exempt', async () => {
        draw(0.99);
        const { nickTok, ada, gee } = await setup();
        const laneRes = await post(
          '/teams/dawn/lanes',
          { title: 'typo in a comment', claim: true, stakes: 'low' },
          ada,
        );
        const laneId = laneRes.json.lane.id as string;

        const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        expect(ready.status).toBe(200);
        expect(ready.json.lane.state).toBe('awaiting_acceptance');
        // No acceptor was chosen — and the response says so in the exemption's own vocabulary, NOT as
        // `self_close_sanctioned`. That field is the ADR 172 degradation ("we tried, nobody was
        // eligible, you are forgiven"); being forgiven for a path you deliberately chose teaches the
        // wrong lesson about it.
        expect(ready.json.review.reviewer).toBeUndefined();
        expect(ready.json.review.acceptance_exempt).toBe(true);
        expect(ready.json.review.self_close_sanctioned).toBeUndefined();
        expect(ready.json.review.close_records).toBe('acceptance_exempt');
        // The rate rides along so the exemption never reads as a promise: the next low submit may
        // well route, and a worker who learns "low never routes" has learned something false.
        expect(ready.json.review.sample_rate).toBeGreaterThan(0);

        // Nothing was delivered to the counterpart who WOULD have been picked.
        const inbox = await get(`/teams/dawn/inbox?limit=50`, gee);
        expect(
          (inbox.json.messages as any[]).filter((m) => m.meta?.lane_review?.lane === laneId),
        ).toHaveLength(0);

        const readyRows = await auditRows(nickTok, 'lane.ready_for_review');
        const r0 = readyRows.find((r: any) => r.detail.lane === laneId)!;
        expect(r0.detail.acceptance_exempt).toBe(true);
        // THE GATE (miley's catch): never the null-pick path. `no_candidate` is the bucket meaning
        // "we wanted a counterpart and could not get one"; every exempt lane borrowing it would
        // inflate dolly's n=16 and rot this ADR's own 84% headline.
        expect(r0.detail.no_candidate).toBeUndefined();
        expect(r0.detail.reviewer).toBeUndefined();
        // ADR 217: an exempt lane promised nobody anything, so it stamps no window.
        expect(r0.detail.ask_tier).toBeUndefined();
        expect(r0.detail.ask_timeout_ms).toBeUndefined();
        // ADR 172: `family_posture` answers "why was nobody eligible" — a question this submit never
        // asked. Recording one would put an empty-pool diagnosis on a row where the pool was never
        // consulted, and send a reader after a remedy for a non-problem.
        expect(r0.detail.family_posture).toBeUndefined();
        // The label itself is still recorded, unconditionally, exactly as increment 1 promised.
        expect(r0.detail.stakes).toBe('low');
        expect(r0.detail.exempt_sampled).toBeUndefined();

        await patchLane(laneId, { state: 'done' }, ada);
        const closed = (await auditRows(nickTok, 'lane.closed')).find(
          (r: any) => r.detail.lane === laneId,
        )!;
        expect(closed.detail.reason).toBe('acceptance_exempt');
        // Distinguishable from BOTH neighbours in the unverified bucket, which is the requirement.
        expect(closed.detail.reason).not.toBe('no_candidate');
        expect(closed.detail.reason).not.toBe('self_close');
        // Still an unverified close — nobody confirmed it. Unverified BY DESIGN is a different fact
        // about the fleet than "nobody was available", but it is not a verified one.
        expect(closed.detail.verified).toBe(false);
      });

      it('the 1-in-5 routes exactly like normal, and the draw is recorded so it can be told apart', async () => {
        draw(0);
        const { nickTok, ada } = await setup();
        const laneRes = await post(
          '/teams/dawn/lanes',
          { title: 'also small', claim: true, stakes: 'low' },
          ada,
        );
        const laneId = laneRes.json.lane.id as string;
        const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        expect(ready.json.review.reviewer).toBeTruthy();
        expect(ready.json.review.acceptance_exempt).toBeUndefined();

        const r0 = (await auditRows(nickTok, 'lane.ready_for_review')).find(
          (r: any) => r.detail.lane === laneId,
        )!;
        expect(r0.detail.reviewer).toBeTruthy();
        expect(r0.detail.acceptance_exempt).toBeUndefined();
        // Without this flag a sampled-in low lane is indistinguishable in the ledger from a lane
        // declared `normal` — they route identically — and the hole would produce data nobody could
        // attribute to the low tier. The whole point of paying for the sample is being able to read it.
        expect(r0.detail.exempt_sampled).toBe(true);
        expect(r0.detail.stakes).toBe('low');
        expect(r0.detail.ask_tier).toBe('standard');
        // A CLEAN route records the posture too. When it was written only on the degraded paths,
        // any instrument reading `family_posture` was silently conditioned on routing having
        // already failed — the estimand defect miley's decline of lane 01M08AMC4F named.
        expect(r0.detail.family_posture).toBeDefined();
        expect(['diverse', 'monoculture', 'unknown']).toContain(r0.detail.family_posture.state);
      });

      it('a risk tag outranks the declaration — low + risky still routes to a human', async () => {
        // ADR 172 makes human review a REQUIREMENT on a risky lane. If `stakes: low` could dissolve
        // it, the field would be a second and quieter way to clear `risk`.
        draw(0.99); // would exempt, were the lane not risky
        const { nickTok, ada } = await setup();
        const laneRes = await post(
          '/teams/dawn/lanes',
          { title: 'small but user-facing', claim: true, stakes: 'low', risk: ['user_facing'] },
          ada,
        );
        const laneId = laneRes.json.lane.id as string;
        const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        expect(ready.json.review.acceptance_exempt).toBeUndefined();

        const r0 = (await auditRows(nickTok, 'lane.ready_for_review')).find(
          (r: any) => r.detail.lane === laneId,
        )!;
        expect(r0.detail.acceptance_exempt).toBeUndefined();
        expect(r0.detail.human_required).toBe(true);
      });

      it('normal and high are untouched by the flip, at the draw that would exempt', async () => {
        draw(0.99);
        const { nickTok, ada } = await setup();
        for (const stakes of ['normal', 'high'] as const) {
          const laneRes = await post(
            '/teams/dawn/lanes',
            { title: `a ${stakes} lane`, claim: true, stakes },
            ada,
          );
          const laneId = laneRes.json.lane.id as string;
          const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
          expect(ready.json.review.reviewer).toBeTruthy();
          const r0 = (await auditRows(nickTok, 'lane.ready_for_review')).find(
            (r: any) => r.detail.lane === laneId,
          )!;
          expect(r0.detail.acceptance_exempt).toBeUndefined();
          expect(r0.detail.exempt_sampled).toBeUndefined();
        }
      });

      it('the close reads the RECORDED exemption, so editing stakes afterwards cannot rewrite it', async () => {
        // The trap the reason ladder's own discipline warns about: `stakes` is editable after open
        // (ADR 234), so a close that re-derived the label from the live field would let an edit made
        // minutes later rewrite what the submit actually did — in both directions.
        draw(0.99);
        const { nickTok, ada } = await setup();

        // (a) exempt at submit, then raised to `high` before the close. The close must still say
        // acceptance_exempt: no ask was sent, and no later edit changes that fact.
        const a = await post('/teams/dawn/lanes', { title: 'a', claim: true, stakes: 'low' }, ada);
        const aId = a.json.lane.id as string;
        await patchLane(aId, { state: 'ready_for_review' }, ada);
        await patchLane(aId, { stakes: 'high' }, ada);
        await patchLane(aId, { state: 'done' }, ada);
        const aClosed = (await auditRows(nickTok, 'lane.closed')).find(
          (r: any) => r.detail.lane === aId,
        )!;
        expect(aClosed.detail.reason).toBe('acceptance_exempt');

        // (b) the mirror: routed at submit, then dropped to `low` before the close. A lane whose ask
        // WAS sent must keep an ask-shaped reason — relabelling it exempt would erase a real unanswered
        // acceptance from the numerator the rollback condition is judged on.
        const b = await post(
          '/teams/dawn/lanes',
          { title: 'b', claim: true, stakes: 'normal' },
          ada,
        );
        const bId = b.json.lane.id as string;
        const bReady = await patchLane(bId, { state: 'ready_for_review' }, ada);
        expect(bReady.json.review.reviewer).toBeTruthy();
        await patchLane(bId, { stakes: 'low' }, ada);
        await patchLane(bId, { state: 'done' }, ada);
        const bClosed = (await auditRows(nickTok, 'lane.closed')).find(
          (r: any) => r.detail.lane === bId,
        )!;
        expect(bClosed.detail.reason).not.toBe('acceptance_exempt');
        expect(['review_cut_short', 'review_unanswered', 'review_timeout']).toContain(
          bClosed.detail.reason,
        );
      });

      it('a repeat submit reports the STANDING acceptance, not a fresh decision — and re-sends nothing', async () => {
        // The 2026-08-05 defect this pins: recording a merge SHA after the PR lands is a repeat
        // submit, a legal no-op that re-routes nothing. The transition block composes no `review`,
        // and both clients read that silence as "no eligible acceptor is live" and sanctioned
        // self-close — against lanes whose acceptor held a pending ask. The daemon owns the fact the
        // clients were guessing at, so the repeat now reports it.
        draw(0.99);
        const { nickTok, ada, gee } = await setup();
        const laneRes = await post('/teams/dawn/lanes', { title: 'routed once', claim: true }, ada);
        const laneId = laneRes.json.lane.id as string;
        const first = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        const acceptor = first.json.review.reviewer as string;
        expect(acceptor).toBeTruthy();

        // The repeat: same state, now carrying the merge attestation.
        const again = await patchLane(
          laneId,
          { state: 'ready_for_review', merged: { pr: 7, sha: 'abc123' } },
          ada,
        );
        expect(again.status).toBe(200);
        // Marked `standing` so no consumer mistakes the report for a fresh routing decision — and it
        // names the acceptor who already holds the ask, which is the fact that forbids the sanction.
        expect(again.json.review.standing).toBe(true);
        expect(again.json.review.reviewer).toBe(acceptor);
        expect(again.json.review.self_close_sanctioned).toBeUndefined();

        // Report, not re-ask: still exactly one ready row and one delivered ask.
        const readyRows = await auditRows(nickTok, 'lane.ready_for_review');
        expect(readyRows.filter((r: any) => r.detail.lane === laneId)).toHaveLength(1);
        // The ladder is human-first, so the acceptor may be nick or gee — read the right inbox.
        const inbox = await get(`/teams/dawn/inbox?limit=50`, acceptor === 'gee' ? gee : nickTok);
        expect(
          (inbox.json.messages as any[]).filter((m) => m.meta?.lane_review?.lane === laneId),
        ).toHaveLength(1);
      });

      it('a repeat submit of an exempt lane reports the exemption, never the null-pick sanction', async () => {
        draw(0.99);
        const { ada } = await setup();
        const laneRes = await post(
          '/teams/dawn/lanes',
          { title: 'small twice', claim: true, stakes: 'low' },
          ada,
        );
        const laneId = laneRes.json.lane.id as string;
        await patchLane(laneId, { state: 'ready_for_review' }, ada);
        const again = await patchLane(
          laneId,
          { state: 'ready_for_review', merged: { pr: 8 } },
          ada,
        );
        expect(again.json.review.standing).toBe(true);
        // Keyed on the RECORDED acceptance_exempt from the ready row — same discipline as the close
        // reason, and for the same reason: a repeat submit after a stakes edit must report what the
        // submit did, not what the lane says now.
        expect(again.json.review.acceptance_exempt).toBe(true);
        expect(again.json.review.reviewer).toBeUndefined();
        expect(again.json.review.self_close_sanctioned).toBeUndefined();
      });

      it('a counterpart who confirms an exempt lane anyway still records a verified close', async () => {
        // The exemption removes the ASK, never the possibility. A seat that reviews a low lane
        // unprompted has performed a real cross-seat review, and `verified` must keep meaning what it
        // has always meant — otherwise the exemption would quietly suppress good news too.
        draw(0.99);
        const { nickTok, ada, gee } = await setup();
        const laneRes = await post(
          '/teams/dawn/lanes',
          { title: 'small', claim: true, stakes: 'low' },
          ada,
        );
        const laneId = laneRes.json.lane.id as string;
        await patchLane(laneId, { state: 'ready_for_review' }, ada);
        await patchLane(laneId, { state: 'done' }, gee); // a different seat closes it

        const closed = (await auditRows(nickTok, 'lane.closed')).find(
          (r: any) => r.detail.lane === laneId,
        )!;
        expect(closed.detail.verified).toBe(true);
        expect(closed.detail.reason).toBe('counterpart_confirm');
      });
    });

    // The hole nick observed on 2026-07-31 (lane 01KYN3CKJE): the picker excludes only the CURRENT
    // owner, so a lane that changed hands can route acceptance to a previous owner — an author of the
    // artifact. Deliberately NOT fixed by exclusion: the pool already finds nobody on most attempts,
    // and narrowing it converts confirmed closes into unconfirmed ones. The ask names the overlap and
    // the acceptor recuses by judgment.
    it('names the overlap when the acceptor previously owned the lane, and still routes to them', async () => {
      // An isolated team so the pick is DETERMINISTIC: exactly one eligible candidate, who is the
      // prior owner. On the shared `dawn` fixture the live human would outrank ada and the branch
      // under test would never run — a test that passes without exercising its own subject.
      const t = await post('/teams', { slug: 'coauth', creator: { name: 'nick3', kind: 'human' } });
      const nick3 = t.json.human_credential as string;
      const mk = async (name: string, model: string): Promise<Auth> => {
        await post('/teams/coauth/members', { name, kind: 'agent' }, nick3);
        const auth = (await resolveAuth('/teams/coauth/inbox', {
          key: t.json.agent_key as string,
          seat: name,
        }))!;
        await reattestAgentModel('coauth', auth, model);
        return auth;
      };
      const first = await mk('first', 'claude-opus-5'); // opens, owns, writes it
      const shipper = await mk('shipper', 'gpt-5'); // takes the handoff and ships it
      // nick3 stays OFFLINE after creation, so `first` is the only eligible acceptor.

      const lane = await post(
        '/teams/coauth/lanes',
        { title: 'handed over mid-flight', branch: 'first/work', claim: true },
        first,
      );
      const laneId = lane.json.lane.id as string;

      // The handoff — after this, `first` is a prior owner and invisible to the picker's one exclusion.
      const handed = await fetch(h.base + `/teams/coauth/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(first) },
        body: JSON.stringify({ owner_seat: 'shipper' }),
      }).then(async (r) => (await r.json()) as Record<string, any>);
      expect(handed.lane.owner_seat).toBe('shipper');

      // ADR 260 drops a live agent whose newest *work* audit is inside 120s. `first` just opened
      // and handed this lane, so without aging those rows the pick is null and this test would
      // assert the quiet-filter instead of the overlap it exists to name. Occupancy attestation
      // is already not work; lane open/handoff are.
      await h.db.run(
        `UPDATE audit SET ts = ts - 180000
        WHERE actor = 'first' AND action != 'occupancy.model_attested'`,
      );

      const ready = await fetch(h.base + `/teams/coauth/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(shipper) },
        body: JSON.stringify({
          state: 'ready_for_review',
          merged: { pr: 7, sha: 'deadbee', authorized_by: 'nick3' },
        }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(ready.status).toBe(200);
      // The pool was NOT narrowed: the prior owner is still routable, which is the whole design.
      expect(ready.json.review.reviewer).toBe('first');

      const inbox = await get('/teams/coauth/inbox?unread=1', first);
      const ask = inbox.json.messages.find(
        (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
          m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
      );
      expect(ask).toBeDefined();
      // Routed to the prior owner — allowed, but said out loud, with both options named.
      expect(ask.body).toContain('you previously owned this lane');
      expect(ask.body).toContain('recusing');
      // …and it is still a real acceptance ask, not a refusal.
      expect(ask.body).toContain('acceptance requested');
      expect(ask.meta.lane_review.lane).toBe(laneId);
    });

    it('acceptance ask stays quiet about goals when the lane is attached to one', async () => {
      const { ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'attached work', branch: 'ada/att', goal_id: 'g1', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await patchLane(
        laneId,
        { state: 'ready_for_review', merged: { pr: 43, sha: 'abc124', authorized_by: 'nick' } },
        ada,
      );
      const inbox = await get('/teams/dawn/inbox?unread=1', gee);
      const ask = inbox.json.messages.find(
        (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
          m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
      );
      expect(ask).toBeDefined();
      expect(ask.body).not.toContain('on no goal');
    });

    // The ledger read is the whole mechanism, so pin it directly rather than only through the ask:
    // ownership history must survive a handoff and list both holders, newest first.
    it('lane ownership history lists every prior owner from the lane.claimed ledger', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'history', branch: 'ada/hist', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await patchLane(laneId, { owner_seat: 'gee' }, ada);

      const rows = (await auditRows(nickTok, 'lane.claimed')).filter(
        (r: { target?: string }) => r.target === laneId,
      ) as { detail: { owner?: string; kind?: string; at_open?: boolean } }[];
      // Two acquisitions: the birth claim (#579) and the handoff — the birth row is why a lane that
      // was born owned is legible here at all.
      expect(rows.map((r) => r.detail.owner).sort()).toEqual(['ada', 'gee']);
      expect(rows.find((r) => r.detail.at_open)?.detail.owner).toBe('ada');
      expect(rows.find((r) => r.detail.kind === 'handoff')?.detail.owner).toBe('gee');
    });

    it('a cross_model counterpart is routable and graded as such (ADR 188)', async () => {
      // A private team with just two agents of one family, different models — the dawn fixture's
      // live human and cross-family gee would outrank the rung this test is about.
      const t = await post('/teams', { slug: 'grade', creator: { name: 'nick2', kind: 'human' } });
      const nick2 = t.json.human_credential as string;
      const mk = async (name: string, model: string): Promise<Auth> => {
        await post(`/teams/grade/members`, { name, kind: 'agent' }, nick2);
        const auth = (await resolveAuth('/teams/grade/inbox', {
          key: t.json.agent_key as string,
          seat: name,
        }))!;
        await reattestAgentModel('grade', auth, model);
        return auth;
      };
      const worker = await mk('worker', 'claude-opus-5');
      await mk('twin', 'claude-opus-4-8');
      // nick2 stays OFFLINE (no ambient touch before the ready), so the human rung cannot outrank the
      // cross_model rung this test is about.

      const lane = await post('/teams/grade/lanes', { title: 'graded', claim: true }, worker);
      const ready = await fetch(h.base + `/teams/grade/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(worker) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(ready.status).toBe(200);
      // Before ADR 188 this was a no_candidate: same family, different model. Now it routes, graded.
      expect(ready.json.review.reviewer).toBe('twin');
      expect(ready.json.review.grade).toBe('cross_model');
      const rows = await auditRowsFor(nick2, 'grade', 'lane.ready_for_review');
      expect(rows[0].detail.review_grade).toBe('cross_model');

      // The close edge derives the grade too (ADR 188): twin (opus-4.8) confirms worker's (opus-5)
      // lane — verified:true with review_grade cross_model beside it, not a bare boolean.
      const twin = (await resolveAuth('/teams/grade/lanes', {
        key: t.json.agent_key as string,
        seat: 'twin',
      }))!;
      const closed = await fetch(h.base + `/teams/grade/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(twin) },
        body: JSON.stringify({ state: 'done' }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(closed.status).toBe(200);
      const closedRows = await auditRowsFor(nick2, 'grade', 'lane.closed');
      expect(closedRows[0].detail.verified).toBe(true);
      expect(closedRows[0].detail.review_grade).toBe('cross_model');
    });

    it('an unattested worker is routed at the `ungraded` rung and the close abstains (ADR 351)', async () => {
      const t = await post('/teams', {
        slug: 'ungraded',
        creator: { name: 'nick4', kind: 'human' },
      });
      const nick4 = t.json.human_credential as string;
      const mk = async (name: string, model?: string): Promise<Auth> => {
        await post(`/teams/ungraded/members`, { name, kind: 'agent' }, nick4);
        const auth = (await resolveAuth('/teams/ungraded/inbox', {
          key: t.json.agent_key as string,
          seat: name,
        }))!;
        if (model !== undefined) await reattestAgentModel('ungraded', auth, model);
        return auth;
      };
      // The worker is live on a bare claim that attests nothing — the shape a CLI-driven seat has
      // when no harness binding is present (12 of 129 no_candidate rows to 2026-09-02).
      const worker = await mk('worker');
      const twin = await mk('twin', 'claude-opus-4-8');

      const lane = await post('/teams/ungraded/lanes', { title: 'ungraded', claim: true }, worker);
      const laneId = lane.json.lane.id as string;
      const ready = await fetch(h.base + `/teams/ungraded/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(worker) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(ready.status).toBe(200);
      // Before ADR 351 this was a no_candidate. Now it routes — and the record claims no diversity.
      expect(ready.json.review).toMatchObject({
        reviewer: 'twin',
        route: 'ungraded',
        grade: 'ungraded',
      });
      const rows = await auditRowsFor(nick4, 'ungraded', 'lane.ready_for_review');
      expect(rows[0].detail.no_candidate).toBeUndefined();
      expect(rows[0].detail.route).toBe('ungraded');
      expect(rows[0].detail.review_grade).toBe('ungraded');
      expect(rows[0].detail.review_selection).toMatchObject({
        outcome: 'peer_selected',
        worker_family: 'unknown',
        selected: { reviewer: 'twin', grade: 'ungraded' },
      });
      // The ask the reviewer sees carries the same word, so nobody reads a cross_family it is not.
      const inbox = await get('/teams/ungraded/inbox?unread=1', twin);
      const ask = inbox.json.messages.find(
        (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
          m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
      );
      expect(ask.meta.lane_review.grade).toBe('ungraded');

      // The close edge grades from live attestations (ADR 188 §3): the worker still attests nothing,
      // so the grade abstains and the abstention is COUNTED (ADR 173) — verified, ungraded, honest.
      const closed = await fetch(h.base + `/teams/ungraded/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(twin) },
        body: JSON.stringify({ state: 'done' }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(closed.status).toBe(200);
      const closedRows = await auditRowsFor(nick4, 'ungraded', 'lane.closed');
      expect(closedRows[0].detail.verified).toBe(true);
      expect(closedRows[0].detail.review_grade).toBeUndefined();
      expect(closedRows[0].detail.review_grade_unknown).toBe(true);
    });

    it('a same-model voluntary confirm stays verified but is graded same_model (ADR 188)', async () => {
      const t = await post('/teams', { slug: 'twins', creator: { name: 'n3', kind: 'human' } });
      const n3 = t.json.human_credential as string;
      const mk = async (name: string): Promise<Auth> => {
        await post(`/teams/twins/members`, { name, kind: 'agent' }, n3);
        const auth = (await resolveAuth('/teams/twins/inbox', {
          key: t.json.agent_key as string,
          seat: name,
        }))!;
        await reattestAgentModel('twins', auth, 'claude-opus-5');
        return auth;
      };
      const a = await mk('alpha');
      const b = await mk('beta');
      const lane = await post('/teams/twins/lanes', { title: 'twinned', claim: true }, a);
      const patch = async (body: unknown, auth: Auth) =>
        fetch(h.base + `/teams/twins/lanes/${lane.json.lane.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders(auth) },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      await patch({ state: 'ready_for_review' }, a); // same-model twin ⇒ no_candidate routed
      const closed = await patch({ state: 'done' }, b); // beta confirms anyway — legal, never a wedge
      expect(closed.status).toBe(200);
      const rows = await auditRowsFor(n3, 'twins', 'lane.closed');
      expect(rows[0].detail.verified).toBe(true); // a different seat DID confirm
      expect(rows[0].detail.review_grade).toBe('same_model'); // and the grade says what it was worth
    });

    // The grade a lane is ROUTED with and the grade its confirm is WORTH are two different facts, and
    // a seat can change model between them: observed live 2026-08-02, when a reviewer routed at
    // cross_model re-attested to the worker's own model six minutes later, inside one acceptance
    // window. Model switches take seconds here and the window is five minutes, so this is ordinary,
    // not exotic. The close edge already re-derives from LIVE attestations and downgrades correctly
    // (three real lanes in the dogfood ledger routed cross_model and closed same_model) — but nothing
    // pinned it: the sibling test above only covers a confirm that was never routed at all. Untested
    // correct behaviour is one refactor from becoming a false diversity claim, and this particular
    // number feeds ADR 056's conclusions, so it fails in the direction that matters.
    it('a reviewer who re-attests to the worker model is graded on what it was worth, not what it was routed as', async () => {
      const t = await post('/teams', { slug: 'switch', creator: { name: 'n4', kind: 'human' } });
      const n4 = t.json.human_credential as string;
      const mk = async (name: string, model: string): Promise<Auth> => {
        await post('/teams/switch/members', { name, kind: 'agent' }, n4);
        const auth = (await resolveAuth('/teams/switch/inbox', {
          key: t.json.agent_key as string,
          seat: name,
        }))!;
        await reattestAgentModel('switch', auth, model);
        return auth;
      };
      const worker = await mk('worker', 'claude-opus-5');
      const reviewer = await mk('reviewer', 'claude-opus-4-8'); // different model ⇒ routable
      // n4 stays offline so the human rung cannot outrank the cross_model one under test.

      const lane = await post('/teams/switch/lanes', { title: 'switched', claim: true }, worker);
      const patch = async (body: unknown, auth: Auth) =>
        fetch(h.base + `/teams/switch/lanes/${lane.json.lane.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders(auth) },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

      const ready = await patch({ state: 'ready_for_review' }, worker);
      expect(ready.json.review.reviewer).toBe('reviewer');
      expect(ready.json.review.grade).toBe('cross_model'); // true AT ROUTING TIME

      // …then the reviewer's session comes back on the worker's own model, as a real one did.
      await fetch(h.base + '/teams/switch/inbox', {
        headers: { ...authHeaders(reviewer), 'x-musterd-model': 'claude-opus-5' },
      });
      const closed = await patch({ state: 'done' }, reviewer);
      expect(closed.status).toBe(200);

      const readyRows = await auditRowsFor(n4, 'switch', 'lane.ready_for_review');
      const closedRows = await auditRowsFor(n4, 'switch', 'lane.closed');
      // The routing row keeps its own truth — it records the decision that was made, and rewriting
      // history to match the outcome would destroy the ability to ask why a seat was chosen.
      expect(readyRows[0].detail.review_grade).toBe('cross_model');
      // The close records what the review was actually WORTH. These two disagreeing is correct.
      expect(closedRows[0].detail.verified).toBe(true); // a different seat did confirm
      expect(closedRows[0].detail.review_grade).toBe('same_model');
      expect(closedRows[0].detail.reviewer_family).toBeDefined();
    });

    it('counterpart confirm derives verified:true and carries the stage-one attestation into git.pr_merged', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'fix the store', branch: 'ada/fix', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await patchLane(
        laneId,
        { state: 'ready_for_review', merged: { pr: 42, sha: 'abc123', authorized_by: 'nick' } },
        ada,
      );

      // nick (a different seat) confirms — no fresh merged on the closing patch.
      const closed = await patchLane(laneId, { state: 'done' }, nickTok);
      expect(closed.status).toBe(200);
      expect(closed.json.lane.state).toBe('done');

      const closedRows = await auditRows(nickTok, 'lane.closed');
      expect(closedRows).toHaveLength(1);
      expect(closedRows[0].detail.verified).toBe(true);
      expect(closedRows[0].detail.reason).toBe('counterpart_confirm');
      expect(closedRows[0].detail.closed_by).toBe('nick');
      expect(closedRows[0].detail.owner_at_close).toBe('ada');
      expect(closedRows[0].detail.worker_family).toBe('claude');
      expect(closedRows[0].detail.reviewer_family).toBe('human');
      // ADR 188: a human confirmer grades as 'human' — cross-family by construction, named honestly.
      expect(closedRows[0].detail.review_grade).toBe('human');
      expect(closedRows[0].detail.time_in_review_ms).toBeGreaterThanOrEqual(0);

      // git.pr_merged carries the worker's stage-one attestation, credited via attested_by.
      const merged = await auditRows(nickTok, 'git.pr_merged');
      expect(merged).toHaveLength(1);
      expect(merged[0].actor).toBe('nick');
      expect(merged[0].detail.pr).toBe(42);
      expect(merged[0].detail.sha).toBe('abc123');
      expect(merged[0].detail.attested_by).toBe('ada');
    });

    it('counterpart close with a partial merged patch keeps the worker attestation (ADR 305)', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'keep the submit stamp', branch: 'ada/keep-stamp', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await patchLane(
        laneId,
        {
          state: 'ready_for_review',
          merged: {
            pr: 42,
            sha: 'abc123',
            authorized_by: 'nick',
            verification: 'ancestor',
          },
        },
        ada,
      );

      // The MCP/CLI counterpart-resolve shape: re-sends pr/sha/authorized_by and drops verification.
      const closed = await patchLane(
        laneId,
        { state: 'done', merged: { pr: 42, sha: 'abc123', authorized_by: 'nick' } },
        nickTok,
      );
      expect(closed.status).toBe(200);
      expect(closed.json.lane.merged).toEqual({
        pr: 42,
        sha: 'abc123',
        authorized_by: 'nick',
        verification: 'ancestor',
      });

      const merged = await auditRows(nickTok, 'git.pr_merged');
      expect(merged[0].detail.pr).toBe(42);
      expect(merged[0].detail.sha).toBe('abc123');
      expect(merged[0].detail.authorized_by).toBe('nick');
      expect(merged[0].detail.attested_by).toBe('ada');
    });

    it('owner close may still rewrite merged — ADR 305 is counterpart-only', async () => {
      const { ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'worker may re-attest', branch: 'ada/re-attest', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await patchLane(
        laneId,
        {
          state: 'ready_for_review',
          merged: {
            pr: 42,
            sha: 'abc123',
            authorized_by: 'nick',
            verification: 'ancestor',
          },
        },
        ada,
      );
      const closed = await patchLane(
        laneId,
        { state: 'done', merged: { pr: 42, sha: 'abc123', authorized_by: 'nick' } },
        ada,
      );
      expect(closed.status).toBe(200);
      expect(closed.json.lane.merged).toEqual({
        pr: 42,
        sha: 'abc123',
        authorized_by: 'nick',
      });
    });

    it('counterpart close on a never-submitted lane ESTABLISHES the attestation — ADR 305 strips only what stands (amendment 1)', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'never submitted', branch: 'ada/never-submitted', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      // The worker was told to skip lane_submit; the lane landed and the acceptor closes it as a
      // non-owner with the flags the tool description tells them to pass. Measured 2026-09-06 on
      // 01M1VEMAKX / #1370: the row closed `done` with `merged` null and git.pr_merged carrying only
      // the lane id — the only attestation anyone would ever offer, silently discarded.
      const closed = await patchLane(
        laneId,
        { state: 'done', merged: { pr: 1370, sha: 'd2a0f0fe', authorized_by: 'nick' } },
        nickTok,
      );
      expect(closed.status).toBe(200);
      expect(closed.json.lane.merged).toEqual({ pr: 1370, sha: 'd2a0f0fe', authorized_by: 'nick' });

      const merged = await auditRows(nickTok, 'git.pr_merged');
      expect(merged[0].detail.pr).toBe(1370);
      expect(merged[0].detail.sha).toBe('d2a0f0fe');
      expect(merged[0].detail.authorized_by).toBe('nick');
    });

    // Lane 01M2GR0434 (stanley, 2026-09-14): a merge attestation could not be CLEARED through any
    // exposed path — `updateLane` honours `merged: null`, but `UpdateLaneSchema.merged` was
    // `.optional()` without `.nullable()`, so the wire rejected the clear (measured: 400 "merged:
    // Expected object, received null") and a lane that acquired a wrong stamp kept it for good.
    it('the owner (or an admin) clears a wrong attestation with merged: null; a counterpart may not (ADR 305 amendment 2)', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'wrong stamp', branch: 'ada/wrong-stamp', claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      const stamped = await patchLane(laneId, { merged: { pr: 1, sha: 'aaaa0001' } }, ada);
      expect(stamped.json.lane.merged).toEqual({ pr: 1, sha: 'aaaa0001' });
      // A counterpart's clear is a replacement-with-nothing of the worker's stamp — ADR 305's rule.
      const byCounterpart = await patchLane(laneId, { merged: null }, gee);
      expect(byCounterpart.status).toBe(403);
      expect(byCounterpart.json.error.code).toBe('forbidden');
      const byOwner = await patchLane(laneId, { merged: null }, ada);
      expect(byOwner.status).toBe(200);
      expect(byOwner.json.lane.merged).toBeNull();
      // The clear is a recorded transition, so a replicating peer folds it (changes.merged.to null).
      const updated = (await auditRows(nickTok, 'lane.updated')).filter(
        (r: any) => r.detail.lane === laneId && r.detail.fields.includes('merged'),
      );
      // Newest first, as `auditRows` returns them: the clear is the latest merged change.
      expect(updated.some((r: any) => r.detail.changes.merged.to === null)).toBe(true);
      // An admin may clear too: the row is the team's record, and the owner may be gone.
      const again = await patchLane(laneId, { merged: { pr: 1, sha: 'aaaa0001' } }, ada);
      expect(again.status).toBe(200);
      const byAdmin = await patchLane(laneId, { merged: null }, nickTok);
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.json.lane.merged).toBeNull();
    });

    // The guard that would have caught 01M2GBGA03: delta closed their lane from the VM with stanley's
    // PR 1376 / 23ae48bb — ancestor-verified, because the SHA IS on main — and nothing asked whether
    // that SHA already attested a different seat's lane. Measured on the live db 2026-09-14: 657
    // distinct attested SHAs, 10 on two lanes, nine of them the same owner's twin lanes closed by one
    // PR (legitimate, and must stay so) and the tenth this defect. So the rule is cross-OWNER.
    it("a SHA that already attests a DIFFERENT seat's lane is refused naming that lane; a seat's own twin lanes may share one PR", async () => {
      const { nickTok, ada, gee } = await setup();
      const first = await post(
        '/teams/dawn/lanes',
        { title: "ada's landed work", branch: 'ada/landed', claim: true },
        ada,
      );
      const firstId = first.json.lane.id as string;
      const submitted = await patchLane(
        firstId,
        { state: 'ready_for_review', merged: { pr: 1376, sha: '23ae48bb', authorized_by: 'nick' } },
        ada,
      );
      expect(submitted.status).toBe(200);

      // gee's lane, closed with ada's merge: refused, and the refusal names the lane that owns it.
      const other = await post(
        '/teams/dawn/lanes',
        { title: "gee's unrelated lane", branch: 'gee/unrelated', claim: true },
        gee,
      );
      const otherId = other.json.lane.id as string;
      const wrong = await patchLane(
        otherId,
        { state: 'done', merged: { pr: 1376, sha: '23ae48bb', authorized_by: 'nick' } },
        gee,
      );
      expect(wrong.status).toBe(409);
      expect(wrong.json.error.code).toBe('conflict');
      expect(wrong.json.error.message).toContain(firstId);
      expect(wrong.json.error.message).toContain('ada');
      const untouched = await get(`/teams/dawn/lanes`, nickTok);
      expect(
        (untouched.json.lanes as { id: string; state: string; merged: unknown }[]).find(
          (l) => l.id === otherId,
        ),
      ).toMatchObject({ state: 'claimed', merged: null });

      // ada's own second lane, landed by the same PR: allowed — one PR may close two of one seat's lanes.
      const twin = await post(
        '/teams/dawn/lanes',
        { title: "ada's twin, same PR", branch: 'ada/landed', claim: true },
        ada,
      );
      const twinDone = await patchLane(
        twin.json.lane.id as string,
        { state: 'done', merged: { pr: 1376, sha: '23ae48bb', authorized_by: 'nick' } },
        ada,
      );
      expect(twinDone.status).toBe(200);
      expect(twinDone.json.lane.merged).toMatchObject({ sha: '23ae48bb' });
    });

    /**
     * ADR 202 — the verdict moves the lane it judges. Before this, an `accept` answering an acceptance
     * ask wrote telemetry and left the lane sitting in awaiting_acceptance; the acceptor had to
     * remember a second, separate close. Measured on the live team: three reviewed lanes in one
     * evening recorded as unreviewed because the second call never came.
     */
    /** ADR 484 — the challenge-evidence rail: warn the conceding sender, never refuse, ships OFF. */
    describe('challenge-evidence rail (ADR 484)', () => {
      async function send(
        who: Auth | string,
        from: string,
        act: string,
        body: string,
        replyTo?: string,
      ) {
        const id = ulid();
        const r = await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id,
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from,
              to: { kind: 'team' },
              act,
              body,
              ...(replyTo ? { meta: { in_reply_to: replyTo } } : {}),
              ts: Date.now(),
            },
          },
          who,
        );
        return { id, ...r };
      }

      it('is off by default: an unverified concession is stored with no notice and no audit', async () => {
        const { nickTok, ada } = await setup();
        const ch = await send(nickTok, 'nick', 'challenge', 'are you sure?');
        const a = await send(ada, 'ada', 'accept', 'fair, changing it', ch.id);
        expect(a.status).toBe(201);
        expect(a.json.evidence_notice).toBeUndefined();
        expect(await auditRows(nickTok, 'challenge.accept_unverified')).toHaveLength(0);
      });

      it('when on: warns once per challenge, audits it, and leaves verified accepts and declines alone', async () => {
        const { nickTok, ada } = await setup();
        expect(
          (await post('/teams/dawn/policy', { challenge_evidence_rail: true }, nickTok)).status,
        ).toBe(200);
        const ch = await send(nickTok, 'nick', 'challenge', 'are you sure?');

        const first = await send(ada, 'ada', 'accept', 'fair, changing it', ch.id);
        expect(first.status).toBe(201);
        expect(first.json.evidence_notice).toMatch(/without naming what you checked/);
        const again = await send(ada, 'ada', 'accept', 'yes, agreed', ch.id);
        expect(again.json.evidence_notice).toBeUndefined();
        const rows = await auditRows(nickTok, 'challenge.accept_unverified');
        expect(rows).toHaveLength(1);
        expect((rows[0] as any).target).toBe(ch.id);

        const ch2 = await send(nickTok, 'nick', 'challenge', 'and this?');
        const verified = await send(ada, 'ada', 'accept', 'ran `pnpm test`: 3 fail', ch2.id);
        expect(verified.json.evidence_notice).toBeUndefined();
        const declined = await send(ada, 'ada', 'decline', 'no, holding', ch2.id);
        expect(declined.json.evidence_notice).toBeUndefined();
      });
    });

    describe('an acceptance verdict moves the lane (ADR 202)', () => {
      /** Post `act` as `who`, answering the acceptance ask `askId`. */
      async function verdict(who: Auth | string, from: string, askId: string, act: string) {
        return await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: ulid(),
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from,
              to: { kind: 'team' },
              act,
              body: `${act} — exercised it`,
              meta: { in_reply_to: askId },
              ts: Date.now(),
            },
          },
          who,
        );
      }

      /** A lane in awaiting_acceptance, plus the acceptance ask's id from the reviewer's inbox. */
      async function laneAwaitingAcceptance(nickTok: string, ada: Auth, gee: Auth) {
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'the verdict lane', branch: 'ada/verdict', claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        const ready = await patchLane(
          laneId,
          { state: 'ready_for_review', merged: { pr: 7, sha: 'deadbee', authorized_by: 'nick' } },
          ada,
        );
        const reviewer = ready.json.review.reviewer as string;
        const auth: Auth | string = reviewer === 'nick' ? nickTok : gee;
        const inbox = await get('/teams/dawn/inbox?unread=1', auth);
        const ask = inbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        return { laneId, reviewer, auth, askId: ask.id as string };
      }

      it('closes the lane on accept, with the same verified derivation the board produces', async () => {
        const { nickTok, ada, gee } = await setup();
        const { laneId, reviewer, auth, askId } = await laneAwaitingAcceptance(nickTok, ada, gee);

        const sent = await verdict(auth, reviewer, askId, 'accept');
        expect(sent.status).toBe(201);
        // Lane 01M2GQFJXG (stanley, 2026-09-14): the accept's ack said nothing about the lane it had
        // just closed, so a reviewer who sent `accept` as an ANNOUNCEMENT ("taking this review")
        // learned only later that the announcement was the verdict. The ack names the move.
        expect(sent.json.lane_verdict).toEqual({ lane: laneId, state: 'done' });

        const lane = await get(`/teams/dawn/lanes`, nickTok);
        const closed = (lane.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(closed!.state).toBe('done');

        // The audit is the point: this must read exactly as a board close by the same seat, or the
        // record would depend on which door the verdict came through.
        const rows = await auditRows(nickTok, 'lane.closed');
        expect(rows).toHaveLength(1);
        expect(rows[0].detail.lane).toBe(laneId);
        expect(rows[0].detail.closed_by).toBe(reviewer);
        expect(rows[0].detail.owner_at_close).toBe('ada');
        expect(rows[0].detail.verified).toBe(true);
        expect(rows[0].detail.reason).toBe('counterpart_confirm');
        // ADR 109: the worker's stage-one attestation still flows into the merge join.
        const merged = await auditRows(nickTok, 'git.pr_merged');
        expect(merged[0].detail.pr).toBe(7);
        expect(merged[0].detail.attested_by).toBe('ada');
      });

      /**
       * Lane 01M2P2E2H6 — the falsifier that opened the lane, run as a test: reply to a fresh
       * acceptance ask with the announcement a seat actually means, and read the lane's state.
       * Before this, the only reply the rail offered was `accept`, which closed the lane on the send.
       */
      it('a `wait` on the ask TAKES it without deciding: nothing moves, and the verdict is still owed', async () => {
        const { nickTok, ada, gee } = await setup();
        const { laneId, reviewer, auth, askId } = await laneAwaitingAcceptance(nickTok, ada, gee);

        const taken = await verdict(auth, reviewer, askId, 'wait');
        expect(taken.status).toBe(201);
        // The sender learns what their send did — here, that it did NOT decide. Without this the
        // acknowledge and the verdict are indistinguishable from the sender's side, which is the
        // ambiguity this lane exists to remove rather than relocate.
        expect(taken.json.lane_ack).toEqual({ lane: laneId });
        expect(taken.json.lane_verdict).toBeUndefined();

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const still = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(isAwaitingAcceptance(still!.state)).toBe(true);
        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(0);

        // It IS recorded — the board and the teammates can see the review is taken.
        const acked = await auditRows(nickTok, 'lane.review_acknowledged');
        expect(acked).toHaveLength(1);
        expect(acked[0].detail.lane).toBe(laneId);
        expect(acked[0].detail.ask).toBe(askId);
        expect(acked[0].detail.acceptor).toBe(reviewer);

        // And the ask is NOT discharged: the same ask still takes the real verdict afterwards. An
        // acknowledge that consumed the ask would have replaced one trap with a quieter one.
        const decided = await verdict(auth, reviewer, askId, 'accept');
        expect(decided.status).toBe(201);
        expect(decided.json.lane_verdict).toEqual({ lane: laneId, state: 'done' });
        const closed = await auditRows(nickTok, 'lane.closed');
        expect(closed).toHaveLength(1);
        expect(closed[0].detail.verified).toBe(true);
      });

      it('the ask itself names both moves, so the acceptor reads it BEFORE deciding', async () => {
        const { nickTok, ada, gee } = await setup();
        const { auth, laneId } = await laneAwaitingAcceptance(nickTok, ada, gee);
        const inbox = await get('/teams/dawn/inbox?unread=1', auth);
        const ask = inbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        // The guidance used to arrive only in the ack, i.e. after the write it was warning about.
        expect(ask.body).toContain('IS the verdict');
        expect(ask.body).toContain('`wait`');
      });

      it('a `wait` that answers something other than a live acceptance ask reports no ack', async () => {
        const { nickTok, ada, gee } = await setup();
        // A plain directed act, not a daemon-composed lane_review ask.
        const plain = await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: ulid(),
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'ada',
              to: { kind: 'member', name: 'gee' },
              act: 'request_help',
              body: 'can you look at this',
              ts: Date.now(),
            },
          },
          ada,
        );
        const taken = await verdict(gee, 'gee', plain.json.ack.id as string, 'wait');
        expect(taken.status).toBe(201);
        expect(taken.json.lane_ack).toBeUndefined();
        expect(await auditRows(nickTok, 'lane.review_acknowledged')).toHaveLength(0);
      });

      // The acceptance a human routes by hand had no door into the ledger. Measured 2026-09-01 on
      // lane 01M1F9QVG6XCFQAZSH7XSZ13JT: nick routed acceptance to `ghost`, ghost reviewed and sent a
      // real `accept`, and the close still recorded `verified: false` / self_close — because the
      // accept auto-targeted a plain `request_help` (meta NULL), `applyAcceptanceVerdict` returns at
      // its `!replied?.meta` guard, and the lane never left awaiting_acceptance for the owner to do
      // it themselves. The ask is the only binding, so an ask nobody composed is an acceptance the
      // ledger cannot see — understating review in exactly the field ADR 056 counts from.
      it('a submit naming its acceptor routes the ask there, and that seat’s accept closes it verified', async () => {
        const { nickTok, ada, gee } = await setup();
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'named acceptor', branch: 'ada/named', claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;

        const ready = await patchLane(
          laneId,
          {
            state: 'ready_for_review',
            acceptor: 'gee',
            merged: { pr: 11, sha: 'cafe11', authorized_by: 'nick' },
          },
          ada,
        );
        expect(ready.status).toBe(200);
        expect(ready.json.review.reviewer).toBe('gee');
        // `named` is its own route, never folded into a pick. The daemon's picker is what enforces
        // cross-family eligibility, so recording a hand-routed acceptor as if it had been picked
        // would feed a diversity claim nobody made into the ADR 056 counts.
        expect(ready.json.review.route).toBe('named');

        // The named seat gets a real, server-composed lane_review ask — the only thing an accept
        // can bind to.
        const inbox = await get('/teams/dawn/inbox?unread=1', gee);
        const ask = inbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(ask).toBeDefined();
        expect(ask.meta.lane_review.route).toBe('named');

        expect((await verdict(gee, 'gee', ask.id as string, 'accept')).status).toBe(201);

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const closed = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(closed!.state).toBe('done');

        const rows = await auditRows(nickTok, 'lane.closed');
        expect(rows).toHaveLength(1);
        expect(rows[0].detail.closed_by).toBe('gee');
        expect(rows[0].detail.owner_at_close).toBe('ada');
        // The whole point: a routed-by-hand acceptance is a confirmed close, not a self_close.
        expect(rows[0].detail.verified).toBe(true);
        expect(rows[0].detail.reason).toBe('counterpart_confirm');

        // …and the submit row says the routing was named, so the two reads never disagree.
        const submitted = await auditRows(nickTok, 'lane.ready_for_review');
        expect(submitted[0].detail.route).toBe('named');
        expect(submitted[0].detail.reviewer).toBe('gee');
      });

      // A refused acceptor must not leave the lane submitted. The name is validated after the state
      // row is written, so if the refusal did not roll back, the owner would get a 400 telling them
      // nothing was routed while the lane sat in awaiting_acceptance with no ask — the exact silent
      // limbo this whole lane exists to remove, reintroduced by the fix for it.
      it('refuses an unknown acceptor and leaves the lane where it was', async () => {
        const { nickTok, ada } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 'bad acceptor', claim: true }, ada);
        const laneId = lane.json.lane.id as string;
        const bad = await patchLane(laneId, { state: 'ready_for_review', acceptor: 'nobody' }, ada);
        expect(bad.status).toBe(400);
        expect(JSON.stringify(bad.json)).toContain('no such seat');

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const still = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(still!.state).toBe('claimed');
      });

      // Lane 01M1QYHJFY. Two seats in one hour named an acceptor on a lane ALREADY awaiting
      // acceptance and got a 200 with no ask: the routing block is edge-triggered on entering
      // awaiting_acceptance, so a re-route fell through it, and the hint then sanctioned self-close.
      // Mutation control, run by hand before this landed: with the re-route arm removed from
      // http.ts this test fails at the first `expect(ask).toBeDefined()` — the old edge guard alone
      // mints nothing here.
      it('re-routes an already-awaiting lane to a named seat: new ask, old ask closed, old verdict inert', async () => {
        const { nickTok, ada, gee, agentKey } = await setup();
        // A third agent to re-route to, attested on a third model so the pairing grades honestly.
        await post('/teams/dawn/members', { name: 'hal', kind: 'agent' }, nickTok);
        const hal = (await resolveAuth('/teams/dawn/inbox', { key: agentKey, seat: 'hal' }))!;
        await reattestAgentModel('dawn', hal, 'gemini-3-pro');

        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'reroute me', branch: 'ada/reroute', claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        const first = await patchLane(
          laneId,
          {
            state: 'ready_for_review',
            acceptor: 'gee',
            merged: { pr: 12, sha: 'cafe12', authorized_by: 'nick' },
          },
          ada,
        );
        expect(first.status).toBe(200);
        expect(first.json.review.reviewer).toBe('gee');
        const geeInbox = await get('/teams/dawn/inbox?unread=1', gee);
        const oldAsk = geeInbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(oldAsk).toBeDefined();

        // The re-route: same state, a different name. Before the fix this was the silent no-op.
        const again = await patchLane(
          laneId,
          { state: 'awaiting_acceptance', acceptor: 'hal' },
          ada,
        );
        expect(again.status).toBe(200);
        expect(again.json.review.rerouted).toBe(true);
        expect(again.json.review.reviewer).toBe('hal');
        expect(again.json.review.route).toBe('named');
        expect(again.json.review.superseded).toBe('gee');
        expect(again.json.review.standing).toBeUndefined();

        // hal holds a real, server-composed ask — the only thing an accept can bind to.
        const halInbox = await get('/teams/dawn/inbox?unread=1', hal);
        const ask = halInbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(ask).toBeDefined();
        expect(ask.meta.lane_review.route).toBe('named');

        // gee was TOLD: a daemon-composed resolve on the old ask's thread, naming where it went.
        const geeAfter = await get('/teams/dawn/inbox?unread=1', gee);
        const closed = geeAfter.json.messages.find(
          (m: { act: string; thread?: string | null }) =>
            m.act === 'resolve' && m.thread === oldAsk.id,
        );
        expect(closed).toBeDefined();
        expect(closed.body).toContain('re-routed to hal');
        // …and the old ask is off gee's interrupt line — an obligation nobody holds must not ring.
        const probe = await get('/teams/dawn/inbox/interrupt-check', gee);
        expect(probe.status).toBe(200);
        expect(JSON.stringify(probe.json)).not.toContain(laneId);

        // The audit says what happened, in its own verb — NOT a second submit row.
        const rerouted = await auditRows(nickTok, 'lane.review_rerouted');
        expect(rerouted).toHaveLength(1);
        expect(rerouted[0].detail.reviewer).toBe('hal');
        expect(rerouted[0].detail.from_reviewer).toBe('gee');
        expect(rerouted[0].detail.superseded_ask).toBe(oldAsk.id);
        expect(await auditRows(nickTok, 'lane.ready_for_review')).toHaveLength(1);

        // A late verdict from gee on the superseded ask binds to nothing: the lane stays awaiting.
        // ADR 545: and gee is TOLD so on the ack — which ask holds the lane now, and whose it is.
        const late = await verdict(gee, 'gee', oldAsk.id as string, 'accept');
        expect(late.status).toBe(201);
        expect(late.json.lane_verdict).toBeUndefined();
        expect(late.json.lane_superseded).toEqual({
          lane: laneId,
          ask: oldAsk.id,
          current: { ask: ask.id, reviewer: 'hal' },
        });
        const lanesMid = await get('/teams/dawn/lanes', nickTok);
        expect(
          (lanesMid.json.lanes as { id: string; state: string }[]).find((l) => l.id === laneId)!
            .state,
        ).toBe('awaiting_acceptance');
        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(0);

        // hal's accept is the one that closes it — verified, counterpart_confirm, closed_by hal.
        expect((await verdict(hal, 'hal', ask.id as string, 'accept')).status).toBe(201);
        const lanesEnd = await get('/teams/dawn/lanes', nickTok);
        expect(
          (lanesEnd.json.lanes as { id: string; state: string }[]).find((l) => l.id === laneId)!
            .state,
        ).toBe('done');
        const rows = await auditRows(nickTok, 'lane.closed');
        expect(rows).toHaveLength(1);
        expect(rows[0].detail.closed_by).toBe('hal');
        expect(rows[0].detail.verified).toBe(true);
        expect(rows[0].detail.reason).toBe('counterpart_confirm');
      });

      it('a second verdict on an ask answered before a resubmit moves nothing (lane 01M4VH00A8)', async () => {
        // 2026-10-13, lane 01M4V95YGT: a reviewer declined, the owner resubmitted, and the reviewer
        // declined the OLD ask again — which sent the resubmitted lane back to active, so their
        // accept on the new ask 4 s later moved nothing.
        const { nickTok, ada, gee } = await setup();
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'resubmit me', branch: 'ada/resubmit', claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        const submit = () =>
          patchLane(
            laneId,
            {
              state: 'ready_for_review',
              acceptor: 'gee',
              merged: { pr: 13, sha: 'cafe13', authorized_by: 'nick' },
            },
            ada,
          );
        const reviewAsks = async () =>
          (await get('/teams/dawn/inbox?unread=0', gee)).json.messages.filter(
            (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
              m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
          ) as { id: string }[];
        const stateOf = async () =>
          (
            (await get('/teams/dawn/lanes', nickTok)).json.lanes as { id: string; state: string }[]
          ).find((l) => l.id === laneId)!.state;

        expect((await submit()).status).toBe(200);
        const [oldAsk] = await reviewAsks();
        expect((await verdict(gee, 'gee', oldAsk!.id, 'decline')).json.lane_verdict).toEqual({
          lane: laneId,
          state: 'active',
        });

        expect((await submit()).status).toBe(200);
        const newAsk = (await reviewAsks()).find((a) => a.id !== oldAsk!.id);
        expect(newAsk).toBeDefined();
        expect(await stateOf()).toBe('awaiting_acceptance');

        const stale = await verdict(gee, 'gee', oldAsk!.id, 'decline');
        expect(stale.status).toBe(201);
        expect(stale.json.lane_verdict).toBeUndefined();
        expect(stale.json.lane_superseded).toEqual({
          lane: laneId,
          ask: oldAsk!.id,
          current: { ask: newAsk!.id, reviewer: 'gee' },
        });
        expect(await stateOf()).toBe('awaiting_acceptance');

        expect((await verdict(gee, 'gee', newAsk!.id, 'accept')).json.lane_verdict).toEqual({
          lane: laneId,
          state: 'done',
        });
      });

      it('a peer accept on a SUPERSEDED risky-lane ask fires no human ask and says where the ask went (ADR 545)', async () => {
        // Before ADR 545 the escalation hook never asked whether the ask was still live: a peer
        // answering an ask the reaper had already moved woke the human for a review nobody held.
        const { nickTok, ada, gee, agentKey } = await setup();
        await post('/teams/dawn/members', { name: 'hal', kind: 'agent' }, nickTok);
        const hal = (await resolveAuth('/teams/dawn/inbox', { key: agentKey, seat: 'hal' }))!;
        await reattestAgentModel('dawn', hal, 'gemini-3-pro');
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'risky reroute', risk: ['destructive'], claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        await patchLane(laneId, { state: 'ready_for_review', acceptor: 'gee' }, ada);
        const oldAsk = (await get('/teams/dawn/inbox?unread=1', gee)).json.messages.find(
          (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        await patchLane(laneId, { state: 'awaiting_acceptance', acceptor: 'hal' }, ada);
        const newAsk = (await get('/teams/dawn/inbox?unread=1', hal)).json.messages.find(
          (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );

        const late = await verdict(gee, 'gee', oldAsk.id as string, 'accept');
        expect(late.status).toBe(201);
        expect(late.json.lane_escalation).toBeUndefined();
        expect(late.json.lane_superseded).toEqual({
          lane: laneId,
          ask: oldAsk.id,
          current: { ask: newAsk.id, reviewer: 'hal' },
        });
        expect(await auditRows(nickTok, 'lane.review_peer_confirmed')).toHaveLength(0);
        const nickInbox = await get('/teams/dawn/inbox?unread=1', nickTok);
        expect(
          nickInbox.json.messages.filter((m: any) => m.act === 'ask' && m.meta?.lane_review),
        ).toHaveLength(0);
      });

      it('a `wait` on a superseded ask is acked as superseded, not as taking the review (ADR 545)', async () => {
        const { nickTok, ada, gee, agentKey } = await setup();
        await post('/teams/dawn/members', { name: 'hal', kind: 'agent' }, nickTok);
        const hal = (await resolveAuth('/teams/dawn/inbox', { key: agentKey, seat: 'hal' }))!;
        await reattestAgentModel('dawn', hal, 'gemini-3-pro');
        const lane = await post('/teams/dawn/lanes', { title: 'wait late', claim: true }, ada);
        const laneId = lane.json.lane.id as string;
        await patchLane(laneId, { state: 'ready_for_review', acceptor: 'gee' }, ada);
        const oldAsk = (await get('/teams/dawn/inbox?unread=1', gee)).json.messages.find(
          (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        await patchLane(laneId, { state: 'awaiting_acceptance', acceptor: 'hal' }, ada);

        const late = await verdict(gee, 'gee', oldAsk.id as string, 'wait');
        expect(late.status).toBe(201);
        expect(late.json.lane_ack).toBeUndefined();
        expect(late.json.lane_superseded?.current?.reviewer).toBe('hal');
      });

      it('re-routing to the seat that already holds the ask mints nothing and reports it standing', async () => {
        const { nickTok, ada, gee } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 'same seat', claim: true }, ada);
        const laneId = lane.json.lane.id as string;
        await patchLane(laneId, { state: 'ready_for_review', acceptor: 'gee' }, ada);
        const again = await patchLane(
          laneId,
          { state: 'awaiting_acceptance', acceptor: 'gee' },
          ada,
        );
        expect(again.status).toBe(200);
        expect(again.json.review.standing).toBe(true);
        expect(again.json.review.reviewer).toBe('gee');
        const inbox = await get('/teams/dawn/inbox?unread=1', gee);
        const asks = inbox.json.messages.filter(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(asks).toHaveLength(1);
        expect(await auditRows(nickTok, 'lane.review_rerouted')).toHaveLength(0);
      });

      // Lane 01M1VF8166 (2026-09-06). A re-route by name is a routing request, not a second
      // attestation — but the MCP tool sends `merged: { verification }` on every submit, and with no
      // SHA that verification is `unattested`. Measured on the live daemon: five ancestor-verified
      // lanes re-routed by name each lost {pr, sha, authorized_by} to {verification:"unattested"}
      // in one lane.updated row. The guard lives in decideLanePatch so the hub arbitration and the
      // local path agree: a patch that carries no attestation cannot downgrade one that stands.
      it('a re-route that carries no attestation keeps the standing merge attestation', async () => {
        const { nickTok, ada, agentKey } = await setup();
        await post('/teams/dawn/members', { name: 'hal', kind: 'agent' }, nickTok);
        const hal = (await resolveAuth('/teams/dawn/inbox', { key: agentKey, seat: 'hal' }))!;
        await reattestAgentModel('dawn', hal, 'gemini-3-pro');
        const lane = await post('/teams/dawn/lanes', { title: 'keep my sha', claim: true }, ada);
        const laneId = lane.json.lane.id as string;
        const attested = {
          pr: 77,
          sha: 'facade77',
          authorized_by: 'nick',
          verification: 'ancestor',
        };
        const first = await patchLane(
          laneId,
          { state: 'ready_for_review', acceptor: 'gee', merged: attested },
          ada,
        );
        expect(first.status).toBe(200);
        expect(first.json.lane.merged).toEqual(attested);

        // Exactly what the MCP tool sends for `lane_submit {id, acceptor}` with no pr/sha.
        const again = await patchLane(
          laneId,
          { state: 'awaiting_acceptance', acceptor: 'hal', merged: { verification: 'unattested' } },
          ada,
        );
        expect(again.status).toBe(200);
        expect(again.json.review.rerouted).toBe(true);
        expect(again.json.lane.merged).toEqual(attested);
        const rerouted = await auditRows(nickTok, 'lane.review_rerouted');
        expect(rerouted).toHaveLength(1);
        expect(rerouted[0].detail.merged).toEqual(attested);
        // The ledger never saw a downgrade: the only lane.updated row touching `merged` is the first
        // submit's (null → attested); the re-route wrote no merged change at all.
        const updated = await auditRows(nickTok, 'lane.updated');
        const mergedRows = updated.filter((r) =>
          (r.detail.fields as string[] | undefined)?.includes('merged'),
        );
        expect(mergedRows).toHaveLength(1);
        expect((mergedRows[0].detail.changes as { merged: { to: unknown } }).merged.to).toEqual(
          attested,
        );

        // A patch that DOES carry a SHA still replaces the block — re-attesting is allowed.
        const reattest = {
          pr: 78,
          sha: 'facade78',
          authorized_by: 'nick',
          verification: 'ancestor',
        };
        const third = await patchLane(
          laneId,
          { state: 'awaiting_acceptance', acceptor: 'gee', merged: reattest },
          ada,
        );
        expect(third.status).toBe(200);
        expect(third.json.lane.merged).toEqual(reattest);
      });

      // The other door into the same limbo: `acceptor` on a patch that does not leave the lane
      // awaiting acceptance validates the name and has nowhere to route it. Refused before the write.
      it('refuses an acceptor on a patch that is not a submit, and applies none of the patch', async () => {
        const { nickTok, ada } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 'not a submit', claim: true }, ada);
        const laneId = lane.json.lane.id as string;
        const bad = await patchLane(laneId, { state: 'active', acceptor: 'gee' }, ada);
        expect(bad.status).toBe(400);
        expect(JSON.stringify(bad.json)).toContain('rides a submit');
        const lanes = await get('/teams/dawn/lanes', nickTok);
        expect(
          (lanes.json.lanes as { id: string; state: string }[]).find((l) => l.id === laneId)!.state,
        ).toBe('claimed');
      });

      it('refuses an owner who names themselves — that close could only ever be unverified', async () => {
        const { ada } = await setup();
        const lane = await post('/teams/dawn/lanes', { title: 'self named', claim: true }, ada);
        const bad = await patchLane(
          lane.json.lane.id as string,
          { state: 'ready_for_review', acceptor: 'ada' },
          ada,
        );
        expect(bad.status).toBe(400);
        expect(JSON.stringify(bad.json)).toContain('unverified close');
      });

      it('sends the lane back to active on decline, and audits the rejection', async () => {
        const { nickTok, ada, gee } = await setup();
        const { laneId, reviewer, auth, askId } = await laneAwaitingAcceptance(nickTok, ada, gee);

        expect((await verdict(auth, reviewer, askId, 'decline')).status).toBe(201);

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const back = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(back!.state).toBe('active');
        const sentBack = await auditRows(nickTok, 'lane.review_sent_back');
        expect(sentBack).toHaveLength(1);
        expect(sentBack[0].detail.reviewer).toBe(reviewer);
        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(0);
      });

      it('is idempotent — a second accept on the same ask does not re-close or reopen', async () => {
        const { nickTok, ada, gee } = await setup();
        const { reviewer, auth, askId } = await laneAwaitingAcceptance(nickTok, ada, gee);

        await verdict(auth, reviewer, askId, 'accept');
        await verdict(auth, reviewer, askId, 'accept');

        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(1);
      });

      it('a risky lane escalates instead of closing — stage one hands off, it does not decide', async () => {
        // The ADR 188 interaction this feature could quietly break: on a risky lane the PEER's accept
        // is a screening, not the verdict. If the accept closed the lane here, the human review the
        // risk tag demands would be asked for and then made irrelevant by the same act.
        const { nickTok, ada, gee } = await setup();
        const lane = await post(
          '/teams/dawn/lanes',
          { title: 'drop the old table', risk: ['destructive'], claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
        expect(ready.json.review.reviewer).toBe('gee'); // the peer, stage one
        const geeInbox = await get('/teams/dawn/inbox?unread=1', gee);
        const peerAsk = geeInbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );

        await verdict(gee, 'gee', peerAsk.id as string, 'accept');

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const still = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(still!.state).toBe('awaiting_acceptance'); // waiting on the human, not closed
        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(0);
        // …and the human really was asked, at the blocking tier (the stage-two handoff).
        const nickInbox = await get('/teams/dawn/inbox?unread=1', nickTok);
        const humanAsk = nickInbox.json.messages.find(
          (m: { act: string; meta?: { lane_review?: { lane?: string }; tier?: string } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(humanAsk).toBeDefined();
        expect(humanAsk.meta.tier).toBe('blocking');
      });

      it('leaves ordinary accepts alone — an act answering a non-lane ask touches no lane', async () => {
        const { nickTok, ada, gee } = await setup();
        const { laneId, askId, reviewer, auth } = await laneAwaitingAcceptance(nickTok, ada, gee);
        // A plain directed ask, nothing to do with lanes.
        const plain = await post(
          '/teams/dawn/messages',
          {
            envelope: {
              id: ulid(),
              v: PROTOCOL_VERSION,
              team: 'dawn',
              from: 'ada',
              to: { kind: 'member', name: reviewer },
              act: 'ask',
              body: 'unrelated question',
              meta: { species: 'consult', tier: 'advisory' },
              ts: Date.now(),
            },
          },
          ada,
        );
        expect(plain.status).toBe(201);
        await verdict(auth, reviewer, plain.json.ack.id as string, 'accept');

        const lanes = await get('/teams/dawn/lanes', nickTok);
        const still = (lanes.json.lanes as { id: string; state: string }[]).find(
          (l) => l.id === laneId,
        );
        expect(still!.state).toBe('awaiting_acceptance');
        expect(await auditRows(nickTok, 'lane.closed')).toHaveLength(0);
        expect(askId).toBeDefined();
      });
    });

    it('owner self-close from review derives verified:false / review_cut_short; legacy direct close derives self_close', async () => {
      const { nickTok, ada } = await setup();
      // Lane A: through review, then self-closed by the owner (the ADR 145 degradation). It closes in
      // milliseconds, far inside the `standard` window the acceptor was promised — so ADR 217 grades
      // it `review_cut_short`, not the `review_timeout` this test asserted while the reason consulted
      // no clock at all.
      const a = await post('/teams/dawn/lanes', { title: 'lane a', claim: true }, ada);
      await patchLane(a.json.lane.id, { state: 'ready_for_review' }, ada);
      await patchLane(a.json.lane.id, { state: 'done' }, ada);
      // Lane B: today's callers — straight active → done, never entered review.
      const b = await post('/teams/dawn/lanes', { title: 'lane b', claim: true }, ada);
      await patchLane(b.json.lane.id, { state: 'active' }, ada);
      await patchLane(b.json.lane.id, { state: 'done' }, ada);

      const rows = await auditRows(nickTok, 'lane.closed');
      const byLane = Object.fromEntries(rows.map((r: any) => [r.detail.lane, r.detail]));
      expect(byLane[a.json.lane.id].verified).toBe(false);
      expect(byLane[a.json.lane.id].reason).toBe('review_cut_short');
      // ADR 217: the promise is carried on the close row, so the grading is auditable without
      // re-reading the ready edge.
      expect(byLane[a.json.lane.id].promised_wait_ms).toBe(20 * 60_000);
      expect(byLane[a.json.lane.id].time_in_review_ms).toBeLessThan(20 * 60_000);
      expect(byLane[b.json.lane.id].verified).toBe(false);
      expect(byLane[b.json.lane.id].reason).toBe('self_close');
    });

    it('a close with no counterpart derives no_candidate, never review_timeout (nothing was asked)', async () => {
      // A team of exactly one: `pickReviewCounterpart` finds nobody, so NO review ask is sent.
      // Calling that close a "timeout" asserts a question was asked and went unanswered — it wasn't.
      // The distinction is the difference between "reviewers rubber-stamp" and "review never ran",
      // and ADR 169's counter-metric ("if nearly all review asks expire unanswered, the tier or the
      // routing is wrong") indicts the tier and the picker unless these two are separable.
      const team = await post('/teams', { slug: 'solo', creator: { name: 'sol', kind: 'human' } });
      const solTok = team.json.human_credential as string;
      const lane = await post('/teams/solo/lanes', { title: 'alone', claim: true }, solTok);
      const soloPatch = async (body: unknown) => {
        const r = await fetch(h.base + `/teams/solo/lanes/${lane.json.lane.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${solTok}` },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json()) as Record<string, any> };
      };

      const ready = await soloPatch({ state: 'ready_for_review' });
      expect(ready.json.review.self_close_sanctioned).toBe(true); // nobody to ask
      expect(ready.json.review.empty_pool).toEqual({ kind: 'no_live_member' });
      // ADR 172: the sanction says WHY nobody was eligible — the derived family posture. A team of
      // one human has zero attesting agents, so the honest state is `unknown`, never `monoculture`.
      expect(ready.json.review.family_posture.state).toBe('unknown');
      expect(ready.json.review.family_posture.attesting).toBe(0);
      expect(typeof ready.json.review.posture_hint).toBe('string');
      await soloPatch({ state: 'done' });

      const rows = await auditRowsFor(solTok, 'solo', 'lane.closed');
      const closed = rows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(closed.detail.verified).toBe(false); // unchanged — still an unverified close
      expect(closed.detail.reason).toBe('no_candidate');

      // And the routing outcome is recorded where it is KNOWN — at ready time, not inferred later.
      const readyRows = await auditRowsFor(solTok, 'solo', 'lane.ready_for_review');
      const r0 = readyRows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(r0.detail.no_candidate).toBe(true);
      expect(r0.detail.review_selection).toMatchObject({
        outcome: 'no_candidate',
        selected: null,
        candidates: [{ member: 'sol', family: 'human', eligible: false, exclusion: 'self' }],
      });
      // ADR 172: the audit row carries the posture compactly (wake_pool as a COUNT, not names), so a
      // series of no_candidate rows is analyzable later without replaying presence history.
      expect(r0.detail.family_posture.state).toBe('unknown');
      expect(r0.detail.family_posture.wake_pool).toBe(0);
      expect(r0.detail.reviewer).toBeUndefined();
    });

    it('a routed review that the owner closes anyway derives review_cut_short', async () => {
      // The other side of the same coin: here an ask WAS sent, so the close is honestly about the
      // wait — and ADR 217 says which way. Closing immediately is the owner cutting its own promise
      // short, which is a different failure from a window that genuinely elapsed.
      const { nickTok, ada } = await setup();
      const lane = await post('/teams/dawn/lanes', { title: 'routed', claim: true }, ada);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(ready.json.review.reviewer).toBeTruthy(); // a counterpart existed and was asked
      await patchLane(lane.json.lane.id, { state: 'done' }, ada);

      const rows = await auditRows(nickTok, 'lane.closed');
      const closed = rows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(closed.detail.reason).toBe('review_cut_short');
      const readyRows = await auditRows(nickTok, 'lane.ready_for_review');
      const r0 = readyRows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(r0.detail.reviewer).toBeTruthy();
      expect(r0.detail.no_candidate).toBeUndefined();
      // ADR 217: the promise is recorded at the ready edge, where the tier is decided — the close edge
      // has no business re-deriving it later from a roster that has moved on.
      expect(r0.detail.ask_tier).toBe('standard');
      expect(r0.detail.ask_timeout_ms).toBe(20 * 60_000);
      // ADR 506: the owner's reply states the same promise the ready row recorded.
      expect(ready.json.review.wait_ms).toBe(20 * 60_000);
    });

    it("a team's acceptance_review_window_ms is the promise the ready row records and the reply states (ADR 506)", async () => {
      const { nickTok, ada } = await setup();
      expect(
        (await post('/teams/dawn/policy', { acceptance_review_window_ms: 45 * 60_000 }, nickTok))
          .status,
      ).toBe(200);
      const lane = await post('/teams/dawn/lanes', { title: 'slow team', claim: true }, ada);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(ready.json.review.reviewer).toBeTruthy();
      expect(ready.json.review.wait_ms).toBe(45 * 60_000);
      const readyRows = await auditRows(nickTok, 'lane.ready_for_review');
      const r0 = readyRows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(r0.detail.ask_timeout_ms).toBe(45 * 60_000);
    });

    it('an owner that WAITS the promised window derives review_unanswered, not cut_short (ADR 217)', async () => {
      // The other half of the split, and the one that makes it worth having: same edges, same actors,
      // same unconfirmed close — only the elapsed wait differs. If both shapes still landed on one
      // reason, no remedy aimed at either could ever be measured.
      const { nickTok, ada } = await setup();
      const lane = await post('/teams/dawn/lanes', { title: 'patient', claim: true }, ada);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(ready.json.review.reviewer).toBeTruthy();

      // Past the review window the acceptor was promised (ADR 506: 20m by default). Faked rather than
      // waited: the point is the comparison, and a real 20-minute test is a 20-minute test.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 20 * 60_000 + 1_000));
      try {
        // The 5-minute proof is intentionally expired at this boundary; a real adapter reclaims to
        // mint a fresh lease before it may close the lane.
        const refreshed = await post('/teams/dawn/claim', {
          key: ada.key,
          target: { seat: ada.seat },
          surface: 'cli',
        });
        Object.assign(ada, { sessionLease: refreshed.json.session_lease });
        await patchLane(lane.json.lane.id, { state: 'done' }, ada);
      } finally {
        vi.useRealTimers();
      }

      const rows = await auditRows(nickTok, 'lane.closed');
      const closed = rows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(closed.detail.reason).toBe('review_unanswered');
      expect(closed.detail.promised_wait_ms).toBe(20 * 60_000);
      expect(closed.detail.time_in_review_ms).toBeGreaterThanOrEqual(20 * 60_000);
      // Still never a wedge (ADR 145): waiting longer changes the LABEL, never the owner's ability to
      // close, and never the verified-ness the close derives.
      expect(closed.detail.verified).toBe(false);
    });

    it('reviewer send-back audits lane.review_sent_back and the lane resumes', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post('/teams/dawn/lanes', { title: 'needs work', claim: true }, ada);
      await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);

      const back = await patchLane(
        lane.json.lane.id,
        { state: 'active', detail: 'the error path is untested — send it back through' },
        gee,
      );
      expect(back.json.lane.state).toBe('active');
      const rows = await auditRows(nickTok, 'lane.review_sent_back');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail.reviewer).toBe('gee');
      expect(rows[0].detail.owner).toBe('ada');
    });

    it('chat rejection persists its concrete note in lane.review_sent_back', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post('/teams/dawn/lanes', { title: 'needs a note', claim: true }, ada);
      await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      const inbox = await get('/teams/dawn/inbox?unread=1', gee);
      const ask = inbox.json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === lane.json.lane.id,
      );
      expect(ask).toBeDefined();

      const declined = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            v: 'musterd/0.3',
            id: 'declinenote0000000000000000',
            team: 'dawn',
            from: 'gee',
            to: { kind: 'member', name: 'ada' },
            act: 'decline',
            body: 'the error path is untested — please add the boundary case',
            meta: { in_reply_to: ask.id },
            ts: Date.now(),
          },
        },
        gee,
      );
      expect(declined.status).toBe(201);

      const rows = await auditRows(nickTok, 'lane.review_sent_back');
      expect(rows.at(-1)?.detail.note).toBe(
        'the error path is untested — please add the boundary case',
      );
    });

    it('a risk-tagged lane routes the PEER first; the human requirement is recorded gated (ADR 188)', async () => {
      const { nickTok, ada } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'prod deploy', risk: ['production'], claim: true },
        ada,
      );
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      expect(ready.json.review.reviewer).toBe('gee'); // stage one: the peer, not nick
      expect(ready.json.review.human_review_required).toBe(true);
      expect(ready.json.review.human_ask).toBe('gated');
      void nickTok;
    });

    it('a risky lane with no live human does NOT fall through to agent review (ADR 172)', async () => {
      // A live cross-family agent exists — gee attests gpt — and would have been picked before
      // ADR 172. Human review is a requirement class for risky work, not a preference: the agent is
      // not a substitute, so no ask is routed and the response says what a close will be recorded as.
      const team = await post('/teams', {
        slug: 'risky',
        creator: { name: 'boss', kind: 'human' },
      });
      const bossTok = team.json.human_credential as string;
      // Enroll agents without flipping the human present — every authed call touches presence, so
      // the member-adds ride x-musterd-no-touch (the notifier's opt-out, ADR 057).
      for (const name of ['ada', 'gee']) {
        await fetch(h.base + '/teams/risky/members', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bossTok}`,
            'x-musterd-no-touch': '1',
          },
          body: JSON.stringify({ name, kind: 'agent' }),
        });
      }
      const ada = (await resolveAuth('/teams/risky/inbox', {
        key: team.json.agent_key,
        seat: 'ada',
      }))!;
      const gee = (await resolveAuth('/teams/risky/inbox', {
        key: team.json.agent_key,
        seat: 'gee',
      }))!;
      await reattestAgentModel('risky', ada, 'claude-opus-5');
      await reattestAgentModel('risky', gee, 'gpt-5.2-codex');
      const mk = await fetch(h.base + '/teams/risky/lanes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ title: 'prod deploy', risk: ['production'], claim: true }),
      });
      const laneId = ((await mk.json()) as any).lane.id as string;
      const patch = async (body: unknown, auth: Auth) => {
        const r = await fetch(h.base + `/teams/risky/lanes/${laneId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders(auth) },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json()) as Record<string, any> };
      };

      const ready = await patch({ state: 'ready_for_review' }, ada);
      // ADR 188 two-stage: gee (agent, cross-family) IS picked — as the PEER, stage one. The human
      // requirement stands (recorded, still unmet with no human live) but no longer suppresses the
      // peer review that is possible right now.
      expect(ready.json.review.reviewer).toBe('gee');
      expect(ready.json.review.tier).toBe('standard'); // peer stage rides standard, not blocking
      expect(ready.json.review.human_review_required).toBe(true);
      expect(ready.json.review.human_ask).toBe('gated');

      // The close is still possible (never a wedge) — and the record says what was missed.
      const closed = await patch({ state: 'done' }, ada);
      expect(closed.status).toBe(200);
      const rows = await auditRowsFor(bossTok, 'risky', 'lane.closed');
      const row = rows.find((r: any) => r.detail.lane === laneId)!;
      // ADR 188: a peer WAS asked (gee), so the close is honestly about the wait — and the human miss
      // is carried by its own flag, not folded into the reason. ADR 217: the owner closed instantly,
      // so the wait was cut short rather than exhausted.
      expect(row.detail.reason).toBe('review_cut_short');
      expect(row.detail.human_review_missed).toBe(true);
      expect(row.detail.peer_review).toBe('none');
      expect(row.detail.verified).toBe(false);
    });

    it('a risky lane asks the PEER first; the human ask fires when the peer accepts (ADR 188)', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'drop the old table', risk: ['destructive'], claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      const ready = await patchLane(laneId, { state: 'ready_for_review' }, ada);
      // Stage one: the peer (gee, cross_family), standard tier — nick is NOT asked yet.
      expect(ready.json.review.reviewer).toBe('gee');
      expect(ready.json.review.tier).toBe('standard');
      expect(ready.json.review.human_ask).toBe('gated');
      const nickInboxBefore = await get('/teams/dawn/inbox?unread=1', nickTok);
      expect(
        nickInboxBefore.json.messages.filter((m: any) => m.act === 'ask' && m.meta?.lane_review),
      ).toHaveLength(0);

      // gee accepts the peer ask → the human ask fires at BLOCKING with gee's findings in the body.
      const geeInbox = await get('/teams/dawn/inbox?unread=1', gee);
      const peerAsk = geeInbox.json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review,
      );
      expect(peerAsk).toBeDefined();
      const peerSent = await post(
        '/teams/dawn/messages',
        {
          envelope: {
            v: 'musterd/0.3',
            id: 'peeraccept0000000000000000',
            team: 'dawn',
            from: 'gee',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'diff read end-to-end; boundary cases covered; ship it',
            meta: { in_reply_to: peerAsk.id },
            ts: Date.now(),
          },
        },
        gee,
      );
      // ADR 539: the peer learns on the ack that this was the peer stage and who holds the verdict.
      expect(peerSent.json.lane_verdict).toBeUndefined();
      expect(peerSent.json.lane_escalation).toEqual({ lane: laneId, human: 'nick' });

      const nickInbox = await get('/teams/dawn/inbox?unread=1', nickTok);
      const humanAsk = nickInbox.json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review,
      );
      expect(humanAsk).toBeDefined();
      expect(humanAsk.meta.tier).toBe('blocking');
      expect(humanAsk.body).toContain('ship it'); // the peer's findings ride along
      const confirmed = await auditRows(nickTok, 'lane.review_peer_confirmed');
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].detail).toMatchObject({
        lane: laneId,
        peer: 'gee',
        grade: 'cross_family',
        human_ask_fired: true,
        peer_accept: 'peeraccept0000000000000000',
      });
      // ADR 539: the receipt that the human stage was asked, first time (not a retry).
      const askedRows = await auditRows(nickTok, 'lane.review_human_asked');
      expect(askedRows).toHaveLength(1);
      expect(askedRows[0].detail).toMatchObject({
        lane: laneId,
        human: 'nick',
        peer: 'gee',
        ask: humanAsk.id,
        retried: false,
      });

      // nick confirms — the close records both reviews.
      const closed = await patchLane(laneId, { state: 'done' }, nickTok);
      expect(closed.status).toBe(200);
      const rows = await auditRows(nickTok, 'lane.closed');
      const row = rows.find((r: any) => r.detail.lane === laneId)!;
      expect(row.detail.verified).toBe(true);
      expect(row.detail.review_grade).toBe('human');
      expect(row.detail.peer_review).toBe('cross_family');
      expect(row.detail.human_review_missed).toBeUndefined();
    });

    it('a peer accept on an enrolled JOINER fires no human ask there; the hub fires it when the accept folds (lane 01M3ZBTJKD)', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'drop the old table', risk: ['destructive'], claim: true },
        ada,
      );
      await patchLane(lane.json.lane.id as string, { state: 'ready_for_review' }, ada);
      const peerAsk = (await get('/teams/dawn/inbox?unread=1', gee)).json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review,
      );
      const humanAsks = async () =>
        (await get('/teams/dawn/inbox?unread=0', nickTok)).json.messages.filter(
          (m: any) => m.act === 'ask' && m.meta?.lane_review,
        );

      const team = (await getTeamBySlug(h.server.store, 'dawn'))!;
      const { id: node_id } = await localNodeForTeam(h.server.store, team.id);
      const dir = mkdtempSync(join(tmpdir(), 'musterd-gated-joiner-'));
      const prior = process.env['MUSTERD_NODE_STATE'];
      process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
      const acceptId = ulid();
      try {
        saveNodeEnrollment({
          team: 'dawn',
          hub_url: 'http://127.0.0.1:9',
          credential: 'x',
          node_id,
          enrolled_at: 1,
        });
        const sent = await post(
          '/teams/dawn/messages',
          {
            envelope: {
              v: PROTOCOL_VERSION,
              id: acceptId,
              team: 'dawn',
              from: 'gee',
              to: { kind: 'member', name: 'ada' },
              act: 'accept',
              body: 'read it; ship it',
              meta: { in_reply_to: peerAsk.id },
              ts: Date.now(),
            },
          },
          gee,
        );
        expect(sent.status).toBe(201);
        // ADR 539: the joiner cannot ask, but it tells the peer what happened — escalated, human
        // unknown here — rather than answering with a bare message that looks like a verdict.
        expect(sent.json.lane_escalation).toEqual({ lane: lane.json.lane.id, human: null });
        expect(sent.json.lane_verdict).toBeUndefined();
        expect(await humanAsks()).toHaveLength(0);
        // …and the peer's accept is not a verdict here: the gate is still owed to a human.
        const state = await h.server.store.get<{ state: string }>(
          'SELECT state FROM lanes WHERE id = ?',
          [lane.json.lane.id],
        );
        expect(isAwaitingAcceptance(state!.state as never)).toBe(true);
      } finally {
        if (prior === undefined) delete process.env['MUSTERD_NODE_STATE'];
        else process.env['MUSTERD_NODE_STATE'] = prior;
        rmSync(dir, { recursive: true, force: true });
      }

      // The same accept, folded on the hub: stage two fires there.
      const ctx = { db: h.server.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
      await handleFoldedMessages(ctx, 'dawn', [acceptId]);
      const asks = await humanAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0].meta.tier).toBe('blocking');
      expect(asks[0].body).toContain('ship it');
    });

    it('ADR 539: a peer accept with NO live human leaves a visible pending state, and the first human to come live is asked', async () => {
      // The nameplates lane, 2026-10-06: ryder's accept was the peer stage, the hub found no live
      // human, `human_ask_fired: false` was the last word, and the lane sat awaiting_acceptance with
      // nobody owing it. Rebuilt here: a team whose only human never touched presence.
      const team = await post('/teams', {
        slug: 'quiet',
        creator: { name: 'boss', kind: 'human' },
      });
      const bossTok = team.json.human_credential as string;
      for (const name of ['ada', 'gee']) {
        await fetch(h.base + '/teams/quiet/members', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bossTok}`,
            'x-musterd-no-touch': '1',
          },
          body: JSON.stringify({ name, kind: 'agent' }),
        });
      }
      const ada = (await resolveAuth('/teams/quiet/inbox', {
        key: team.json.agent_key,
        seat: 'ada',
      }))!;
      const gee = (await resolveAuth('/teams/quiet/inbox', {
        key: team.json.agent_key,
        seat: 'gee',
      }))!;
      await reattestAgentModel('quiet', ada, 'claude-opus-5');
      await reattestAgentModel('quiet', gee, 'gpt-5.2-codex');
      // ADR 607: the stage-two ask now fires to an offline human too, so the pending state only
      // arises on a team with NO askable human seat. Rebuilt as that: boss is an observer until
      // the retry step below, which is the "a human seat appears later" case ADR 539 §5 keeps.
      await h.server.store.run(`UPDATE members SET observer = 1 WHERE name = 'boss'`);
      const lane = await post(
        '/teams/quiet/lanes',
        { title: 'nameplates stop jumping', risk: ['user-facing'], claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await fetch(h.base + `/teams/quiet/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      });
      const peerAsk = (await get('/teams/quiet/inbox?unread=1', gee)).json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review,
      );
      expect(peerAsk).toBeDefined();
      const acceptId = ulid();
      const sent = await post(
        '/teams/quiet/messages',
        {
          envelope: {
            v: PROTOCOL_VERSION,
            id: acceptId,
            team: 'quiet',
            from: 'gee',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'five rules present; 15/15 tests; feel not judged',
            meta: { in_reply_to: peerAsk.id },
            ts: Date.now(),
          },
        },
        gee,
      );
      // (1) The ack says what happened: peer stage, nobody live to ask.
      expect(sent.status).toBe(201);
      expect(sent.json.lane_verdict).toBeUndefined();
      expect(sent.json.lane_escalation).toEqual({ lane: laneId, human: null });
      const confirmed = await auditRowsFor(bossTok, 'quiet', 'lane.review_peer_confirmed');
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].detail).toMatchObject({
        lane: laneId,
        peer: 'gee',
        human_ask_fired: false,
        human_live: false,
        peer_accept: acceptId,
      });
      expect(await auditRowsFor(bossTok, 'quiet', 'lane.review_human_asked')).toHaveLength(0);
      // (2) The state is visible: the brief's review debt names it as peer-confirmed, pending a human.
      const briefBefore = await get('/teams/quiet/next', gee);
      const debtBefore = (briefBefore.json.review_debt as any[]).find((r) => r.id === laneId);
      expect(debtBefore).toMatchObject({ pending_human: true, peer_confirmed_by: 'gee' });
      // Nothing was asked of boss — the read above was as gee; boss has never touched presence.
      const bossAsks = async () =>
        (await get('/teams/quiet/inbox?unread=0', bossTok)).json.messages.filter(
          (m: any) => m.act === 'ask' && m.meta?.lane_review,
        );
      expect(await bossAsks()).toHaveLength(0);
      // boss becomes an askable human seat and touches the daemon — an observer's read leaves no
      // presence (ADR 063), so this read is the one that makes boss live.
      await h.server.store.run(`UPDATE members SET observer = 0 WHERE name = 'boss'`);
      await get('/teams/quiet/inbox?unread=0', bossTok);
      // (3) The retry asks the first human who comes live.
      const teamRow = (await getTeamBySlug(h.server.store, 'quiet'))!;
      const ctx = { db: h.server.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
      expect(await retryPendingHumanAsks(ctx, teamRow)).toEqual([{ lane: laneId, human: 'boss' }]);
      const asks = await bossAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0].meta.tier).toBe('blocking');
      expect(asks[0].meta.lane_review.peer_confirmed_by).toBe('gee');
      expect(asks[0].body).toContain('15/15 tests'); // the peer's findings, read back from the accept
      const askedRows = await auditRowsFor(bossTok, 'quiet', 'lane.review_human_asked');
      expect(askedRows).toHaveLength(1);
      expect(askedRows[0].detail).toMatchObject({
        lane: laneId,
        human: 'boss',
        peer: 'gee',
        ask: asks[0].id,
        retried: true,
        human_live: true,
      });
      // Asked once: a second tick asks nothing more, and the brief no longer says pending.
      expect(await retryPendingHumanAsks(ctx, teamRow)).toEqual([]);
      expect(await bossAsks()).toHaveLength(1);
      const briefAfter = await get('/teams/quiet/next', gee);
      const debtAfter = (briefAfter.json.review_debt as any[]).find((r) => r.id === laneId);
      expect(debtAfter?.pending_human ?? false).toBe(false);
      // boss's accept on the stage-two ask is the verdict that closes it.
      const closed = await post(
        '/teams/quiet/messages',
        {
          envelope: {
            v: PROTOCOL_VERSION,
            id: ulid(),
            team: 'quiet',
            from: 'boss',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'looks good to me',
            meta: { in_reply_to: asks[0].id },
            ts: Date.now(),
          },
        },
        bossTok,
      );
      expect(closed.json.lane_verdict).toEqual({ lane: laneId, state: 'done' });
    });

    it('ADR 603: the owner cannot close a risky lane past its pending human review inside the promised window; a human can, and the owner can once the window has run', async () => {
      // miley, 2026-10-15: two risky lanes peer-confirmed with no human live, both self-closed by
      // the owner inside the promised 20m window — the second 226 s before nick came live and the
      // ADR 539 retry would have asked him. The ledger said `review_cut_short` +
      // `human_review_missed`; nothing refused the close.
      const team = await post('/teams', {
        slug: 'early',
        creator: { name: 'boss', kind: 'human' },
      });
      const bossTok = team.json.human_credential as string;
      for (const name of ['ada', 'gee']) {
        await fetch(h.base + '/teams/early/members', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bossTok}`,
            'x-musterd-no-touch': '1',
          },
          body: JSON.stringify({ name, kind: 'agent' }),
        });
      }
      const ada = (await resolveAuth('/teams/early/inbox', {
        key: team.json.agent_key,
        seat: 'ada',
      }))!;
      const gee = (await resolveAuth('/teams/early/inbox', {
        key: team.json.agent_key,
        seat: 'gee',
      }))!;
      await reattestAgentModel('early', ada, 'claude-opus-5');
      await reattestAgentModel('early', gee, 'gpt-5.2-codex');
      const patch = async (laneId: string, body: unknown, auth: Auth | string) => {
        const r = await fetch(h.base + `/teams/early/lanes/${laneId}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            ...(typeof auth === 'string' ? { authorization: `Bearer ${auth}` } : authHeaders(auth)),
          },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json()) as Record<string, any> };
      };
      const peerConfirm = async (title: string) => {
        const lane = await post(
          '/teams/early/lanes',
          { title, risk: ['user-facing'], claim: true },
          ada,
        );
        const laneId = lane.json.lane.id as string;
        expect((await patch(laneId, { state: 'ready_for_review' }, ada)).status).toBe(200);
        const peerAsk = (await get('/teams/early/inbox?unread=1', gee)).json.messages.find(
          (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        );
        expect(peerAsk).toBeDefined();
        const sent = await post(
          '/teams/early/messages',
          {
            envelope: {
              v: PROTOCOL_VERSION,
              id: ulid(),
              team: 'early',
              from: 'gee',
              to: { kind: 'member', name: 'ada' },
              act: 'accept',
              body: 'peer: fine',
              meta: { in_reply_to: peerAsk.id },
              ts: Date.now(),
            },
          },
          gee,
        );
        // ADR 607: boss has never touched presence, and is asked anyway.
        expect(sent.json.lane_escalation).toEqual({ lane: laneId, human: 'boss' });
        return laneId;
      };

      // (1) Inside the window the owner's close is refused, and the reply says who confirmed,
      // that a human is owed, and that the retry will ask one.
      const a = await peerConfirm('hide the dead-end toggle');
      const refused = await patch(a, { state: 'done' }, ada);
      expect(refused.status).toBe(409);
      expect(refused.json.error.message).toMatch(/gee/);
      expect(refused.json.error.message).toMatch(/with boss/);
      expect(refused.json.error.message).toMatch(/ADR 603/);
      expect(
        (await get('/teams/early/lanes', ada)).json.lanes.find((l: any) => l.id === a).state,
      ).toBe('awaiting_acceptance');
      // Abandoning is not shipping past the review: still the owner's call.
      expect((await patch(a, { state: 'abandoned' }, ada)).status).toBe(200);

      // (2) Once the promised window has run, the owner's close is the ADR 235 self-close again,
      // recorded `review_unanswered` + `human_review_missed` exactly as before.
      const c = await peerConfirm('observer view after 580');
      expect((await patch(c, { state: 'done' }, ada)).status).toBe(409);
      await h.server.store.run('UPDATE lanes SET updated_at = ? WHERE id = ?', [
        Date.now() - 2 * 60 * 60 * 1000,
        c,
      ]);
      const late = await patch(c, { state: 'done' }, ada);
      expect(late.status).toBe(200);
      expect(late.json.closed).toMatchObject({ verified: false, reason: 'review_unanswered' });
      const closedRows = await auditRowsFor(bossTok, 'early', 'lane.closed');
      expect((closedRows as any[]).find((r) => r.target === c)?.detail).toMatchObject({
        reason: 'review_unanswered',
        human_review_missed: true,
      });

      // (3) A human's close from the board is the human stage — allowed inside the window.
      const b = await peerConfirm('watch-link a11y name');
      expect((await patch(b, { state: 'done' }, bossTok)).status).toBe(200);
    });

    it('ADR 607: a peer accept with no live human still fires the stage-two ask — to the offline admin — and that ask is what the rail shows and the human answers', async () => {
      // lane 01M50CD7SN, 2026-10-15: wanderer accepted at 18:49, nobody live, nothing on the rail
      // for six minutes until nick opened /live and the reaper asked him. Now the ask exists at 18:49.
      const team = await post('/teams', {
        slug: 'rail',
        creator: { name: 'boss', kind: 'human' },
      });
      const bossTok = team.json.human_credential as string;
      for (const name of ['ada', 'gee']) {
        await fetch(h.base + '/teams/rail/members', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bossTok}`,
            'x-musterd-no-touch': '1',
          },
          body: JSON.stringify({ name, kind: 'agent' }),
        });
      }
      const ada = (await resolveAuth('/teams/rail/inbox', {
        key: team.json.agent_key,
        seat: 'ada',
      }))!;
      const gee = (await resolveAuth('/teams/rail/inbox', {
        key: team.json.agent_key,
        seat: 'gee',
      }))!;
      await reattestAgentModel('rail', ada, 'claude-opus-5');
      await reattestAgentModel('rail', gee, 'gpt-5.2-codex');
      const lane = await post(
        '/teams/rail/lanes',
        { title: 'person glyph', risk: ['user-facing'], claim: true },
        ada,
      );
      const laneId = lane.json.lane.id as string;
      await fetch(h.base + `/teams/rail/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(ada) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      });
      const peerAsk = (await get('/teams/rail/inbox?unread=1', gee)).json.messages.find(
        (m: any) => m.act === 'ask' && m.meta?.lane_review,
      );
      const sent = await post(
        '/teams/rail/messages',
        {
          envelope: {
            v: PROTOCOL_VERSION,
            id: ulid(),
            team: 'rail',
            from: 'gee',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'glyph renders; 3/3 tests',
            meta: { in_reply_to: peerAsk.id },
            ts: Date.now(),
          },
        },
        gee,
      );
      // The ack names the human asked; the ledger says they were not live.
      expect(sent.json.lane_verdict).toBeUndefined();
      expect(sent.json.lane_escalation).toEqual({ lane: laneId, human: 'boss' });
      const confirmed = await auditRowsFor(bossTok, 'rail', 'lane.review_peer_confirmed');
      expect(confirmed[0].detail).toMatchObject({ human_ask_fired: true, human_live: false });
      const askedRows = await auditRowsFor(bossTok, 'rail', 'lane.review_human_asked');
      expect(askedRows[0].detail).toMatchObject({
        human: 'boss',
        retried: false,
        human_live: false,
      });
      // No pending state: the brief has nothing to retry, and the retry asks nothing more.
      const teamRow = (await getTeamBySlug(h.server.store, 'rail'))!;
      const ctx = { db: h.server.store, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
      expect(await retryPendingHumanAsks(ctx, teamRow)).toEqual([]);
      // The ask is in boss's inbox — the same blocking ask the rails render.
      const asks = (await get('/teams/rail/inbox?unread=0', bossTok)).json.messages.filter(
        (m: any) => m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
      );
      expect(asks).toHaveLength(1);
      expect(asks[0].meta.tier).toBe('blocking');
      expect(asks[0].meta.lane_review.peer_confirmed_by).toBe('gee');
      // boss's accept on it is the verdict.
      const closed = await post(
        '/teams/rail/messages',
        {
          envelope: {
            v: PROTOCOL_VERSION,
            id: ulid(),
            team: 'rail',
            from: 'boss',
            to: { kind: 'member', name: 'ada' },
            act: 'accept',
            body: 'ship it',
            meta: { in_reply_to: asks[0].id },
            ts: Date.now(),
          },
        },
        bossTok,
      );
      expect(closed.json.lane_verdict).toEqual({ lane: laneId, state: 'done' });
    });

    it('risky with NO peer candidate: the human ask fires immediately at blocking (ADR 188)', async () => {
      const { nickTok, ada } = await setup();
      // gee exists but we make the lane while only ada (worker) + nick (human) matter: use a lane
      // whose worker is gee-family… simpler: a fresh team with one agent + one live human.
      const t = await post('/teams', { slug: 'lone', creator: { name: 'n4', kind: 'human' } });
      const n4 = t.json.human_credential as string;
      await get('/teams/lone/inbox', n4); // n4 present
      await post('/teams/lone/members', { name: 'solo', kind: 'agent' }, n4);
      const solo: Auth = { key: t.json.agent_key as string, seat: 'solo' };
      await fetch(h.base + '/teams/lone/inbox', {
        headers: { ...authHeaders(solo), 'x-musterd-model': 'claude-opus-5' },
      });
      const lane = await post(
        '/teams/lone/lanes',
        { title: 'wipe cache', risk: ['destructive'], claim: true },
        solo,
      );
      const r = await fetch(h.base + `/teams/lone/lanes/${lane.json.lane.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(solo) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      }).then(async (x) => ({ status: x.status, json: (await x.json()) as Record<string, any> }));
      // No agent peer exists — the requirement is not gated behind a stage that cannot happen.
      expect(r.json.review.reviewer).toBe('n4');
      expect(r.json.review.tier).toBe('blocking');
      expect(r.json.review.human_ask).toBe('immediate');
      void nickTok;
      void ada;
    });

    it('an agent confirm on a risky lane is verified but flagged human_review_missed (ADR 172)', async () => {
      const { nickTok, ada, gee } = await setup();
      const lane = await post(
        '/teams/dawn/lanes',
        { title: 'prod config change', risk: ['production'], claim: true },
        ada,
      );
      await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      // gee (an agent) confirms. That is a real cross-seat review — verified — but the risk tag
      // demanded a HUMAN's judgment, and the record must not let the agent confirm satisfy it.
      const closed = await patchLane(lane.json.lane.id, { state: 'done' }, gee);
      expect(closed.status).toBe(200);
      const rows = await auditRows(nickTok, 'lane.closed');
      const row = rows.find((r: any) => r.detail.lane === lane.json.lane.id)!;
      expect(row.detail.verified).toBe(true);
      expect(row.detail.reason).toBe('counterpart_confirm');
      expect(row.detail.human_review_missed).toBe(true);
    });

    it('no eligible counterpart → no ask, self-close sanctioned (never a wedge)', async () => {
      // A team of exactly one: the worker is the only live seat.
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'solo', kind: 'human' } });
      const soloTok = team.json.human_credential as string;
      const lane = await post('/teams/dawn/lanes', { title: 'alone', claim: true }, soloTok);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, soloTok);
      expect(ready.json.review.self_close_sanctioned).toBe(true);
      // And the self-close still works.
      const closed = await patchLane(lane.json.lane.id, { state: 'done' }, soloTok);
      expect(closed.status).toBe(200);
    });

    it('ready_for_review keeps the surface contending (overlap still warns)', async () => {
      const { nickTok, ada } = await setup();
      const l1 = await post(
        '/teams/dawn/lanes',
        { title: 'store work', project: 'p', scope: ['packages/server/**'], claim: true },
        ada,
      );
      await patchLane(l1.json.lane.id, { state: 'ready_for_review' }, ada);
      const l2 = await post(
        '/teams/dawn/lanes',
        { title: 'also store', project: 'p', scope: ['packages/server/src/**'], claim: true },
        nickTok,
      );
      expect(l2.json.warnings.map((w: { kind: string }) => w.kind)).toContain('surface_overlap');
    });

    it('GET /lanes annotates done lanes with the derived close verdict (inc 4)', async () => {
      const { nickTok, ada } = await setup();
      // Lane A confirmed by nick; lane B self-closed by ada; lane C still live.
      const a = await post('/teams/dawn/lanes', { title: 'confirmed', claim: true }, ada);
      await patchLane(a.json.lane.id, { state: 'ready_for_review' }, ada);
      await patchLane(a.json.lane.id, { state: 'done' }, nickTok);
      const b = await post('/teams/dawn/lanes', { title: 'selfclosed', claim: true }, ada);
      await patchLane(b.json.lane.id, { state: 'done' }, ada);
      const c = await post('/teams/dawn/lanes', { title: 'live', claim: true }, ada);

      const board = await get('/teams/dawn/lanes', nickTok);
      const byId = Object.fromEntries(
        board.json.lanes.map((l: { id: string; verified?: boolean }) => [l.id, l.verified]),
      );
      expect(byId[a.json.lane.id]).toBe(true);
      expect(byId[b.json.lane.id]).toBe(false);
      expect(byId[c.json.lane.id]).toBeUndefined(); // live lane: no verdict to annotate
    });

    it('a seat with an unknown model family is never picked as the cross-family reviewer', async () => {
      const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
      const nickTok = team.json.human_credential as string;
      await post('/teams/dawn/members', { name: 'ada', kind: 'agent' }, nickTok);
      await post('/teams/dawn/members', { name: 'mist', kind: 'agent' }, nickTok);
      const ada: Auth = { key: team.json.agent_key, seat: 'ada' };
      const mist: Auth = { key: team.json.agent_key, seat: 'mist' };
      await fetch(h.base + '/teams/dawn/inbox', {
        headers: { ...authHeaders(ada), 'x-musterd-model': 'claude-opus-5' },
      });
      // mist is live but attests nothing → family unknown → ineligible.
      await fetch(h.base + '/teams/dawn/inbox', { headers: authHeaders(mist) });
      await get('/teams/dawn/inbox', nickTok); // nick present

      const lane = await post('/teams/dawn/lanes', { title: 'diverse it', claim: true }, ada);
      const ready = await patchLane(lane.json.lane.id, { state: 'ready_for_review' }, ada);
      // ADR 253: nick is live and mist is ungradeable — a human is not a fallback. Nobody is asked.
      expect(ready.json.review.reviewer).toBeUndefined();
      expect(ready.json.review.self_close_sanctioned).toBe(true);
    });

    it('a non-risky breaker trip does not ask a live human (ADR 253)', async () => {
      const t = await post('/teams', { slug: 'brk', creator: { name: 'n5', kind: 'human' } });
      const n5 = t.json.human_credential as string;
      await get('/teams/brk/inbox', n5); // human live
      await post('/teams/brk/members', { name: 'solo', kind: 'agent' }, n5);
      const solo: Auth = { key: t.json.agent_key as string, seat: 'solo' };
      await fetch(h.base + '/teams/brk/inbox', {
        headers: { ...authHeaders(solo), 'x-musterd-model': 'claude-opus-5' },
      });
      const lane = await post('/teams/brk/lanes', { title: 'bounced', claim: true }, solo);
      const laneId = lane.json.lane.id as string;
      const teamId = (await getTeamBySlug(h.server.store, 'brk'))!.id;
      for (let i = 0; i < REVIEW_LOOP_BREAKER_N; i++) {
        await appendAudit(h.server.store, teamId, {
          actor: 'solo',
          action: 'lane.ready_for_review',
          target: laneId,
          result: 'allow',
          detail: { lane: laneId },
        });
      }
      const ready = await fetch(h.base + `/teams/brk/lanes/${laneId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...authHeaders(solo) },
        body: JSON.stringify({ state: 'ready_for_review' }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
      expect(ready.status).toBe(200);
      expect(ready.json.review.reviewer).toBeUndefined();
      expect(ready.json.review.self_close_sanctioned).toBe(true);
      expect(ready.json.review.breaker_tripped).toBe(true);
      const inbox = await get('/teams/brk/inbox?unread=1', n5);
      expect(
        inbox.json.messages.some(
          (m: { act: string; meta?: { lane_review?: { lane?: string } } }) =>
            m.act === 'ask' && m.meta?.lane_review?.lane === laneId,
        ),
      ).toBe(false);
    });
  });
});
