# 460 — The presenter host wakes a member-created agent on creation (demo stopgap)

- Status: proposed — 2026-09-26
- Date: 2026-09-26
- Lane: `01M3FBKS3987E8FDXC4WQ8FY6C` (goal `demo`)
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (residency: a host wakes an enrolled seat) /
  [ADR 337](337-agent-http-session-authority.md) (agent seat credential plus lease) /
  [ADR 447](447-team-first-workspace-layout.md) (Workspace layout) / [ADR 449](449-member-expiry-sponsored-agents.md)
  (member-created agents) / [ADR 451](451-public-demo-ordinary-members.md) (daemon on Fly behind the
  Tunnel) / [ADR 456](456-team-agents-connect-authority.md) (team agents).
- Amends: [ADR 448](448-public-demo-tunnel-route.md) §3, which allows only the phone paths, by adding
  a **second hostname** for one operator machine. The phone hostname is unchanged.
- Review gate: big-body reviews §1 (the operator hostname) and §3 (credentials in a Workspace of a public
  repo) before merge.

## Context

In the demo, attendees create agents from their phones (ADR 449 `team_agent_create`). A phone
cannot run an agent. nick's direction (2026-09-26, lane brief): the presenter's laptop runs every
agent attendees create, each in a Workspace of its own: a checkout of the demo's public GitHub repo. There the agents
build, open PRs and merge, and Cloudflare Pages deploys `main`. Credentials are issued on the host,
with no connect link to paste. The agent's first act is to greet its sponsor. A hosted runtime is the
real answer, and this is the stopgap until it exists.

Most of the machinery exists. `musterd host` wakes enrolled seats (ADR 131). `musterd agent` provisions a
Workspace and a seat binding (ADR 447). `musterd residency on` enrolls a seat on a host. Four things are
missing (research map, 2026-09-26):

1. **The laptop cannot reach the daemon.** ADR 451 put it on Fly, and the Tunnel's ingress allows only
   `/mcp/demo`, OAuth, `/join/demo` and assets. Every route a host needs — wake leases, claim,
   residency, the WebSocket — returns 404.
2. **Nothing tells a host a new agent exists.** Wake leases and doorbell rings exist only for seats that
   are already enrolled.
3. **Provisioning is manual.** Today a person runs `musterd agent` and then `residency on --seat
   --workspace` by hand, both as admin.
4. **Nothing wakes a newborn seat.** A wake needs a directed act that arrived after enrollment (ADR
   434 §c), and a brand-new seat has none. Nothing tells the woken agent who its sponsor is.

## Decision

### 1. An operator hostname, gated by Cloudflare Access

The demo Tunnel gains a **second hostname** (for example `ops-demo.example.org`), routed to the same
loopback daemon. Every path is allowed, including the WebSocket. A Cloudflare Access application
fronts it, and its only policy is **one service token** held by the presenter's laptop. The phone
hostname, its literal path list and its "no Access" rule (ADR 448 §4, which is about phone clients
that cannot send headers) are unchanged.

- Requests that pass Access still meet the daemon's own checks. With `--insecure-trust-proxy` a
  tunneled request counts as remote, so provisioning needs an admin credential (ADR 134) and every
  agent route needs its credential and lease (ADR 337).
- `MUSTERD_ALLOWED_HOSTS` gains the operator hostname.
- The daemon's HTTP and WebSocket clients (the CLI, the host, and the MCP adapter a woken agent runs)
  send `CF-Access-Client-Id` and `CF-Access-Client-Secret` **when configured for that server origin**.
  The token lives in the machine config `~/.musterd/config.json` (mode 0600), keyed by origin. It is
  never in a repo, a seat binding, an environment variable, or a log line. A client talking to any
  other origin sends nothing.

### 2. Creation queues a provision for the team's agent host

Team policy gains `agent_host: { host: <label>, max_hosted: <n> }`. Unset, the default, means no
auto-provisioning, and creation behaves exactly as ADR 449 built it.

When set, `mintSponsoredAgent` also inserts a `host_provisions` row: team, agent, sponsor, host label,
`pending`. A host polls `POST /teams/:slug/host/provisions` with its host credential and claims its
label's pending rows, the same way it claims wake leases. The creator's reply says the agent is being
set up on the team's host, instead of handing back a connect link to paste. The link is still
returned, for anyone who wants to run the agent elsewhere.

`max_hosted` (default 20) bounds how many agents one host runs. A row beyond it stays `pending`
with the reason `host_full`, and the sponsor is told. ADR 449's per-sponsor cap of 3 still applies,
so there are two caps: per sponsor and per host.

### 3. The host provisions it, and keeps the credential out of the public repo

`musterd host --provision <team>=<local clone of the demo repo>` names a team this host provisions
for. It also makes the host poll that team even while it has no seats there (today a team with no
local seats is never polled). For each claimed row, as the team admin identity already bound on the
laptop, the host:

