# 463 — Sponsor-hosted agents: a sponsored agent runs on its sponsor's own machine, provisioned by the sponsor's own host

- Status: proposed — 2026-09-28
- Date: 2026-09-28
- Lane: `01M3FBKS3987E8FDXC4WQ8FY6C` (goal `seat-continuity`)
- Supersedes: ADR 460 (never merged; branch `docs/adr-auto-wake-created-agents`, PR #1765 closed)
- Builds on: ADR 131 (residency), ADR 344 (seat-scoped credentials), ADR 395 (host key), ADR 447 (layout), ADR 449/452/456/459 (sponsored agents)
- Design: `docs/superpowers/specs/2026-09-28-sponsor-hosted-agents-design.md`
- Plan: `docs/superpowers/plans/2026-09-28-sponsor-hosted-agents.md`
- Review gate: big-body (security) on Decision §1 (sponsor-scoped authority)

## Context

The demo ran on 2026-09-27: the audience joined a live team from their phones. The direction
from nick on 2026-09-28 is to stop building demo stopgaps and build the production path —
self-hosted first, musterd Cloud (ADR 461 Topology C) later on the same code. The first
production user is one developer with two harnesses, then a team of 2–5 on one repo (ADR 122).

ADR 460 (never merged) answered "a created agent should start working" by making the
_presenter's_ machine run every attendee's agent. That was a demo stopgap, and it put a
stranger's agent on a machine that holds credentials that are not the stranger's.

## Problem

Two machines exist and never touch:

| Path                                                    | What it does                                     | Who may                              | Where it runs                                       |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ | --------------------------------------------------- |
| `team_agent_create` (`sponsoredAgentMint.ts`)           | roster row + 15-minute connect nonce; nothing runs | any human with `can_create_agents`   | nowhere — the sponsor completes OAuth by hand       |
| `musterd agent <name>`                                  | member + workspace + `binding.json` + MCP wiring  | **admin** (credential mint, grant)   | the admin's machine                                 |
| `musterd residency on` + `musterd host`                 | enrolls a seat for daemon wakes; host spawns it  | **admin/governance**                 | any enrolled host                                   |

Every authority a running agent needs — bootstrap credential, grant, residency — is admin-only.
An ordinary member can create an agent but cannot give it a process.

ADR 456's takeover residual lives here too: `agent_connect: 'any_member'` lets any human issue a
connect link for any sponsored agent, and its two containments (invite expiry, "no valuable
agents on that team") are runbook text, not server checks. `cascadeSponsoredRevocation` runs only
on `/members/:name/remove`, not on disable or ban.

## Decision

**A sponsored agent runs on its sponsor's own machine, under the sponsor's identity, provisioned
by the sponsor's own `musterd host`.** The sponsor already has the repo, the harness, the API key
and a workspace. Creation becomes one step: mint the member; if the sponsor runs a host, the host
claims the provision, stands up the workspace, wires the harness, enrolls residency, and wakes the
seat once to greet its sponsor. The connect-link path stays for a sponsor with no host.

### 1. Sponsor-scoped authority

A server authorizer `authSponsorOf(ctx, slug, req, agentName)` passes only when the caller is a
live human member in good standing, `can_create_agents` is not withdrawn,
`agent.sponsored_by === caller.id`, and the agent is live (a removed agent is `not_found`, never
re-minted for). It is accepted **only for the sponsor's own agents** on:

- `POST /agent-bootstrap-credentials` with `use: 'claim_seat'`, `target: <own agent>`;
- `POST /grants` with `scope: 'seat'`, `target: <own agent>`;
- `POST /residency/enroll` and `/residency/revoke` for `<own agent>`;
- `POST /agent-bootstrap-credentials` with `use: 'host'` — a **sponsor host key**. The server
  filters `/residency/wake-leases` and `/host/provisions` for that key to seats its creator
  sponsors, even when other seats share the host label.

A host label is not a machine identity (ADR 344, ADR 395), so the own-machine guarantee is bound
to the key, not the label: **a sponsored seat is served only by a host key its sponsor minted.**
A team-wide key — admin-minted, or the legacy team key — serves unsponsored seats as before and
never a sponsored one, even on a shared label. An admin's own key also serves the agents that
admin sponsors. Wake-lease reports and doorbell rings follow the same rule.

Admin keeps every existing power. Audit rows carry `actor: <sponsor>` and
`detail.sponsor_scoped: true`. `can_create_agents` (ADR 459) now gates hosting as well as
creating.

### 2. Provisions

A `host_provisions` table: `id, team_id, member_id, sponsor_id, host, state
(pending|claimed|ready|failed|cancelled), claimed_by, claimed_at, ready_at, first_wake_at,
failed_reason, created_at`. `host_liveness` gains a nullable `sponsor_id`.

- `mintSponsoredAgent` inserts a `pending` row when a host key of the sponsor's polled in the last
  10 minutes; else it inserts nothing. The reply gains `hosting: 'sponsor_host' | 'connect_link'`.
- `POST /teams/:slug/host/provisions` — a host key claims the pending rows it may see,
  atomically, one claimant; rows past `agent_host.max_per_host` live hosted seats stay pending.
- `POST /teams/:slug/host/provisions/:id/report` — `ready | failed {reason}`. A `ready` report is
  refused, and the row marked `failed`, if the sponsor or the agent lost standing since the claim.
- A `ready` row yields exactly one wake candidate with reason `provisioned`; its composed line
  names the sponsor. No fake directed act is written.
- A `pending` row older than 15 minutes becomes `cancelled`, and the sponsor gets one message with
  a fresh connect link. Nothing is stuck.

Policy: `PolicySchema.agent_host: { max_per_host (int 1..100, default 5), policy:
ResidencyPolicyOverride }`. `agent_host.policy.budget_usd` has no default and is required; a
claimed row without it fails `no_budget` and the sponsor is told the setting to change.

### 3. The provisioner

`musterd host` gains a provision step each tick after wake leases, running as the host's own bound
identity (the sponsor, on the sponsor's machine): `provisionWorkspace` (a `git worktree` by default;
`--clone` for isolation from the sponsor's own checkout), then the seat sequence of
`musterd agent` extracted into `onboard/provisionSeat.ts` (credential, grant, `binding.json` 0600,
permissions, spec, harness wiring), then `enrollResidency` with `agent_host.policy`, then report.
Any failed step reports `failed` with the step name. A workspace already bound to the seat is
never provisioned a second time. `--no-provision` opts out; `musterd host provisions` lists rows.
`musterd agent <name>` works for a non-admin sponsor on their own agent.

### 4. ADR 456's residual, closed in code

1. A sponsored agent enrolled in residency is never OAuth-connectable: `connectRefusal` refuses it
   (`conflict`, "hosted"), and a policy change to `agent_connect: 'any_member'` is refused while
   any sponsored agent on the team is hosted.
2. Every loss of a sponsor's standing cascades the same way (`store/sponsoredCascade.ts`): each
   descendant is disabled and loses its residency (with the standing grant), its OAuth chains and
   unexchanged codes, and its presence. Removal and expiry are the triggers today. Disable and ban
   have no writer on the teams where sponsored agents exist — seat-file reconcile is the only
   account-status writer, and a seat-file team refuses sponsored mints (ADR 449) — so the first
   such writer must call the same cascade.
3. `PolicySchema.invite_requires_expiry` (default `false`): when true, `POST /invites` without
   `member_until` is refused. The policy setter refuses `agent_connect: 'any_member'` unless
   `invite_requires_expiry` is also true.
4. The expiry sweeper (ADR 459) revokes an expired member's own residency and cascades from it;
   increment 3 adds cancelling its pending provisions.

### 5. Protocol changes this ADR authorizes

`PolicySchema.agent_host`, `PolicySchema.invite_requires_expiry`, `WakeOrderSchema.reason:
'provisioned'`, `HostProvisionSchema` with its claim/report body and response schemas, and
`SponsoredAgentHostingSchema`. No envelope or act changes.

## Considered and rejected

- **Presenter-hosted agents (ADR 460).** Puts a stranger's agent in a trust domain that holds
  someone else's credentials. Right for one demo slot, wrong for a product.
- **One OS user for all agents on a shared host.** Every agent can read every other agent's
  `binding.json`. Team-shared hosts wait for containers.
- **Harness settings as the isolation boundary.** Permission prompts are a UX control, not a
  security boundary; an agent with shell reaches the file system regardless.
- **Opening the host routes on the public hostname.** Hosts are daemon-local HTTP with host-key
  auth; the Cloud edge does not route them.
- **Admin-only provisioning with a request flow.** Keeps the gap: every agent would wait on a
  human who is not its sponsor.

## Consequences

- Who may mint credentials widens, bounded to the caller's own sponsored agents. That is the
  review surface for big-body.
- A sponsored agent shares its sponsor's OS account. This is the trust domain `musterd agent`
  already uses; nothing widens it. Containers on the sponsor's machine (opt-in via
  `agent_host.policy.isolation`), team-shared hosts and the Cloud runtime are the next increments
  on the same table.
- 2026-09-28 (increment 2): §4.2 first named `setMemberGovernance` as the disable/ban hook. That
  setter is written only by seat-file reconcile, and seat-file teams cannot hold sponsored
  agents, so the hook could never fire — and where it could, the agent's own seat file would
  overwrite the cascade on the same pass. §4.2 now names the triggers that exist (remove, expiry).
  The real gap it closes: the remove route disabled descendants and revoked OAuth but left their
  residency, so a hosted agent kept its standing grant after its sponsor was removed.
- 2026-09-28 (increment 2, review): the note above said seat-file teams cannot hold sponsored
  agents. That holds for new mints only. A DB-rostered team that already holds them could be cut
  over — by `team export` or by a hand-written `team.toml` — and then its sponsor could be disabled
  with no cascade (found in review by big-body). The cutover is now refused at both points.
  `reconcileTeam` fails closed with `conflict` while any live member has `sponsored_by`, and
  `rosterToFiles` refuses the export first and names the way out: remove the agents, then export.
  Falsifier: a file-backed team with a live `sponsored_by` row.
- 2026-09-28 (big-body, REQUIRED on #1779): as first written, §1 left admin host keys
  team-wide over sponsored seats, so a sponsor enrolling on a label an admin host already used
  would be woken on the admin's machine. §1 now binds a sponsored seat to its sponsor's own key
  (landed with increment 1, #1784, with a regression on an admin host label).
- The work lands in five PRs, each alone: (1) this ADR; (2) sponsor-scoped authority and host-key
  scoping; (3) the residual closed in code; (4) provisions; (5) the provisioner, Scenario D, docs.

## Observability & Evaluation

- **Traces:** audit rows `bootstrap_credential.minted` / `grant.issued` / `residency.enrolled`
  with `detail.sponsor_scoped`; `host.provision_claimed`, `host.provision_ready`,
  `host.provision_failed` (with reason), `host.provision_cancelled`; the `provisioned` wake order
  and the new seat's first `team_send` to its sponsor.
- **Eval:** Scenario D (`06-testing.md`): a non-admin member with a running `musterd host` calls
  `team_agent_create`; within 2 minutes the new agent greets them by name from a seat enrolled on
  that host; the member cannot OAuth-connect it; an admin disabling the member stops its wakes.
  Negative falsifiers: a sponsor host key sees zero wake orders for a seat it does not sponsor on
  a shared host label; a sponsor minting for another member's agent gets `forbidden`; a report
  after the sponsor is disabled is refused. Baseline: today no non-admin-created agent ever gets
  a process without a manual OAuth connect.
- **Experiment:** on the revive team, count created agents by `hosting` over the first week; a
  week where every creation answers `connect_link` means no sponsor runs a host, and the path is
  unexercised, not working.
