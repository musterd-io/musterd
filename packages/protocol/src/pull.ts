import { z } from 'zod';

/**
 * ADR 645 — the band-2 pull: a host with room asks the hub for one pre-registered lane one of its
 * enrolled seats may take; the host's service seat announces it to the lane's opener as an
 * advisory ask; the hub watches the window; on silence the host claims the lane AS the seat with a
 * `pulled` pick (`PickSchema.via: 'pull'`). This module is the policy keys and the wire shapes;
 * `pullEligible` (lanes.ts) is what a pull may offer.
 */

/** Team policy `pull` (ADR 645 §4, §5, §8). `parse({})` yields the shipped defaults. */
export const PullPolicySchema = z.object({
  /**
   * The announcement window for an advisory ask (spec §7: 3 min — the work is redo-able by
   * declaration, so the moment is light). A lane whose `expected_spend` is over `spend_cap_usd`
   * is announced as a standard ask instead, and waits `standard_window_ms`.
   */
  window_ms: z.number().int().min(60_000).max(3_600_000).default(180_000),
  standard_window_ms: z.number().int().min(60_000).max(3_600_000).default(300_000),
  /** USD. A declared `expected_spend` over this is announced standard, not advisory. `0` = only
   *  unmetered work is announced advisory. */
  spend_cap_usd: z.number().min(0).max(100_000).default(0),
  /** Pulls a seat may be offered per calendar day (§8, default 4). */
  daily_cap_per_seat: z.number().int().min(1).max(100).default(4),
  /** Expired wake leases on a pulled lane before the hub releases it (§5, default 3). */
  release_after_expiries: z.number().int().min(1).max(50).default(3),
  /** Host absence before the hub releases a pulled lane (§5, default 2 h). */
  release_after_ms: z
    .number()
    .int()
    .min(300_000)
    .max(7 * 24 * 3_600_000)
    .default(2 * 3_600_000),
});
export type PullPolicy = z.infer<typeof PullPolicySchema>;

/**
 * The announcement row's life (ADR 645 §4 and §6 — one row, transitioned atomically, so N daemons
 * on one database cannot both own a window):
 * - `announced`: the ask went out; the hub is watching the window.
 * - `granted`: the window lapsed in silence with the lane unchanged; the host may claim now.
 * - `claimed`: the seat's own claim landed (`lane.pulled` names this row's ask).
 * - `declined`: stopped inside the window, or the grant was never redeemed (`reason` says which).
 */
export const PULL_STATES = ['announced', 'granted', 'claimed', 'declined'] as const;
export type PullState = (typeof PULL_STATES)[number];

export const PullAnnouncementSchema = z.object({
  id: z.string(),
  lane: z.string(),
  seat: z.string(),
  host: z.string(),
  /** The announcement act's id — what `pick.ask` and `lane.pulled` name. */
  ask: z.string(),
  /** Which seat voiced the announcement (the host's service seat, ADR 232). */
  announced_by: z.string(),
  tier: z.enum(['advisory', 'standard']),
  state: z.enum(PULL_STATES),
  announced_at: z.number().int(),
  /** When the window closes — `announced_at + window`. */
  window_ends_at: z.number().int(),
  decided_at: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type PullAnnouncement = z.infer<typeof PullAnnouncementSchema>;

/** `POST /teams/:slug/residency/pull` — the host's band-2 poll, agent-key auth like wake-leases. */
export const PullPollBodySchema = z.object({
  host: z.string().min(1).max(200),
});
export type PullPollBody = z.infer<typeof PullPollBodySchema>;

/**
 * The poll's answer: the one announcement in flight for this host (one per host, §8), or null
 * when there is nothing to offer — no eligible lane, every seat capped, or the hub unreachable
 * from a joiner. A `granted` row is the host's cue to claim as the seat.
 */
export const PullPollResponseSchema = z.object({
  offer: PullAnnouncementSchema.nullable(),
  /** Why nothing was offered, for the host log; absent when `offer` is set. */
  idle_reason: z.string().optional(),
});
export type PullPollResponse = z.infer<typeof PullPollResponseSchema>;

/** A grant the host could not redeem (the seat's credential refused, the workspace gone). */
export const PullGrantReportBodySchema = z.object({
  announcement: z.string(),
  reason: z.string().min(1).max(500),
});
export type PullGrantReportBody = z.infer<typeof PullGrantReportBodySchema>;

/**
 * The hub-forwarded form of the poll (§6: a joiner forwards; one daemon decides). Node-credential
 * auth on `/sync/pull`; the body carries the host label the joiner polled with.
 */
export const SyncPullRequestSchema = PullPollBodySchema;
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;
