# 621 — Talk-only guests: an invite admits a guest by default, and a guest can talk but not coordinate

- Status: accepted
- Date: 2026-10-15
- Lane: `01M3Z42GN1YHTJC97W1067V8JS` (goal `cloud`, Cloud increment 4)
- Builds on: [ADR 070](070-v0.3-p1-seats-data-model.md) (capabilities narrow, never widen),
  [ADR 227](227-roles-as-the-aptitude-layer.md) (role labels; reconcile writes capabilities),
  [ADR 446](446-remote-mcp-https-oauth.md) (remote MCP), [ADR 450](450-team-invite-join.md)
  (invites), [ADR 580](580-human-credentials-require-human-admin.md) (human credentials are
  human-admin minted), [ADR 616](616-demo-audiences-read-at-broadcast-grade.md) (guests read at
  `broadcast` grade)
- Spec: Cloud design §4.6 (`docs/superpowers/specs/2026-09-29-musterd-cloud-design.md`)
- Amends: ADR 450 §1 (an invite carries a ceiling), ADR 616 §4 (names the field it keys on)

## Context

Cloud spec §4.6 settled three ceilings for a joiner: **guest** (talk only), **member** (the full
tool set and lanes) and **owner**. "A public join link defaults to guest", and "nobody gets lane
tools without a human deciding they should". It listed what talk-only means: a guest may join, read
its inbox, read the roster, and send `message`, `status_update`, `request_help` and `ask`, plus
`accept`, `decline`, `wait` and `resolve` on a thread addressed to it. Every lane, goal, seed, memory,
insight-save, report, policy and admin route is refused, and so are `handoff`, `steer`, `challenge`
and `defer`. The spec said a role on an invite is a protocol change and needs its own ADR.

ADR 616 then decided that a guest reads at `broadcast` grade: agent DMs and asks, never a DM between
two other humans, keys masked.

## Problem

None of this exists yet, and three things in the code shape how it can be built.

- **Joiners get everything today.** ADR 450 admits an invited person as a human member at the
  team's default role. That member resolves to the generalist capabilities, and it reads at `team`
  grade (ADR 407), which includes human-to-human DMs. On the phone it is held back only because the
  remote MCP registers five tools. The same credential opens `/live` or the CLI with full reach.
- **"Role" is taken.** `members.role` is the ADR 227 role label, and the spec's "role on an invite"
  would overload it. Narrowing is already the job of capabilities (ADR 070).
- **Reconcile is the single writer of capabilities** (`setMemberGovernance`), projected from seat
  and role files. An invite-admitted member has no seat file, so its capabilities column is NULL and
  resolves to the generalist default. A capability blob written at admit time could be overwritten
  by the next reconcile.

## Decision

1. **A new Universe-1 capability, `can_coordinate`.** It is a boolean and defaults to `true`, so
   every existing seat and stored blob keeps today's behaviour. `false` is talk-only. It narrows like
   every capability (`true→false` only, `clampNarrow`) and is enforced by the server on every
   in-band operation (SPEC A.1).
2. **What `can_coordinate: false` refuses.**
   - **Sends:** every act except `message`, `status_update`, `request_help` and `ask`. `accept`,
     `decline`, `wait` and `resolve` are allowed only as replies (`reply_to` or `thread`) to an act
     addressed to this seat.
   - **Routes:** every lane, goal, seed, memory, insight-save, report, policy and admin route, and
     creating or connecting agents.
   - **The refusal** is `forbidden`, and its message names the reason: "talk-only seat: <what was
     refused>". It is audited like a muted send.
3. **The guest ceiling** is one constant in the protocol:
   `{ can_coordinate: false, can_create_agents: false, can_flag_urgent: false, can_observe: false }`.
   _(Amended 2026-10-15: `can_observe` is not narrowed. It gates the firehose, which a guest needs
   for ADR 616's live view and which is already filtered at its `broadcast` grade — see
   Consequences.)_
   "Guest" is the name of this ceiling on an invite and in the CLI's invite and member commands. On
   the roster and `/live` a guest is a member, as the spec says.
4. **The guest ceiling lives in its own column, `members.ceiling`** (`'guest'` or NULL), and is
   applied when capabilities are read. `resolveCapabilities` clamps the projected capabilities with
   `clampNarrow(caps, GUEST_CEILING)`, the same read-side clamp it already applies to `is_admin`. A
   reconcile, a role file or a seat file therefore cannot widen a guest. Only an admin clears the
   column (decision 6).
