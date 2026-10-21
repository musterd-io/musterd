import { createHash } from 'node:crypto';
import {
  type ActorAttestation,
  type AskSpecies,
  ASK_TOP_TIER,
  askContractText,
  type GateCheckRequest,
  type GateDecision,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { findGateAsk, gateAskHumanAnswer } from '../store/gateAsk.js';
import { pricedWakeCostUsd, unpricedWakeCount, WAKE_WINDOW_DAYS } from '../store/insights.js';
import { laneCoveringPath, laneHoldingFile } from '../store/lanes.js';
import { getMemberByName, listMembers } from '../store/members.js';
import { isPresentOrReclaimable } from '../store/presence.js';
import { unblockerReachable } from '../store/reachability.js';
import { getRoleSkill } from '../store/roles.js';
import { type MemberRow, type TeamRow, toMember } from '../store/rows.js';
import { getPolicy, spendCapUsd, unpricedWakeCap } from '../store/teams.js';
import { routeEnvelope } from './route.js';

/**
 * PreToolUse gate adjudication (ADR 150 — structural inducement). The daemon side of the two enforcement
 * gates: the hook has already matched the tool call against a declared class CLIENT-side and POSTed the
 * shapes here (`GateCheckRequest`); this module makes the decision **atomically server-side** and records
 * one shapes-only audit row. Dispatch is by `req.kind`: `contended-surface` → Gate A (lane-ownership),
 * `costly-action` → Gate B (action→ask).
 *
 * **The warn path is the same for both gates and lives here in the foundation** — warn posture (the
 * ADR 083 default) always proceeds, records `outcome: 'warned'`, and surfaces an advisory. Only the
 * `block`-posture decision is gate-specific, so that is what `gateA`/`gateB` own. Until a gate's block
 * path is implemented it **fails open** (allows): an unfinished gate must never wedge an agent — the
 * ADR's guard metric is "enforcement must not raise interventions-to-done by stranding a seat on a gate
 * it cannot satisfy." The block logic lands in the Gate A (izzo) and Gate B (stanley) lanes on top.
 */

export interface GateContext {
  /** The full server bundle (db, hub, config). Gate A needs only `srv.db` (a lane-board read); Gate B's
   *  deny-is-emit raises its ask through `routeEnvelope`, which needs `srv.hub`/`srv.config` for the
   *  ADR 147/149 admin-push + Slack surfaces — hence the whole `Ctx`, not a bare `db`. */
  srv: Ctx;
  team: TeamRow;
  /** The acting seat — the request is member-authed AS this seat, so a Gate B ask emitted here is
   *  raised "through the seat's own credential" (ADR 150). */
  member: MemberRow;
  req: GateCheckRequest;
}

/**
 * Gate A — lane-ownership (ADR 150). An edit to a declared **contended surface** requires the acting
 * seat to own a claimed lane whose `scope` covers the target path. The check is one lane-board
 * read: does this seat hold a contending lane covering `req.target`?
 *   - **Owns it** → allow, quietly (`allowed`, no nag) — under either posture. Ownership IS the point;
 *     a seat that claimed its lane should never be warned or blocked.
 *   - **Doesn't own it, `warn`** → allow with the advisory (`warned`) — ADR 083 default preserved.
 *   - **Doesn't own it, `block`** → deny with a repair string that names the reality: another seat's
 *     lane already covers it ("owned by X — coordinate / take a different surface"), or nothing does
 *     ("claim one first"). Claiming becomes the only path to the edit — the forcing function.
 * `req.target` arrives repo-relative (the hook normalizes it) so it compares against lane globs, which
 * are repo-relative by convention.
 */
export async function gateA(ctx: GateContext): Promise<GateDecision> {
  const { db } = ctx.srv;
  const { id: teamId, slug } = ctx.team;
  const path = ctx.req.target;
  const cls = ctx.req.class;

  const owned = await laneCoveringPath(db, teamId, slug, path, { owner: ctx.member.name });
  if (owned) {
    // ADR 691: a lane that NAMES this file holds it for its tenure, first claim first. Covering it
    // through an area glob, or naming it later, is not enough while another seat's named claim is
    // in flight — that is the collision the overlap warning only ever reported (finding 015).
    const holder = await laneHoldingFile(db, teamId, slug, path, owned.project);
    if (holder && holder.owner_seat !== ctx.member.name) {
      const since = holder.claimed_at ? new Date(holder.claimed_at).toISOString() : 'its claim';
      // ADR 693: an agent holder that has left — no live session, past its reclaim grace — no
      // longer holds the file against a seat that is here. The lane stays theirs on the board; the
      // edit proceeds with the advisory naming them, under either posture. A human's hold stands:
      // a person's presence is not a reliable sign they are still working.
      const holderSeat = await getMemberByName(db, teamId, holder.owner_seat!);
      if (
        holderSeat?.kind === 'agent' &&
        !(await isPresentOrReclaimable(db, holderSeat.id, ctx.srv.config.presenceTimeoutMs))
      ) {
        return {
          decision: 'allow',
          outcome: 'warned',
          reason:
            `heads-up: '${path}' was held by ${holder.owner_seat} (lane "${holder.title}", since ${since}), ` +
            `who has left — the hold has lapsed (ADR 693). Their lane is still on the board: tell them ` +
            `what you changed in it.`,
        };
      }
      const detail =
        `'${path}' is held by ${holder.owner_seat} (lane "${holder.title}", named it first, since ${since}) — ` +
        `ask them to hand it off or narrow their lane, wait for that lane to finish, or split the ` +
        `work by handoff. Your lane "${owned.title}" covers it but does not hold it (ADR 691).`;
      if (ctx.req.posture === 'warn') {
        return { decision: 'allow', outcome: 'warned', reason: `heads-up: ${detail}` };
      }
      return { decision: 'deny', outcome: 'denied', reason: `blocked: ${detail}` };
    }
    return {
      decision: 'allow',
      outcome: 'allowed',
      reason: `owned: '${cls}' is covered by your lane "${owned.title}"`,
    };
  }

  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${cls}' is a declared contended surface and you have no claimed lane covering it — open one so the team can see this edit (lane_open "<what>" --surface ${path} --claim)`,
    };
  }

  // block: the forcing function. Name whether someone else holds it, or it's simply unclaimed.
  const otherLane = await laneCoveringPath(db, teamId, slug, path);
  const detail = otherLane
    ? `it is owned by ${otherLane.owner_seat ?? 'another seat'} (lane "${otherLane.title}") — coordinate with them, take a different surface, or hand off`
    : `no lane covers it — claim one first: lane_open "<what>" --surface ${path} --claim`;
  return {
    decision: 'deny',
    outcome: 'denied',
    reason: `blocked: '${cls}' is a declared contended surface you have not claimed a lane for. ${detail}`,
  };
}

