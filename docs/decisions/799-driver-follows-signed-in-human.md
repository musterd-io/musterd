# 799 — a seat's driver follows the human signed in on its node

- Status: accepted
- Date: 2026-11-04

## Context

[ADR 021](021-driver-co-presence.md) added `presence.driver`: the name of the human steering an agent session, sent on `hello` and rendered as `driven by <name>`. Its source is a label resolved once at config load — `MUSTERD_DRIVER` (manual override) else `binding.json`'s `driver`, written once by `musterd agent --driver` ([ADR 165](165-worktree-family-mcp-entry.md) increment 2). `packages/mcp/src/config.ts` resolves it once (`driver: resolveDriver(env) ?? binding?.driver`); `packages/server/src/store/presence.ts` records it at attach and re-writes the same value on heartbeat. Nothing ever changes it inside a session. <!-- vocab:ok -->

On 2026-10-28 (slippy, macbook-air-2) that static label produced a wrong record: nick drove the session, then swetha signed in on the same machine and kept going. The seat had no driver bound, and the human signed in on the machine never reached the seat, so the agent guessed nick for swetha's requests — and lane `requested.by` (write-once) was recorded from that guess. The accountability chain this goal promises (who asked → who claimed → which model → who accepted → who signed off) starts with a guess whenever the human at the keyboard is not the human named at wire time.

Two lease-like signals already name the human present on a node, and neither reaches `presence.driver` today:

- a signed-in `/live` browser session from that machine (`packages/server/src/store/browserSessions.ts`, [ADR 722](722-hosted-live-browser-session.md) — a revocable browser session per team origin, bound to a member);
- a human member's own live presence from the `musterd` CLI on that machine (the human workspace attach behind `inbox --watch`, `board`, and the like — a `presence` row carrying the human's `member_id` and `node`).

## Problem

`presence.driver` answers "who is steering this seat?" from a provisioning-time label instead of from the human currently signed in on the seat's node. It is wrong whenever the human changes without the workspace being re-wired, and every consumer of the driver inherits the error: the roster's `driven by` line and derived human presence ([ADR 155](155-human-presence-ladder.md)), the style block a seat replies in, acceptance routing, and `requested.by` on lanes opened from that seat's work. The agent is left to infer who is typing, and the inference lands in a write-once field.

## Decision

`presence.driver` is resolved by the daemon from the human currently holding a live lease on the seat's node, and updated in place when that human changes. The wire field, column, and rendering do not change; the source and lifetime do. This supersedes ADR 021's "resolved once at config load and sent on `hello`" as the source of the value; ADR 021's Decision stands unedited, and its rejection of a paired human presence row still holds — the driver remains a label on the agent's own presence, never an impersonation.

1. **Lease sources.** A human holds a node lease while either is live for that node: (a) a signed-in `/live` browser session bound to that human member, or (b) that human member's own live CLI presence on that node. The most recently established (or refreshed) lease wins when more than one human holds one.
2. **Daemon-resolved, updated in place.** The daemon derives each agent presence's `driver` from the winning lease on its `node` and updates the presence row when the winner changes — no re-`hello`, no session restart. A seat running through a handover at the keyboard (nick → swetha) reads the new driver on its next roster/style read.
3. **No lease, no driver.** When no human holds a live lease on the node, `driver` clears to null rather than holding the last value. A stale name is the bug being fixed; an absent driver degrades to ADR 021's `(session)` render, as today.
4. **Static label demoted to fallback.** `MUSTERD_DRIVER` / `binding.json` `driver` no longer outrank a live lease. Where no lease exists (a headless or hosted seat with no human on its node), the static label still names the sponsoring human, exactly as today. The adapter keeps sending it on `hello`; the daemon treats it as the floor, not the answer.
5. **Write-once fields keep their history.** `requested.by` and other recorded attributions are not rewritten when the driver changes. Lanes opened under nick stay nick's; lanes opened after swetha's lease wins record swetha. The fix is that the value is read from the lease at open time, not guessed — not that history is repaired.

Implementation is daemon-side derivation over rows the daemon already holds (`browser_sessions`, `presence`), so no protocol change is needed: `HelloFrame.driver` and `PresenceSchema.driver` already carry the field. The MCP adapter's `resolveDriver()` keeps its contract (it still never invents a driver); it simply stops being the last word.

## Consequences

- The roster, style block, acceptance routing, and `requested.by` follow the human actually signed in, including mid-session. No agent infers who is typing, and nothing about the driver needs to live in seat memory.
- Two humans of one team signed in on one machine at once — never previously considered — resolves as "most recent lease wins" for every seat on the node. If both stay active, the driver follows whoever refreshed a lease last. Per-seat driver assignment is not built; if that case ever matters it needs its own decision, not a silent widening of this one.
  Follows-up: deferred — per-seat driver assignment, if two humans routinely share one node (2026-11-04)
- A driver now lapses. Closing `/live` (or its session expiring) and ending the CLI attach both end the lease; seats on that node lose `driven by` until a human signs in again or the static fallback applies. That is the honest roster ADR 021 wanted, at the cost of the label flickering with browser sessions where the static label never moved.
- The daemon gains a derivation it must keep cheap: it runs over live presence and browser-session rows it already reads for the roster, not a new sweep.
  Follows-up: 01M61SG4608MWC9XV8H56DC8V8

- _(2026-11-04, build note)_ Implemented as read-time derivation in the roster, live-driver, and style reads (`liveNodeDrivers` in `packages/server/src/store/presence.ts`) rather than a background row rewrite — the same observable reads, no sweep. The `/live` browser-session lease reads `browser_sessions` only when that table exists; until ADR 722 increment 1 lands it, the human-presence (CLI) lease alone decides. A presence counts as a lease only while connected (`conn_id` set) — an ambient HTTP touch is not a sign-in. The ADR 155 steering set (`listLiveDrivers`) is unchanged: only the explicit hello label marks a human steering/working, since co-presence on a node is not proof of steering every seat there. _(2026-11-04, review fix)_ §3 now holds as written: a node that ever had a human presence and has none live clears its seats' driver to null; the static label survives only on a node that never had a human (§4). _(2026-11-05, review fix)_ An earlier build used a 24h window for "had a human"; cider's review showed the stale name reviving after it, so the window is dropped — "ever recorded" is the rule, in both the roster and style reads.

## Observability & Evaluation

- Traces: `presence.driver` is already on the roster read and in the presence record; a driver change is visible as the row's value changing without a new attach. No new audit kind is added by this decision — if the build needs one to debug flapping, it names it in its own lane.
  Follows-up: 01M61SG4608MWC9XV8H56DC8V8
- Eval: the falsifier is the 2026-10-28 scenario replayed — human A drives a seat, human B signs in on the same node (browser session or CLI attach), and the seat's next `requested.by`, style block, and roster line name B without a restart; with no lease live, the driver reads unset rather than A.
- Experiment: n/a — this corrects an attribution source against a recorded incident; there is no rate to pre-register beyond the replay above.
