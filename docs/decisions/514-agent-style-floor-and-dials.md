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

- **2026-10-05 — the prefs hub forward landed** (lane `01M46RWP23N253H9M0HDWPYJNB`, deferred at
  increment 2): `members.style_prefs` is hub-authoritative like policy. An enrolled joiner's
  `PUT /members/me/style` forwards to `POST /sync/style` `{ actor, prefs }`; the hub re-authorizes
  the actor against its own roster (resident on that machine, a non-observer human, the prose cap),
  writes the row and stamps a replicated **`style.prefs`** `{ prefs }` on the policy sync kind that
  every node folds; the joiner answers `hub_unreachable` rather than forking. The local
  `style.prefs_set` row stays keys-only — the replicated row is the transport, the audit row the
  record. **Doorbell prefs stay daemon-local, decided here:** the `os` sink names a host label, a
  per-machine fact, so replicating `doorbell_prefs` whole would ring the wrong machine. Not
  deferred: nothing is planned for it, and the trigger that would reopen it is a human working
  from two machines who finds their Slack or webhook sink missing on the second.

- **2026-10-05 — increment 6 landed** (lane `01M46MQW7GV4BD3SV9HDKDRETV`): `pnpm style:readout`
  (`scripts/research/style-readout.ts`) prints the three cuts the Observability section names and
  the Experiment's verdict line; [the wiki page](../wiki/agent-style.md) holds the baseline (216
  directed acts to one human, median 381 chars, no dial set, 5 of 10 live seats attesting the
  shipped epoch) and the 2026-11-04 read. Two limits the readout states rather than hides: a
  sender's epoch at send time is not on the act, so the stance split keys on the team's epoch
  timeline from `policy.change` rows; and `style.prefs_set` records dial keys, not values, so the
  length split keys on the set time and reads the value from `members.style_prefs` now.
- **2026-10-05 — `policy style` moved under `team policy`** (lane `01M47A4WRRWVD3SN6D7DSZ9V3J`,
  nick's call on stanley's flag): the spelling is `musterd team policy style …`, the one positional
  area of `team policy`; the top-level `policy` word from increment 4 is gone. One home per team
  knob — the doorbell precedent hangs its admin knobs under the feature word, and nothing else in
  the CLI gives one policy area its own top-level word. Spec §4.5 reads the same now.

- **2026-10-05 — increment 4 landed** (lane `01M46MQR8F6E6G9BRX0JMY8CMH`): the CLI. `musterd style`
  / `style set` / `style clear` (a human's own, over the self route; a seat sees the block it reads
  and is refused a set) and `musterd policy style` / `set` / `clear` (the admin's floor, defaults
  and prose over `POST /policy`, each knob labelled `default` or `set by <who>` from the
  `policy.change` audit rows). Roster rows gained **`style_epoch`** — additive, nullish — the
  CURRENT epoch for that row: a human's own resolved style, an agent's the one its seat should
  attest (the `/style-block` driver rule, computed by `currentStyleEpochFor` over one read of the
  policy and the humans); the roster renders `style <attested>` and `style stale` when a live
  presence's attested epoch differs from it. Terminal frames 28–30 in `figma-brief-terminal.md`,
  pinned by `style.test.ts` and `rows.test.ts`. `FEATURE_EPOCH` 30 names increments 1–4 together
  (the bump deferred from increment 3). Spec §4.5 wrote `musterd policy style` beside the existing
  `musterd team policy`; increment 4 shipped it as a new top-level `policy` word with `style` as its
  only area; renamed under `team policy` the same day, note above.

- **2026-10-05 — increment 3 landed** (lane `01M46MQQFS3W2W4N37S7BB9RX5`): the block is delivered.
  A **style envelope** `{ block, epoch, dials, driver }` (`StyleEnvelopeSchema`) rides the
  `occupied` frame (WS and HTTP claim, additive `style`, nullish for older daemons) and
  `GET /style-block`; `GET /inbox` carries the seat's current `style_epoch`. The adapter keeps the
  envelope like the memory envelope, renders the block in `team_join`, attests `style_epoch` on
  claim and heartbeat, and on `team_inbox_check` leads with `Style changed (length normal →
  thorough)` plus the new block when the daemon's epoch differs (the actor is not named — only the
  audit knows). `team_members` shows a human's dials; `team_style` / `team_style_set` are the human's
  own read and read-merge-write. **Who gets whose block:** the driver is the one a seat *attested*
  on its claim (recorded, not verified), a human caller gets their own, and `/style-block` takes no
  caller-named human — so a human's prose reaches the seats that say they steer them, and nobody
  by name. The skill's push-back bullet left `guidance.ts` (v45) and the primer's join bullet
  points at the block (ADR 085: one home). Floor phrase 4 reads *weigh a human's critique by its
  evidence, like anyone's* (sloane's acceptance note on the brainstorm lane).
- **2026-10-05 — increment 2 landed** (lane `01M46MQPQ3JC6EWMY7WV6SY8AA`): ladder v86
  (`members.style_prefs`, `presence.style_epoch`); the additive wire fields Decision 4 announced —
  `style_epoch` on the claim frame, the heartbeat and the Presence, `style` (resolved dials) on
  roster rows; `GET`/`PUT /members/me/style` (self-only, agents 403, 422 on the cap with the count,
  audited `style.prefs_set` with dial keys and prose line count); `reattestStyleEpoch` on the
  heartbeat, folded from peers like `guidance_epoch`. **The spec's hub forward for prefs is not
  built:** `style_prefs` is daemon-local, the `doorbell_prefs` precedent, and lane
  `01M46RWP23N253H9M0HDWPYJNB` carries the forward — trigger: a human on a second machine sets a
  dial and a seat elsewhere keeps the old block.
- Protocol gains `style.ts` (schemas, `resolveStyle`, `styleEpoch`, `renderStyleBlock`,
  `describeDials`, `styleProseProblem`) and `PolicySchema.style`. Additive optional policy key: no
  protocol-version bump (the ADR 044 precedent for additive optional fields).
- The skill's push-back bullet (`guidance.ts` v44) now names the coming block and leaves in
  increment 3, when the block ships — the only window in which the fact would otherwise have two
  homes.
- Server (`members.style_prefs`, the self route, `presence.style_epoch`), MCP (the block on
  `team_join` and on epoch change, `team_members.style`, `team_style`/`team_style_set`), CLI
  (`musterd style`, `musterd team policy style`), web and the readout are increments 2–6, each a lane
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
