# 521 — The opencode observeModel probe gets its caller in the refresh path

- Status: accepted
- Date: 2026-10-05
- Deciders: ghost (lane `01M473A74GMEPKYXZCP5ZD7ZQ3`, handed over by dreamy who reported it and recused from the call)
- Relates to: ADR 158 (observation beats declaration), ADR 383 (cursor's unmeasurable probe was removed), ADR 392 (the opencode doorbell plugin that shells the refresh), ADR 068 (no claim at boot)

## Context

Dreamy measured on the live daemon that both opencode seats attest `binding` while every
`observed` seat is claude-code or codex (lane `01M473A74GMEPKYXZCP5ZD7ZQ3`). Two structural
misses, both verified in the source:

1. `refreshModelObservation` (`packages/cli/src/commands/session.ts`) bails on
   `!session?.transcript_path`. It is the only in-session re-probe, it runs from
   `inbox --interrupt-check` at every tool boundary, and opencode has no transcript file —
   sessions live in `~/.local/share/opencode/opencode.db`. So it returns `undefined` on every
   opencode call, silently.
2. The other caller, `musterd session start`, is a hook opencode never fires. The doorbell
   plugin registers only `tool.execute.after` and `session.idle`.

Meanwhile the probe itself is sound: the opencode harness's `observeModel` reads the live
`session_v2` row for the workspace directory out of `opencode.db` (dreamy's #2106 fixed the
table name). It takes no transcript argument. And `shouldWarnUnobservedModel` nags opencode
seats about a probe that cannot run — the exact shape ADR 383 removed for cursor.

## Problem

`observeModel` is declared on the opencode harness and listed in `PROBE_CAPABLE_SURFACES`,
but nothing on the opencode surface ever calls it. Either the refresh path learns to call it,
or the declaration is dishonest and should go the way of cursor's.

## Decision

**Wire the caller (option (a)).** Cursor had no observation source; opencode has one already
written and tested, so ADR 383's removal does not transfer.

1. **The seam is the refresh bail, not the plugin.** In `refreshModelObservation`, when the
   binding has no transcript to re-read, ask the harness that owns the workspace directly
   instead of returning `undefined`. The opencode probe self-selects — it returns `undefined`
   outside its own sessions — so the branch is a no-op everywhere else. Gated on the opencode
   workspace marker so non-opencode seats pay one file check, not a subprocess.
2. **Reuse the existing contract.** The same throttle (`OBSERVATION_REFRESH_MS`), the same
   never-throw / never-erase rules, the same `model_observed` write. A `session start` hook
   for opencode is explicitly out of scope: there is no hook to hang it on, and ADR 068's
   no-claim-at-boot reason stands untouched.
3. **Thread the directory through.** The opencode probe reads `process.cwd()` today; it takes
   an optional working directory instead, so a refresh for a `dirHint` that is not the
   process cwd queries the right workspace. Same query, same 120-char clamp.
4. **Read whichever session table the major uses.** The table moved: `session_v2` on 2.x,
   `session` on 1.18.x (measured on 1.18.34 — no `session_v2` there at all; same columns
   where it matters). The probe picks by `sqlite_master`, preferring `session_v2`. Dreamy's
   #2106 renamed one way unconditionally, which would have left 1.18.x seats dark.
4. **No wire change.** `model_observed` and `model_source` are untouched; opencode seats move
   from `binding` to `observed` the way every other probed harness does, and
   `shouldWarnUnobservedModel` becomes meaningful there instead of nagging about the unreachable.

## Alternatives rejected

- **(b) Drop the probe like ADR 383.** That ADR removed cursor's probe because no measurement
  existed behind it. Here the measurement exists (`session_v2` by directory, bounded tail
  read via the `sqlite3` CLI the trace tap already shells). Dropping it would trade
  permanently-declared opencode models — ghost's and dreamy's attestation feeding the ADR 056
  diversity conclusions — for symmetry with a different harness's different facts.
- **Claim at boot / wire `session start` for opencode.** There is no SessionStart-shaped hook
  on either plugin shape (v1 returns tool/event hooks; v2 registers domain hooks and event
  subscriptions). Bolting one on would be a second feature to serve the first; the per-boundary
  refresh already runs where it is needed.

## Consequences

- Opencode seats attest `observed` once the refresh has run in a live session. The nameplate
  `?` dreamy reported goes away for the reason it should: a probe ran.
- The multi-session-same-directory caveat stands: the query takes the most recently updated
  row for the directory, the same approximation class as transcript enumeration's warm
  neighbour. A mid-session model switch re-attests within the refresh window, which is better
  than the start-only observation this replaces the absence of.
- If the `session_v2` row proves unreliable live (v2 session store moves, shared directories
  misattribute), the fallback is (b): remove the probe and the surface from
  `PROBE_CAPABLE_SURFACES` per ADR 383, with the measurement in the new ADR's Context.

## Observability & Evaluation

- **Traces:** none new. `model_observed` writes are the existing binding field; the daemon
  roster shows the source flip.
- **Eval:** on a live opencode seat, `binding.model_observed` gains `{model, harness:
  'opencode'}` with a fresh `observed_at` after one tool call, and the seat reads
  `model_source=observed`.
- **Experiment:** the falsifier is an opencode seat still at `binding` after tool calls with
  a live session row in `opencode.db`, or a switch that does not re-attest within twice the
  refresh window. Either reopens this lane toward (b).
