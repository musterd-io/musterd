# 460 — The presenter host wakes a member-created agent on creation, one container each (demo stopgap)

- Status: proposed — 2026-09-26
- Date: 2026-09-26
- Lane: `01M3FBKS3987E8FDXC4WQ8FY6C` (goal `demo`)
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (residency: a host wakes an enrolled
  seat) / [ADR 337](337-agent-http-session-authority.md) (agent seat credential plus lease) /
  [ADR 447](447-team-first-workspace-layout.md) (Workspace layout) /
  [ADR 449](449-member-expiry-sponsored-agents.md) (member-created agents) /
  [ADR 451](451-public-demo-ordinary-members.md) (daemon on Fly behind the Tunnel) /
  [ADR 456](456-team-agents-connect-authority.md) (team agents).
- Amends: [ADR 448](448-public-demo-tunnel-route.md) §3, which allows only the phone paths, by adding
  a **second hostname** for one operator machine. The phone hostname is unchanged.
- Review gate: big-body (security). The first draft was held on big-body's finding `01M3G46738`: a
  hosted agent running as the presenter's OS user could read the presenter's credentials. §3 is the
  containment that answers it.

## Context

In the demo, attendees create agents from their phones (ADR 449 `team_agent_create`). A phone
cannot run an agent. nick's direction (2026-09-26, lane brief): the presenter's laptop runs every
agent attendees create, each with its own checkout of the demo's public GitHub repo. There the
agents build, open PRs and merge, and Cloudflare Pages deploys `main`. Credentials are issued on the
host, with no connect link to paste. The agent's first act is to greet its sponsor. A hosted runtime
is the real answer, and this is the stopgap until it exists.

Most of the machinery exists. `musterd host` wakes enrolled seats (ADR 131). `musterd agent`
provisions a Workspace and a seat binding (ADR 447). `musterd residency on` enrolls a seat on a
host. Five things are missing (research map, 2026-09-26):

1. **The laptop cannot reach the daemon.** ADR 451 put it on Fly, and the Tunnel's ingress allows only
   `/mcp/demo`, OAuth, `/join/demo` and assets. Every route a host needs — wake leases, claim,
   residency, the WebSocket — returns 404.
2. **Nothing tells a host a new agent exists.**
3. **Provisioning is manual,** as admin.
4. **Nothing wakes a newborn seat,** and nothing tells it who its sponsor is.
5. **Nothing contains a hosted agent** (big-body `01M3G46738`, high). Today the host launches a harness
   as the host's own OS user, working in the seat's Workspace, with the host's environment.
   Filesystem and tool enforcement is delegated to the harness (`docs/design/security.md`). An agent
   that an attendee directs has a shell. As the presenter, it can read `~/.musterd/config.json` — the
   presenter's admin credential for every team on that laptop, the Access token — and every sibling
   agent's seat binding. Mode `0600` and git excludes stop other users and accidental commits. They do
   not stop the process running as that user.

## Decision

### 1. An operator hostname, gated by Cloudflare Access, reached through a laptop proxy

The demo Tunnel gains a **second hostname** (for example `ops-demo.example.org`), routed to the same
loopback daemon. Every path is allowed, including the WebSocket. A Cloudflare Access application
fronts it, and its only policy is **one service token**. The phone hostname, its literal path list and
its "no Access" rule (ADR 448 §4) are unchanged. `MUSTERD_ALLOWED_HOSTS` gains the operator hostname.

Requests that pass Access still meet the daemon's own checks. With `--insecure-trust-proxy` a tunneled
request counts as remote, so provisioning needs an admin credential (ADR 134) and every agent route
needs its credential and lease (ADR 337).

**The token never leaves the host process.** It lives in the presenter's machine config
(`~/.musterd/config.json`, mode 0600), keyed by origin. It is read only by `musterd host` and the
presenter's own CLI. Hosted agents reach the daemon through **`musterd host`'s egress proxy**. The
proxy listens only where the agent containers can reach it (the container network's host gateway,
never a LAN interface). It forwards HTTP and WebSocket to the operator hostname and adds the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on the way out. Nothing inside a
container holds the token.

### 2. Creation queues a provision for the team's agent host

