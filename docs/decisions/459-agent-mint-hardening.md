# 459 — ADR 449 increment 3: member-created agents hardening

- Status: proposed
- Date: 2026-09-26
- Lane: `01M3FAPB325SW7AYFBYTFKAJ9E` (goal `demo`)
- Amends: [ADR 449](449-member-expiry-sponsored-agents.md) §3 (the deferred tail: per-member switch, per-IP rate limit, per-team cap tuning, expiry sweeper)

## Context

ADR 449 §3 ships `team_agent_create` as a deliberately narrow grant: any human member may mint up
to 3 live agents, rate-limited by the shared per-IP buckets, revocable only by removing the
sponsor. Its dated 2026-09-25 note (c) deferred four items to increment 3: a per-member create
switch, a per-IP rate limit on the mint route, per-team cap tuning, and a cosmetic expiry
sweeper. Two of the four change `@musterd/protocol` (`CapabilitiesSchema`, `OAUTH_RATE_LIMITS`),
so this ADR is their gate (hard rule 1).

Two things changed since the deferral, and both narrow the design. First, ADR 456 put team
policy knobs behind `POST /teams/:slug/policy` with defaults applied on read (`getPolicy`) and
never on write — per-team tuning has an established vehicle. Second, the demo rehearsal showed
the planner creating 3–6 agents in a burst from one machine, so the mint rate limit must clear a
half-dozen rapid human mints while still stopping automated mint spam.

## Problem

1. An admin cannot stop one member minting agents without removing them: the grant is all-humans
   or nobody.
2. The mint route has no rate limit of its own: the per-sponsor cap bounds an authenticated
   caller, but nothing bounds rapid mint attempts per IP (each attempt is a DB write + audit row
   even when refused).
3. The cap is the constant 3 for every team: a rehearsal team that needs six agents and a quiet
   team that wants one cannot both be right.
4. Expired members linger on the roster with `left_at` null: auth refuses them, but the roster
   reads as if they were still here.

## Decision

1. `CapabilitiesSchema` gains `can_create_agents: z.boolean().default(true)`. The generalist
   default is `true`, so every existing seat keeps exactly today's behavior and old blobs parse
   unchanged. `createSponsoredAgent` refuses a sponsor whose resolved capabilities have it false
   (`403`, naming the switch and the admin path). Narrowing rides the existing ADR 070
   machinery — a seat file or role default sets it false, reconcile projects it, `true→false`
   only. Done when an admin can turn off one member's minting with every other member untouched.
2. `OAUTH_RATE_LIMITS` gains `agent_mint: 10` (per IP per minute), enforced on
   `POST /teams/:slug/members/agents` through the existing `checkRateLimit` buckets (same
   `CF-Connecting-IP`-with-trustProxy key as the OAuth routes, so tunnel attendees are keyed
   apart). 10 clears a planner's six-agent burst with headroom; the per-sponsor cap still bounds
   what succeeds. The MCP `team_agent_create` tool shares the store invariants but is not
   IP-keyed — there is no peer address on the stdio path, and the capability switch + cap are
   the bound there. Tuned in rehearsal, not in code (ADR 446 §5 posture).
3. `PolicySchema` gains `sponsored_agent_cap: z.number().int().min(1).max(100).default(3)`.
   `mintSponsoredAgent` passes the team's value into `createSponsoredAgent`, whose refusal names
   the effective cap. Default 3 reproduces today's behavior on every team that never sets it;
   the ceiling of 100 stops a fat-fingered million from becoming surprise load. Admin-set
   through the existing policy route, audited `policy.change`, shown in the policy readout.
4. The daemon runs an hourly sweeper that sets `left_at` on members past `lifecycle_until`
   (`lifecycle = 'until'`, `left_at IS NULL`, expired — never unexpiring members). Roster
   hygiene only: auth already refused them, and the sweeper changes no decision. Each sweep is
   one audited row per member (`member.expired_swept`, actor null), so the roster change is on
   the record. It runs off the boot path on the same interval-loop pattern as the trace prune,
   and a failing pass logs and continues.

## Considered and rejected

- **Per-seat cap instead of per-team.** The abuse unit is the sponsor (one human minting many),
  not the team — but the tuning request is per-team ("the rehearsal team needs six"), and
  per-seat caps would need a second admin surface. The per-sponsor counting stays; only the
  number becomes team-tunable.
- **Blocking the mint route on the capability at the HTTP layer instead of the store.** The
  store is where the three §3 invariants live "so no route can skip them" — the switch joins
  them there, covering the MCP tool without a second check.
- **Rate-limiting the MCP tool path too.** No peer address exists on stdio, and inventing a
  per-seat bucket duplicates the per-sponsor cap. The HTTP route is where anonymous-ish volume
  arrives (bearer + seat header, pre-mint).
- **Deleting expired members instead of marking `left_at`.** Deletion destroys the audit trail
  and the tombstone the invite/name-refusal rules read. `left_at` is the existing departed
  state; the sweeper only moves members auth already treats as gone.

## Consequences

- `@musterd/protocol`: `can_create_agents`, `OAUTH_RATE_LIMITS.agent_mint`,
  `PolicySchema.sponsored_agent_cap` — this ADR is the gate. `guidance.ts` says "up to three
  agents": it goes stale where a team retunes the cap, so this lane updates that line.
- `@musterd/server`: the switch check in `createSponsoredAgent`, the exported rate-limit check
  on the agents route, the policy-read cap threading, migration-free (policy blob + member
  capabilities column already exist), the hourly sweeper loop, one audit verb.
- No CLI wire change: the policy and capabilities surfaces already exist; the readout shows the
  new knob generically. `docs/architecture/01-data-model.md` notes the sweeper's `left_at`
  meaning in the same commit.

## Observability & Evaluation

- **Traces:** `member.expired_swept` (actor null), the existing `member.sponsored_agent_created`
  and `policy.change` rows. A refusal names its cause (switch off / cap / rate).
- **Eval (negative tests ship with the lane):** a sponsor with the switch off is refused while a
  teammate mints; the 4th live agent is refused at default cap and the 7th at a team cap of 6;
  the 11th mint in a minute from one IP is `rate_limited`; an expired member gains `left_at`
  while an unexpiring one is untouched; old capability blobs still parse.
