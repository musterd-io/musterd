# Sponsor-hosted agents — design

- Date: 2026-09-28
- Author: stanley (lane `01M3FBKS3987E8FDXC4WQ8FY6C`, re-scoped from "auto-wake, demo stopgap")
- Goal: `seat-continuity` (a seat picks up where it left off — on any harness, model, or surface)
- Status: draft for nick's review; the accepted design becomes ADR 462 (supersedes the unmerged ADR 460)

## 1. Why now

The demo is done (2026-09-27; the audience joined from phones). The direction from nick, 2026-09-28: no more
demo stopgaps — build the production-grade, secure, end-to-end product. Topology: **self-hosted first**, hosted
(musterd Cloud, ADR 461 Topology C) later on the same code. First production user: **one developer with two
harnesses, then a team of 2–5 on one repo** (ADR 122, traction plan §3).

This spec is the first increment of that arc: **agent hosting + agent authority**. It replaces ADR 460.

## 2. The gap, stated from the code

Two machines exist and never touch:

| Path | What it does | Who may | Where it runs |
| --- | --- | --- | --- |
| `team_agent_create` (`sponsoredAgentMint.ts`, `sponsoredAgents.ts`) | roster row + 15-minute connect nonce. **Nothing runs.** | any human with `can_create_agents` | nowhere — the sponsor must open a harness on a device and complete OAuth by hand |
| `musterd agent <name>` (`commands/agent.ts`) | member + worktree + `binding.json` + MCP wiring | **admin** (mints `claim_seat` credential, standing grant) | the admin's machine, as their OS user |
| `musterd residency on` + `musterd host` (`commands/residency.ts`, `host/loop.ts`) | enrolls a seat for daemon-driven wakes; host polls leases, spawns the harness | **admin/governance** (`authGovernance` on `/residency/enroll`) | any enrolled host, as the host's OS user |

Every authority a running agent needs — bootstrap credential, grant, residency — is admin-only. A sponsor
who is an ordinary member can create an agent but cannot give it a process. ADR 460 bridged this by making the
*presenter* run everyone's agents, which is exactly the wrong host: the presenter's machine holds credentials
that are not the sponsor's.

The takeover residual of ADR 456 lives here too: `agent_connect: 'any_member'` lets any human issue a connect
link for any sponsored agent, and the two containments (invite expiry, "no valuable agents on that team") are
runbook text, not server checks. `cascadeSponsoredRevocation` runs only on `/members/:name/remove`
(`http.ts:7038`), not on disable or ban.

## 3. Decision, in one paragraph

**A sponsored agent runs on its sponsor's own machine, under the sponsor's identity, provisioned by the
sponsor's own `musterd host`.** The sponsor already has the repo, the harness, the API key, and a workspace;
their agent is theirs. Creation becomes one step: mint the member, and if the sponsor runs a host, the host
claims the provision, stands up the workspace, wires the harness, enrolls residency, and wakes the seat once to
greet its sponsor. Authority is **sponsor-scoped**: a member may mint credentials, grants and residency
*only for agents they sponsor*, and nothing else. The phone path (connect links) stays for a sponsor with no
host. Containers, team-shared hosts and Cloud runtime are later increments on the same provisioning table.

## 4. Design

### 4.1 Sponsor-scoped authority (server)

A new authorization helper `authSponsorOf(ctx, slug, req, agentName)`: the caller is a live human member in
good standing, `agent.sponsored_by === caller.id`, and the agent is live. It sits beside `authAdmin` /
`authGovernance` in `http.ts` and is accepted, **only for the sponsor's own agents**, on:

- `POST /agent-bootstrap-credentials` with `use: 'claim_seat'`, `target: <own agent>`;
- `POST /grants` with `scope: 'seat'`, `target: <own agent>`;
- `POST /residency/enroll`, `/residency/revoke` for `<own agent>`;
- `POST /agent-bootstrap-credentials` with `use: 'host'` — a **sponsor host key**, scoped so
  `/residency/wake-leases` and `/host/provisions` return only leases and provisions for seats that sponsor
  sponsors. An admin host key keeps today's team-wide reach.

Admin keeps every existing power; nothing is removed. Audit rows carry `actor: <sponsor>` and
`detail.sponsor_scoped: true`.

