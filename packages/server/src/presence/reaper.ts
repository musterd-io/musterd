import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { flushLapsedHolds } from '../notify/doorbell.js';
import { sweepReapedAcceptances } from '../protocol/laneReroute.js';
import { announceIncidentRouted, retryPendingHumanAsks } from '../protocol/route.js';
import { appendAudit } from '../store/audit.js';
import { pruneRings } from '../store/doorbell.js';
import { routeUnclaimedIncidents } from '../store/incidents.js';
import { releaseDepartedSeatClaims } from '../store/lanes.js';
import { sweepAbandonedAcceptance } from '../store/laneSweep.js';
import { getMemberById, reapExcessIdleObservers, reapStaleObservers } from '../store/members.js';
import { hasLivePresence, reapStale } from '../store/presence.js';
import { expireRequests } from '../store/requests.js';
import type { RequestRow } from '../store/requests.js';
import {
  HOST_SUSPEND_GAP_MS,
  WAKE_UNREACHABLE_CEILING_MS,
  awakeMsSince,
  expireWakeLeases,
  firstWakeLeaseTs,
  leaseCapturedSession,
  listResidencyTeamIds,
  wakeExhaustionKey,
} from '../store/residency.js';
import { getPolicy, getTeamById, getTeamBySlug, listActiveTeams } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';

/** Periodically remove stale presence rows and emit offline events for members who lost all presence. */
export function startReaper(ctx: Ctx): () => void {
  const tick = reaperTick(ctx);
  // One tick at a time: an async tick can straddle the next interval (a slow sweep, a queue wait),
  // and two overlapping ticks would each act on the same rows (review I2, 2026-09-30).
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    // A failed tick is logged and the next one runs: on Postgres any store call can reject, and an
    // unhandled rejection from this loop exited the server (lane 01M3ZC3EXN).
    void tick()
      .catch((err: unknown) => log.warn({ msg: 'reaper_tick_failed', err: String(err) }))
      .finally(() => {
        running = false;
      });
  }, ctx.config.reaperIntervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

/**
 * One reaper pass, with the loop's continuity clocks closed over. Exported so a test can run a
 * single tick against the ctx the daemon hands the loop (spec §12.1: the OPERATOR ctx — a reaper
 * that saw one team's rows would "succeed" at reaping nothing).
 */