Team policy gains `agent_host: { host: <label>, max_hosted: <n>, policy: {…} }`. Unset, the default,
means no auto-provisioning, and creation behaves exactly as ADR 449 built it.

When set, `mintSponsoredAgent` also inserts a `host_provisions` row: team, agent, sponsor, host label,
`pending`. A host polls `POST /teams/:slug/host/provisions` with its host credential and claims its
label's pending rows, as it claims wake leases. The creator's reply says the agent is being set up on
the team's host.

`max_hosted` (default 20) bounds how many agents one host runs. A row beyond it stays `pending` with
`host_full`, and the sponsor is told. ADR 449's per-sponsor cap of 3 still applies, so there are two
caps: per sponsor and per host.

### 3. Each hosted agent runs in its own container, seeing only its own things

A provisioned seat is woken by a **container backend**: the ADR 131 backend interface, with Claude
Code running inside a per-agent container rather than as the host's user. The host needs Docker or
OrbStack.

Each agent's container holds:

- **its own checkout** of the demo repo, a full clone, not a `git worktree`. A `worktree`'s `.git` points
  back into a shared clone on the host, which would put every sibling in reach. The clone sits on the
  host at the ADR 447 path `~/musterd/<team>/<repo>/<agent>`, and that one directory is the only host
  path mounted. `.musterd/` is listed in the clone's `.git/info/exclude` before the binding is
  written. The demo repo's committed `.gitignore` lists it too (lane `01M3FCFQ8K`). That is hygiene
  against pushing the binding, not the security boundary;
- **its own seat binding** inside that directory: its `msac_`, its grant and its lease, and nothing
  else. The agent has always held its own credential; its blast radius is its own seat;
- **two scoped secrets as environment variables, and nothing else:**
  - an **Anthropic API key for the demo only**, with a hard spend limit set in the Anthropic console;
  - a **GitHub fine-grained token scoped to the demo repo alone** (contents and pull requests). `main`
    is protected, so changes arrive only by PR.

  An attendee can extract either one through their agent. The damage is bounded by the spend limit
  and by one disposable public repo, and the presenter revokes both after the event. The Access token,
  the presenter's credentials, `~/.musterd`, other agents' directories and the host's environment are
  **not** in the container;
- **the proxy address from §1** as its daemon origin;
- **a non-root user, CPU and memory limits,** and no host PID or network namespace.

The provisioner does, for each claimed row, as the team admin identity already bound on the laptop,
outside any container:

1. clone the demo repo into the agent's directory and exclude `.musterd/`;
2. mint the seat's bootstrap credential and standing grant, and write the binding (mode 0600);
3. enroll residency on this host with the container backend and the policy in §5;
4. report the row `ready`, or `failed` with its reason. A failure leaves the agent created but
   unhosted, and the sponsor is told.

### 4. The first wake: `provisioned`, and the agent greets its sponsor

A row reported `ready` makes the daemon derive one immediate wake candidate for that seat, with the
reason `provisioned`, exactly once. It does not fake a directed act. The composed wake line gains
the sponsor's name for that reason only: "you were just created by `<sponsor>`; greet them with
`team_send` and ask what to build". Before reporting `ready`, the host saves the seat's first memory
("sponsor: `<sponsor>`; this checkout is the demo repo; PR to main, Pages deploys it").

### 5. Hosted agents may work, within caps