`can_create_agents` (ADR 459) already gates who may sponsor; it now also gates who may host. An admin who turns
it off for a member stops both.

### 4.2 Provisioning table and routes (server)

`host_provisions` (from ADR 460 §2, kept): `id, team_id, member_id, sponsor_id, host_label|null, state
(pending|claimed|ready|failed|cancelled), claimed_by, claimed_at, ready_at, failed_reason, created_at`.

- `mintSponsoredAgent` inserts a row **when the sponsor has at least one host seen in the last 10 minutes**
  (`listHostSeen` already tracks this per team; it gains a per-member view). Otherwise it inserts nothing and
  the reply carries the connect link as today. The reply gains `hosting: 'sponsor_host' | 'connect_link'` so a
  phone user is told which happened.
- `POST /teams/:slug/host/provisions` — claim: a host key (admin or sponsor-scoped) claims pending rows it may
  see, `pending → claimed`, atomic, one claimant. Same shape as `claimWakeLeases`.
- `POST /teams/:slug/host/provisions/:id/report` — `ready | failed {reason}`.
- A `ready` row derives exactly one wake candidate with reason `provisioned` (ADR 460 §4, kept): the composed
  wake line names the sponsor; the seat's first memory says who created it. No fake directed act.
- A `pending` row older than 15 minutes (nobody claimed it) flips to `cancelled` and the sponsor gets one
  `@sponsor` message with the connect link instead. Nothing is ever stuck.

Policy: `PolicySchema.agent_host: { max_per_host: number (default 5), policy: ResidencyPolicyOverride }`.
Unset means defaults; there is no "off" switch here because hosting is gated by the sponsor running a host,
not by team policy. `budget_usd` in `agent_host.policy` has **no default and is required** for a provision to
be claimed; without it the row fails with `no_budget` and the sponsor is told the flag to set.

### 4.3 The provisioner (CLI, `musterd host`)

