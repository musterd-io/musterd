# 503 — The launcher catalog is roster-first: every member shows, and residence decides what a row can do

- Status: accepted
- Date: 2026-10-03
- Deciders: nick (asked for it after the second-machine run, 2026-10-03), stanley (lane
  `01M41PKM82RN1JQY7XYPQCT2GW`)
- Amends: [ADR 491](491-seat-launcher.md) Decision 7 (the catalog's source) and the Decision 6 /
  §4.7 "on the team · not here" rows
- Relates to: [ADR 358](358-human-seat-trusts-a-set-of-machines.md) (an agent seat lives on one machine),
  [ADR 393](393-residency-enrollment-projects.md) (residency names the host), [ADR 456](456-team-agents-connect-authority.md)
  (a sponsor is accountable for an agent), [ADR 447](447-team-first-workspace-layout.md) (the
  layout the catalog scans), [docs/guides/second-machine.md](../guides/second-machine.md)

## Context

ADR 491 Decision 7 defines the seat catalog as "every Workspace on this machine": `config.bindings`
plus a scan of `~/musterd/<team>/<project>/<member>`. The team roster is an overlay on those rows,
read time-boxed after the first paint, used to mark a seat live `here` or `on <node>` and to draw an
"on the team · not here" list under a project once the human has a seat there.

On 2026-10-03 nick opened bare `musterd` on Air 2, the second machine, after five seats had moved
there. The picker showed those five. The other nineteen members of revive were absent or buried
under a project level nick had no reason to descend to. The question that followed: shouldn't the
front door show the whole team, wherever each member lives, and let the machine decide only which
rows it can start?

Two facts make the current shape worse than incomplete:

- **A "not here" row is a setup, and a setup is a move.** Picking a team-only row runs the
  `musterd agent` path: it provisions a Workspace here and the seat's next act binds it to this
  node (ADR 358). For a seat resident on another machine that is a silent move — the exact act the
  second-machine guide spends a section making deliberate (`residency off` + `node unbind` on the
  hub first). The only guard is the live-Presence y/N of Decision 6, which an offline seat passes.
- **The roster already knows more than the catalog asks.** A `MemberSummary` carries each
  presence's `node` and `node_label`, `sponsored_by`, and whether the seat is enrolled for wake;
  residency records the one host a seat is enrolled on. None of it reaches a row unless the seat
  also has a folder here.

## Problem

The catalog's unit is a folder, so the picker answers "what is set up on this disk" when the
person asked "who is on my team, and which of them can I start from here". A member with no folder
here is invisible or an accidental move; a member with a folder here but resident elsewhere looks
launchable. Two machines named `mac` make the hostname labels the picker leans on ambiguous as
well (second-machine findings, 2026-10-03).

## Decision

1. **The catalog's unit is the member, not the folder.** For every team this machine knows
   (`config.identities`, `knownIdentities`, and any Workspace here), the catalog is the team's
   roster, every member of it, overlaid with the Workspaces found on this machine. A folder with no
   roster member stays a row (with its existing `problem`); a member with no folder is a row too.
   When the roster read fails or times out, the catalog falls back to today's folder-only set and
   the picker says so in its receipt line.

2. **Each row carries `where` and `can`, both derived, never stored.**

   | `where`     | Meaning                                                                 |
   | ----------- | ----------------------------------------------------------------------- |
   | `here`      | resident on this node (residency host or a live presence on this node)  |
   | `node:<id>` | resident on another enrolled node; the label is the node's, not a hostname |
   | `cloud`     | resident on a cloud seat node (ADR 475 / the `delta` shape)             |
   | `nowhere`   | no residence and no presence anywhere                                   |

   | `can`    | When                                                                                                 | `⏎` does                        |
   | -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
   | `launch` | a Workspace exists here and `where` is `here` or `nowhere`                                           | ADR 491's launch, unchanged     |
   | `wake`   | `where` is another node or cloud, the seat is wake-enrolled, and the viewer is its sponsor or an admin | sends a `steer` (the doorbell) |
   | `setup`  | `where` is `nowhere`, no Workspace here, and the viewer has a seat here                              | the `musterd agent` path, as today |
   | `none`   | otherwise — resident elsewhere and not yours to wake                                                 | nothing; the row names where it is |

   Sponsorship is ADR 456's `sponsored_by`; a human seat is its own sponsor. A seat resident on
   another node is **never** `setup` from here: moving it is the guide's ceremony, and the row's
   detail line names it (`resident on <node> — move it: musterd residency off + node unbind there`).

3. **The picker's levels read the same catalog.** The recent and team levels gain nothing new; the
   project level's two headings become `on this machine` and `on the team` (the "· not here" suffix
   goes), and every member appears once under one of them with its `where` label and a dimmed
   `can` verb. `musterd seats [--json]` prints `where` and `can` per row. Decision 6's live-seat
   confirm is unchanged for `launch`.