5. **An invite carries a ceiling: `guest` or `member`.** `musterd team invite create` mints a
   **guest** invite by default; `--member` mints one that admits full members. The `team_invites`
   row gains `ceiling`, and every member the invite admits is stamped with it. An invite row minted
   before this ADR (NULL) still admits members, so a link already in a room keeps meaning what it
   meant. Minting stays human-admin only (ADR 134, ADR 580).
6. **An admin sets or clears a seat's ceiling.** `musterd member ceiling <name> guest|none` (and the
   HTTP route behind it) is admin-only and audited (`member.ceiling_set`). _(Amended 2026-10-15: the
   command is `musterd team ceiling <name> guest|none`, beside `team add` and `team remove`; there
   is no `member` command group.)_ This promotes a guest who
   should help build, and narrows a member admitted before this ADR, such as a past demo joiner who
   still holds a credential.
7. **A talk-only seat reads at `broadcast` grade.** `messageVisibilityOf` returns `broadcast` for a
   non-admin, non-observer member whose effective `can_coordinate` is `false`, with the party union
   and scrub of ADR 616 §5–7. This is the field ADR 616 §4 means by "the talk-only guest role".
8. **Tool lists follow the ceiling.** The remote MCP (`transport/mcpHttp.ts`) and the local adapter
   list only the tools the seat's effective capabilities allow, so a phone is never offered a tool
   it would be refused. Refusal at the server is the guarantee; the filtered list is courtesy.
9. **The remote MCP serves the full member tool set, gated by these capabilities** (spec §4.6). _(Amended 2026-10-16:
   served by composing the adapter's own tools, not by building them in the daemon — ADR 630.)_ This
   replaces ADR 446's increment-3 plan to converge "after rehearsal" for members. Building that set
   is lane `01M512KNKZ`; until then the remote surface stays at its five tools, and a guest is
   refused `team_agent_create` and `team_agent_connect` by decision 2.
   Follows-up: 01M512KNKZBSGSG5KEJ9HYJ5TT

## Consequences

- A stranger who joins through a public link can talk to the team and read what a demo shows, and
  cannot claim a lane, move a goal, open a seed, hand off work or steer anyone. Doing any of that
  takes a human admin's decision (decision 6), which is the spec's line.
- **Past joiners keep the access they were given.** Members admitted before this ADR are not
  narrowed automatically. An admin narrows them with decision 6; the build lane lists the seats
  admitted by an invite (`team_invites` admissions) so that is one command per seat.
- A guest cannot `defer` or `challenge`. It can still disagree in a `message`, and its `ask` reaches
  a human.
- `can_coordinate` is a new field on the capability record. Older clients parse it away (the schema
  strips unknown keys) and older blobs parse with the default, so no feature-epoch gate is needed.
  SPEC A.1's capability list gains it in the build commit.
- The local adapter's filtered list depends on knowing the seat at `tools/list` time. Where it does
  not (before the first join), it lists everything and the server refuses; the remote endpoint
  always knows its seat.
- Lanes: `01M3Z42GN1` builds decisions 1–8. `01M50XJJFE` builds decision 7's read path (ADR 616
  §4–7). Decision 9's full member set on the remote MCP is lane `01M512KNKZ`.
  Follows-up: 01M512KNKZBSGSG5KEJ9HYJ5TT
  Follows-up: 01M50XJJFE7WC6E1Z126XG28Q9

- **2026-10-15 — the guest ceiling keeps `can_observe`.** Found while building: `can_observe`
  gates the firehose subscription (ADR 071), and a guest's firehose is filtered at its `broadcast`
  grade because the connection's grade comes from `messageVisibilityOf`. Narrowing it would only
  remove ADR 616's live view, so the ceiling narrows `can_coordinate`, `can_create_agents` and
  `can_flag_urgent` only.

## Observability & Evaluation

- **Traces:** refused calls are audited (`forbidden`, reason "talk-only seat"), and ceiling changes
  are audited `member.ceiling_set`. Together they answer "who was stopped from what, and who lifted
  it".
- **Eval:** the build lane's done-when. A guest admitted by a default invite can send `message` and
  `ask` and reply to an ask addressed to it. It is refused `lane_claim`, `team_goal_declare`,
  `handoff` and `team_agent_create`, each with "talk-only seat". It is never offered those tools in
  `tools/list`, and it reads at `broadcast` grade. After `musterd member ceiling <name> none` it can
  claim a lane. A reconcile of a seat file for that member does not widen a guest.
- **Experiment:** n/a — an access rule chosen in the Cloud spec, not a hypothesis to measure.