A provisioned seat's residency policy comes from `agent_host.policy`, with these defaults: `flow:
auto`, the seat's own tool policy (these agents build), `max_turns` 40, a work timeout of 30
minutes, and 4 wakes an hour. `budget_usd` has no default. A team that sets `agent_host` must set it,
or provisioning refuses. The demo key's hard spend limit (§3) is the backstop behind it.

### 6. A hosted agent is not OAuth-connectable

While an agent is enrolled on a host, `connectRefusal` (ADR 456) refuses to issue it a connect link,
naming the host. Otherwise the container's session and an OAuth device would occupy one seat at once.
Unenrolling the agent from the host releases it.

### 7. Removal stops the waking; the checkout stays

A removed or disabled agent is never woken: `claimWakeLeases` already skips seats not in good standing.
The container is stopped. The checkout and its branch stay on the laptop as the agent's work, and the
presenter deletes them after the event.

## What this does not decide

- A hosted runtime on managed infrastructure. The §3 container image is its seed. Follows-up:
  deferred — after the demo, if member-created agents prove useful beyond it (2026-09-26).
- Egress filtering inside the containers. They can reach the internet, which a coding agent needs;
  their secrets are the two scoped ones in §3.
- The demo repo, branch protection, Pages, and the setup script (lane `01M3FCFQ8K`).
- Harnesses other than Claude Code in the container.

## Considered and rejected

- **Running hosted agents as the presenter's OS user** (this ADR's first draft). big-body `01M3G46738`:
  a shell as that user reads every credential the presenter has, for every team on the laptop.
- **One dedicated OS user for all hosted agents.** It protects the presenter, but the agents share the
  user, so any attendee's agent can read and take over any other attendee's agent.
- **The harness's own permission or sandbox settings as the boundary.** They are enforced by the
  process an attendee is steering, and the security design delegates exactly this to the harness today.
  An OS-level container does not depend on the agent's cooperation.
- **Accepting the same-user blast radius.** Every attendee would effectively hold the presenter's admin
  access to the demo team and to `revive`.
- **Opening the host routes on the phone hostname.** It widens the public surface ADR 448 kept
  literal, for every client on the internet, in order to serve one laptop.
- **Running the agents on the Fly machine.** This is the hosted runtime, built early, off the laptop
  nick chose. §3's container is the piece of it this ADR does build.
- **A private SSH or Fly port-forward.** The daemon would see loopback, which ADR 134 trusts fully.
- **The Access token in a container's environment.** Any agent could read it. The §1 proxy keeps it in
  the host process.

## Consequences

- `@musterd/protocol`: `PolicySchema.agent_host` and the `provisioned` wake reason. Both are
  ADR-gated, and this ADR is the gate.
- `@musterd/server`: a `host_provisions` table and routes, the creation hook in
  `mintSponsoredAgent`, the `provisioned` candidate in `claimWakeLeases`, the sponsor field in the
  composed line, and the hosted refusal in `connectRefusal`.
- `@musterd/cli`: origin-keyed Access headers, the `musterd host` egress proxy, the container backend
  and its agent image, `musterd host --provision <team>=<repo url>`, and the unattended provisioner.
- `docs/operations/public-demo-tunnel.md`: the operator hostname and its Access application; Docker or
  OrbStack on the laptop; the demo-only Anthropic key with a hard spend limit; the demo-repo-scoped
  GitHub token and branch protection; revoking both after the event; and a pre-show check that a
  container reaches the daemon through the proxy and cannot read `~/.musterd`.
- Increments:
  1. the operator hostname, the Access headers and the proxy;
  2. the agent image and the container backend. With these, a manual `musterd agent` on the laptop
     runs contained against the Fly daemon;
  3. provisions, the provisioner and the first wake;
  4. hosted policy, caps and the connect refusal.

## Observability & Evaluation

- **Traces:** `host_provisions` rows (`pending` → `ready` or `failed`, with timestamps and reasons);
  audit `host.provision_claimed`, `host.provision_ready`, `host.provision_failed`; the `provisioned`
  wake lease; and the agent's greeting as an ordinary message to its sponsor. The Access token never
  appears in a row, a log line, or a container.
- **Eval (the Done line):** on the demo daemon, an attendee on a phone calls `team_agent_create`.
  Within 2 minutes, with nobody at the laptop, the new agent messages its sponsor by name from its own
  container.
  - Falsifiers for containment. Inside an agent's container: `cat ~/.musterd/config.json` finds nothing
    of the presenter's, a sibling agent's directory is absent, and the environment holds no Access
    token.
  - `git status` in a checkout never shows the binding.
  - With the Access token removed, the proxy's requests get 403.
  - A connect link for a hosted agent is refused.
  - A creation past `max_hosted` stays `pending` with `host_full`.
- **Experiment:** in rehearsal, time creation to greeting for each agent, and count provisions that
  failed and why. A p95 above 2 minutes, or any containment falsifier that fails, blocks the demo.
