# 514 — Agent style: an admin-owned floor and per-human dials, resolved by the daemon

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (brainstorm 2026-10-05: preferences travel with the human; the stance floor is
  team policy admins configure; dials are every human's), stanley
- Lane: `01M46MQD2FXXJ1RVTDCN6XW7WK` (increment 1 of 6, Goal `agent-style`)
- Spec: `docs/superpowers/specs/2026-10-05-agent-style-design.md`
- Relates to: ADR 476 (verify before conceding — the stance this makes a floor), ADR 085 (one fact
  per guidance layer), ADR 185 (sparse team policy), ADR 417 (a seat attests the guidance it runs),
  ADR 443 (`members.doorbell_prefs`, the per-human prefs precedent), ADR 021/155 (the driver)

## Context

Stance guidance exists as one bullet in the skill (`guidance.ts` v41, agent-style lane
`01M44BNJRF`): assess before you agree, push back once with the reason, then commit, no opening
praise. It is one rule, in one static file, for everyone. Format is the harness's: nick's Claude
Code output style is `Concise`, and it covers one harness on one machine. Nothing lets a human say
how seats should talk to _them_, and nothing lets the team's admins change the stance rule without
a rebuild and a guidance refresh that reaches a Workspace only on `musterd init`
([guidance distribution](../wiki/guidance-distribution.md)).

The daemon already speaks to every seat at session start: the `team_join` reply carries live text
(the seat-memory headline), on every harness, current as of that call. The presence row already
knows the Workspace's driver.

## Problem

Make "how a seat talks" a thing the team owns and a human tunes — harness-independent, current
without a reprovision, with the stance rules of ADR 476 kept as a floor no preference can lower —
without adding a second home for a fact the skill already states.

## Decision

1. **Style has two layers.** The **floor** (four stance booleans) and the **team defaults** (four
   dials: `pushback`, `bluntness`, `length`, `format`) plus a team prose addendum are **team
   policy**: `PolicySchema.style`, dense on read and sparse on the wire and in the row (ADR 185),
   written by admins through `POST /policy`, audited as `policy.change`. A human's own **dials and
   prose** are `members.style_prefs`, written only by that human for themselves. Agents have no
   preferences.
2. **A preference never lowers the floor.** `resolveStyle(policy, prefs)` reads the floor from
   policy alone; prefs supply dials and prose. The shipped defaults are every floor boolean on and
   `when-it-matters · plain · normal · prose`. An admin may turn a floor boolean off; the audit row
   says who.
3. **Prose is capped at five lines and 800 characters**, team and human alike, inclusive; a longer
   prose is refused with the count (`styleProseProblem`, surfaced through the schema issue). Every
   line-break form counts as a line (CRLF, LF, lone CR, VT, FF, NEL, LS, PS), and the block prints
   prose as one JSON-quoted line, so prose can never shed its label.
4. **The resolved style has an epoch**: eight hex characters of sha256 over the floor, the human's
   dials, the team's default dials and both proses — everything the block prints, so an admin moving
   a default a human has overridden still re-sends the block. The addressee's name is not in it. A seat attests the epoch it is running (increments 2–3), the ADR 417 shape.
5. **One renderer, in protocol.** `renderStyleBlock` prints the block a seat reads: floor first,
   team prose, the driver's dials and prose labelled with their name, then what `@team` and the
   record get. With no driver it says so and names the fix. Where the block is delivered is
   increment 3's work; this ADR fixes what it says.
6. **Scope of a preference** (spec §2): the chat with that human and any act addressed to them.
   Team-addressed and peer-addressed output stays the team default.

## Consequences

- Protocol gains `style.ts` (schemas, `resolveStyle`, `styleEpoch`, `renderStyleBlock`,
  `describeDials`, `styleProseProblem`) and `PolicySchema.style`. Additive optional policy key: no
  protocol-version bump (the ADR 044 precedent for additive optional fields).
- The skill's push-back bullet (`guidance.ts` v44) now names the coming block and leaves in
  increment 3, when the block ships — the only window in which the fact would otherwise have two
  homes.
- Server (`members.style_prefs`, the self route, `presence.style_epoch`), MCP (the block on
  `team_join` and on epoch change, `team_members.style`, `team_style`/`team_style_set`), CLI
  (`musterd style`, `musterd policy style`), web and the readout are increments 2–6, each a lane
  under `agent-style`: `01M46MQPQ3JC6EWMY7WV6SY8AA`, `01M46MQQFS3W2W4N37S7BB9RX5`,
  `01M46MQR8F6E6G9BRX0JMY8CMH`, `01M46MQSMJFBNGS0QE4PHVTXWT`, `01M46MQW7GV4BD3SV9HDKDRETV`.
- Harness-native renderers (writing a harness's own format knob from the dials) are deferred with a
  dated trigger: the first readout, thirty days after increment 3, showing the `length` dial not
  moving what reaches the human.

## Observability & Evaluation

- **Traces:** no new spans in this increment. The evidence later increments add is structured:
  `presence.style_epoch` (increments 2–3) beside `guidance_epoch`, the `policy.change` audit row
  when an admin edits `style`, and the self route's audit row when a human sets a dial. Chat stays
  off the record (ADR 476).
- **Eval:** dataset = every `ask` / `message` / `handoff` addressed to a human in `messages`, with
  the recipient's `length` dial and the sender's attested `style_epoch` at send time; baseline =
  body-length distribution per human over the thirty days before increment 3 lands (every seat at
  the shipped epoch, no dials set). Success = after a human sets `concise`, their inbound bodies are
  shorter than the baseline median and than the same seats' `normal`-dial recipients; failure = no
  difference by dial. Alongside it, ADR 476's own eval (unverified-concession share, `challenge`
  decline rate) is read split by `style_epoch`, so an admin's floor change reads as a before/after.
  Readout: `pnpm style:readout` (increment 6) under ADR 294 — channel and denominator on every
  number, no per-seat leaderboard.
- **Experiment:** thirty days after increment 3, read the eval. Falsifier for the design: no human
  has set a dial, or the `length` split shows no difference. Then the block has no standing with the
  models and the deferred alternative (harness-native renderers) is the next increment.