export function reaperTick(ctx: Ctx): () => Promise<void> {
  // ADR 236: this loop is its own reachability probe. `lastTickAt` is when it last ran and
  // `continuousSince` is the start of its current unbroken run — initialised to boot, because before
  // that the loop was not running either (a restart is an absence like any other). A lease that was
  // outstanding across a break in that run tells us nothing about the host: nothing was there.
  let lastTickAt = Date.now();
  let continuousSince = lastTickAt;
  // Presence keeps its own continuity clock. It is the same argument as `continuousSince` but at a
  // different scale: the wake ledger asks "was the HOST there?" (90 s discriminates a suspend from
  // jitter), while presence asks "were WE there to hear a 45 s heartbeat?" — and this loop shares an
  // event loop with the sockets it judges, so any gap as long as the timeout itself already means
  // no row could have been heard. Both start at boot, because before that neither was running.
  let presenceWatchedSince = lastTickAt;

  const tick = async () => {
    const now = Date.now();

    const tickGap = now - lastTickAt;
    lastTickAt = now;
    if (tickGap >= ctx.config.presenceTimeoutMs) presenceWatchedSince = now;
    if (tickGap >= HOST_SUSPEND_GAP_MS) {
      continuousSince = now;
      for (const teamId of await listResidencyTeamIds(ctx.db)) {
        await appendAudit(ctx.db, teamId, {
          actor: null,
          action: 'residency.host_suspended',
          target: 'daemon',
          result: 'allow',
          detail: { gap_ms: tickGap, from: now - tickGap, to: now },
        });
      }
      log.info({ msg: 'reap_host_suspended', gap_ms: tickGap });
    }

    // P3.2: expire claim requests past their deadline (ADR 077 spec-gap 3). Fetch pending+expired
    // rows BEFORE updating so we have from_session connIds to push refused frames.
    const expiredRows = await ctx.db.all<RequestRow>(
      "SELECT * FROM requests WHERE status = 'pending' AND expires_at < ?",
      [now],
    );
    if (expiredRows.length > 0) {
      await expireRequests(ctx.db, now);
      for (const row of expiredRows) {
        ctx.hub.deliverClaimDecision(row.from_session, {
          type: 'refused',
          code: 'expired_grant',
          message: 'your claim request expired — please re-claim',
          claimable: [],
          hint: 'musterd claim <seat> --key <mskey_...>',
        });
        await appendAudit(ctx.db, row.team_id, {
          actor: null,
          action: 'request.expired',
          target: row.target,
          result: 'deny',
          detail: { request_id: row.id },
        });
      }
      log.info({ msg: 'reap_requests_expired', count: expiredRows.length });
    }

    // ADR 131: expire wake leases the host never reported (a crash mid-spawn, a hung headless
    // harness past the watchdog). Such an expiry writes `residency.wake_failed` so the attempt still
    // consumes rate budget — a host that dies mid-spawn can never retry forever — and the wake
    // re-becomes due on the next poll, bounded by the derived cooldown/caps.
    //
    // ADR 236: but the same expiry also happens when the machine simply slept, and that carries no
    // information about the act — so it burns nothing. `continuousSince` above answers which:
    // a lease created before this loop's current unbroken run was outstanding while we were not
    // running, so no host could have been asked. That defers (`wake_deferred`, budget-neutral by
    // construction, ADR 221's verb) — bounded by HOST-AWAKE time since the act was first leased, so
    // "retires nine hours early" cannot quietly become "never retires".
    const expiredLeases = await expireWakeLeases(ctx.db, now);
    for (const lease of expiredLeases) {
      const seat = await getMemberById(ctx.db, lease.member_id);
      const act = wakeExhaustionKey(lease.act_id, lease.lane_id);
      const detail = {
        act,
        lease_id: lease.id,
        lane: lease.lane,
        ...(lease.lane_id ? { lane_id: lease.lane_id } : {}),
        ...(lease.edge ? { edge: lease.edge } : {}),
      };
      const unreachable = lease.created_at < continuousSince;
      // The ceiling's clock starts at the act's FIRST lease, not this one — three attempts spread
      // across three sleeps must not each restart the bound.
      const clockFrom = (await firstWakeLeaseTs(ctx.db, lease.team_id, act)) ?? lease.created_at;
      const awakeMs = unreachable ? await awakeMsSince(ctx.db, lease.team_id, clockFrom, now) : 0;
      if (unreachable && awakeMs < WAKE_UNREACHABLE_CEILING_MS) {
        await appendAudit(ctx.db, lease.team_id, {
          actor: null,
          action: 'residency.wake_deferred',
          target: seat?.name ?? '?',
          result: 'allow',
          detail: { ...detail, reason: 'host_unreachable', awake_ms: awakeMs },
        });
        continue;
      }
      // ADR 252: an expired lease is not automatically a wake that cost nothing. If a session
      // attested THIS lease id, the wake spawned a real, paid session that then died without ever
      // reporting — `residency.wake_cost` exists only on the report path, so that spend is
      // otherwise invisible. Stamp the fact, not a number: no cost source exists here, and
      // inventing one would be worse than recording the spend as unpriced.
      const paidSession = await leaseCapturedSession(ctx.db, lease.team_id, lease.id);
      await appendAudit(ctx.db, lease.team_id, {
        actor: null,
        action: 'residency.wake_failed',
        target: seat?.name ?? '?',
        result: 'deny',
        detail: {
          ...detail,
          reason: 'lease_expired',
          ...(paidSession ? { session_captured: true } : {}),
        },
      });
    }
    if (expiredLeases.length > 0) {
      log.info({ msg: 'reap_wake_leases_expired', count: expiredLeases.length });
    }

    // ADR 443 §4: a doorbell hold lapses by its `until` with no availability POST to flush it, so
    // the tick flushes on its behalf (dolly's review, change b). A still-holding ring is skipped.
    await flushLapsedHolds(ctx, (id) => getTeamById(ctx.db, id));
    const prunedRings = await pruneRings(ctx.db, now);
    if (prunedRings > 0) log.info({ msg: 'reap_doorbell_rings', count: prunedRings });

    // The sweeps below decide things about the WHOLE team: which seat is gone, which incident lane
    // nobody claimed, which acceptance was abandoned. Those are the hub's decisions (ADR 361 §1,
    // ADR 371 §2); an enrolled joiner holds only a replica of the team — partial mid-drain, stale
    // after a sleep, blind to every seat that lives on another machine — and converges on the hub's
    // own decisions through the pull. Making them anyway writes hub-owned lane state from that
    // replica and sends messages AS seats bound to the hub, which the hub refuses `bound_elsewhere`
    // for good: every later push from the machine wedges behind the first one (second-machine
    // run, 2026-10-02). So an enrolled joiner skips them, team by team — one daemon can be a hub
    // for one team and a joiner of another.
    const activeTeams = await listActiveTeams(ctx.db);
    const joinerTeams = new Set<string>();
    for (const team of activeTeams) {
      if (await joinerEnrollment(ctx.db, team.id, team.slug)) joinerTeams.add(team.id);
    }

    // ADR 196: release in-flight lanes still owned by soft-removed seats (pre-fix ghosts + any
    // leave path that skipped the store composition).
    const releasedClaims = await releaseDepartedSeatClaims(ctx.db, now, joinerTeams);
    if (releasedClaims.length > 0) {
      log.info({ msg: 'reap_departed_claims', count: releasedClaims.length });
    }

    // ADR 271 (incident spec §3): close the claim window on any incident nobody picked up, handing
    // it to the fallback role. Deliberately NOT behind `loops.sweep` — that switch arms a loop that
    // CLOSES other people's lanes, and this one only puts a name on a lane already open and visible.
    // Its own `incident.enabled` is the switch, and it defaults on because increment 1 already does.
    for (const team of activeTeams) {
      if (joinerTeams.has(team.id)) continue;
      for (const { lane, owner } of await routeUnclaimedIncidents(
        ctx.db,
        team.id,
        team.slug,
        now,
      )) {
        log.info({ msg: 'incident_routed', team: team.slug, lane: lane.id, owner });
        // Assigning without telling anyone would make this a board-only fact — the seat would find
        // its new lane by luck. Best-effort: the assignment is already durable, and a delivery
        // failure must not roll it back or stop the rest of the sweep.
        try {
          // listActiveTeams returns {id, slug} only; routing needs the full row.
          const teamRow = await getTeamBySlug(ctx.db, team.slug);
          if (teamRow) {
            await announceIncidentRouted(ctx, teamRow, lane, owner, now - lane.created_at);
          }
        } catch (err) {
          log.warn({ msg: 'incident_route_announce_failed', lane: lane.id, err: String(err) });
        }
      }
    }

    // Lane 01M2RQ8W0RR838P2KW3SP6SYGV: an acceptance whose reviewer was REAPED has no goodbye for
    // ADR 412 to hear, so the reaper notices on its behalf. Ungated, unlike the ADR 229 backstop
    // below: this never closes a lane and never invents a verdict, it only moves an ask to a seat
    // that is actually there. Runs BEFORE the backstop so a lane gets a live reviewer offered
    // before it can be closed unreviewed on a team that armed the sweep. Gated on the same listening
    // window as `reapStale` below (lane 01M4BJX7JJ): "the holder is gone" is a judgement of silence.
    for (const team of activeTeams) {
      if (joinerTeams.has(team.id)) continue;
      for (const lane of await sweepReapedAcceptances(ctx, team, presenceWatchedSince, now)) {
        log.info({ msg: 'reroute_reaped_acceptance', team: team.slug, lane });
      }
    }

    // ADR 539: a risky lane whose peer confirmed while no human was live is owed a human ask the
    // moment one comes live. Hub only (the ask is composed FROM the lane owner, who may be bound to
    // the hub); never closes anything. Runs before the backstop for the same reason the reroute does.
    for (const team of activeTeams) {
      if (joinerTeams.has(team.id)) continue;
      const teamRow = await getTeamBySlug(ctx.db, team.slug);
      if (!teamRow) continue;
      try {
        for (const { lane, human } of await retryPendingHumanAsks(ctx, teamRow)) {
          log.info({ msg: 'retry_human_stage_ask', team: team.slug, lane, human });
        }
      } catch (err) {
        log.warn({ msg: 'retry_human_stage_ask_failed', team: team.slug, err: String(err) });
      }
    }

    // ADR 229: the acceptance backstop. A lane past the grace in `awaiting_acceptance` has no actor
    // left to close it — the ADR 217 reasons label a close, they never cause one. Per team, and only
    // where an admin armed `loops.sweep`; every team is bit-identical to pre-229 until they do.
    for (const team of activeTeams) {
      if (joinerTeams.has(team.id)) continue;
      if ((await getPolicy(ctx.db, team.id)).loops?.sweep !== true) continue;
      const swept = await sweepAbandonedAcceptance(ctx.db, team.id, team.slug, now);
      for (const lane of swept) {
        log.info({
          msg: 'sweep_abandoned_acceptance',
          team: team.slug,
          lane: lane.id,
          owner: lane.owner_seat,
          waited_hours: Math.round(lane.waited_ms / 3_600_000),
        });
      }
    }

    // Reap idle observer seats (ADR 064) so the auto-provisioned `web-xxxx` seats don't accumulate.
    const reapedObservers = await reapStaleObservers(
      ctx.db,
      now - ctx.config.observerTtlMs,
      now - ctx.config.presenceTimeoutMs,
    );
    if (reapedObservers.length > 0) {
      log.info({ msg: 'reap_observers', count: reapedObservers.length });
    }

    // ADR 196: concurrent idle-observer cap — TTL is the long-stop; the cap bounds peak churn.
    const reapedExcess = await reapExcessIdleObservers(
      ctx.db,
      ctx.config.observerIdleCap,
      now - ctx.config.presenceTimeoutMs,
    );
    if (reapedExcess.length > 0) {
      log.info({ msg: 'reap_observers_excess', count: reapedExcess.length });
    }

    // Gated the same way the wake ledger is gated above: a row cannot be called silent over a
    // window in which nothing was listening for it.
    // `now` is this tick's clock, deliberately: a tick that blocks past the timeout inside its own
    // body must not judge by the time it finishes (see reapStale).
    const removed = await reapStale(
      ctx.db,
      ctx.config.presenceTimeoutMs,
      presenceWatchedSince,
      now,
    );
    if (removed.length === 0) return;
    const seen = new Set<string>();
    for (const row of removed) {
      if (seen.has(row.member_id)) continue;
      seen.add(row.member_id);
      // A pure grace-hold expiring is not a state change: the member already went offline when its
      // connection dropped. Only a stale *live* row (a zombie that never released) reverts to offline.
      if (row.held_until !== null) continue;
      if (await hasLivePresence(ctx.db, row.member_id, ctx.config.presenceTimeoutMs)) continue;
      const member = await getMemberById(ctx.db, row.member_id);
      if (!member) continue;
      ctx.hub.broadcastTeam(member.team_id, {
        type: 'presence',
        member: member.name,
        status: 'offline',
      });
      log.info({ msg: 'reap_offline', member: member.name });
    }
  };
  return tick;
}