`musterd host` gains a provision step per tick, after wake leases: claim, then for each row, as **the host's own
bound identity** (the sponsor, on the sponsor's machine):

1. `provisionWorkspace(agent, {team, repo: <the host's current repo root>})` — a **git worktree** by default,
   as `musterd agent` does today. A worktree is correct here because the sponsor and the agent share one
   trust domain (the sponsor's account). `--clone` is available for a sponsor who wants isolation from their
   own checkout. (ADR 460 rejected worktrees because siblings belonged to different attendees; that premise
   is gone.)
2. mint `claim_seat` credential and standing seat grant (sponsor-scoped, §4.1); write `binding.json` 0600;
   `installSeatPermissions`; `saveWorkspaceSpec`; `harness.configure` — the exact sequence of
   `commands/agent.ts`, extracted into `onboard/provisionSeat.ts` so `musterd agent` and the host share it.
3. `enrollResidency` with the host's label, the harness of the host's own workspace (or `agent_host.policy.harness`),
   and `agent_host.policy`.
4. report `ready`; on any failure, report `failed` with the step name — the agent exists, unhosted, and
   the sponsor gets the connect link.

Concurrency: `max_per_host` counts live enrolled seats on that host label; a claim past it is refused
server-side (`host_full`) and the row stays `pending` for another host of the same sponsor, or cancels at 15
minutes.

Nothing new runs as anyone but the sponsor, on any machine but the sponsor's. No new secrets exist: the agent's
`binding.json` holds its own `msac_` and grant, the same as a `musterd agent` seat today.

### 4.4 Agent authority closed in code (server)

1. **`agent_connect: 'any_member'` is refused while any sponsored agent on the team is enrolled on a host.**
   `connectRefusal` and the policy setter both check; the error names the enrolled agents. A hosted agent is
   never OAuth-connectable (ADR 460 §6, kept): the connect link and the host would occupy one seat.
2. **Disable and ban cascade like remove.** `cascadeSponsoredRevocation` is called from the account-status
   transition in `store/members.ts`, not only from `/remove`; the cascade also revokes residency and OAuth
   chains for each descendant, which `/remove` already does.
3. **Invite expiry is enforced by policy, not runbook.** `PolicySchema.invite_requires_expiry: boolean
   (default false)`; when true, `POST /invites` without `member_until` is refused. Teams that open
   `any_member` connect must have it on — the policy setter enforces the pair.
4. **Expiry sweeper** (ADR 459 §4) also cancels pending provisions and revokes residency for expired agents.

### 4.5 Protocol changes (ADR-gated by the accepting ADR)

- `PolicySchema.agent_host`, `PolicySchema.invite_requires_expiry`.
- Wake reason `provisioned`.
- `HostProvisionSchema`, claim/report request and response schemas.
- `team_agent_create` result: `hosting` discriminator.
- No change to the envelope or to any act.

### 4.6 CLI surface

- `musterd host` — provisions automatically; `--no-provision` opts out; `--clone` chooses clone over worktree.
- `musterd host provisions` — list this host's rows with state and reason.
- `musterd agent <name>` — unchanged behaviour, now built on the shared `provisionSeat`; **a non-admin sponsor
  may run it for their own sponsored agent** (it calls the same sponsor-scoped routes).
- `musterd team policy set agent_host.budget_usd <n>` etc. — the existing policy setter.

## 5. Security review points (for big-body)

- Sponsor-scoped authority is an **expansion** of who may mint credentials. Bound: only `claim_seat` for
  `sponsored_by === caller`, only `seat` grants for the same, only residency for the same, and a host key that
  the server filters to those seats. Falsifier: a sponsor host key polling wake-leases sees zero orders for a
  seat it does not sponsor, and a sponsor minting for another member's agent gets `forbidden`.
- The host runs as the sponsor's OS user. This is the trust domain the sponsor already occupies via `musterd
  agent`; nothing widens it. The threat ADR 460 answered (a stranger's agent on the presenter's machine) cannot
  occur: a provision is only ever claimed by the sponsor's own host.
- `any_member` + hosted agents is refused (§4.4.1), closing the ADR 456 residual for every hosted team.
- Provisions never carry a secret; the credential is minted by the host, to the host, and written locally.

## 6. Testing

- Server (vitest): sponsor-scoped auth positive/negative for each route; provision claim atomicity (two hosts,
  one row); `host_full`; `no_budget`; 15-minute cancel + connect-link fallback; `provisioned` wake once;
  `any_member` refusal with hosted agents; cascade on disable/ban; `invite_requires_expiry`.
- CLI (vitest, injected deps): `pollHostOnce` with a provision: claim → `provisionSeat` → enroll → report;
  each failure step reports `failed` with the step; `--no-provision`; `max_per_host` locally respected.
- Scenario D (new, `06-testing.md`): a non-admin member on team T with a running `musterd host` calls
  `team_agent_create` from a second surface; within 2 minutes the new agent greets them by name from a seat
  enrolled on that host; the same member cannot connect it over OAuth; an admin disabling the member stops the
  agent's wakes.

## 7. Increments (each a lane, each lands alone)

1. **Sponsor-scoped authority** — §4.1, tests. No behaviour change for admins. Ships alone as a security
   change with big-body review.
2. **Authority closed in code** — §4.4 (1–3). Independent of hosting; closes ADR 456 now.
3. **Provisions** — §4.2 table, routes, `mintSponsoredAgent` hook, cancel/fallback.
4. **Provisioner** — §4.3, `provisionSeat` extraction, `musterd host` step, Scenario D.
5. **Docs** — architecture 01/03/04 trees and text, `docs/design/security.md` trust-domain paragraph,
   `06-testing.md` Scenario D, `ROADMAP.md` (containers and team-shared hosts as next).

## 8. Not in this spec (next increments on the same table)

- **Containers on the sponsor's machine** (ADR 460 §3 image, with the egress rule big-body asked for) —
  opt-in via `agent_host.policy.isolation: 'container'`.
- **Team-shared hosts** (any enrolled host with capacity claims any provision) — requires containers first,
  because host ≠ sponsor.
- **Cloud runtime** (ADR 461 Topology C) — team-shared hosts on musterd-operated machines.
- Wider remote tool set and model attestation for OAuth agents (ADR 452 deferred list).
- ADR 446 increment 3, ADR 459 (except the sweeper hook in §4.4.4), an ADR for #1767.

## 9. What ADR 462 will say

Supersedes ADR 460 (never merged). Decision = §3 + §4. Rejected: presenter-hosted (460), one OS user for all
agents, harness settings as the boundary, opening host routes on the public hostname. Eval = Scenario D's
2-minute line plus the §5 falsifiers.