/**
 * The denial's repair string — the agent's marching orders at the point of block. Parity with the ADR 147
 * ask contract an ask-raiser would get (the shared `askContractText`, so gate-blocked and self-raised
 * agents read the same thing), plus the two things the deny alone must add: **what the block is for**
 * (a human will review this consequential action) and **that routing around defeats it** — the finding-006
 * datum that agents met a blocked push by landing the change via a local merge, pricing the hold at zero.
 */
function blockingContractReason(cls: string, askId: string, unblockerReachable: boolean): string {
  return (
    `blocked pending human approval — '${cls}' is a declared costly action your team gated for human ` +
    `review; ask ${askId} raised (species:approve). ${askContractText(askId, ASK_TOP_TIER, unblockerReachable)} ` +
    `Re-try the action to re-check. Landing this another way — a local merge, a different command, an ` +
    `alternate path — bypasses the very review this block exists for; hold or hand the work off instead.`
  );
}

/** The ADR 153 reachability projection at the gate: the acting seat is the raiser, the daemon's presence
 *  timeout is the liveness window. A pure read of team + policy state — no timer, nothing stored. */
async function gateUnblockerReachable(ctx: GateContext): Promise<boolean> {
  return await unblockerReachable(
    ctx.srv.db,
    ctx.team.id,
    ctx.member.name,
    ctx.srv.config.presenceTimeoutMs,
  );
}

/** Raise the gate-ask through the acting seat's own credential (member-authed `routeEnvelope`): a
 *  top-tier `approve` ask carrying `meta.gate = { class, fingerprint }` so re-attempts converge (dedup
 *  reads it back) and a gate-emitted ask is distinguishable from an agent-authored one. Returns the ask
 *  id. Reuses the one validate→persist→deliver path, so admin push (ADR 147), Slack (ADR 149), and the
 *  `ask.raised` lifecycle row all fall out for free — the deny IS the emission. */
async function emitGateAsk(ctx: GateContext): Promise<string> {
  const { srv, team, member, req } = ctx;
  const id = ulid();
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: member.name,
    to: { kind: 'team' },
    act: 'ask',
    body: `Approval needed for costly action '${req.class}': ${req.target}`,
    meta: {
      species: 'approve' satisfies AskSpecies,
      tier: ASK_TOP_TIER,
      gate: { class: req.class, fingerprint: req.fingerprint },
    },
  });
  await routeEnvelope(srv, team, member, env, undefined, true);
  return id;
}

