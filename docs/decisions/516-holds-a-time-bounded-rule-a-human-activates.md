# 516 — Holds: a time-bounded team rule only a human activates

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (fixed effect list plus one notice kind; 12h cap; agent proposals a later
  increment — answered 2026-10-05)
- Lane: `01M46S3Q4APZYRZMZ3HYNT522E` (goal `memory-and-rules`)
- Design: [docs/design/memory-and-rules.md](../design/memory-and-rules.md) §The rule store
- Builds on: ADR 172 (admins are human; enforced at the read since #2092), ADR 150 (PreToolUse
  gate), ADR 501 (halt — the human-only standing this mirrors), ADR 185 / 367 / 398 (team policy:
  sparse, hub-owned, replicated), ADR 259 (truth is the log; indexes are derived)
- Protocol change: yes (hard rule 1) — `Hold`, the `/holds` routes, `NextBrief.holds` /
  `NextSummary.holds`, audit verbs `hold.set` / `hold.lifted` (carried by the `policy` sync kind),
  refusal code `held` (increment 2)

## Context

Before the demo in the week of 2026-09-28, nick told one agent when the demo was. The agent
proposed pausing the daemon's autorefresh for the slot, and the mechanism existed:
`musterd service hold --auto --for 90m` writes `~/.musterd/autorefresh/hold-until`, the tick
honours it, and it clears itself at a 12h cap (`packages/cli/src/service/hold.ts`).

That hold had the right shape and the wrong reach. It records no author, the team never sees it,
and it lives on one machine. So the rule travelled the only way left: agents restated it in seat
memory, messages and handoff notes. Each restatement lost the end time, who said it, or what it
covered, until "pause the autorefresh for the slot" read as "nobody merges for a couple of hours".
nick then corrected seats one at a time. The design doc records the incident and the general
failure: a claim can spread with no author, no end and no way to take it back.

## Problem

A human has no way to tell the whole team "this is paused, by me, until then" that the team can
see, that ends on its own, and that a single act can lift. With nothing authoritative to point
at, agents re-state the rule in their own words and it outlives its author's intent.

## Decision

