import { makeEnvelope, WakeContextPacketSchema, type Act } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import type { PgliteDriver } from '../db/pgliteDriver.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAudit } from './audit.js';
import { openLane, updateLane } from './lanes.js';
import { addMember, getMemberByName } from './members.js';
import { saveMemory } from './memory.js';
import { countOpenLoops, insertMessage } from './messages.js';
import { attach } from './presence.js';
import {
  WAKE_DEFER_ACTUATOR_RESTART,
  WAKE_DEFER_SNOOZE_MS,
  WAKE_DEFER_SNOOZE_CAP_MS,
  WAKE_LEASE_TTL_MS,
  WAKE_POLICY_DEFAULTS,
  WORK_ORDER_CONTINUATION_SUCCESS_CAP,
  buildWakeContext,
  claimWakeLeases,
  effectiveWakePolicy,
  enrollResidency,
  expireWakeLeases,
  firstWakeLeaseTs,
  getResidency,
  hostAsleepMs,
  leaseCapturedSession,
  listWakeableMemberIds,
  parsePolicyOverride,
  recordSessionAttestation,
  revokeResidency,
  settleWakeLease,
  markWakeSpawned,
} from './residency.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam, getPolicy, setPolicy } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('residency', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  const WAKE_COOLDOWN_MS = WAKE_POLICY_DEFAULTS.cooldown_ms;
  const WAKE_HOURLY_CAP = WAKE_POLICY_DEFAULTS.hourly_cap;
  const WAKE_ATTEMPT_CAP = WAKE_POLICY_DEFAULTS.attempt_cap;

  const PRESENCE_TIMEOUT_MS = 45_000;
  const HOST = 'laptop.local';

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
    const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
    return { db, team, nick, ada, bob };
  }

  async function msg(
    db: Database,
    team: TeamRow,
    from: MemberRow,
    to: MemberRow | null,
    act: Act,
    id: string,
    ts: number,
    opts: { thread?: string; body?: string; meta?: Record<string, unknown> } = {},
  ) {
    await insertMessage(
      db,
      team.id,
      from.id,
      to?.id ?? null,
      makeEnvelope({
        id,
        team: team.slug,
        from: from.name,
        to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
        act,
        body: opts.body ?? 'x',
        thread: opts.thread ?? null,
        meta: opts.meta ?? null,
        ts,
      }),
    );
  }

  async function enroll(
    db: Database,
    team: TeamRow,
    member: MemberRow,
    host = HOST,
    policy?: Record<string, unknown>,
  ) {
    return await enrollResidency(db, team.id, {
      member_id: member.id,
      harness: 'claude-code',
      host,
      grant_id: 'g1',
      authorized_by: 'nick',
      ...(policy !== undefined ? { policy } : {}),
    });
  }

  /** Simulate a reported actuation outcome — the audit rows the rate policy derives from. */
  async function wakeOutcomeRow(
    db: Database,
    team: TeamRow,
    seat: string,
    actId: string,
    action: 'residency.woke' | 'residency.wake_failed',
    ts?: number,
  ) {
    await appendAudit(db, team.id, {
      actor: null,
      action,
      target: seat,
      result: action === 'residency.woke' ? 'allow' : 'deny',
      detail: { act: actId, lease_id: 'x' },
    });
    if (ts !== undefined) {
      // Backdate for cooldown/hourly-window tests (appendAudit stamps now). Keyed on rowid — the only
      // strictly monotonic column when several rows land in the same millisecond.
      await db.run(
        'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
        [ts],
      );
    }
  }

  describe('residency enrollment (ADR 131)', async () => {
    it('enrolls, upserts on re-enroll (last-enrolled-wins), and revokes', async () => {
      const { db, team, ada } = await seed();
      const first = await enroll(db, team, ada, 'host-a');
      expect(first.previous).toBeNull();
      expect(first.row.host).toBe('host-a');
      expect((await listWakeableMemberIds(db, team.id)).has(ada.id)).toBe(true);

      // Re-enrolling moves the seat to the new host and reports the superseded enrollment.
      const second = await enrollResidency(db, team.id, {
        member_id: ada.id,
        harness: 'claude-code',
        host: 'host-b',
        grant_id: 'g2',
        authorized_by: 'nick',
      });
      expect(second.previous?.host).toBe('host-a');
      expect(second.previous?.grant_id).toBe('g1');
      expect(second.row.id).toBe(first.row.id);
      expect((await getResidency(db, team.id, ada.id))?.host).toBe('host-b');

      const removed = await revokeResidency(db, team.id, ada.id);
      expect(removed?.grant_id).toBe('g2');
      expect(await getResidency(db, team.id, ada.id)).toBeNull();
      expect((await listWakeableMemberIds(db, team.id)).has(ada.id)).toBe(false);
      expect(await revokeResidency(db, team.id, ada.id)).toBeNull();
    });
  });

  describe('buildWakeContext (ADR 209)', async () => {
    it('derives a body-free reply packet only for the directed recipient', async () => {
      const { db, team, nick, ada, bob } = await seed();
      await msg(db, team, nick, ada, 'message', 'm1', 1_000, { thread: 't1' });

      expect(await buildWakeContext(db, team, ada, { act_id: 'm1' })).toMatchObject({
        wake: { kind: 'reply', act_id: 'm1' },
        objective: { action: 'reply' },
        fetch: [],
        delivery: { requirement: 'portable', intended: 'fresh' },
      });
      await expect(buildWakeContext(db, team, bob, { act_id: 'm1' })).rejects.toThrow(/forbidden/i);
    });

    /**
     * A huddle open naming 2–4 seats is team-addressed with an eligible set (ADR 254), and that set is
     * exactly what convenes them (ADR 386) — so the wake lease points every named seat at an act the
     * recipient-only rule refused. Rehearsal 2026-10-01 (huddle 01M3W9RMA5): all three named seats
     * woke to "forbidden wake context target", and two replied outside the room.
     */
    it('serves an eligible-set act to every seat it names, and still refuses an unnamed reader', async () => {
      const { db, team, nick, ada, bob } = await seed();
      const carol = (await addMember(db, team, { name: 'carol', kind: 'agent' })).row;
      await msg(db, team, nick, null, 'message', 'hud1', 1_000, {
        meta: { eligible: ['Ada', 'bob'] },
      });
      await msg(db, team, nick, null, 'message', 'all1', 1_001);

      expect(await buildWakeContext(db, team, ada, { act_id: 'hud1' })).toMatchObject({
        wake: { act_id: 'hud1' },
      });
      expect(await buildWakeContext(db, team, bob, { act_id: 'hud1' })).toMatchObject({
        wake: { act_id: 'hud1' },
      });
      await expect(buildWakeContext(db, team, carol, { act_id: 'hud1' })).rejects.toThrow(
        /forbidden/i,
      );
      // A plain @team act names nobody: the packet carries the whole thread, so it stays refused.
      await expect(buildWakeContext(db, team, ada, { act_id: 'all1' })).rejects.toThrow(
        /forbidden/i,
      );
    });

    it('v2: carries the waking thread, the open ledger and the memory body; fetch names only what did not fit (ADR 430)', async () => {
      const { db, team, nick, ada } = await seed();
      await saveMemory(db, ada.id, { headline: 'h', body: 'carrying lane X' });
      await msg(db, team, nick, ada, 'message', 'v1', 1_000, { body: 'first' });
      await msg(db, team, nick, ada, 'steer', 'v2', 1_001, { thread: 'v1', body: 'do the thing' });
      const packet = await buildWakeContext(db, team, ada, { act_id: 'v2' });
      expect(packet.version).toBe(2);
      expect(packet.context?.thread?.acts.map((a) => [a.from, a.body])).toEqual([
        ['nick', 'first'],
        ['nick', 'do the thing'],
      ]);
      expect(packet.context?.memory).toEqual({ body: 'carrying lane X', truncated: false });
      expect(packet.budget?.used_bytes).toBeGreaterThan(0);
      expect(packet.fetch).toEqual([]); // everything fit
      expect(WakeContextPacketSchema.parse(packet)).toEqual(packet);
    });

    it('v2: a lane wake carries the lane block and still points at the git artifact', async () => {
      const { db, team, ada } = await seed();
      const lane = await openLane(db, team.id, team.slug, ada.name, {
        title: 'L',
        detail: 'D',
        branch: 'feat/x',
        claim: true,
      });
      const packet = await buildWakeContext(db, team, ada, { lane_id: lane.id });
      expect(packet.context?.lane).toMatchObject({ detail: 'D', truncated: false });
      expect(packet.fetch).toEqual(['git_artifact']);
      expect(WakeContextPacketSchema.parse(packet)).toEqual(packet);
    });

    it('derives handoff, review, and owned work-order packets without stored bodies', async () => {
      const { db, team, nick, ada } = await seed();
      const lane = await openLane(db, team.id, team.slug, ada.name, {
        title: 'Portable context',
        branch: 'feat/context',
        claim: true,
      });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id } },
      });
      await msg(db, team, nick, ada, 'ask', 'r1', 1_001, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });

      expect(await buildWakeContext(db, team, ada, { act_id: 'h1' })).toMatchObject({
        wake: { kind: 'handoff' },
        objective: { action: 'continue_lane' },
        state: { lane: { id: lane.id, branch: 'feat/context' } },
        fetch: ['git_artifact'],
      });
      expect(await buildWakeContext(db, team, ada, { act_id: 'r1' })).toMatchObject({
        wake: { kind: 'review' },
        objective: { action: 'review' },
      });
      expect(await buildWakeContext(db, team, ada, { lane_id: lane.id })).toMatchObject({
        wake: { kind: 'work_order', lane_id: lane.id },
        objective: { action: 'begin_lane' },
      });
    });

    /**
     * The case the suite above never had: a reviewer is NOT the lane's owner. Every existing
     * `buildWakeContext` lane assertion used one seat as both owner and recipient, so the owner-only
     * rule on the lane path read as satisfied and the reviewer's actual experience went untested.
     *
     * Measured 2026-09-04: 83 of 87 `residency.context_read` denials were a seat asking about a lane
     * it did not own, and 38 of 47 review-edge wakes carried one within ±5 minutes of the wake.
     */
    it('a REVIEWER is refused the lane path and served by the act path — which is why the wake line names the act', async () => {
      const { db, team, nick, ada, bob } = await seed();
      const lane = await openLane(db, team.id, team.slug, ada.name, {
        title: 'Owned by ada, reviewed by bob',
        branch: 'feat/reviewed',
        claim: true,
      });
      // The routed acceptance ask (ADR 225): directed at bob, carrying the daemon-set lane_review.
      await msg(db, team, nick, bob, 'ask', 'rev1', 1_000, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });

      // The lane path authorizes by OWNERSHIP, so it must refuse bob — this is correct, not the bug.
      await expect(buildWakeContext(db, team, bob, { lane_id: lane.id })).rejects.toThrow(
        /forbidden/i,
      );

      // The act path authorizes by RECIPIENCY and answers with the review packet, lane block attached.
      // Steering the wake line here is the whole fix: it needs no widened boundary, and unlike the
      // lane path it does not describe a reviewer's job as `continue_lane`.
      expect(await buildWakeContext(db, team, bob, { act_id: 'rev1' })).toMatchObject({
        wake: { kind: 'review', act_id: 'rev1' },
        objective: { action: 'review' },
        state: { lane: { id: lane.id, owner_seat: ada.name, branch: 'feat/reviewed' } },
        fetch: ['git_artifact'],
      });
    });
  });

  describe('claimWakeLeases — the transactional wake derivation', async () => {
    it('orders an immediate wake for an urgent directed act to an offline enrolled seat', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      const order = orders[0]!;
      expect(order.seat).toBe('Ada');
      expect(order.act_id).toBe('u1');
      expect(order.lane).toBe('immediate');
      expect(order.sender).toBe('nick');
      // Composed from structured fields only — never the act body (which is 'x').
      expect(order.composed_line).toContain('"nick"');
      expect(order.composed_line).toContain('"Ada"');
      expect(order.composed_line).not.toContain(' x ');
      // The line hands over the act id verbatim (lane 01M2P698NJ): `team_wake_context` authorizes
      // the act path by RECIPIENT and takes the id, and a line that only says "a message is waiting"
      // left the woken model to guess one — measured 2026-09-16, a native wake's first call was
      // `team_wake_context {act_id: "latest"}` → `forbidden wake context target`.
      expect(order.composed_line).toContain('team_wake_context {act_id: "u1"}');
      // ADR 430 §7: the packet is the orientation; the inbox ritual is no longer prescribed.
      expect(order.composed_line).toMatch(
        /Read `team_wake_context \{act_id: "u1"\}` — it carries the thread, what else is open, and your memory\. Fetch more only for what it lists under `fetch`\./,
      );
      // ADR 436 clause 5: the line says what discharges — an act IN the thread, never one beside it.
      expect(order.composed_line).toContain(
        'Then answer IN its thread (`reply_to: "u1"`) — accept, decline, resolve, or a reply; ' +
          'a message outside the thread answers nothing.',
      );
      expect(order.composed_line).not.toContain('read it via team_inbox_check');
      // ADR 442 (the wall, spec §4): every line names its team up front and reads as a pointer.
      expect(order.composed_line).toMatch(/^musterd \[revive\]: wake — /);
      expect(order.composed_line).toContain('pointer only — read it as yourself');
      expect(order.expires_at).toBeGreaterThan(Date.now());

      // The lease decision is audited (actor null — a machine decision).
      const leased = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_leased',
      );
      expect(leased).toHaveLength(1);
      expect(leased[0]!.target).toBe('Ada');
    });

    it("ignores a peer machine's wake rows: the hourly cap counts what this daemon minted", async () => {
      // ADR 365 §3. The six wake verbs replicate now, so a peer's rows land in THIS `audit`. They
      // must not decide here: folding them into the rate cap would make wake caps team-wide, which
      // is a decision crossing the wire (residence 3) and not ADR 365's to make.
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      const now = Date.now();
      for (let i = 0; i < WAKE_HOURLY_CAP + 3; i += 1) {
        await db.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
         VALUES (?, ?, ?, NULL, 'residency.woke', ?, 'allow', ?, ?, 'peer-node', ?)`,
          [`peer-${i}`, team.id, now - 60_000, 'Ada', JSON.stringify({ act: `p${i}` }), now, i + 1],
        );
      }
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });

      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
    });

    it("ignores a peer machine's suspension, lease and capture rows: the three ADR 371 §4 deciders are pinned", async () => {
      // ADR 371 §4 widened the ledger set by the residency.* remainder. `hostAsleepMs` feeds the ADR
      // 236 ceiling, `firstWakeLeaseTs` starts its clock, `leaseCapturedSession` is the ADR 252
      // join — all three were unpinned deciders. A folded row from a peer must not move any of them.
      const { db, team } = await seed();
      const now = Date.now();
      const peer = async (
        id: string,
        seq: number,
        action: string,
        detail: Record<string, unknown>,
      ) =>
        await db.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
           VALUES (?, ?, ?, NULL, ?, 'Ada', 'allow', ?, ?, 'peer-node', ?)`,
          [id, team.id, now - 30_000, action, JSON.stringify(detail), now, seq],
        );
      await peer('p-1', 1, 'residency.host_suspended', { from: now - 60_000, to: now - 10_000 });
      await peer('p-2', 2, 'residency.wake_leased', { act: 'a1', lease_id: 'L-peer' });
      await peer('p-3', 3, 'residency.session_captured', { wake_lease: 'L-peer' });

      expect(await hostAsleepMs(db, team.id, now - 120_000, now)).toBe(0);
      expect(await firstWakeLeaseTs(db, team.id, 'a1')).toBeNull();
      expect(await leaseCapturedSession(db, team.id, 'L-peer')).toBe(false);

      // The same three rows minted HERE (unstamped — the `''` arm) decide as they always did.
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.host_suspended',
        target: null,
        result: 'allow',
        detail: { from: now - 60_000, to: now - 10_000 },
      });
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_leased',
        target: 'Ada',
        result: 'allow',
        detail: { act: 'a1', lease_id: 'L-here' },
      });
      await appendAudit(db, team.id, {
        actor: 'Ada',
        action: 'residency.session_captured',
        target: 'Ada',
        result: 'allow',
        detail: { wake_lease: 'L-here' },
      });
      expect(await hostAsleepMs(db, team.id, now - 120_000, now)).toBe(50_000);
      expect(await firstWakeLeaseTs(db, team.id, 'a1')).not.toBeNull();
      expect(await leaseCapturedSession(db, team.id, 'L-here')).toBe(true);
    });

    it('holds mutual exclusion: a live lease blocks a second order for the same seat', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });

      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
      // Re-poll (same host or another poll loop): the live lease means no new order.
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('derives nothing for a host the seat is not enrolled to (last-enrolled-wins)', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, 'host-a');
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      expect(
        await claimWakeLeases(db, team.id, team.slug, 'host-b', PRESENCE_TIMEOUT_MS),
      ).toHaveLength(0);
      expect(
        await claimWakeLeases(db, team.id, team.slug, 'host-a', PRESENCE_TIMEOUT_MS),
      ).toHaveLength(1);
    });

    it('never wakes a seat with live presence', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await attach(db, ada.id, 'claude-code', 'conn1');
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('wakes on the batched lane for an ordinary unanswered handoff, immediate lane first', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.lane).toBe('batched');
      expect(orders[0]!.act).toBe('handoff');

      // An urgent act outranks the batched ledger: immediate lane wins the single per-poll lease.
      const { db: db2, team: team2, nick: nick2, ada: ada2 } = await seed();
      await enroll(db2, team2, ada2);
      await msg(db2, team2, nick2, ada2, 'handoff', 'h1', 1_000);
      await msg(db2, team2, nick2, ada2, 'steer', 's1', 2_000);
      const orders2 = await claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders2).toHaveLength(1);
      expect(orders2[0]!.lane).toBe('immediate');
      expect(orders2[0]!.act_id).toBe('s1');
    });

    it('skips an answered act: an accept naming it closes the loop', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    // ADR 090's `answered` predicate is an accept/decline naming the act, or a resolve on its thread.
    // A HANDOFF is not discharged that way in practice — it is discharged by DOING THE WORK. Measured
    // on the live ledger 2026-08-06: miley handed ryder lane 01KZ9W0R29, he shipped it (ADR 246,
    // #716/#722, lane submitted 18:19:57), and no accept ever named the handoff and no resolve ever
    // landed on its thread. So the candidate query never learned it was done and kept spawning
    // sessions three hours later — three per envelope, and her one handoff was TWO envelopes, so six
    // paid wakes for work already merged.
    // A fresh db per assertion, deliberately: `claimWakeLeases` CLAIMS a lease, so a second call on
    // the same db is suppressed by the live lease and by the cooldown — which made the first draft of
    // this test pass before the fix existed, for entirely the wrong reason. (The file's db2/db3 idiom
    // is here for the same hazard.)
    const handoffOfLane = async (
      laneState?: 'awaiting_acceptance' | 'done' | 'abandoned' | 'active',
    ) => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      const lane = await openLane(db, team.id, team.slug, 'nick', {
        title: 'the handed work',
        claim: false,
      });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id, branch: null } },
      });
      if (laneState) {
        await updateLane(db, team.id, lane.id, team.slug, { state: laneState, owner_seat: 'Ada' });
      }
      return await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
    };

    it('skips a lane handoff whose lane the recipient already discharged', async () => {
      // Still owed while the lane is live work — the control.
      expect(await handoffOfLane()).toHaveLength(1);
      // Submitted for acceptance: shipped and merged. Waking to redo it is the defect.
      expect(await handoffOfLane('awaiting_acceptance')).toHaveLength(0);
      expect(await handoffOfLane('done')).toHaveLength(0);
      expect(await handoffOfLane('abandoned')).toHaveLength(0);
    });

    // The property that makes DERIVING this (rather than storing a flag) the right shape: a rejected
    // acceptance sends the lane back to active and the handoff becomes owed again by itself.
    it('re-owes the handoff when acceptance sends the lane back to active', async () => {
      expect(await handoffOfLane('active')).toHaveLength(1);
    });

    // Narrow on purpose: only a handoff that NAMES a live lane is discharged this way. A bare handoff,
    // or one naming a lane that no longer exists, keeps the old behaviour rather than going quiet.
    it('leaves a handoff that names no lane exactly as it was', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );

      const { db: db2, team: team2, nick: nick2, ada: ada2 } = await seed();
      await enroll(db2, team2, ada2);
      await msg(db2, team2, nick2, ada2, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: '01NOSUCHLANE0000000000000', branch: null } },
      });
      expect(
        await claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS),
      ).toHaveLength(1);
    });

    it('applies the batched-lane cooldown but lets the immediate lane through', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      const now = Date.now();
      // A wake completed 5 minutes ago — inside the 30-minute batched cooldown.
      await wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', now - 5 * 60_000);

      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );

      // An interrupt-class act ignores the cooldown (same scarcity as the live interrupt line).
      await msg(db, team, nick, ada, 'steer', 's1', 2_000);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.lane).toBe('immediate');

      // Past the cooldown window the batched lane is due again.
      const { db: db3, team: team3, nick: nick3, ada: ada3 } = await seed();
      await enroll(db3, team3, ada3);
      await wakeOutcomeRow(
        db3,
        team3,
        'Ada',
        'old-act',
        'residency.woke',
        now - WAKE_COOLDOWN_MS - 1_000,
      );
      await msg(db3, team3, nick3, ada3, 'handoff', 'h1', 1_000);
      expect(
        await claimWakeLeases(db3, team3.id, team3.slug, HOST, PRESENCE_TIMEOUT_MS),
      ).toHaveLength(1);
    });

    it('enforces the hourly cap across both lanes', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      const now = Date.now();
      for (let i = 0; i < WAKE_HOURLY_CAP; i++) {
        await wakeOutcomeRow(db, team, 'Ada', `past-${i}`, 'residency.woke', now - 10 * 60_000);
      }
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('writes a terminal wake_exhausted (once) at the per-act attempt cap and stops waking that act', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      // The act already burned its attempts — backdated outside cooldown/hourly windows so only the
      // per-act cap is in play.
      const old = Date.now() - 2 * 3_600_000;
      for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) {
        await wakeOutcomeRow(db, team, 'Ada', 's1', 'residency.wake_failed', old);
      }
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      let exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(exhausted).toHaveLength(1);
      expect(JSON.parse(exhausted[0]!.detail!)['act']).toBe('s1');
      // A second poll never duplicates the terminal row.
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(exhausted).toHaveLength(1);
    });
  });

  describe('ADR 434: a discharged act never re-wakes its seat', async () => {
    it("(a) a steer the seat answered in-thread by a plain message is not leased — ryder's shape", async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, null, 'message', 'root', 1_000);
      await msg(db, team, nick, ada, 'steer', 's1', 1_001, { thread: 'root' });
      await msg(db, team, ada, null, 'message', 'her-reply', 1_002, { thread: 'root' });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it("(a) an urgent act the seat answered by `message` in_reply_to is not leased — gptbot's shape", async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'steer', 's1', 1_000, {
        meta: { urgent: true, urgent_reason: 'r' },
      });
      await msg(db, team, ada, nick, 'message', 'standing-down', 1_001, {
        meta: { in_reply_to: 's1' },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('(b) an act that already WOKE the seat is never leased again for the same act', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      // The session ran (a `woke` row), replied nothing the predicate can see, and the window reopened.
      await wakeOutcomeRow(db, team, 'Ada', 'h1', 'residency.woke', Date.now() - 2 * 3_600_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      // No terminal row either: this is a spent act, not an exhausted one.
      expect(
        (await listAudit(db, team.id)).filter((r) => r.action === 'residency.wake_exhausted'),
      ).toHaveLength(0);
    });

    it('(b) …unless a NEWER act from someone else reopened its thread', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      const woke = Date.now() - 2 * 3_600_000;
      await wakeOutcomeRow(db, team, 'Ada', 'h1', 'residency.woke', woke);
      // nick nudges in the handoff's thread after the wake — the act is live again.
      await msg(db, team, nick, ada, 'message', 'nudge', woke + 1, { thread: 'h1' });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.map((o) => o.act_id)).toEqual(['h1']);
    });

    it("ADR 436 clause 5: an answer sent OUTSIDE the thread is not re-leased, and discharges nothing — ghost's arm-E shape", async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      const woke = Date.now() - 2 * 3_600_000;
      await wakeOutcomeRow(db, team, 'Ada', 'h1', 'residency.woke', woke);
      // The woken seat answers with a directed message beside the act: no thread, no in_reply_to.
      await msg(db, team, ada, nick, 'message', 'beside', woke + 1);
      // The wake edge holds (ADR 434 §2: the completed wake spent the act)…
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      // …but the sender is still owed an answer — which is why the wake line now says, in words, that
      // only an act IN the thread answers.
      expect(await countOpenLoops(db)).toBe(1);
    });

    it("(b) the seat's OWN later turn in the thread does not reopen it", async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      const woke = Date.now() - 2 * 3_600_000;
      await wakeOutcomeRow(db, team, 'Ada', 'h1', 'residency.woke', woke);
      await msg(db, team, ada, null, 'status_update', 'mine', woke + 1, { thread: 'h1' });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('(b) a wake that FAILED is still retried up to the attempt cap — only a completed wake spends the act', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await wakeOutcomeRow(
        db,
        team,
        'Ada',
        'h1',
        'residency.wake_failed',
        Date.now() - 2 * 3_600_000,
      );
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
    });

    it("(c) a fresh enrollment stamps a wake horizon: acts that predate it do not wake the seat — gptbot's July backlog", async () => {
      const { db, team, nick, ada } = await seed();
      await msg(db, team, nick, ada, 'handoff', 'old', 1_000);
      // `msg` stamps receipt with the wall clock; the backlog was RECEIVED before the enrollment.
      await db.run("UPDATE messages SET created_at = 1000 WHERE id = 'old'");
      await enroll(db, team, ada);
      await appendAudit(db, team.id, {
        actor: 'nick',
        action: 'residency.enrolled',
        target: 'Ada',
        result: 'allow',
        detail: { harness: 'claude-code', host: HOST, authorized_by: 'nick' },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      // An act after the horizon wakes as ever.
      await msg(db, team, nick, ada, 'handoff', 'new', Date.now() + 1);
      expect(
        (await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).map(
          (o) => o.act_id,
        ),
      ).toEqual(['new']);
    });

    it('(c) a RE-enrollment (policy tweak, host swap) does not move the horizon', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await appendAudit(db, team.id, {
        actor: 'nick',
        action: 'residency.enrolled',
        target: 'Ada',
        result: 'allow',
        detail: { harness: 'claude-code', host: HOST, authorized_by: 'nick' },
      });
      await db.run("UPDATE audit SET ts = ? WHERE action = 'residency.enrolled'", [500]);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      await appendAudit(db, team.id, {
        actor: 'nick',
        action: 'residency.enrolled',
        target: 'Ada',
        result: 'allow',
        detail: { harness: 'claude-code', host: HOST, authorized_by: 'nick', previous_host: HOST },
      });
      expect(
        (await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).map(
          (o) => o.act_id,
        ),
      ).toEqual(['h1']);
    });
  });

  describe('claimWakeLeases — a deferred act is not a wake reason (ADR 211 §4)', async () => {
    it('does not wake a seat for an act it deferred', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      // Ada says "not now" — the act stays durably unread, but it stops being a reason to spawn her.
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });

      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('does not wake for a RAISED deferral either — increment 2 turns that on deliberately', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });
      // The condition fires: the act is pending again in the inbox, but wake eligibility for raised
      // deferrals is withheld until its own increment, so nothing is leased here.
      await msg(db, team, nick, null, 'message', 'l1', 3_000, {
        meta: { lane_state: { lane: 'L1', state: 'done' } },
      });

      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('still wakes for a NON-deferred act alongside a deferred one', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'deferred one' },
      });
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });
      await msg(db, team, nick, ada, 'message', 'u2', 3_000, {
        meta: { urgent: true, urgent_reason: 'this one still counts' },
      });

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.act_id).toBe('u2');
    });

    it('wakes again once the deferral is withdrawn by a newer wait naming a fired condition', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );

      // A deferral by a seat OTHER than the recipient must not suppress anything.
      await msg(db, team, nick, null, 'wait', 'w2', 2_500, {
        meta: { defer_ref: 'u1', until: { reply: true } },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });
  });

  describe('claimWakeLeases — the poll costs what is due, not seats x window (big-body 2026-09-04)', async () => {
    /**
     * The daemon wedged ALIVE: the process was up, `/health` timed out, and a 3-second stack sample
     * spent 2,406 of 2,407 samples inside synchronous `sqlite3_step` (big-body, 2026-09-04). Two
     * shapes in this poll made cost scale with (enrolled seats x the whole log) instead of with what
     * was actually due.
     *
     * Counted as STATEMENTS, never as wall time: a timing assertion on a shared laptop is a flake
     * generator, and the defect is a count — the same team-scoped query issued once per seat, and a
     * 2,000-row read issued for a seat with nothing to filter.
     */
    function countingDb(db: Driver) {
      const seen: string[] = [];
      (db as SqliteDriver | PgliteDriver).onStatement((sql) => {
        seen.push(sql.replace(/\s+/g, ' ').trim());
      });
      return seen;
    }
    const ledgerReads = (sql: string[]) =>
      sql.filter((q) => q.includes("m.act IN ('request_help','handoff')")).length;
    const windowReads = (sql: string[]) =>
      sql.filter((q) => q.includes('FROM messages') && q.includes('LIMIT')).length;

    /** Three enrolled seats on one host, all reaching the batched lane, with one open directed act. */
    async function threeSeats() {
      const s = await seed();
      const cid = (await addMember(s.db, s.team, { name: 'cid', kind: 'agent' })).row;
      await enroll(s.db, s.team, s.ada);
      await enroll(s.db, s.team, s.bob);
      await enroll(s.db, s.team, cid);
      await msg(s.db, s.team, s.nick, s.ada, 'request_help', 'rh1', 1_000);
      return s;
    }

    it('reads the open directed ledger ONCE for the whole poll, not once per enrolled seat', async () => {
      const { db, team } = await threeSeats();
      const sql = countingDb(db);
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(ledgerReads(sql)).toBe(1);
    });

    // The ledger is unbounded and correlated; a team where nobody reaches the batched lane should not
    // pay for it at all. Lazy, not merely hoisted — an eagerly-evaluated argument read it anyway, and
    // this case is what caught that.
    it('does not read the ledger when no seat reaches the batched lane', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { lane: 'interrupt' });
      await msg(db, team, nick, ada, 'request_help', 'rh1', 1_000);
      const sql = countingDb(db);
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(ledgerReads(sql)).toBe(0);
    });

    // The idle case, which is most of the time: nothing is due, so the deferral window filters an
    // already-empty list. It was marshalling 2,000 rows per seat per poll to do it.
    it('does not scan the deferral window for a seat with nothing due', async () => {
      const { db, team, ada } = await seed();
      await enroll(db, team, ada);
      const sql = countingDb(db);
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(windowReads(sql)).toBe(0);
    });

    // The control: when something IS due the scan must still happen, or the deferral suppression it
    // exists for (ADR 211 §4) silently stops working.
    it('still scans the window when something is due, so deferral suppression survives', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      const sql = countingDb(db);
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(windowReads(sql)).toBeGreaterThan(0);
    });

    // Behaviour must be identical either way — this is a cost fix, not a semantics change.
    it('derives the same wakes it always did', async () => {
      const { db, team } = await threeSeats();
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.map((o) => o.seat)).toEqual(['Ada']);
      expect(orders[0]!.act_id).toBe('rh1');
    });
  });

  describe('claimWakeLeases — a huddle OPEN convenes the seats it names (ADR 378 inc 4)', async () => {
    const HUDDLE = {
      huddle: {
        topic: { kind: 'design', id: 'doorbells' },
        room: 'http://127.0.0.1:4851/b/huddle-h1',
        anchor: 'docs/wiki/huddles.md',
      },
    };

    /**
     * nick opens a huddle naming Ada (offline, enrolled) and bob — the case the lane was opened for.
     * Two names because `meta.eligible` refuses a set of one: to reach a single seat you address it.
     *
     * `convene_huddles` is set explicitly because it ships OFF (ADR 386 — the cross-machine run has
     * not reported). These tests are about what the rail does WHEN CONVENING IS ON; the default
     * itself is pinned in `protocol/residency.test.ts` and by the two off-cases below.
     */
    async function openHuddleNaming(seat: string) {
      const s = await seed();
      await enroll(s.db, s.team, s.ada, HOST, { convene_huddles: true });
      await msg(s.db, s.team, s.nick, null, 'message', 'h1', 1_000, {
        meta: { ...HUDDLE, eligible: [seat, 'bob'] },
      });
      return s;
    }

    it('orders ONE immediate wake for a named offline seat', async () => {
      const { db, team } = await openHuddleNaming('Ada');
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.seat).toBe('Ada');
      expect(orders[0]!.act_id).toBe('h1');
      expect(orders[0]!.lane).toBe('immediate');
    });

    // The shipped default, exercised on the rail rather than only in the schema: an enrolled seat
    // with no policy of its own is NOT convened. This is the case a two-machine team gets today.
    it('orders nothing by default — convening ships dark until the cross-machine run reports', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, null, 'message', 'h1', 1_000, {
        meta: { ...HUDDLE, eligible: ['Ada', 'bob'] },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    // The knob nick asked for, exercised where it actually gates rather than where it is declared.
    it('orders nothing when the seat has convene_huddles off', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { convene_huddles: false });
      await msg(db, team, nick, null, 'message', 'h1', 1_000, {
        meta: { ...HUDDLE, eligible: ['Ada', 'bob'] },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('honours the same switch set as a TEAM default', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await setPolicy(db, team.id, { residency: { convene_huddles: false } });
      await msg(db, team, nick, null, 'message', 'h1', 1_000, {
        meta: { ...HUDDLE, eligible: ['Ada', 'bob'] },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    // The cost property, on the real rail: turns are free. Without this the feature is a per-turn
    // wake storm wearing an open's clothes.
    it('does not pay a second wake for the turns that follow', async () => {
      const { db, team, nick, bob } = await openHuddleNaming('Ada');
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
      await settleWakeLease(db, team.id, 'Ada', { result: 'woke' });
      await msg(db, team, bob, null, 'message', 't1', 2_000, { thread: 'h1' });
      await msg(db, team, nick, null, 'message', 't2', 3_000, { thread: 'h1' });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    // The blast-radius control. A @team huddle must never bill every enrolled seat on the roster.
    it('orders nothing for a @team huddle that names nobody', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { convene_huddles: true });
      await msg(db, team, nick, null, 'message', 'h1', 1_000, { meta: HUDDLE });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('orders nothing once the huddle is closed', async () => {
      const { db, team, nick } = await openHuddleNaming('Ada');
      await msg(db, team, nick, null, 'resolve', 'c1', 2_000, { thread: 'h1' });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });
  });

  describe('claimWakeLeases — raised deferrals as wake candidates (ADR 211 increment 2)', async () => {
    /** Ada defers an urgent directed act until lane L1, then L1 moves. */
    async function deferredThenRaised(policy?: Record<string, unknown>) {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, policy);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });
      await msg(db, team, nick, null, 'message', 'l1', 3_000, {
        meta: { lane_state: { lane: 'L1', state: 'done' } },
      });
      return { db, team };
    }

    it('stays suppressed while the knob is off — the launch default', async () => {
      const { db, team } = await deferredThenRaised();
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('wakes once the knob is on', async () => {
      const { db, team } = await deferredThenRaised({ raised_deferral_wakes: true });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.act_id).toBe('u1');
    });

    it('takes the BATCHED lane even though the act was urgent — a deferral must not jump the line', async () => {
      const { db, team } = await deferredThenRaised({ raised_deferral_wakes: true });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders[0]!.lane).toBe('batched');
      expect(orders[0]!.derivation).toBe('batched');
    });

    it('does not wake a deferral whose condition has NOT fired, knob on', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { raised_deferral_wakes: true });
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await msg(db, team, ada, null, 'wait', 'w1', 2_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L1' } },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('respects a seat pinned to the interrupt lane: batched is closed, so nothing is ordered', async () => {
      const { db, team } = await deferredThenRaised({
        raised_deferral_wakes: true,
        lane: 'interrupt',
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('re-deferring after a raise suppresses it again', async () => {
      const { db, team } = await deferredThenRaised({ raised_deferral_wakes: true });
      const ada = (await getMemberByName(db, team.id, 'Ada'))!;
      const nick = (await getMemberByName(db, team.id, 'nick'))!;
      await msg(db, team, ada, null, 'wait', 'w2', 4_000, {
        meta: { defer_ref: 'u1', until: { lane: 'L2' } },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      // ...and raises again when the NEW condition fires.
      await msg(db, team, nick, null, 'message', 'l2', 5_000, {
        meta: { lane_state: { lane: 'L2', state: 'done' } },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.map((o) => o.act_id)).toEqual(['u1']);
    });
  });

  describe('wake-lease settlement + expiry', async () => {
    it('settles a lease once; an unknown or already-reported lease returns null', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      const lease = await settleWakeLease(db, team.id, order!.lease_id);
      expect(lease?.act_id).toBe('u1');
      expect(await settleWakeLease(db, team.id, order!.lease_id)).toBeNull();
      expect(await settleWakeLease(db, team.id, 'nope')).toBeNull();
    });

    it('expires overdue leases (reaper) so the wake re-becomes due, bounded by rate policy', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(order).toBeDefined();

      expect(await expireWakeLeases(db, Date.now())).toHaveLength(0); // not overdue yet
      const expired = await expireWakeLeases(db, Date.now() + WAKE_LEASE_TTL_MS + 1);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.id).toBe(order!.lease_id);

      // With the lease expired (and the reaper's wake_failed row not yet at any cap), it re-leases.
      const again = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(again).toHaveLength(1);
      expect(again[0]!.act_id).toBe('u1');
    });
  });

  describe('session capture (ADR 131 inc 4): attestation + the wake_deferred snooze', async () => {
    /** A host-reported deferral (the local-session guard) — the audit row the snooze derives from. */
    async function deferredRow(db: Database, team: TeamRow, seat: string, ts?: number) {
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_deferred',
        target: seat,
        result: 'allow',
        detail: { act: 'u1', lease_id: 'x', reason: 'local-session-live' },
      });
      if (ts !== undefined) {
        await db.run(
          'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
          [ts],
        );
      }
    }

    it('recordSessionAttestation stamps the enrolled row (harness class only); unenrolled is false', async () => {
      const { db, team, ada, bob } = await seed();
      await enroll(db, team, ada);
      expect(await recordSessionAttestation(db, team.id, ada.id, 'claude-code', 42)).toBe(true);
      const row = (await getResidency(db, team.id, ada.id))!;
      expect(row.resumable_harness).toBe('claude-code');
      expect(row.resumable_at).toBe(42);
      // bob never enrolled — the capture is honest about it, and nothing is created.
      expect(await recordSessionAttestation(db, team.id, bob.id, 'claude-code')).toBe(false);
      expect(await getResidency(db, team.id, bob.id)).toBeNull();
    });

    it('a fresh wake_deferred snoozes lease derivation; it lifts after WAKE_DEFER_SNOOZE_MS', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await deferredRow(db, team, ada.name); // just reported — the human is working there
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );

      // Backdate the deferral past the snooze window: the act is still due, full budget intact.
      await db.run("UPDATE audit SET ts = ? WHERE action = 'residency.wake_deferred'", [
        Date.now() - WAKE_DEFER_SNOOZE_MS - 1_000,
      ]);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.act_id).toBe('u1');
    });

    describe('ADR 485: a repeated local-session deferral backs off', () => {
      /** A streak of `n` same-reason deferrals, the newest `ageMs` ago, each one base snooze apart. */
      async function streak(
        db: Database,
        team: TeamRow,
        seat: string,
        n: number,
        ageMs: number,
        reason: string,
      ) {
        const newest = Date.now() - ageMs;
        for (let i = n - 1; i >= 0; i--) {
          await appendAudit(db, team.id, {
            actor: null,
            action: 'residency.wake_deferred',
            target: seat,
            result: 'allow',
            detail: { act: 'u1', lease_id: `x${i}`, reason },
          });
          await db.run(
            'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
            [newest - i * WAKE_DEFER_SNOOZE_MS],
          );
        }
      }
      async function due(reason: string, n: number, ageMs: number) {
        const { db, team, nick, ada } = await seed();
        await enroll(db, team, ada);
        await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
          meta: { urgent: true, urgent_reason: 'wake me' },
        });
        await streak(db, team, ada.name, n, ageMs, reason);
        return (await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).length;
      }

      it('the window doubles per repeat: a 3rd attended-session-open deferral snoozes 20 min', async () => {
        // One deferral: the base 5 min, unchanged (ADR 444's guard is not weakened).
        expect(await due('attended-session-open', 1, WAKE_DEFER_SNOOZE_MS + 1_000)).toBe(1);
        // Three in a row: 5 → 10 → 20 min, so 6 min after the third is still snoozed …
        expect(await due('attended-session-open', 3, 6 * 60_000)).toBe(0);
        // … and 21 min after it is not.
        expect(await due('attended-session-open', 3, 21 * 60_000)).toBe(1);
      });

      it('the window is capped: a 20-deferral streak snoozes WAKE_DEFER_SNOOZE_CAP_MS, not longer', async () => {
        expect(await due('local-session-live', 20, WAKE_DEFER_SNOOZE_CAP_MS - 60_000)).toBe(0);
        expect(await due('local-session-live', 20, WAKE_DEFER_SNOOZE_CAP_MS + 60_000)).toBe(1);
      });

      it('only local-session reasons back off: host_unreachable keeps the flat base snooze', async () => {
        expect(await due('host_unreachable', 10, WAKE_DEFER_SNOOZE_MS + 1_000)).toBe(1);
      });

      it('a change of reason restarts the streak at the base window', async () => {
        const { db, team, nick, ada } = await seed();
        await enroll(db, team, ada);
        await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
          meta: { urgent: true, urgent_reason: 'wake me' },
        });
        await streak(db, team, ada.name, 5, 30 * 60_000, 'local-session-live');
        await streak(db, team, ada.name, 1, WAKE_DEFER_SNOOZE_MS + 1_000, 'attended-session-open');
        expect(
          await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS),
        ).toHaveLength(1);
      });

      it('a wake between deferrals ends the streak', async () => {
        const { db, team, nick, ada } = await seed();
        await enroll(db, team, ada);
        await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
          meta: { urgent: true, urgent_reason: 'wake me' },
        });
        await streak(db, team, ada.name, 5, 40 * 60_000, 'attended-session-open');
        await appendAudit(db, team.id, {
          actor: null,
          action: 'residency.woke',
          target: ada.name,
          result: 'allow',
          detail: { act: 'u0', lease_id: 'w' },
        });
        await db.run(
          'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
          [Date.now() - 20 * 60_000],
        );
        await streak(db, team, ada.name, 1, WAKE_DEFER_SNOOZE_MS + 1_000, 'attended-session-open');
        expect(
          await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS),
        ).toHaveLength(1);
      });

      it('a long quiet gap ends the streak: yesterday’s deferrals do not stretch today’s snooze', async () => {
        const { db, team, nick, ada } = await seed();
        await enroll(db, team, ada);
        await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
          meta: { urgent: true, urgent_reason: 'wake me' },
        });
        await streak(db, team, ada.name, 8, 24 * 3_600_000, 'attended-session-open');
        await streak(db, team, ada.name, 1, WAKE_DEFER_SNOOZE_MS + 1_000, 'attended-session-open');
        expect(
          await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS),
        ).toHaveLength(1);
      });
    });

    it('an actuator_restart handback does NOT snooze: the next poll re-derives the lease (lane 01M3QRYZM2)', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_deferred',
        target: ada.name,
        result: 'allow',
        detail: { act: 'u1', lease_id: 'x', reason: WAKE_DEFER_ACTUATOR_RESTART },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.act_id).toBe('u1');
    });

    it('deferrals burn NO attempt or rate budget: many deferrals, then a wake with full caps', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'message', 'u1', 1_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });
      // A long working session deferred the wake many times over (all past the snooze window now) —
      // more rows than the attempt cap and the hourly cap combined.
      // ADR 485: a streak this long is snoozed to the cap, so backdate past the CAP, not the base.
      const old = Date.now() - WAKE_DEFER_SNOOZE_CAP_MS - 60_000;
      for (let i = 0; i < WAKE_ATTEMPT_CAP + WAKE_HOURLY_CAP + 1; i++) {
        await deferredRow(db, team, ada.name, old - i * 1_000);
      }
      // The act still derives a lease (attempt cap untouched), and no wake_exhausted was written.
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(
        (await listAudit(db, team.id)).filter((r) => r.action === 'residency.wake_exhausted'),
      ).toHaveLength(0);
    });
  });

  describe('wake policy (ADR 131 inc 5): defaults ⊕ team ⊕ seat', async () => {
    it('effectiveWakePolicy layers a sparse override; unparseable/unknown input degrades honestly', () => {
      const defaults = WAKE_POLICY_DEFAULTS;
      expect(effectiveWakePolicy(defaults, null)).toEqual(defaults);
      const merged = effectiveWakePolicy(defaults, JSON.stringify({ cooldown_ms: 900_000 }));
      expect(merged.cooldown_ms).toBe(900_000);
      expect(merged.hourly_cap).toBe(defaults.hourly_cap); // unset keys flow through
      // Drift (hand-edit, downgrade): unreadable ⇒ no override, never a throwing wake pipeline.
      expect(effectiveWakePolicy(defaults, 'not json')).toEqual(defaults);
      expect(parsePolicyOverride('{"unknown_knob": 5}')).toEqual({}); // zod strips unknowns
    });

    it('team defaults govern the derivation (cooldown via setPolicy, no per-seat override)', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      // Shrink the team cooldown to 5 minutes; a wake 10 minutes ago no longer blocks batched.
      await setPolicy(db, team.id, {
        ...(await getPolicy(db, team.id)),
        residency: { ...WAKE_POLICY_DEFAULTS, cooldown_ms: 5 * 60_000 },
      });
      await wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', Date.now() - 10 * 60_000);
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
    });

    it('a seat override tightens the hourly cap below the team default', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { hourly_cap: 1 });
      await wakeOutcomeRow(db, team, 'Ada', 'past-0', 'residency.woke', Date.now() - 45 * 60_000);
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      // One wake this hour ≥ the seat's cap of 1 — nothing derives (default cap of 2 would allow).
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('lane=interrupt never leases batched candidates; lane=batched never leases a steer', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { lane: 'interrupt' });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      await msg(db, team, nick, ada, 'steer', 's1', 2_000);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.lane).toBe('immediate');

      const { db: db2, team: team2, nick: nick2, ada: ada2 } = await seed();
      await enroll(db2, team2, ada2, HOST, { lane: 'batched' });
      await msg(db2, team2, nick2, ada2, 'steer', 's1', 1_000);
      expect(
        await claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS),
      ).toHaveLength(0);
      await msg(db2, team2, nick2, ada2, 'handoff', 'h1', 2_000);
      const orders2 = await claimWakeLeases(db2, team2.id, team2.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders2).toHaveLength(1);
      expect(orders2[0]!.lane).toBe('batched');
    });

    it('a seat attempt_cap override exhausts at the effective cap and audits it', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { attempt_cap: 2 });
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      const old = Date.now() - 2 * 3_600_000;
      for (let i = 0; i < 2; i++)
        await wakeOutcomeRow(db, team, 'Ada', 's1', 'residency.wake_failed', old);
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      const exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(exhausted).toHaveLength(1);
      expect(JSON.parse(exhausted[0]!.detail!)['attempts']).toBe(2);
    });

    it('the emitted order carries the effective actuation knobs for the host', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, {
        tool_policy: 'seat-policy',
        timeout_ms: 120_000,
        max_turns: 12,
        budget_usd: 2,
        transcript_max_bytes: 2_097_152,
      });
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(order!.tool_policy).toBe('seat-policy');
      expect(order!.bounds).toEqual({ timeout_ms: 120_000, max_turns: 12, budget_usd: 2 });
      expect(order!.transcript_max_bytes).toBe(2_097_152);
    });

    it('re-enroll without a policy preserves the override; {} clears it', async () => {
      const { db, team, ada } = await seed();
      await enroll(db, team, ada, HOST, { hourly_cap: 5 });
      expect((await getResidency(db, team.id, ada.id))?.policy).toBe('{"hourly_cap":5}');
      await enroll(db, team, ada); // drift-fixing re-enroll, no policy — tuning survives
      expect((await getResidency(db, team.id, ada.id))?.policy).toBe('{"hourly_cap":5}');
      await enroll(db, team, ada, HOST, {}); // explicit clear
      expect((await getResidency(db, team.id, ada.id))?.policy).toBeNull();
    });
  });

  describe('ping-pong demotion (ADR 131 §4, landed inc 5)', async () => {
    /** A steer sent while the SENDER's live presence attests provenance `wake` — the machine chain. */
    async function steerFromWakeOccupancy(
      db: Database,
      team: TeamRow,
      sender: MemberRow,
      recipient: MemberRow,
      id: string,
      ts: number,
    ) {
      await attach(db, sender.id, 'claude-code', `conn-${id}`, { provenance: 'wake' });
      await msg(db, team, sender, recipient, 'steer', id, ts);
    }

    it('an interrupt-class act sent from a wake occupancy is demoted to the batched lane', async () => {
      const { db, team, ada, bob } = await seed();
      await enroll(db, team, ada);
      await steerFromWakeOccupancy(db, team, bob, ada, 's1', 1_000);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.lane).toBe('batched'); // still reachable — at cooldown cadence, not instantly
    });

    it('the demoted act respects the batched cooldown (chains run at cooldown cadence)', async () => {
      const { db, team, ada, bob } = await seed();
      await enroll(db, team, ada);
      await wakeOutcomeRow(db, team, 'Ada', 'old-act', 'residency.woke', Date.now() - 5 * 60_000);
      await steerFromWakeOccupancy(db, team, bob, ada, 's1', 1_000);
      // Inside the 30-minute cooldown a human steer would wake immediately; the machine steer waits.
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('a human-sent steer still wakes immediately (nothing over-demotes)', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await attach(db, nick.id, 'cli', 'conn-nick'); // provenance null — a human session
      await msg(db, team, nick, ada, 'steer', 's1', 1_000);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.lane).toBe('immediate');
    });
  });

  describe('claimWakeLeases — work_order derivation (ADR 191 review loop)', () => {
    it('leases a seat-policy work_order for an unanswered lane_review ask when loops.review + flow:auto', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: {
          species: 'approve',
          tier: 'standard',
          lane_review: {
            lane: lane.id,
            title: lane.title,
            route: 'cross_family',
            grade: 'cross_model',
          },
        },
      });

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        seat: 'Ada',
        act_id: 'ask1',
        derivation: 'work_order',
        lane_id: lane.id,
        tool_policy: 'seat-policy',
        continuity_requirement: 'portable',
        intended_delivery: 'fresh',
      });
      expect(orders[0]!.bounds?.timeout_ms).toBe(WAKE_POLICY_DEFAULTS.work_timeout_ms);
      expect(orders[0]!.composed_line).toContain(lane.id);
      expect(orders[0]!.composed_line).not.toContain(lane.title);
      expect(orders[0]!.composed_line).toContain('team_wake_context');
      // The review line must steer to the ACT, not the lane. `buildWakeContext` authorizes the lane
      // path by OWNERSHIP, and a reviewer never owns the lane it reviews — a line naming only the lane
      // sends them at the one path that must refuse them (measured 2026-09-04: 38 of 47 review-edge
      // wakes carried a `residency.context_read` deny within ±5 minutes).
      expect(orders[0]!.composed_line).toContain('act_id: "ask1"');
      expect(orders[0]!.composed_line).toMatch(/^musterd \[revive\]: wake — /); // ADR 442
      expect(orders[0]!.composed_line).toContain('pointer only — read it as yourself');
      const leased = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_leased',
      );
      expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
        derivation: 'work_order',
        lane_id: lane.id,
        continuity_requirement: 'portable',
        intended_delivery: 'fresh',
      });
    });

    it('does not derive work_order when loops.review is off (launch default)', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: {
          species: 'approve',
          tier: 'standard',
          lane_review: { lane: lane.id },
        },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('does not derive work_order when the seat is flow:manual', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true } });
      await enroll(db, team, ada, HOST, { flow: 'manual' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: {
          species: 'approve',
          tier: 'standard',
          lane_review: { lane: lane.id },
        },
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });
  });

  describe('claimWakeLeases — work_order derivation (ADR 199 dispatch loop)', async () => {
    it('handoff with lane_handoff becomes seat-policy work_order when loops.dispatch + flow:auto', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'secret title',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
      });

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        seat: 'Ada',
        act_id: 'h1',
        act: 'handoff',
        derivation: 'work_order',
        lane_id: lane.id,
        tool_policy: 'seat-policy',
      });
      expect(orders[0]!.bounds?.timeout_ms).toBe(WAKE_POLICY_DEFAULTS.work_timeout_ms);
      expect(orders[0]!.composed_line).toContain(lane.id);
      expect(orders[0]!.composed_line).toContain('is yours');
      expect(orders[0]!.composed_line).not.toContain('secret title');
      // The dispatch line spells the lane path's argument too — the owner is authorized on lane_id.
      expect(orders[0]!.composed_line).toContain(`team_wake_context {lane_id: "${lane.id}"}`);
      expect(orders[0]!.composed_line).toMatch(/^musterd \[revive\]: wake — /); // ADR 442
      expect(orders[0]!.composed_line).toContain('pointer only — read it as yourself');
    });

    it('does not promote handoff to work_order when loops.dispatch is off (reply doorbell remains)', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id } },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.derivation).toBe('batched');
      expect(orders[0]!.tool_policy).not.toBe('seat-policy');
      expect(orders[0]).toMatchObject({
        continuity_requirement: 'portable',
        intended_delivery: 'fresh',
      });
    });

    it('does not derive dispatch work_order when the seat is flow:manual', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'manual' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id } },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.derivation).toBe('batched');
      expect(orders[0]).toMatchObject({
        continuity_requirement: 'portable',
        intended_delivery: 'fresh',
      });
    });

    // ADR 325 prereq: the "last failure on this edge" pick tie-broke on local `rowid`, an ordering
    // that exists only on this machine's file. Today appendAudit's ULIDs land in rowid order, so the
    // two agree — but a replicated log has no shared rowid, and the ULID id is the ordering the
    // schema actually promises. The tie is constructed raw (same ts, ids opposed to insertion
    // order): id-order says the still-true failure was superseded; rowid-order says it stands.
    it("breaks a same-ts tie on the ULID id, not on this file's rowid (ADR 325 prereq)", async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      // The continuation edge: Ada owns a claimed lane and there is no triggering act, so the ONLY
      // candidate is (lane, 'dispatch_continuation') — the injected failures decide everything.
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'tied',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });

      const failRow = async (id: string, wakeability: string) =>
        await db.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
           VALUES (?, ?, 1000, NULL, 'residency.wake_failed', 'Ada', 'deny', ?, 1000)`,
          [
            id,
            team.id,
            JSON.stringify({ lane_id: lane.id, edge: 'dispatch_continuation', wakeability }),
          ],
        );
      // Later-by-id row first: the failure that SUPERSEDED the still-true one (not in the closed set).
      await failRow('01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'host_asleep');
      // Earlier-by-id row second, so rowid points at it: the stale still-true failure.
      await failRow('01AAAAAAAAAAAAAAAAAAAAAAAA', 'not_enrolled');

      // The latest failure by the schema's ordering is not still-true, so the edge leases again.
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ seat: 'Ada', derivation: 'work_order', lane_id: lane.id });
    });

    it('keeps ordinary inbox wakes on the legacy ladder until the portable reply cohort is enabled', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'steer', 'm1', 1_000);

      const [legacy] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        10_000,
      );
      expect(legacy).not.toHaveProperty('intended_delivery');

      await db.run('DELETE FROM wake_leases WHERE team_id = ?', [team.id]);
      await setPolicy(db, team.id, { residency: { portable_inbox_replies: true } });
      expect((await getPolicy(db, team.id)).residency.portable_inbox_replies).toBe(true);
      const [portable] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        2_000_000,
      );
      expect(portable).toMatchObject({
        continuity_requirement: 'portable',
        intended_delivery: 'fresh',
      });
    });

    it('continuation: owned claimed lane with no act → work_order with null act_id', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'keep going',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });

      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        seat: 'Ada',
        derivation: 'work_order',
        lane_id: lane.id,
        tool_policy: 'seat-policy',
      });
      expect(orders[0]!.act_id).toBeUndefined();
      expect(orders[0]!.composed_line).toContain(lane.id);
      expect(orders[0]!.composed_line).not.toContain('keep going');
      const leased = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_leased',
      );
      expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
        act: `lane:${lane.id}`,
        derivation: 'work_order',
        lane_id: lane.id,
      });
    });

    it('continuation does not auto-pick unowned open lanes', async () => {
      const { openLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      await openLane(db, team.id, team.slug, nick.name, { title: 'unowned work', claim: false });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('continuation skips blocked and awaiting_acceptance lanes', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const blocked = await openLane(db, team.id, team.slug, nick.name, {
        title: 'blocked',
        claim: true,
      });
      await updateLane(db, team.id, blocked.id, team.slug, {
        owner_seat: ada.name,
        state: 'blocked',
      });
      const awaiting = await openLane(db, team.id, team.slug, nick.name, {
        title: 'awaiting',
        claim: true,
      });
      await updateLane(db, team.id, awaiting.id, team.slug, {
        owner_seat: ada.name,
        state: 'awaiting_acceptance',
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });
  });

  describe('claimWakeLeases — resume eligibility (ADR 210 exact-match continuity)', async () => {
    // The daemon may only MARK a wake resume_eligible. That mark is permission to consider a local
    // resume, never an instruction to perform one — the host still has to prove an exact match.
    const REPLY_TS = 1_000_000;
    const soon = REPLY_TS + 30_000;

    async function threadedReply(over: { ts?: number; thread?: string } = {}) {
      const seeded = await seed();
      const { db, team, nick, ada } = seeded;
      await enroll(db, team, ada);
      await setPolicy(db, team.id, {
        residency: { portable_inbox_replies: true, exact_match_resume: true },
      });
      await msg(db, team, nick, ada, 'steer', 'm1', over.ts ?? REPLY_TS, {
        thread: over.thread ?? 'T1',
      });
      return seeded;
    }

    it('marks a recent directed threaded reply resume_eligible', async () => {
      const { db, team } = await threadedReply();
      const [order] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        soon,
      );
      expect(order).toMatchObject({ resume_eligible: true, intended_delivery: 'fresh' });
    });

    // The mark alone is unusable: the local registry is keyed by thread, so a host that is told
    // "you may consider a resume" but not WHICH thread has nothing to match against. The thread id
    // travels daemon→host only; the reverse direction (session id, transcript path, workspace) is
    // what ADR 210's privacy invariant forbids, and it stays forbidden.
    it('carries the thread id the host needs to find its local binding, only when eligible', async () => {
      const { db, team } = await threadedReply();
      const [order] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        soon,
      );
      expect(order).toMatchObject({ resume_eligible: true, thread_id: 'T1' });

      // Past the horizon the wake is not eligible — so the thread id is not sent either.
      const late = REPLY_TS + WAKE_POLICY_DEFAULTS.resume_eligible_ms + 1;
      const [stale] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        late,
      );
      expect(stale).not.toHaveProperty('thread_id');
    });

    it('does not mark a reply older than the eligibility horizon', async () => {
      const { db, team } = await threadedReply();
      const late = REPLY_TS + WAKE_POLICY_DEFAULTS.resume_eligible_ms + 1;
      const [order] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        late,
      );
      expect(order).not.toHaveProperty('resume_eligible');
    });

    it('does not mark an un-threaded directed reply — there is no join key to prove a match', async () => {
      const seeded = await seed();
      const { db, team, nick, ada } = seeded;
      await enroll(db, team, ada);
      await setPolicy(db, team.id, {
        residency: { portable_inbox_replies: true, exact_match_resume: true },
      });
      await msg(db, team, nick, ada, 'steer', 'm1', REPLY_TS);
      const [order] = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
        soon,
      );
      // A message with no explicit thread still has a canonical thread of its own id, but it is the
      // FIRST act in it — there is no prior dialogue to resume into.
      expect(order).not.toHaveProperty('resume_eligible');
    });

    it('never marks a handoff, even inside a live thread — the derivation wins', async () => {
      const seeded = await seed();
      const { db, team, nick, ada } = seeded;
      await enroll(db, team, ada);
      await setPolicy(db, team.id, {
        residency: { portable_inbox_replies: true, exact_match_resume: true },
      });
      await msg(db, team, nick, ada, 'message', 'root', REPLY_TS - 1_000, { thread: 'T1' });
      await msg(db, team, nick, ada, 'handoff', 'h1', REPLY_TS, { thread: 'T1' });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
      for (const o of orders) expect(o).not.toHaveProperty('resume_eligible');
    });

    it('never marks a work_order wake', async () => {
      const { openLane, updateLane } = await import('./lanes.js');
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, {
        loops: { review: true },
        residency: { exact_match_resume: true },
      });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: {
          species: 'approve',
          tier: 'standard',
          lane_review: {
            lane: lane.id,
            title: lane.title,
            route: 'cross_family',
            grade: 'cross_model',
          },
        },
      });
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(order!.derivation).toBe('work_order');
      expect(order).not.toHaveProperty('resume_eligible');
    });

    it('marks nothing while the exact_match_resume switch is off (the launch default)', async () => {
      const seeded = await seed();
      const { db, team, nick, ada } = seeded;
      await enroll(db, team, ada);
      await setPolicy(db, team.id, { residency: { portable_inbox_replies: true } });
      expect((await getPolicy(db, team.id)).residency.exact_match_resume).toBe(false);
      await msg(db, team, nick, ada, 'message', 'root', REPLY_TS - 1_000, { thread: 'T1' });
      await msg(db, team, nick, ada, 'steer', 'm1', REPLY_TS, { thread: 'T1' });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
      for (const o of orders) expect(o).not.toHaveProperty('resume_eligible');
    });

    it('records the eligibility bit in the wake_leased audit row and no local identity', async () => {
      const { db, team } = await threadedReply();
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS, soon);
      const leased = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_leased',
      );
      const detail = JSON.parse(leased[0]!.detail as string);
      expect(detail).toMatchObject({ resume_eligible: true });
      expect(detail).not.toHaveProperty('session_id');
      expect(detail).not.toHaveProperty('transcript_path');
      expect(detail).not.toHaveProperty('thread_id');
    });
  });

  describe('wake_leases edge + spawned_at (ADR 262)', async () => {
    // pragma_table_info is SQLite's; the Postgres side is pinned by pg/drift.test.ts.
    it.runIf(kind === 'sqlite')('migration adds nullable edge and spawned_at', async () => {
      const { db } = await seed();
      const cols = (
        await db.all<{ name: string }>("SELECT name FROM pragma_table_info('wake_leases')")
      ).map((c) => c.name);
      expect(cols).toContain('edge');
      expect(cols).toContain('spawned_at');
    });
  });

  describe('claimWakeLeases — stamps loop edge (ADR 262)', async () => {
    it('review work_order stamps edge=review on the lease and the audit', async () => {
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders).toHaveLength(1);
      const row = (await db.get('SELECT edge, spawned_at FROM wake_leases WHERE id = ?', [
        orders[0]!.lease_id,
      ])) as { edge: string | null; spawned_at: number | null };
      expect(row.edge).toBe('review');
      expect(row.spawned_at).toBeNull();
      const leased = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_leased',
      );
      expect(JSON.parse(leased[0]!.detail as string)).toMatchObject({
        edge: 'review',
        lane_id: lane.id,
      });
    });

    it('dispatch handoff stamps dispatch_handoff; continuation stamps dispatch_continuation', async () => {
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const handed = await openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
      await updateLane(db, team.id, handed.id, team.slug, {
        owner_seat: ada.name,
        state: 'claimed',
      });
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: handed.id, branch: 'feat/x' } },
      });
      const handoffOrders = await claimWakeLeases(
        db,
        team.id,
        team.slug,
        HOST,
        PRESENCE_TIMEOUT_MS,
      );
      const handoffRow = (await db.get('SELECT edge FROM wake_leases WHERE id = ?', [
        handoffOrders[0]!.lease_id,
      ])) as { edge: string };
      expect(handoffRow.edge).toBe('dispatch_handoff');

      // settle the lease and park the handed lane so it is no longer a handoff or
      // continuation candidate — otherwise Ada's still-claimed handoff lane wins the
      // single per-seat lease and the new continuation never appears.
      await db.run("UPDATE wake_leases SET status = 'reported' WHERE id = ?", [
        handoffOrders[0]!.lease_id,
      ]);
      await msg(db, team, ada, nick, 'accept', 'a1', 2_000, { meta: { in_reply_to: 'h1' } });
      await updateLane(db, team.id, handed.id, team.slug, { state: 'awaiting_acceptance' });
      const cont = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      const contOrders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      const contLease = contOrders.find((o) => o.lane_id === cont.id);
      expect(contLease).toBeTruthy();
      const contRow = (await db.get('SELECT edge FROM wake_leases WHERE id = ?', [
        contLease!.lease_id,
      ])) as { edge: string };
      expect(contRow.edge).toBe('dispatch_continuation');
    });

    it('inbox wakes leave edge NULL', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada);
      await msg(db, team, nick, ada, 'request_help', 'r1', 1_000);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.length).toBeGreaterThan(0);
      const row = (await db.get('SELECT edge FROM wake_leases WHERE id = ?', [
        orders[0]!.lease_id,
      ])) as { edge: string | null };
      expect(row.edge).toBeNull();
    });
  });

  describe('markWakeSpawned (ADR 262)', async () => {
    async function reviewDue() {
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });
      return { db, team };
    }

    it('stamps spawned_at, does not settle, is idempotent, null on unknown', async () => {
      const { db, team } = await reviewDue();
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      const first = await markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_000);
      expect(first!.status).toBe('leased');
      expect(first!.spawned_at).toBe(1_700_000_000_000);
      const second = await markWakeSpawned(db, team.id, order!.lease_id, 1_700_000_000_999);
      expect(second!.spawned_at).toBe(1_700_000_000_000); // first stamp wins
      expect(await markWakeSpawned(db, team.id, 'nope')).toBeNull();

      await settleWakeLease(db, team.id, order!.lease_id);
      const afterSettle = await markWakeSpawned(db, team.id, order!.lease_id, 1_800_000_000_000);
      expect(afterSettle!.status).toBe('reported');
      expect(afterSettle!.spawned_at).toBe(1_700_000_000_000); // already set; settle-then-progress is a no-op stamp
    });

    it('after settle with null spawned_at, progress still stamps', async () => {
      const { db, team } = await reviewDue();
      const [order] = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      await settleWakeLease(db, team.id, order!.lease_id);
      const stamped = await markWakeSpawned(db, team.id, order!.lease_id, 42);
      expect(stamped!.status).toBe('reported');
      expect(stamped!.spawned_at).toBe(42);
    });
  });

  describe('claimWakeLeases — spend breaker + still-true (ADR 262)', async () => {
    async function reviewDue() {
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', attempt_cap: 10, hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, nick.name, {
        title: 'a change',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, team.slug, { state: 'ready_for_review' });
      await msg(db, team, nick, ada, 'ask', 'ask1', 1_000, {
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: lane.id } },
      });
      return { db, team, ada, lane };
    }

    async function failEdge(
      db: Database,
      teamId: string,
      detail: Record<string, unknown>,
      ts = Date.now() - WAKE_COOLDOWN_MS - 1,
    ) {
      await appendAudit(db, teamId, {
        actor: null,
        action: 'residency.wake_failed',
        target: 'Ada',
        result: 'deny',
        detail,
      });
      await db.run(
        'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
        [ts],
      );
    }

    /** A reported successful wake on one (lane, edge) — the rows the ADR 306 bounds derive from. */
    async function wokeEdge(
      db: Database,
      teamId: string,
      laneId: string,
      edge: string,
      ts = Date.now() - WAKE_COOLDOWN_MS - 1,
    ) {
      await appendAudit(db, teamId, {
        actor: null,
        action: 'residency.woke',
        target: 'Ada',
        result: 'allow',
        detail: { act: `lane:${laneId}`, lane_id: laneId, edge },
      });
      await db.run(
        'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
        [ts],
      );
    }

    /** Move the lane's own clock — the ADR 306 progress signal, without going through a state patch. */
    async function laneTouched(db: Database, laneId: string, ts: number) {
      await db.run('UPDATE lanes SET updated_at = ? WHERE id = ?', [ts, laneId]);
    }

    it('skips when last wake_failed wakeability is enrolled_dead_workspace', async () => {
      const { db, team, lane } = await reviewDue();
      await failEdge(db, team.id, {
        act: 'ask1',
        lane_id: lane.id,
        edge: 'review',
        wakeability: 'enrolled_dead_workspace',
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
    });

    it('retries when last failure is lease_expired or enrolled_seat_busy', async () => {
      const { db, team, lane } = await reviewDue();
      await failEdge(db, team.id, {
        act: 'ask1',
        lane_id: lane.id,
        edge: 'review',
        reason: 'lease_expired',
      });
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        1,
      );
    });

    it('trips after 3 wake_failed on the same edge, not after 3 woke, and not across edges', async () => {
      const { db, team, lane } = await reviewDue();
      for (let i = 0; i < 3; i++) {
        await failEdge(db, team.id, {
          act: `ask${i}`,
          lane_id: lane.id,
          edge: 'review',
          reason: 'lease_expired',
        });
      }
      expect(await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS)).toHaveLength(
        0,
      );
      const exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(JSON.parse(exhausted.at(-1)!.detail as string)).toMatchObject({
        breaker: true,
        edge: 'review',
      });
    });

    /**
     * ADR 306. This test previously passed only because it enrolled with `attempt_cap: 10`.
     * Production runs the ADR 131 default of 3, and at 3 the ADR 262 §4.1 guarantee is FALSE:
     * `attemptsForAct` counts `residency.woke` as well as `wake_failed`, so three SUCCESSFUL
     * continuations exhaust the lane-keyed cap and the edge never derives again. Measured on the
     * live ledger 2026-08-21: lanes `01M040DH9X…` and `01KZ4QH585…`, 3 wokes / 0 failures each,
     * both permanently exhausted. The override configured the defect out of the test that existed
     * to catch it — so the enrollment here is deliberately left at the default.
     *
     * The guarantee is also NARROWED by the ADR 306 progress precondition: three successful
     * continuations still derive, but only if each one moved the lane. A wake that changed nothing
     * does not buy the next one (ADR 247, ADR 250 §2).
     */
    it('three woke on dispatch_continuation still derive at the DEFAULT attempt cap', async () => {
      const { db, team, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      for (let i = 0; i < 3; i++) {
        const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
        await wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
        // the seat woke and did work: the lane moves after the wake it answered
        await laneTouched(db, lane.id, wokeTs + 1);
      }
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.lane_id === lane.id)).toBe(true);
    });

    it('a success does not write a terminal exhaustion row for an edge-bearing work order', async () => {
      const { db, team, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      for (let i = 0; i < 3; i++) {
        const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
        await wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
        await laneTouched(db, lane.id, wokeTs + 1);
      }
      await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      const exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(exhausted).toHaveLength(0);
    });

    /** ADR 306 §2 — no heartbeat that burns spend while nothing changed (ADR 250 §2). */
    it('continuation does not re-derive when the lane has not moved since the last woke', async () => {
      const { db, team, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
      await laneTouched(db, lane.id, wokeTs - 1_000);
      await wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.lane_id === lane.id)).toBe(false);
    });

    it('continuation derives again once the lane moves after the last woke', async () => {
      const { db, team, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      const wokeTs = Date.now() - WAKE_COOLDOWN_MS - 1;
      await wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
      await laneTouched(db, lane.id, wokeTs + 1);
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.lane_id === lane.id)).toBe(true);
    });

    /**
     * The ceiling is a recorded judgment (ADR 306 §3), not an implementation detail: the test that
     * exercises it seeds its chain FROM the constant, so it cannot notice the number changing. This
     * pins the number itself — moving it must be a deliberate edit with an ADR behind it.
     */
    it('the continuation ceiling is the number ADR 306 recorded', () => {
      expect(WORK_ORDER_CONTINUATION_SUCCESS_CAP).toBe(8);
    });

    /** ADR 306 §3 — a succeeding chain is bounded too; nick rejected indefinite chaining. */
    it('trips the continuation success cap and records it as a counted event', async () => {
      const { db, team, ada } = await seed();
      await setPolicy(db, team.id, { loops: { dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', hourly_cap: 20 });
      const lane = await openLane(db, team.id, team.slug, ada.name, { title: 'c', claim: true });
      // The chain must sit OUTSIDE the hourly window, or the hourly cap — not the ADR 306 ceiling —
      // is what stops the ninth wake, and the test would pass for the wrong reason.
      for (let i = 0; i < WORK_ORDER_CONTINUATION_SUCCESS_CAP; i++) {
        const wokeTs = Date.now() - 2 * 3_600_000 + i;
        await wokeEdge(db, team.id, lane.id, 'dispatch_continuation', wokeTs);
        await laneTouched(db, lane.id, wokeTs + 1);
      }
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.lane_id === lane.id)).toBe(false);
      const exhausted = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'residency.wake_exhausted',
      );
      expect(JSON.parse(exhausted.at(-1)!.detail as string)).toMatchObject({
        reason: 'continuation_cap',
        edge: 'dispatch_continuation',
        lane_id: lane.id,
      });
    });

    /**
     * Scope guard for ADR 306 §1: the success-blind counting is restricted to edge-bearing work
     * orders. An inbox wake (edge NULL) must keep today's semantics exactly — a successful wake
     * still retires its act, or a delivered doorbell would ring forever.
     */
    it('inbox wakes still count successes toward the attempt cap', async () => {
      const { db, team, nick, ada } = await seed();
      await enroll(db, team, ada, HOST, { flow: 'auto' });
      await msg(db, team, nick, ada, 'request_help', 'rh1', 1_000);
      for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) {
        await appendAudit(db, team.id, {
          actor: null,
          action: 'residency.woke',
          target: 'Ada',
          result: 'allow',
          detail: { act: 'rh1' },
        });
        await db.run(
          'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
          [Date.now() - WAKE_COOLDOWN_MS - 1],
        );
      }
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.act_id === 'rh1')).toBe(false);
    });

    it('review failures do not trip dispatch_handoff on the same lane', async () => {
      const { db, team, nick, ada } = await seed();
      await setPolicy(db, team.id, { loops: { review: true, dispatch: true } });
      await enroll(db, team, ada, HOST, { flow: 'auto', attempt_cap: 10, hourly_cap: 10 });
      const lane = await openLane(db, team.id, team.slug, nick.name, { title: 'h', claim: true });
      await updateLane(db, team.id, lane.id, team.slug, { owner_seat: ada.name, state: 'claimed' });
      for (let i = 0; i < 3; i++) {
        await failEdge(db, team.id, {
          lane_id: lane.id,
          edge: 'review',
          reason: 'lease_expired',
        });
      }
      await msg(db, team, nick, ada, 'handoff', 'h1', 1_000, {
        meta: { lane_handoff: { lane: lane.id, branch: 'feat/x' } },
      });
      const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      expect(orders.some((o) => o.act_id === 'h1')).toBe(true);
    });
  });

  /**
   * The wake poll runs on the daemon's request path, in one transaction, every 30s per enrolled seat.
   * Its cost must therefore be a function of what is DUE, never of how long the team has been talking
   * — otherwise the poll grows without bound against an append-only log and starves the event loop for
   * every other request (measured on the revive team: 840ms at idle, 8000+ member lookups per poll,
   * `/health` timing out behind the queue and tripping guardian `daemon_down` false alarms).
   *
   * The deferral fold is where that bound was lost: `deferrals` reads only the seat's OWN `wait` acts,
   * but the scan hydrated every row in the window into a full Envelope — two member lookups each —
   * before throwing all of them away. This pins the property rather than the fix: a seat that has
   * deferred nothing must not pay for the timeline.
   */
  describe('claimWakeLeases — cost is bounded by what is due, not by the timeline (burst starvation)', async () => {
    /** Counts executions of the per-row member hydration the deferral scan used to drive. */
    async function countMemberLookups(db: Driver, run: () => Promise<void>): Promise<number> {
      let n = 0;
      const off = (db as SqliteDriver | PgliteDriver).onStatement((sql) => {
        if (/FROM members WHERE id = \?/.test(sql)) n++;
      });
      try {
        await run();
      } finally {
        off();
      }
      return n;
    }

    it('does not hydrate the team timeline for a seat that has deferred nothing', async () => {
      const { db, team, nick, ada, bob } = await seed();
      await enroll(db, team, ada);
      // A long-running team: chatter Ada is a party to, none of it deferred by her.
      for (let i = 0; i < 400; i++) {
        await msg(db, team, nick, bob, 'message', `c${i}`, 1_000 + i);
        await msg(db, team, bob, null, 'status_update', `s${i}`, 1_400 + i);
      }
      // One genuine reason to wake her.
      await msg(db, team, nick, ada, 'message', 'u1', 900_000, {
        meta: { urgent: true, urgent_reason: 'wake me' },
      });

      let orders: unknown[] = [];
      const lookups = await countMemberLookups(db, async () => {
        orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
      });

      expect(orders).toHaveLength(1);
      // The seat, its sender, and the lease bookkeeping — a handful. NOT one per timeline row.
      expect(lookups).toBeLessThan(50);
    });
  });
});