/**
 * Gate B — policy-classed action→ask (ADR 150). The block path is **deny IS emit**: a denied costly
 * action routes itself through the ADR 147 ask stream, so the ask exists whether or not the agent would
 * have raised one. The gate keeps ADR 147's clock discipline — no daemon timer, no hook timer; each
 * re-attempt of the action re-runs this decision:
 *   - **warn** → allow with an advisory (`warned`), no ask — an approval nobody requested is noise.
 *   - **block, first attempt for this fingerprint** → emit the ask, deny (`denied_ask_raised`).
 *   - **block, re-attempt, human accepted** → allow (`released`), standing per-fingerprint.
 *   - **block, re-attempt, human declined** → deny (`denied_declined`) — do not re-raise.
 *   - **block, re-attempt, still unanswered** → deny (`denied_awaiting`), contract restated, no 2nd ask.
 * Release requires a **human** accept (ADR 150 defers admin-only release to `multi-human-admin`).
 */
export async function gateB(ctx: GateContext): Promise<GateDecision> {
  if (ctx.req.posture === 'warn') {
    return {
      decision: 'allow',
      outcome: 'warned',
      reason: `heads-up: '${ctx.req.class}' is a declared costly action — raise an ask (species:approve) before it when it's irreversible`,
    };
  }

  const { db } = ctx.srv;
  const existing = await findGateAsk(db, ctx.team.id, ctx.req.fingerprint);
  if (existing) {
    // Re-attempt of an already-raised action: re-check the ask thread rather than raise a second ask.
    const answer = await gateAskHumanAnswer(db, ctx.team.id, existing.id);
    if (answer?.act === 'accept') {
      return {
        decision: 'allow',
        outcome: 'released',
        reason: `'${ctx.req.class}' approved by ${answer.by} — proceeding (ask ${existing.id})`,
        ask_ref: existing.id,
      };
    }
    if (answer?.act === 'decline') {
      return {
        decision: 'deny',
        outcome: 'denied_declined',
        reason: `'${ctx.req.class}' declined by ${answer.by} — do not re-raise; take a different approach or hand off (ask ${existing.id})`,
        ask_ref: existing.id,
      };
    }
    // Still open, unanswered — restate the contract, do NOT emit another ask. Reachability is
    // re-computed here (ADR 153 §1: re-checkable at the terminal moment), so a hold whose unblocker
    // has since left reads strand orders on the next re-attempt.
    return {
      decision: 'deny',
      outcome: 'denied_awaiting',
      reason: blockingContractReason(ctx.req.class, existing.id, await gateUnblockerReachable(ctx)),
      ask_ref: existing.id,
    };
  }

  // First attempt for this fingerprint — emit the ask, then deny with the blocking contract. The
  // contract carries the reachability-gated terminal (ADR 153): a headless solo seat is told to STRAND
  // (release the lane with WIP, never proceed) instead of holding a room that will never answer — the
  // FB3 fix. Either branch is non-proceed; the wedge-guard is untouched.
  const askId = await emitGateAsk(ctx);
  return {
    decision: 'deny',
    outcome: 'denied_ask_raised',
    reason: blockingContractReason(ctx.req.class, askId, await gateUnblockerReachable(ctx)),
    ask_ref: askId,
  };
}

/**
 * Adjudicate a matched tool call and record the decision. Writes exactly one `lane.gate` / `action.gate`
 * audit row — **shapes only**: `target` is the legible class name (never the raw path/command), `detail`
 * carries class + fingerprint + posture + tool + outcome. The raw `req.target` is used solely to make the
 * decision (and, for a future Gate B, to fill an ask body) and is never persisted to audit.
 */
export async function adjudicateGate(
  srv: Ctx,
  team: TeamRow,
  member: MemberRow,
  req: GateCheckRequest,
): Promise<GateDecision> {
  const ctx: GateContext = { srv, team, member, req };
  const route = req.kind === 'role-route' ? await gateRoute(ctx) : undefined;
  const decision = route
    ? route.decision
    : req.kind === 'contended-surface'
      ? await gateA(ctx)
      : await gateB(ctx);
  const action = req.kind === 'contended-surface' ? 'lane.gate' : 'action.gate';
  await appendAudit(srv.db, team.id, {
    actor: member.name,
    action,
    target: req.class,
    result: decision.decision === 'allow' ? 'allow' : 'deny',
    detail: {
      class: req.class,
      fingerprint: req.fingerprint,
      posture: req.posture,
      tool: req.tool,
      outcome: decision.outcome,
      ...(decision.ask_ref ? { ask_ref: decision.ask_ref } : {}),
      // ADR 513: which role the route needed, so the warn→redirect join can read it per role.
      ...(route ? { kind: 'role-route', role: route.role } : {}),
    },
  });
  return decision;
}