4. **Nothing secret, nothing slow, moves.** The roster read stays the unauthenticated, time-boxed
   `GET /teams/:slug/members` of ADR 491 §5.1; `where` and `can` are computed from fields already in
   `MemberSummary` plus the machine's own `host-registry.json`. The snapshot in `launcher.json` may
   cache `where`/`can` as plain strings; it carries no node credential. The first paint is still
   from the snapshot; the import-closure test still holds.

5. **One protocol addition, gated here.** `MemberSummary` gains an optional `residence` object
   (`{ node, node_label, kind: 'node' | 'cloud' }`) so the roster states where a seat lives even
   when it has no live presence — today only residency's `host` string says, and it is a hostname.
   This is the one schema change and this ADR is its gate (hard rule 1).

## Alternatives rejected

- **Keep the folder catalog and widen "not here".** Leaves the silent-move row in place and still
  shows a member only once a project is descended into. The person's question is team-shaped.
- **A roster-only catalog with no folder scan.** Loses the rows that catch a broken or orphaned
  binding (`problem`), which the folder scan exists to surface.
- **Let `setup` move a resident seat with a stronger confirm.** A y/N is not the ceremony; the
  guide shows what skipping `residency off` + `node unbind` costs (`403 bound_elsewhere`, a wedged
  push). A move stays an explicit admin act.

## Consequences

- Air 2 and the hub show the same twenty-four members; what differs per machine is each row's
  `can`. The roster, not the hostname, labels the node, which also closes the `mac.lan` ambiguity
  the second-machine findings record.
- A sponsor can wake their agent from any machine they have a seat on. That is a new path for
  `steer` to be sent from the picker; it uses the viewer's own credential and is logged like any
  directed act.
- `MemberSummary.residence` is a protocol addition (Decision 5). Older adapters ignore it.
- `docs/design/figma-brief-terminal.md` gains frames for the two headings and the `can` verbs;
  snapshot tests enforce them (hard rule 2).
- Increments: (1) the protocol field and the server filling it from residency; (2) `where`/`can` in
  the catalog and `musterd seats --json`; (3) the picker's headings, labels and the `wake` action;
  (4) frames and snapshots. Each is a lane under goal `seat-continuity`; this ADR's lane is the
  decision only.
- **2026-10-04 — increment 1 landed (lane `01M41Q4YTD`, PR #2055).** `MemberSummary.residence` is
  derived from the seat's earliest unrevoked node binding (ADR 358 `seat_nodes` → `nodes`), **not**
  from `residency.host`: that column is the hostname string the enrolling actuator declared, and on
  revive five seats bound to Air 2 still read `host = mac.lan`. `kind: cloud` is set only for a seat
  bound to the answering daemon's own node while it runs in cloud mode (ADR 475); a sponsor-hosted
  joiner such as `delta` (ADR 463) enrolled as an ordinary node and reads `node` — marking it `cloud`
  would need a fact the node row does not carry. An enrolled seat with no unrevoked binding reads
  `null` (enrolled, nowhere bound), distinct from an older daemon's absence.

## Observability & Evaluation

**Traces.** The picker's existing receipt line gains the row's `where`/`can`. A `wake` from the
picker is an ordinary `steer` and carries the launcher's `MUSTERD_LAUNCH_SURFACE` marker in
`meta` so the share of doorbells rung from the front door can be read later. No new span kinds.

**Eval.** Success is: on a joiner and on the hub, `musterd seats --json` lists the same member set
for a shared team, every row has a `where` and a `can`, and no row of a seat resident on another
node reads `setup`. Baseline: today's output on Air 2 (five rows) against the hub (nineteen).
Falsify: a `setup` row for a seat whose residency host is another node, or two machines listing
different member sets for one team while both roster reads succeeded.

**Experiment.** After increment 3, nick opens bare `musterd` on Air 2 and on the hub and names,
without a hint, which seats he can start from each. The guide's done-means item 5 (residency
truth) is then read from the picker instead of `residency status`.