1. `git worktree add` of the named clone at `~/musterd/<team>/<repo>/<agent>` on branch
   `agent/<agent>` (the ADR 447 layout, with the seat's own git identity);
2. **adds `.musterd/` to that Workspace's `.git/info/exclude`** before writing anything into it. The repo
   is public, and a seat binding holds a live credential. The demo repo's committed `.gitignore` also
   lists `.musterd/` (the setup script, lane `01M3FCFQ8K`), so either guard alone suffices;
3. mints the seat's bootstrap credential and standing grant, and writes the binding (mode 0600) — the
   `musterd agent` steps, unattended;
4. enrolls residency on this host, harness `claude-code`, with the policy in §5;
5. reports the row `ready`, or `failed` with its reason. A failure leaves the agent created but
   unhosted, and the sponsor is told.

### 4. The first wake: `provisioned`, and the agent greets its sponsor

A row reported `ready` makes the daemon derive one immediate wake candidate for that seat, with the
reason `provisioned`, exactly once. It does not fake a directed act. The composed wake line gains
the sponsor's name for that reason only: "you were just created by `<sponsor>`; greet them with
`team_send` and ask what to build". Before reporting `ready`, the host saves the seat's first memory
("sponsor: `<sponsor>`; this Workspace is the demo repo; PR to main, Pages deploys it"). So later
wakes still know whom they answer to and where they are.

### 5. Hosted agents may work, within caps

A provisioned seat's residency policy comes from `agent_host.policy`, with these defaults: `flow:
auto`, the seat's own tool policy (not reply-only, since these agents build), `max_turns` 40, a
work timeout of 30 minutes, 4 wakes an hour, and a `budget_usd` per wake the presenter sets. The
laptop's Claude credentials pay for every agent, so the budget is the presenter's lever. There is no
default budget: a team that sets `agent_host` must set `policy.budget_usd` too, or provisioning
refuses.

### 6. A hosted agent is not OAuth-connectable

While an agent is enrolled on a host, `connectRefusal` (ADR 456) refuses to issue it a connect link,
naming the host. Otherwise the host's session and an OAuth device would occupy one seat at once.
Unenrolling the agent from the host releases it.

### 7. Removal stops the waking; the Workspace stays

A removed or disabled agent is never woken: `claimWakeLeases` already skips seats not in good standing.
The Workspace and its branch stay on the laptop, because they are the agent's work. The presenter
prunes them after the event with the ordinary `git worktree remove`.

## What this does not decide

- A hosted runtime, where agents run on managed infrastructure rather than a laptop. That is the real
  answer. Follows-up: deferred — after the demo, if member-created agents prove useful beyond it
  (2026-09-26).
- The demo repo, Cloudflare Pages, and the setup script. That is lane `01M3FCFQ8K`, which this
  depends on for the committed `.gitignore` in §3.2.
- Harnesses other than Claude Code on the host.

## Considered and rejected

- **Opening the host routes on the phone hostname.** It widens the public surface ADR 448 kept
  literal, for every client on the internet, in order to serve one laptop.
- **Running the agents on the Fly machine.** This is the hosted runtime above, built early, with Claude
  credentials and the demo repo on Fly. It is too large to land before the demo, and it moves the
  agents off the laptop nick chose.
- **A private SSH or Fly port-forward.** The daemon would see loopback, which `authProvision` treats
  as fully trusted (ADR 134). The laptop would become a local peer on a public-facing daemon.
- **Faking a first directed act from the sponsor.** It would put words in a human's mouth to satisfy a
  wake rule. A `provisioned` wake reason says what actually happened.
- **The token in an environment variable.** Every spawned harness would inherit it and could log it.
  An origin-keyed entry in the 0600 machine config reaches only the musterd clients that read it.

## Consequences

- `@musterd/protocol`: `PolicySchema.agent_host` and the `provisioned` wake reason. Both are
  ADR-gated, and this ADR is the gate.
- `@musterd/server`: a `host_provisions` table and routes, the creation hook in
  `mintSponsoredAgent`, the `provisioned` candidate in `claimWakeLeases`, the sponsor field in the
  composed line, and the hosted refusal in `connectRefusal`.
- `@musterd/cli` and `@musterd/mcp`: Access headers for configured origins, `musterd host
  --provision`, and the unattended provisioner.
- `docs/operations/public-demo-tunnel.md`: the operator hostname, its Access application and service
  token, the laptop's machine-config entry, and a pre-show check that the laptop reaches the daemon.
- Increments: (1) the operator hostname and Access headers, which make a manual `musterd agent` on
  the laptop work against the Fly daemon; (2) provisions, the host provisioner and the first wake;
  (3) hosted policy, caps and the connect refusal.

## Observability & Evaluation

- **Traces:** `host_provisions` rows (`pending` → `ready` or `failed`, with timestamps and reasons);
  audit `host.provision_claimed`, `host.provision_ready`, `host.provision_failed`; the `provisioned`
  wake lease; and the agent's greeting as an ordinary message to its sponsor. The Access token never
  appears in any row or log.
- **Eval (the Done line):** on the demo daemon, an attendee on a phone calls `team_agent_create`.
  Within 2 minutes, with nobody at the laptop, the new agent messages its sponsor by name from a
  Workspace on the demo repo.
  - Falsifiers: `.musterd/` is excluded in every Workspace it creates, and a `git status` there never
    shows the binding.
  - With the Access token removed, the laptop gets 403 from the operator hostname.
  - A connect link for a hosted agent is refused.
  - A creation past `max_hosted` stays `pending` with `host_full`.
- **Experiment:** in rehearsal, time creation to greeting for each agent, and count provisions that
  failed and why. A p95 above 2 minutes, or any failure caused by the provisioner, blocks the demo.