/**
 * ADR 513 — a role-gated route. A command only the holders of a roster role may run: the courier's
 * Taildrop is the first (2026-10-04). The role and the posture are read from the team's STORED
 * policy by class name, never from the request, so a client cannot widen its own grant or soften a
 * `block` to `warn`. A class the policy no longer declares is allowed (the client matched a stale
 * table; an undeclared call passes, ADR 150). Humans are the operators this gate serves and pass,
 * as at the ADR 227 infra gate. A holder passes quietly. Anyone else is warned or denied by the
 * class's posture, and the reason names the holders and the ask that reaches them.
 */
async function gateRoute(ctx: GateContext): Promise<{ decision: GateDecision; role: string }> {
  const { db } = ctx.srv;
  const cls = (await getPolicy(db, ctx.team.id)).enforcement.classes.find(
    (c) => c.class === ctx.req.class && c.kind === 'role-route',
  );
  const role = cls?.role;
  if (!cls || role === undefined)
    return {
      role: role ?? '',
      decision: {
        decision: 'allow',
        outcome: 'allowed',
        reason: `'${ctx.req.class}' is no longer a declared route`,
      },
    };
  const slug = ctx.team.slug;
  if (ctx.member.kind === 'human' || toMember(ctx.member, slug).roles.includes(role))
    return {
      role,
      decision: { decision: 'allow', outcome: 'allowed', reason: `you hold ${role}` },
    };
  const holders = (await listMembers(db, ctx.team.id))
    .filter((m) => m.left_at === null && m.observer !== 1)
    .filter((m) => toMember(m, slug).roles.includes(role))
    .map((m) => m.name)
    .sort();
  const who = holders.length
    ? `${holders.join(', ')} ${holders.length === 1 ? 'holds' : 'hold'} ${role}`
    : `no seat holds ${role} yet — ask a human to assign it`;
  const skill = await getRoleSkill(db, ctx.team.id, role);
  const ask = holders.length
    ? ` Send request_help to ${holders.length === 1 ? holders[0] : 'one of them'} naming what, from, to and why (.agents/skills/${skill}/SKILL.md).`
    : '';
  if (cls.posture === 'warn')
    return {
      role,
      decision: {
        decision: 'allow',
        outcome: 'warned',
        reason: `heads-up: '${cls.class}' is a ${role} route and you do not hold ${role}. ${who}.${ask}`,
      },
    };
  return {
    role,
    decision: {
      decision: 'deny',
      outcome: 'denied',
      reason:
        `blocked: '${cls.class}' is a ${role} route and you do not hold ${role}. ${who}.${ask} ` +
        `Running it another way — a different command, a copy through a public carrier — defeats the ` +
        `reason this route is gated; hand it to the holder instead.`,
    },
  };
}

/**
 * Record an actor attestation (ADR 163). **Not a gate** — it returns nothing, decides nothing, and
 * records `result: 'allow'`, because an observer that could deny would be back under the ADR 150
 * declared-class boundary in full. One row per call; the hook only sends write-shaped subagent calls and
 * spawns, so reads never reach here. The one `deny` row is `session-denied` (ADR 442): it records a
 * refusal the client already made, and still decides nothing here.
 *
 * **What is persisted, and why the split.** A path-shaped target (`src/x.ts`) is stored in the clear:
 * lane `scope` globs already hold plain repo-relative paths, so a path is not the sensitive class, and
 * "which surfaces do subagents write to" is the question the ledger exists to answer. A `Bash` command is
 * NOT stored — command text is exactly what ADR 051 protects (it can carry tokens, URLs, secrets), and
 * ADR 150's gate rows already refuse it. Commands are reduced to a sha256 fingerprint, which still
 * de-duplicates repeat attempts without retaining the text. ADR 163 §Mechanism says "target" loosely;
 * this is the careful reading of it.
 */