1. **A hold is a row, and "active" is derived.** New team-owned table `holds`: `id` (ULID),
   `team_id`, `effect`, `reason` (required, ≤ 280 chars), `created_by` (the human's member name),
   `created_at`, `expires_at`, `lifted_at`, `lifted_by`. A hold is active while
   `lifted_at IS NULL AND now < expires_at`. There is no timer and no status column: when
   `expires_at` passes, every reader stops seeing it at once, so no seat holds a copy that
   outlives it. Rows are never deleted; the history is the audit of every rule the team was under.
2. **A fixed list of effects, plus one notice kind.** `effect` is one of:
   - `autorefresh_paused` — the autorefresh tick does not bounce the daemon (today's hold).
   - `merges_paused` — the ADR 150 gate denies merge-shaped commands (increment 2).
   - `notice` — free text in `reason`, shown to every seat, **never enforced**, and labelled
     "notice — not enforced" wherever it renders.

   An enforced effect means exactly what its name says. A seat that tells another "don't merge"
   either points at a `merges_paused` hold or is stating a rule nobody set. New effects need an
   ADR. Scope is the team in this ADR; the column set leaves room for lane, seat or surface scope
   later without a migration of existing rows (`effect` and the scope are separate concepts).
3. **Only a human admin sets or lifts a hold. 12 hours at most.** `POST /teams/:slug/holds
   {effect, reason, until | for_ms}` and `POST /teams/:slug/holds/:id/lift` pass `authAdmin`, which
   since #2092 is human by construction (a non-human row resolves `is_admin: false`). A hold starts
   when it is set; `expires_at - created_at ≤ 12h` (`MAX_HOLD_MS`, unchanged). A longer freeze is a
   new hold, set deliberately. Lifting early is one call. Setting a second hold of the same effect
   while one is active is allowed; the effect is active while any is.
4. **The hub owns holds; joiners forward and fold, like policy.** On a joiner both routes forward
   to the hub (`/sync/holds`, node-authenticated, admin re-checked against the hub's roster), and
   an unreachable hub answers `hub_unreachable` rather than forking the rule. The hub writes the
   row and appends a replicated event in one transaction. `hold.set` / `hold.lifted` ride the
   existing `policy` sync kind — the kind for hub-minted Team rules, already refused from any node
   but the hub's own loopback — and the fold projects them idempotently on the hub's id. A hold set
   on any machine reaches every machine's autorefresh tick, which today's local file never did.
5. **One act tells every seat; the brief shows it until it ends.**
   - Setting and lifting each deliver one server-composed `message` from the human to `@team`
     with `meta.hold = {id, effect, expires_at, lifted?}` — so the change is in every seat's next
     `team_inbox_check`, once.
   - `NextBrief.holds` and `NextSummary.holds` list active holds (effect, reason, author, ends at,
     time left), so `team_next`, the orient block, `musterd next` and `musterd status` carry them
     for as long as they are active and drop them the moment they are not. The SessionStart orient
     block shows effect, author and time left but not the reason — free text written by someone
     else stays out of that block (ADR 088) — and points at `musterd hold list` for it.
   - `meta.hold` is server-controlled: a client-supplied copy is stripped (the ADR 225 rule), so a
     seat cannot announce a hold nobody set.
   - `GET /teams/:slug/holds` (any member) lists active holds; `?all=1` includes ended ones.
   - `/live` shows active holds as a banner from the same read.
6. **Enforcement, and its honest limits.**
   - `autorefresh_paused`: the tick asks its local daemon for active holds (as the service seat)
     before it would bounce; any active one means "<effect> by <human> until <time>: <reason>" and
     no bounce. An unreadable answer is no hold, never a freeze. The local `hold-until` file is
     retired: `musterd service hold --auto --for|--until [--reason]` now sets a server hold as the
     human running it (an agent seat is refused, by item 3), and `--release` lifts it. A file
     already on disk is honoured until it ends (≤ 12h) and is never written again. A manual
     `musterd service refresh` still proceeds with a warning, as today; the guardian still
     restarts a daemon that is down.
   - `merges_paused` (increment 2): the gate's `GET /enforcement` response gains the active holds,
     and the client gate denies merge-shaped commands (`gh pr merge`, a push to `main`) with the
     hold's sentence. Like every ADR 150 path except halt, a gate that cannot reach the daemon
     fails open. A GitHub auto-merge armed before the hold is outside musterd's reach; the hold's
     message says so.
   - `notice`: nothing is enforced, and every rendering says so.
7. **No MCP tool sets or lifts a hold** (ADR 501 §5's reasoning: a tool an agent could call is a
   tool an agent could call). Agents read holds; humans set them from the CLI
   (`musterd hold set|lift|list`) and, later, /live.
8. **Agent proposals are a later increment.** A seat that thinks the team should pause something
   will propose it as an `ask` (species `approve`) carrying `meta.hold_proposal`; a human admin's
   `accept` activates it, on the `gateAskHumanAnswer` pattern (decider must be a human admin).
   Until then an agent asks in prose and the human sets the hold.

Protocol: `Hold` and `HoldEffect` schemas in `@musterd/protocol`; `NextBrief.holds` and
`NextSummary.holds` optional (omitted means the daemon does not report holds); routes in
`02-protocol.md`; audit verbs `hold.set` / `hold.lifted` on the `policy` sync kind; refusal code
`held` for an enforced effect's deny (increment 2, with the first effect that refuses a call). SPEC
Appendix A.15 is the normative text.

Increments: **1** — table, routes, replication, brief/summary/members/`/live` banner, the
autorefresh tick reading server holds, `musterd hold`, the `service hold --auto` rewire.
**2** — `merges_paused` in the gate. **3** — agent proposals. **4** — set and lift from /live.

## Consequences

- _Dated note (2026-10-05, increment 2, lane 01M471RXBV):_ `merges_paused` is enforced, with one
  change of mechanism from Decision 6's wording. The hook does not read holds off `GET /enforcement`
  and decide locally; it matches merge-shaped commands locally (`isMergeShapedCommand`: `gh pr
  merge`, a `git push` naming `main`/`master`) only to decide whether to ask, then calls
  `POST /holds/check`, where the daemon re-tests the command and decides. Reasons: a deny is then
  the server's (the ADR 513 posture — a client cannot widen or soften it), it is audited
  (`action.gate`, target `hold:merges_paused`, `detail.cause: 'hold'`, outcome `denied_held`), and
  every other tool call keeps exactly the round trips it had. Humans are not gated, as at the ADR
  513 route gate. A bare `git push` is not matched: which branch it lands on is not in the text, and
  a hold that guessed would deny branch pushes. Unreachable daemon → fail open, as Decision 6 says.
- The demo case becomes one command — `musterd hold set autorefresh_paused --for 90m --reason
  "demo 14:00"` — that every seat sees with an author and an end, that clears itself, and that
  no agent can widen into "nobody merges", because that would be a different effect nobody set.
- The `hold-until` file goes away. Anyone who relied on holding one machine without telling the
  team loses that; that invisibility is the defect this fixes.
- A hold is only as visible as the surfaces that render `NextBrief.holds`. A harness that never
  calls `team_next` or `team_inbox_check` sees it only when the gate denies something.
- `notice` is deliberately weak. It exists so "please leave the deck alone until 3" has an
  author and an end instead of becoming a rumour; it carries no authority to deny anything.
- Lane 3 of the goal (check on read) can now give a seat's stored "freeze" claim a verdict:
  points at an active hold, points at an ended one, or points at nothing.
- Halt (ADR 501) does not replicate today (its standing lives on the issuing daemon only). Holds
  do not copy that; the gap is noted for its own lane, not fixed here.
  Follows-up: `01M46VYZ84DWBYDAC2ABDYWEMD`

## Observability & Evaluation

- **Traces:** audit rows `hold.set` and `hold.lifted` (replicated ledger verbs) with
  `{effect, expires_at, reason}`; the team `message` acts carrying `meta.hold`; an autorefresh tick
  that stands down logs the hold id; increment 2's gate denials write `action.gate` with
  `detail.cause: 'hold'`.
- **Eval:** the incident's own measure — how many seats a human has to correct one by one after
  a pause. Baseline: the demo week, where nick corrected seats individually (count to be read
  from the message log in lane 3's survey). Target: zero corrections for a pause set as a hold.
  Secondary: count of seat messages asserting "don't merge / freeze" with no active hold
  (lane 3 measures this; this ADR makes it computable).
- **Experiment:** the next demo or freeze is set as a hold; record whether any seat restates it
  past its end and whether any human correction was needed.
