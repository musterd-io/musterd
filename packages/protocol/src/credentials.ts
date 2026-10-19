import { z } from 'zod';
import { ACCEPTANCE_REVIEW_WINDOW_MS } from './ask.wire.js';
import { DoorbellPolicySchema } from './doorbell.js';
import { EnforcementPolicySchema } from './enforcement.js';
import { GuardianTiersSchema } from './guardian.js';
import { IncidentPolicySchema } from './incident.js';
import { StakesDefaultSchema } from './lanes.js';
import { LoopsPolicySchema } from './loops.js';
import { PullPolicySchema } from './pull.js';
import { ResidencyPolicyOverrideSchema, ResidencyPolicySchema } from './residency.js';
import { StylePolicyOverrideSchema, StylePolicySchema } from './style.js';
import { TracePolicySchema } from './trace.js';

/**
 * Credential + team-policy contracts (SPEC A.2/A.6, ADR 069 P3 / ADR 076). Secrets are minted with a
 * typed prefix + `base64url(randomBytes)` and stored **only** as sha256 hashes (SPEC A.2: "Servers MUST
 * store only hashes"); the plaintext is returned exactly once at mint and never logged or re-fetchable.
 * These types are the shared vocabulary for the daemon (mints/validates), the CLI (ADR 075), and the MCP
 * adapter (ADR 069 decision 1).
 */