export async function recordActorAttestation(
  srv: Ctx,
  team: TeamRow,
  member: MemberRow,
  att: ActorAttestation,
): Promise<void> {
  // ADR 442 (the wall) — the gate refused a session-reaching tool. The one attestation that records a
  // `deny`: the refusal itself happened client-side, before any round trip (a daemon outage cannot open
  // it), so this row is its only durable trace. Tool and harness only — no body, target or session id.
  if (att.kind === 'session-denied') {
    await appendAudit(srv.db, team.id, {
      actor: member.name,
      action: 'gate.session_denied',
      target: null,
      result: 'deny',
      detail: { tool: att.tool, ...(att.harness ? { harness: att.harness } : {}) },
    });
    return;
  }
  // ADR 674 (Cloud 4 hooks against a remote server) — the local counter of calls that proceeded
  // `unenforced` while the server was down, flushed as one audit row when the server returns.
  if (att.kind === 'unenforced') {
    await appendAudit(srv.db, team.id, {
      actor: member.name,
      action: 'gate.unenforced',
      target: null,
      result: 'allow',
      detail: {
        count: att.count ?? 1,
        tool: att.tool,
        ...(att.since_ts !== undefined ? { since_ts: att.since_ts } : {}),
        ...(att.until_ts !== undefined ? { until_ts: att.until_ts } : {}),
      },
    });
    return;
  }
  // ADR 167 — a seat used the harness's session-to-session send. Everything sensitive was reduced to
  // sha256-16 client-side (body AND target session id — stricter than the Bash split below, because a
  // session message is another agent's incoming context and a session id is contractually
  // machine-local), so this row records exactly what arrived and nothing needed redacting here.
  // ADR 442 retired increment 2's confirmation loop with the relay: nothing is a sanctioned relay any
  // more, so a `nudgeRef` is recorded as observed and never resolved.
  if (att.kind === 'session-message') {
    await appendAudit(srv.db, team.id, {
      actor: member.name,
      action: 'actor.session_message',
      target: null,
      result: 'allow',
      detail: {
        tool: att.tool,
        ...(att.bodyFingerprint ? { body_fingerprint: att.bodyFingerprint } : {}),
        ...(att.sessionRef ? { session_ref: att.sessionRef } : {}),
        ...(att.nudgeRef ? { nudge_ref: att.nudgeRef } : {}),
      },
    });
    return;
  }
  const isSpawn = att.kind === 'subagent-spawn';
  await appendAudit(srv.db, team.id, {
    actor: member.name,
    action: isSpawn ? 'actor.subagent_spawn' : 'actor.subagent_write',
    target: att.actorType ?? att.spawnType ?? null,
    result: 'allow',
    detail: {
      tool: att.tool,
      ...(att.actorId ? { actor_id: att.actorId } : {}),
      ...(att.actorType ? { actor_type: att.actorType } : {}),
      ...(att.spawnType ? { spawn_type: att.spawnType } : {}),
      ...(att.spawnModel ? { spawn_model: att.spawnModel } : {}),
      // Path in the clear; command as a fingerprint only (see the doc comment above).
      ...(att.target === undefined
        ? {}
        : att.tool === 'Bash'
          ? {
              command_fingerprint: createHash('sha256')
                .update(att.target)
                .digest('hex')
                .slice(0, 16),
            }
          : { target: att.target }),
    },
  });
}

/** ADR 611. What one wake poll found when the 7-day priced total is at or over the cap. */
export interface SpendCapBreach {
  capUsd: number;
  totalUsd: number;
  windowDays: number;
}

/**
 * ADR 611. Null when the cap is unset, the priced total is null, or the total is under the cap.
 * Equality is over. A throw is a failed read: log it and let the poll proceed.
 */
export async function readSpendCapBreach(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<SpendCapBreach | null> {
  try {
    const cap = spendCapUsd(await getPolicy(db, teamId));
    if (cap === null) return null;
    const total = await pricedWakeCostUsd(db, teamId, now);
    if (total === null || total < cap) return null;
    return { capUsd: cap, totalUsd: total, windowDays: WAKE_WINDOW_DAYS };
  } catch (err) {
    log.warn({
      msg: 'spend cap read failed open',
      team: teamId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** ADR 641. What one wake poll found when the 7-day unpriced count is at or over the cap. */
export interface UnpricedWakeBreach {
  cap: number;
  count: number;
  windowDays: number;
}

/**
 * ADR 641. Null when the cap is unset or the count is under the cap. Equality is over, including
 * a cap of 0 with a count of 0. A throw is a failed read: log it and let the poll proceed.
 */
export async function readUnpricedWakeBreach(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<UnpricedWakeBreach | null> {
  try {
    const cap = unpricedWakeCap(await getPolicy(db, teamId));
    if (cap === null) return null;
    const count = await unpricedWakeCount(db, teamId, now);
    if (count < cap) return null;
    return { cap, count, windowDays: WAKE_WINDOW_DAYS };
  } catch (err) {
    log.warn({
      msg: 'unpriced wake cap read failed open',
      team: teamId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