/** The token-prefix registry — one namespace per secret kind, so a secret's role is legible on sight. */
export const TOKEN_PREFIXES = {
  /** Per-seat token (the v0.2 holdover; removed at the P3.3 cutover). */
  seat: 'mskd_',
  /** Per-team agent key — what an agent harness presents to claim a seat. */
  agent_key: 'mskey_',
  /** A grant token — a pre-issued or admin-approved authorization to claim. */
  grant: 'msgr_',
  /** A human credential — what a person presents to authenticate. */
  credential: 'mscr_',
  /** Per-agent-seat credential — self-identifies one agent Member for routine HTTP authority (ADR 337). */
  agent_seat: 'msac_',
  /** Short-lived proof that an agent-seat credential currently holds a specific Presence (ADR 337). */
  session_lease: 'msls_',
  /**
   * A machine credential (ADR 328) — what an admitted daemon presents on the sync surface, and
   * nothing else. Deliberately not a seat credential: a machine being *admitted* and a seat being
   * *authorized* are independent axes, and collapsing them would make one laptop's compromise a
   * licence to mint teammates.
   */
  node: 'msnode_',
  /** A single-use, short-TTL enrollment code that mints exactly one `msnode_` (ADR 328 §2). */
  node_invite: 'msinv_',
  /** A one-shot governed model launch handoff (ADR 411). */
  governed_launch: 'msla_',
  /**
   * OAuth access token (ADR 446) — what a phone MCP app presents on `/mcp/:team`. Opaque, 1h
   * TTL, scoped to (team, member) at mint; authenticates exactly like an `mscr_` in
   * `authMember` (self-identifying, acting-seat must match-or-absent) with NO session lease.
   */
  oauth_access: 'msat_',
  /**
   * OAuth refresh token (ADR 446) — 30d TTL, single-use rotation; reuse of a burned refresh
   * revokes the whole chain (stolen-refresh detection).
   */
  oauth_refresh: 'msrt_',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** Return whether a value begins with any registered musterd credential namespace. */
export function isMusterdCredential(value: string): boolean {
  const normalized = value.toLowerCase();
  return Object.values(TOKEN_PREFIXES).some((prefix) => normalized.startsWith(prefix));
}

/** Any registered prefix, where a token can start: the value's start, or after a non-base64url char. */
const CREDENTIAL_ANYWHERE = new RegExp(
  `(?:^|[^A-Za-z0-9_-])(?:${Object.values(TOKEN_PREFIXES).join('|')})`,
  'i',
);

/**
 * Return whether a musterd credential appears ANYWHERE a token can start in `value` — its start,
 * or after any character outside the base64url alphabet (`?t=`, `&k=`, a space, a slash). A pasted
 * link can carry one in its query or fragment, where `isMusterdCredential` (a prefix test) never
 * looks (ADR 452 §1, big-body `01M3FAF83Z`). It does not fire inside a base64url run, so a random
 * nonce cannot trip it mid-string; nonce minting keeps its first characters off every prefix.
 */
export function containsMusterdCredential(value: string): boolean {
  return CREDENTIAL_ANYWHERE.test(value);
}

/** `POST /teams/:slug/agent-key/rotate` response — the new team agent key, shown **once**. */
export const AgentKeyMintSchema = z.object({ agent_key: z.string() });
export type AgentKeyMint = z.infer<typeof AgentKeyMintSchema>;

/** Exchange a legacy Team key for the seat scope independently proven by `msac_` (ADR 350). */
export const BootstrapMigrationRequestSchema = z
  .object({
    legacy_key: z.string().startsWith(TOKEN_PREFIXES.agent_key),
    seat_credential: z.string().startsWith(TOKEN_PREFIXES.agent_seat),
  })
  .strict();
export type BootstrapMigrationRequest = z.infer<typeof BootstrapMigrationRequestSchema>;

/** Administrator acknowledgement when disabling one Team's legacy compatibility authority. */
export const BootstrapCutoverRequestSchema = z
  .object({
    force: z.boolean().default(false),
  })
  .strict();
export type BootstrapCutoverRequest = z.infer<typeof BootstrapCutoverRequestSchema>;

/** A minted human credential, shown **once** (issued alongside a human seat). */
export const CredentialMintSchema = z.object({ credential: z.string() });
export type CredentialMint = z.infer<typeof CredentialMintSchema>;

/**
 * Team governance policy (SPEC A.6) — daemon-side knobs an admin sets. `allow_pre_issued_grants` lets a
 * session claim with a grant token **without** a pending-request round-trip (the fast path); when false,
 * every claim without a standing grant goes through the request/approval lane.
 */
/** `PolicySchema.agent_host` (ADR 463 §2) — named so sparsification can walk it like the other blocks. */
export const AgentHostPolicySchema = z.object({
  max_per_host: z.number().int().min(1).max(100).default(5),
  policy: ResidencyPolicyOverrideSchema.default({}),
});
export type AgentHostPolicy = z.infer<typeof AgentHostPolicySchema>;

/**
 * ADR 602. Fat-finger ceiling on a team spend cap, in USD. The cap is optional and has no default:
 * unset is unbounded. Zero is refused — a stored 0 would read as "deny every wake" to a reader that
 * treats the number as a bound. Cents are allowed; the field is not an integer.
 */
export const SPEND_CAP_USD_MAX = 1_000_000;

/**
 * ADR 639. Fat-finger ceiling on a team's unpriced-wake count. The key is optional and has no
 * default: unset keeps today's behavior. Zero is a real cap (block unpriced harnesses), so it is
 * inside the range. The count is an integer.
 */
export const UNPRICED_WAKE_CAP_MAX = 10_000;

export const PolicySchema = z.object({
  allow_pre_issued_grants: z.boolean().default(false),
  /**
   * Dogfood-mode re-seat (ADR 146, on the ADR 145 §7 decision). When true, an agent harness (team
   * agent key) re-claiming an **already-bound named agent seat** occupies immediately — a notification,
   * not an admin decision — because the seat-claim wall is a gate meant for *strangers* firing on
   * *teammates*. Brand-new (never-bound) seats and role-pool claims stay gated, so member admission is
   * still a real decision. The standing authorization is **derived** from `policy + bound_at`, not a
   * stored grant row (ADR 145's "verified-ness is derived, never a second stored flag" posture). Default
   * false — an opt-in the record demands for the dogfood team, off for every team that hasn't asked.
   */
  standing_reseat_known_agents: z.boolean().default(false),
  /**
   * The to-human ask stream's one configurable behavior (ADR 147 §6, on ADR 145 §3.1). When true, an ask
   * that admins leave unanswered past its tier timeout may fall back to non-admin humans on the same
   * timeout/risk machinery — the "configurable (never automatic)" fallback the founder named. Default
   * false: admin-only routing until a team opts in. The tier→timeout spectrum itself is a shipped default
   * (protocol `ASK_TIER_DEFAULTS`), not a knob — held to a default rather than made infinitely tunable.
   */
  ask_fallback_to_nonadmin: z.boolean().default(false),
  /**
   * Slack delivery for the ask stream (ADR 149, on ADR 145 §3.2 "deliver where the human already
   * lives"). A Slack *incoming-webhook* URL; when set, the daemon fires one fire-and-forget POST per
   * `ask` raised — the loud reach beside the guaranteed reach (message row + admin push, ADR 147 §3).
   * Unset (the default) = no outbound call ever. The URL is a secret: policy reads are admin-only,
   * `team export` never serializes policy, and the CLI display masks it to its host.
   *
   * Since ADR 443 this is read through as `doorbell.slack_url` (with `slack` in the doorbell
   * defaults) when that is unset — the stored blob is never rewritten.
   */
  ask_slack_webhook: z.string().url().optional(),
  /** The doorbell's team half (ADR 443): the sink allow-list, defaults, and team Slack/webhook
   *  URLs. `parse({})` configures no outbound URL. */
  doorbell: DoorbellPolicySchema.default({}),
  /**
   * Seeds ingest (ADR 248) — where the daemon pulls buffered raw ideas from, and the bearer token it
   * presents. Both set = the ingest loop polls `GET <url>/seeds?after=<cursor>` and opens one lane
   * per seed (open state, unowned, stakes normal — light cleanup only, never interpretation). Either
   * unset (the default) = no outbound call ever, the same posture as `ask_slack_webhook`. The token
   * is a secret with the same handling: policy reads are admin-only, `team export` never serializes
   * policy, and the CLI masks it on display.
   */
  seeds_relay_url: z.string().url().optional(),
  seeds_relay_token: z.string().optional(),
  /**
   * Away relay (ADR 659) — where the daemon dials out for channel deliveries, and the per-team
   * credential it presents (only its sha256 sits at the relay). Both set = the daemon holds one
   * WebSocket to `away_relay_url` per team; either unset (the default) = no outbound connection,
   * the same posture as `seeds_relay_*`. The token is a secret with the same handling: policy
   * reads are admin-only, `team export` never serializes policy, the CLI masks it on display.
   */
  away_relay_url: z.string().url().optional(),
  away_relay_token: z.string().optional(),
  /**
   * Slack adapter (ADR 668) — the bot token the daemon renders `chat.postMessage` deliveries
   * with, for the team's own workspace. Unset (the default) = no Slack channel delivery. The
   * Slack signing secret is deliberately NOT here: it lives only at the relay Worker, so a
   * daemon compromise cannot mint valid Slack callbacks. Same secret handling as
   * `away_relay_token`: admin-set, policy reads admin-only, never in `team export`, masked on
   * CLI display. Increment 9 (per-install tokens) retires this key with its own change.
   */
  slack_bot_token: z.string().optional(),
  /** Team-wide wake-policy defaults (ADR 131 increment 5) — per-seat enrollment overrides layer on
   *  top (`ResidencyPolicyOverrideSchema` in `residency.policy`). `parse({})` yields launch defaults. */
  residency: ResidencyPolicySchema.default({}),
  /**
   * Structural enforcement (ADR 150) — the opt-in PreToolUse gate declaration. A table of *classes* the
   * team marked consequential enough to gate at the tool boundary (contended surfaces → Gate A
   * lane-ownership; costly actions → Gate B action→ask). `parse({})` yields an **empty** table: no class
   * declared means every tool call passes untouched, so the out-of-box posture stays warn-never-block
   * (ADR 083). Not a secret — but, unlike the webhook, it carries no host, so it rides `team export` and
   * the audit `detail` freely. The declaration is admin-set through `POST /policy` (audited
   * `policy.change`); the hook reads it so the gate is consistent across a team's seats.
   */
  enforcement: EnforcementPolicySchema.default({}),
  /**
   * Board-triggered loop enables (ADR 179 / ADR 191). Each switch is independently installable;
   * `parse({})` yields every loop off. A wake fires only where the matching loop is on *and* the
   * target seat's residency `flow` is `auto`.
   */
  loops: LoopsPolicySchema.default({}),
  /** ADR 645: the band-2 pull — announcement window, spend cap, per-seat daily cap, release rule. */
  pull: PullPolicySchema.default({}),
  /**
   * Admin-set default stakes by surface (ADR 244) — the configurable half of "front-end changes
   * default to low". First match wins; a lane whose declared surfaces all fall under a rule opens at
   * that rule's stakes unless the worker declared their own, and records
   * `stakes_provenance: 'defaulted'` so the ADR 234 Eval can still tell policy from judgement.
   *
   * `parse({})` yields an EMPTY list: no rule means every lane opens exactly as it did before, so
   * this is inert until a team asks for it — the same opt-in posture as `enforcement` and `loops`.
   */
  stakes_defaults: z.array(StakesDefaultSchema).default([]),
  /**
   * Guardian autonomy tiers per incident class (2026-08-13 guardian spec §4) — sparse overrides;
   * absent classes read as the guardian's shipped defaults. `parse({})` yields an empty map: inert
   * until an admin flips a class, same opt-in posture as `enforcement`/`loops`/`stakes_defaults`.
   */
  guardian_tiers: GuardianTiersSchema.default({}),
  /**
   * Shared-blocker convergence (incident spec §5, ADR 268). Unlike every block above it, this one
   * is NOT inert on `parse({})` — increment 1 shipped clustering on for every team, so the default
   * reproduces it and `enabled: false` is the opt-out. The two wake knobs inside it are opt-in, for
   * the reasons on `IncidentPolicySchema`.
   */
  incident: IncidentPolicySchema.default({}),
  /**
   * Agent-trace capture (ADR 445 §3). `content` (default `off`) decides whether the trace store's
   * content column is written at all; structural rows are recorded either way. Not a secret.
   */
  trace: TracePolicySchema.default({}),
  /**
   * Who may issue a sponsored agent's one-time connect link (ADR 456 §2). `'sponsor'` (default): the
   * agent's sponsor or a team admin. `'any_member'`: any human member in good standing — team
   * agents. A connect link is a takeover (redeeming it evicts the device holding the agent, ADR 452
   * §2.3), so the default is the safe one; a team opts in. Never refused on an invite-admitting
   * team: that choice, and its risk, is the admin's (ADR 456 §2).
   */
  agent_connect: z.enum(['sponsor', 'any_member']).default('sponsor'),
  /**
   * Live member-created agents per sponsor (ADR 459, on ADR 449 §3). Default 3 reproduces the
   * shipped constant on every team that never sets it; the ceiling stops a fat-fingered million
   * from becoming surprise load. Admin-set through the policy route, audited `policy.change`.
   */
  sponsored_agent_cap: z.number().int().min(1).max(100).default(3),
  /**
   * ADR 602. Team cap in USD over the report's 7-day priced wake cost (`cost_usd_total`). No default:
   * absent is unbounded, and 0 is not a stand-in for absent. Display only — nothing is denied on it.
   * Finite, greater than 0, at most {@link SPEND_CAP_USD_MAX}.
   */
  spend_cap_usd: z.number().finite().positive().max(SPEND_CAP_USD_MAX).optional(),
  /**
   * ADR 635. Per-wake gateway threshold in USD. No default: absent leaves today's gateway
   * behavior, and 0 is not a stand-in for absent. Display only in this lane. The gateway
   * read is lane 01M531H8WGX270MZRR5KN08XPS. Finite, greater than 0, at most
   * {@link SPEND_CAP_USD_MAX}.
   */
  spend_approval_usd: z.number().finite().positive().max(SPEND_CAP_USD_MAX).optional(),
  /**
   * ADR 639. How many unpriced wakes a team allows in the report's 7-day window. No default:
   * absent keeps today's behavior. 0 is a real cap (block unpriced harnesses). Integer, 0 through
   * {@link UNPRICED_WAKE_CAP_MAX}. A set key holds new agent wakes (ADR 641).
   */
  unpriced_wake_cap: z.number().int().min(0).max(UNPRICED_WAKE_CAP_MAX).optional(),
  /**
   * Sponsor-hosted agents (ADR 463 §2). `max_per_host` bounds live enrolled sponsored seats per
   * host label; `policy` is the residency override every provisioned seat enrolls with. `budget_usd`
   * inside it is REQUIRED for a provision to go ready — checked at claim, not here, so `parse({})`
   * stays inert and a team that never hosts never sees it.
   */
  agent_host: AgentHostPolicySchema.default({}),
  /**
   * ADR 463 §4.3: when true, `POST /invites` without `member_until` is refused. The policy setter
   * refuses `agent_connect: 'any_member'` unless this is also true.
   */
  invite_requires_expiry: z.boolean().default(false),
  /**
   * ADR 484: warn (never refuse) the sender of an `accept` that concedes a `challenge` without
   * naming a check (`namesCheck`, ADR 481). Ships OFF; switched on only if ADR 476's five-day read
   * shows the unverified challenge-concession share has not fallen.
   */
  challenge_evidence_rail: z.boolean().default(false),
  /**
   * ADR 506: how long an outcome-acceptance (`lane_review`) ask waits before the owner may self-close
   * on silence — the promise the ready row records (ADR 217) and the "wait ≤Nm" the submit reply
   * prints. A floor, not an override: a tier whose own timeout is longer keeps it. Default 20 minutes
   * (`ACCEPTANCE_REVIEW_WINDOW_MS`), from the measured answer times that ADR records; 1 minute to 24
   * hours, the upper bound being the ADR 229 sweep grace.
   */
  acceptance_review_window_ms: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(ACCEPTANCE_REVIEW_WINDOW_MS),
  /**
   * ADR 514: agent style — the stance floor human admins own, the team's default dials, and a team
   * prose addendum. A human's own dials (`members.style_prefs`) sit on top and can never lower the
   * floor. Dense here (read); sparse on the wire and in the row (`PolicyOverrideSchema`, ADR 185).
   */
  style: StylePolicySchema.default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

/**
 * What an admin actually chose (ADR 185) — the shape team policy is **stored** and **posted** in.
 * Partial at the top level *and* through both nested sub-objects: a top-level `.partial()` alone
 * would leave a present `residency` dense, which is precisely the bug one level down.
 *
 * Why this exists: `setPolicy` used to `PolicySchema.parse` before storing, so the first write of any
 * single knob materialized EVERY default into the row and killed the schema default for that team
 * forever. Defaults are now applied on read (`getPolicy`) and never on write. The pattern is not new
 * — `ResidencyPolicyOverrideSchema` has always been the sparse shape for per-seat overrides; team
 * policy was the odd one out.
 */
/**
 * ADR 533: how long a stored policy doc stands before its admins are asked to look again. A write
 * that names no `review_by` gets `now + POLICY_REVIEW_DEFAULT_MS`; none may be set further out than
 * `POLICY_REVIEW_MAX_MS`. A review is a date on the DOC (the sparse set of chosen knobs), not per
 * knob: the doc is what one `POST /policy` replaces, so it is the unit an admin confirms or drops.
 */
export const POLICY_REVIEW_DEFAULT_MS = 90 * 24 * 3600_000;
export const POLICY_REVIEW_MAX_MS = 365 * 24 * 3600_000;

export const PolicyOverrideSchema = PolicySchema.partial().extend({
  /**
   * ADR 533: epoch ms after which the daemon asks the human admins to re-confirm or drop this doc.
   * Stamped by the server on every write that stores at least one knob (absent ⇒ the default
   * window from now); absent on an empty doc, since defaults need no review. Not a knob: an
   * effective-policy read (`PolicySchema`) never carries it.
   */
  review_by: z.number().int().positive().optional(),
  residency: ResidencyPolicyOverrideSchema.optional(),
  enforcement: EnforcementPolicySchema.partial().optional(),
  loops: LoopsPolicySchema.partial().optional(),
  pull: PullPolicySchema.partial().optional(),
  incident: IncidentPolicySchema.partial().optional(),
  doorbell: DoorbellPolicySchema.partial().optional(),
  trace: TracePolicySchema.partial().optional(),
  agent_host: AgentHostPolicySchema.partial().optional(),
  style: StylePolicyOverrideSchema.optional(),
});
export type PolicyOverride = z.infer<typeof PolicyOverrideSchema>;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The nested policy blocks, by key. Sparsification has to know which keys are sub-objects, and
 * naming them in a map rather than an inline ternary chain is what keeps the next block from being
 * silently omitted — an omitted key falls through to the scalar path and is kept or dropped WHOLE,
 * which is the ADR 185 bug one level down.
 */
const POLICY_SUB_SCHEMAS = {
  residency: ResidencyPolicySchema,
  enforcement: EnforcementPolicySchema,
  loops: LoopsPolicySchema,
  pull: PullPolicySchema,
  incident: IncidentPolicySchema,
  doorbell: DoorbellPolicySchema,
  trace: TracePolicySchema,
  agent_host: AgentHostPolicySchema,
  style: StylePolicySchema,
} as const;

/** Strip the keys of one sub-object that equal their current schema default; undefined if none survive. */
function sparsifySub(
  value: unknown,
  schema: (typeof POLICY_SUB_SCHEMAS)[keyof typeof POLICY_SUB_SCHEMAS],
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const defaults = schema.parse({}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    // A key with no default (max_turns, budget_usd) can only be there because someone set it.
    if (!(key in defaults) || !sameValue(v, defaults[key])) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Recover the sparse doc from a policy blob that was stored densely (ADR 185 migration): **keep the
 * keys whose value differs from the current default, drop the ones that equal it.**
 *
 * A deliberately-chosen value that happens to equal the default is indistinguishable from one the old
 * parse baked in — the audit log recorded the post-parse result, so intent was never written down.
 * That ambiguity is unrecoverable, but bounded: stripping such a key changes nothing unless the
 * default later moves, and at that moment tracking the new default is the likelier intent for a value
 * nobody can show was chosen. A value that *differs* from the default is unambiguously deliberate and
 * is always kept.
 */
export function sparsifyPolicy(stored: unknown): PolicyOverride {
  if (typeof stored !== 'object' || stored === null) return {};
  const defaults = PolicySchema.parse({}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    const subSchema = POLICY_SUB_SCHEMAS[key as keyof typeof POLICY_SUB_SCHEMAS];
    if (subSchema) {
      const sub = sparsifySub(value, subSchema);
      if (sub) out[key] = sub;
      continue;
    }
    if (!(key in defaults) || !sameValue(value, defaults[key])) out[key] = value;
  }
  return PolicyOverrideSchema.parse(out);
}
