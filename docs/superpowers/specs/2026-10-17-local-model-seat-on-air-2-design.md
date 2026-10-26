# A local model seat on Air 2: a 4B-class open-weight model holding a real seat, bounded, with a kill rule

**Date:** 2026-10-17
**Seat:** stanley
**Status:** design agreed with nick in chat on 2026-10-17. This document is the written form.
**Amended 2026-10-17 (lane `01M55WM708DDZGW7442GQ946JW`)** from dolly's, big-body's and fifty's
reads, applied on nick's "apply all"; the amendments are marked _(review 2026-10-17)_ where they
land. Nothing is built or run.
**Lane:** `01M55QY0K5KP5QN53KNHMH1P4E` (goal `research-corpus`)
**Sibling:** [pre-registered work and seats on N machines](2026-10-17-floating-seats-and-pre-registered-work-design.md)
(thread 1 of the same brainstorm). This is thread 2.

## 1. What this is for

nick wants to run a model locally on his second MacBook Air and learn three things from it, in
this order:

1. whether a small open-weight model can follow musterd's coordination loop on the real team
   (orient, drain an inbox, answer in-thread, claim, submit) without going off the rails;
2. whether it can do the team's mechanical work (acceptance reviews on docs-only lanes, the
   pre-registered reads of the sibling design) well enough that frontier peers accept it;
3. what local inference is like on his own hardware: which models fit, how fast they answer,
   how much memory they take, how often they fall over.

If (1) and (2) pass, the seat stays on as a cheap seat for that mechanical work. If they fail, the
readout is the result. Either way it closes [dogfood run 13](../../design/dogfood-scenarios.md)
("a cheap open-weight model doing real work, on the real team"), which is the main run here.

**Success:** a dated readout with every model tried and why each was kept or dropped, the seat's
acceptance rate by frontier peers over a day of ordinary traffic, the time and memory per act, the
two known gaps (G1, G2) confirmed or cleared, and a one-line verdict on the "any model" claim.
**The cheap-seat rule, fixed now:** the seat stays on if every lane it submitted in the main run
(the real lane and the pre-registered read, n = 2) was accepted without a human fixing an act, and
at least two of its three routed reviews were upheld. _(review 2026-10-17, dolly)_ **Upheld** means:
no dispute, reopen, revert or follow-up fix on that lane within seven days of the seat's verdict.
Anything less sends the cheap-seat question to the hosted arm. N is small and the readout says so;
the rule is still fixed before the run.

**Goals**

- Research first. The cheap seat is what you get if the research says yes.
- The model runs on Air 2, beside the seats already there. Nothing is removed from Air 2.
- Every number is a reading with a date and a falsifier (ADR 294 §4; the wiki's rules).

**Non-goals**

- Re-running finding 003's floor. The four guardrail probes passed on `qwen3:4b` in July; run 13
  says not to repeat them.
- A local provider in the resident engine (`pi.ts`). That is the second step, taken only if this
  run says a local model deserves a first-class seat.
- Fine-tuning. The QLoRA coordination-seat experiment (lane `01M0FS6J5AYBAT47MERMZTMC3N`) is a
  separate question with its own kill criterion.
- A hosted open-weight model. Run 13 allows one; this design is the local arm. If the local arm
  fails on acceptance rate, the readout says to try the hosted arm, and that is a new lane.

**Anti-goals (a failure even if it works)**

- Air 2's other seats degrade while the model is loaded. A side note in ADR 169 records a local Ollama run that
  brought an 8 GB host to a standstill twice, competing with the dev fleet for RAM. The kill rule
  (§4.5) exists so this cannot recur unnoticed.
- A human translating for the seat or fixing its acts by hand. Run 13 names that as the finding,
  not a workaround.
- The seat's calls disappear from the cost record. Unpriced is a named reason, never a blank.

## 2. Words

- **Air 2:** nick's second MacBook Air, 8 GB, node label `air-2`, presence host
  `macbook-air-2.lan` (`docs/guides/second-machine.md`). A joiner on the revive team; five seats
  live there.
- **Local model:** an open-weight model served on Air 2 by Ollama (the cheap path run 13 names) and
  used by one seat.
- **The seat:** one named roster seat on Air 2, on OpenCode, pinned to the local model. A normal
  member: it claims, submits and is judged like anyone.
- **Gauntlet:** the fixed short sequence every candidate model runs before one is chosen (§4.2).
- **Main run:** dogfood run 13's run sheet, executed with the chosen model (§4.3).

## 3. Constraints found before design

- **8 GB.** Both Airs are 8 GB; "five seats plus their builds is the honest ceiling"
  (`second-machine.md`, Known edges). A 12–14B model does not fit beside anything. The documented
  ceiling is ~4B (`second-machine.md:19`, which goes on to say such a model "is not a seat" and
  "would not help"; this design is the test of that line, and the readout supersedes it one way or
  the other). `qwen3:4b` is already a dogfood fixture on the hub (`docs/wiki/nicks-laptop.md`).
- **The standstill (a side note in ADR 169, lines ~174-177; there is no ADR about local models).** A prior unbounded run left `ollama serve` resident at `num_ctx 32768`
  and stalled the host twice; the host owner ruled a local arm "off the table on this host
  regardless of how it is bounded." That ruling was for the hub. This design is on Air 2, bounded,
  and with a kill rule. The ruling's reason, not its letter, is what is honoured.
- **OpenCode chooses its own model.** musterd passes no `--model`; the wake argv is `run --format
  json <line>` and the child env is an allowlist (`packages/cli/src/host/backends/opencode.ts`).
  The model comes from `opencode.json` (`model` + a provider block). musterd writes only the
  `mcp.musterd` entry into that file. So the pin is a hand edit of the seat's `opencode.json`.
- **Attestation can be `observed`.** `opencode.observeModel`
  (`packages/cli/src/onboard/harnesses/opencode.ts`) reads the newest session's model from
  OpenCode's own sqlite and takes `id ?? modelID ?? model`. For an Ollama provider the id should be
  the bare tag (`qwen3:4b`); this is inferred from the parser, not yet seen on a real session, and
  the gauntlet checks it.
- **Family comes from the id's leading letters** (`modelFamily`, `packages/protocol/src/model.ts`).
  `qwen3:4b` → `qwen`, `gemma3:4b` → `gemma`: real families, so cross-family acceptance grades. Two
  traps: `gpt-oss:*` → `gpt`, the same family as the Codex seats, so it can never be the
  cross-family reviewer of a GPT worker; and a provider-prefixed declaration (`ollama/qwen3:4b`)
  → family `ollama`. The seat must attest the bare tag.
- **Nothing prices a local model.** The price table (`packages/cli/src/host/prices.ts`) matches by
  prefix and has no `qwen`/`gemma`/`llama` rows, and it is read only by the gateway and the
  resident engine; the OpenCode backend never consults it and does not know the model id. The
  three `unpriced_reason` values (`harness_prints_no_price` and `harness_price_unverified` from ADR
  364, `no_price_row` from ADR 583) have no "local, free" member. Today a local OpenCode wake lands
  as `harness_price_unverified` with OpenCode's own figure (a literal 0), the ADR 436 rail shows
  the harness as 0 priced, and `/report` adds nothing to cost. The `unpriced_wake_cap` counter (ADR
  639/641) counts any lease without a positive `cost_usd`, so a printed 0 and a named reason both
  count against it today (ADR 236's "a printed 0 is unpriced").
- **Known gaps from finding 003.** G1: under a fire-and-exit CLI harness the model stamp goes null
  after the first acts (#172). G2: the `accept` answering a challenge had `reply_to` null. Run 13
  says confirm or clear, not rediscover. An OpenCode wake is a fresh `opencode run` that exits
  when the session idles (the MCP adapter under `opencode serve` persists, ADR 613, but the run
  does not), so for G1 this is the **fire-and-exit** class and G1 is expected to reproduce; the
  readout says what the stamps show.
- **Speed.** Finding 003 measured 50–60 s per act on a 4B model. An hour of team traffic may be
  more inbox than the seat can drain; run 13 treats "never catches up" as its own failure class.

## 4. The design

### 4.1 Setup: bounded serving beside the seats

Ollama on Air 2, with every bound set before the first wake and recorded in the readout:

- **One model loaded at a time** (`OLLAMA_MAX_LOADED_MODELS=1`), and **unloaded when idle**
  (`keep_alive` short, minutes not hours), so memory returns to the seats between acts.
- **A small context window.** The standstill was `num_ctx 32768`. ~~The gauntlet starts at 8k and
  raises it only if an act fails for length~~ _(amended 2026-10-19, stanley)_ The measured floor is
  about 15k tokens with the prompt cut down and about 28k as configured
  ([local model context floor](../../wiki/local-model-context-floor.md)), so 8k would fail every
  candidate on length before testing anything. The gauntlet cuts the prompt first (no skill list,
  only the built-in tools the seat uses, no global instruction file), sets a q8 KV cache, and
  starts `num_ctx` at the trimmed floor rounded up to the next 4k; the value used is recorded per
  candidate.
- **A memory ceiling** the seats always win against, as a number: macOS memory pressure
  (`memory_pressure` / `vm_stat`) must stay at **normal** while the model is loaded, and swap-ins
  must not climb during an act. _(review 2026-10-17, dolly 4)_ A small script on Air 2 samples both
  **every 5 s** while a model is loaded (30 s was too slow: the stall it watches for starves the
  watcher, which is what the ADR 169 note describes), writes a timestamped line, and on the first
  **warn** reading, or on two consecutive missed samples, runs `ollama stop` and tells nick; that
  script is the kill rule's eyes (§4.5). Peak per candidate goes in the readout. The 7–8B trial's
  "room" condition is: the 4B candidates never left normal.
- **The seat.** One new roster seat (name is nick's; a new seat rather than a renamed one, so its
  history is only this run). OpenCode harness, `opencode.json` pinned to `provider: ollama`, the
  bare model tag as `model`, base URL `http://127.0.0.1:11434/v1` _(amended 2026-10-19: or
  llama.cpp's `llama-server` on loopback; ADR 663 names both as local-serving)_. The declaration is
  `binding.model` on the new seat's binding (per seat; `MUSTERD_MODEL` in the actuator env would
  leak to all five Air 2 seats, and the doctor flags it in an MCP entry as stale), and the same
  binding declares the seat **local** (`binding.local: true`, the ADR's name for it). _(review
  2026-10-17, dolly 3)_ The pin goes in the seat's **workspace** `opencode.json`, never the global
  `~/.config/opencode/opencode.json`: Air 2 runs five seats, and a global pin would relabel every
  one of them. Which file OpenCode 2.x reads first is verified on Air 2 before the gauntlet. The
  gauntlet's first check is that attestation comes back `observed` with the same tag and no
  `drift`.
- **The gateway** is not in the path for this phase: OpenCode talks to Ollama directly. What
  marks the wake local is §4.4's change to the OpenCode backend, not the gateway. Naming a local
  upstream in the ADR 583 gateway is the engine's step, not this one.

### 4.2 Model selection: the gauntlet

Candidates that fit 8 GB beside seats: the 3–4B class. `qwen3:4b` is the baseline because it is
the one model with a prior reading. One or two others of the same class, chosen by nick on the
day. _(amended 2026-10-26, dolly: nick fixed the slate and the seat, swan; `qwen3.5:4b` replaces
`qwen3:4b` as the baseline. Both are in [local model gauntlet](../../wiki/local-model-gauntlet.md).)_ A 7–8B at 4-bit gets **one** trial, last, and only if the 4B candidates held the memory bound
with room; if it evicts a seat or trips the kill rule it is out and the trial is the reading.

Every candidate runs the same fixed sequence, in this order, each timed:

1. **Orient:** the seat's first session runs the orient skill end to end and stamps.
2. **Attest:** `team_status` shows the seat with the bare tag, `model_source: observed`, no drift.
3. **Drain:** an inbox of at least ten unread acts, read with ordinary checks, no human help.
4. **Answer in-thread:** one directed ask, answered with `accept`/`decline` carrying `reply_to`.
   This is the G2 check.
5. **Claim and submit:** one docs-only pre-registered lane (the sibling design's band 2; before
   the field exists, a lane whose detail already says what to run and how to judge it), claimed,
   done, pushed, `lane_submit`. One such lane per candidate, opened ahead by nick or stanley and
   named for the candidate, so nothing is reset between runs and each submission is its own
   record.

Recorded per candidate: pass/fail per step, seconds per act (median and worst), peak memory,
`num_ctx` used, and the reason kept or dropped. A candidate that fails step 1 or 2 is dropped
there; one that fails 3–5 is recorded and dropped unless nothing passes, in which case the best
goes on and the readout says the main run started from a failing gauntlet. **The whole gauntlet is
one pre-registered lane** (§6 inc 2) so its verdict rule is fixed before any model is pulled.

### 4.3 Main run: dogfood run 13 with the chosen model

Run 13's run sheet, as written, with these fixed:

- **Where:** Air 2, the seat from §4.1, in ordinary traffic for at least a day (run 13 says an
  hour; a day gives the slow-seat failure class room to show).
- **Band-1 work:** at least three acceptance reviews on docs-only lanes routed to it by the
  ordinary picker (no human steering it there), and every directed ask it receives. _(review
  2026-10-17, dolly 2)_ **The seat's acceptances are advisory for the whole run: they never close a
  lane.** The picker (ADR 260/158) does not read `change_class`, so it will route code and
  high-stakes lanes to the seat too, and under ADR 202 an accept IS the verdict. The seat is
  therefore enrolled with an acceptance scope of `advisory` (a per-seat policy key the ADR adds):
  its `accept`/`decline` is recorded against the lane and counted for the cheap-seat rule, the ask
  is then re-routed to the next eligible acceptor, and the lane closes on that one. The readout
  compares the seat's verdicts with the closing ones. If the run passes, lifting the scope to
  docs-only lanes is the ADR's second step.
- **If G1 reproduces** (the model stamp goes null after the first acts), the picker grades the seat
  `unknown_grade` and stops routing it reviews, and the measure above starves quietly. _(review
  2026-10-17, dolly 7)_ Decided now: the gauntlet's attest step is re-checked after the drain; if
  the stamp is null there, the main run starts anyway, the readout records G1 as reproduced, and
  the three reviews are routed to the seat by name (`acceptor:` on submit) so the measure exists.
- **Band-2 work:** one pre-registered read taken and submitted.
- **One real lane:** small, code or docs, claimed, branch pushed, submitted, judged by a frontier
  seat. And one acceptance routed the other way: the seat judges a frontier seat's lane.
- **Every act shape:** a handoff with a branch, an ask with a tier, a challenge, a huddle turn,
  sent by a teammate, with what came back recorded verbatim.
- **G1 and G2** confirmed or cleared, with the stamps quoted.
- **No shielding, no translating.** The moment a human fixes an act by hand, that is recorded as
  the finding and the run continues.

### 4.4 Plumbing: one change, one ADR

Lands before the gauntlet, so the record is honest from the first act. **One mechanism, not two:**
the first draft also added a zero price row, which the builder check showed does nothing here (the
price table is read only by the gateway and the resident engine, and the OpenCode backend does not
know the model), and which would have made `local` a reason that never appears. Dropped.

- **The OpenCode backend marks a wake `local`.** _(review 2026-10-17, dolly 1, big-body 1)_ As
  first written the signal was a loopback base URL. That is a configuration claim, not evidence:
  the ADR 583 gateway itself binds loopback, so any seat routed through it would have matched, and
  so would a local proxy in front of a paid API; and a file read at settle leaves a start/settle
  TOCTOU. The signal is now **three things that must agree, read at spawn**: the seat's binding
  declares `local: true`; the workspace `opencode.json`'s provider for the pinned model is `ollama`
  (or a provider the ADR lists as local-serving); and that provider's base URL is loopback. The
  backend snapshots the provider block at spawn and stamps the completion with it, so the record
  carries the exact configuration the wake ran under. Any disagreement keeps today's
  `harness_price_unverified`. This still cannot prove where inference ran, which is why the
  exemption below is gone.
- **`local` is a fourth `unpriced_reason`** (the closed set in `packages/protocol/src/residency.ts`
  grows by one; the ADR amends ADR 364 and notes ADR 583). It means: served on the host itself, no
  metered cost; the price is known to be zero.
- **`local` is excluded from the ADR 436 trigger's denominator**, not counted as priced: the rail
  prints it as its own line (`local ×N`) and judges "none priced" over the remaining wakes, so one
  local wake can neither trip nor silence the trigger for the harness's metered wakes.
- **`local` still counts against `unpriced_wake_cap`.** _(review 2026-10-17, dolly 1, big-body 1,
  fifty)_ The first draft exempted it. Both reads showed the signal is spoofable (a local listener
  can forward to a metered endpoint), so an exemption would turn a spend guard off for paid calls;
  big-body called it a design blocker. The experiment does not need the exemption: the cap is a
  team policy nick sets, and a run on revive sets it with the local seat's wakes in mind. `local`
  is therefore a named reason that is **counted and shown** (its own line in `/report` and on the
  rail), never a free pass. fifty's builder note: `countUnpricedWakes` counts leases by cost alone
  and `WakeAuditRow.detail` does not yet carry `unpriced_reason` (the `wake_cost` audit row does),
  so the per-reason line needs the reason plumbed into the wake audit row; that plumbing is what
  gives the rail its `local ×N` line. ADR 639 and ADR 236 are untouched.
- **No price row, no `cost_usd: 0`.** `/report` shows the seat's wakes under their own `local`
  count beside cost, never inside it (`pricedWakeCostUsd` already sums positive costs only, fifty).
  The `budget_usd` refusal is gateway-only and stays blind to these wakes; the cap above is the
  guard that still sees them.
- **No change to `modelFamily` or `normalizeModelId`.** A provider-prefixed id (`ollama/qwen3:4b`),
  if ever observed, is recorded as observed and named in the readout; the fix is the seat's
  configuration, not the protocol's grading of every seat.

### 4.5 Kill rule, fixed in advance

The run stops, and the stop is the result, the moment any of these holds while the model is
loaded:

- the sampler (§4.1) reads memory pressure **warn** while a model is loaded, or misses two
  consecutive samples, or a wake for another Air 2 seat fails (`residency.wake_failed`, watchdog
  timeout or spawn error: no memory reason code exists today, so any failure on Air 2 while the
  model is loaded counts);
- Air 2's sync pull from the hub times out (the shape of lane
  "Sync: Air 2's pull from the hub has timed out", 2026-10-08);
- Air 2's load average stays above 8 for five minutes (the hub's "every seat resident" reading was
  8.9, `second-machine.md`);
- a human has to unload the model by hand to recover the machine.

The sampler watches the first trigger and acts on it; nick watches the rest, and the gauntlet
lanes say so. Stopped runs are written up the same as finished ones, with the trigger named.

### 4.6 What the record shows

- The seat's acts, stamped with the bare tag, `observed`.
- Each wake's `residency.wake_cost` row with `unpriced_reason: local` and the provider snapshot it
  ran under, its duration, and the host.
- The seat's advisory verdicts beside the closing verdicts on the same lanes.
- The acceptance asks it answered and the ones it received, with the reviewer grade
  (`cross_family` against Claude/GPT/Grok workers).
- The readout page in `docs/dogfood/runs/2026-MM-DD-13-<tester>.md` on run 13's template, plus a
  wiki page for the model-selection table with the dated readings and their falsifiers.

## 5. What is left to the builder

- The exact Ollama settings per candidate (`keep_alive`, `num_ctx`, quantisation), recorded, not
  prescribed here.
- The other 4B candidates (nick picks on the day; the readout names them).
- How peak memory is sampled at each act (a small script on Air 2 is fine; what matters is that
  the number has a time beside it).
- Whether OpenCode's Ollama provider needs anything beyond `opencode.json` on 2.x, and which
  `opencode.json` wins when both global and workspace exist; verify on Air 2.
- The OpenCode wake watchdog against 50–60 s per act (dolly 6): a drain of ten acts in one
  `opencode run` may exceed it, and a timeout would be read as a model failure. Raise it for this
  seat or split the drain; decide before the gauntlet, record which.
- The `acceptance_scope: advisory` policy key and the re-route after an advisory verdict.
- The ADR's exact text for the `local` reason and how the rail and `/report` print it.
- Tests: the enum accepts `local`; the three-part signal yields `local` only when all three agree
  (binding without the provider, provider without loopback, loopback without the binding each
  stay `harness_price_unverified`); the snapshot is taken at spawn so an edit mid-wake changes
  nothing; the rail excludes `local` from the trigger's denominator and prints its own line; the
  cap counter still counts `local`; an advisory accept records and re-routes without closing the
  lane; a bare-tag attestation grades `qwen`.

## 6. Increments

1. **ADR + plumbing** (lane `01M55R1B9PXSETR31YD5AVN7C2`): the OpenCode backend marks a wake `local` on the three-part
   signal at spawn; the enum, the rail and `/report` show it; the cap still counts it; the
   per-seat `acceptance_scope: advisory` key and its re-route.
2. **Gauntlet** (lane `01M55R1FN3M1BPFQ5J5RH2QGX1`): Air 2 bounded serving, the new seat, candidates run through §4.2;
   pre-registered with §4.2's verdict rule. Ends with one chosen model or "none passed".
3. **Main run** (lane `01M2M6NV4C2CNBJYVYQTFMAQRW`, dogfood run 13 as already on the board): §4.3
   with the chosen model, under §4.5's kill rule.
4. **Readout** (lane `01M55R1HY8P1PQY7X1JBS4X5DP`): the run file on run 13's template, the model-selection wiki page,
   the verdict on the "any model" claim, and the cheap-seat decision (stay, or try the hosted
   arm).

## 7. Open questions settled here, by stanley

- Local, on Air 2, beside the seats, rather than a model box: nick's call. The bounds and the kill
  rule are the price of it.
- OpenCode first, the resident engine second: the seat loop already works on OpenCode and it reads
  local providers; the engine needs a new provider and speaks only the Responses API.
- A new seat, not a renamed one, so the run's history is clean.
- The gauntlet is its own pre-registered lane rather than a step inside run 13, because run 13's
  run sheet assumes a chosen model and says not to re-run the floor.
- One mechanism (`local` from the OpenCode backend) rather than a zero price row, because the price
  table is never read on this path and two mechanisms would have left `local` unreachable.
- _(review 2026-10-17)_ `local` is counted, not exempted. Three reads agreed the signal is a claim;
  a claim can name a wake but must not switch off a spend guard.
- _(review 2026-10-17)_ The seat's acceptances are advisory for the run, because the picker cannot
  keep it to docs-only lanes and an accept closes a lane.
- _(review 2026-10-17)_ Kill at warn, sampled every 5 s, missed samples count: the watcher must act
  before the stall it watches for can starve it.
- `local` is a new unpriced reason rather than reuse of `no_price_row`, because the ADR 436 trigger
  reads "none priced" as "cannot be priced", and a free local call is the opposite case.
- A day rather than run 13's hour, so "never drains its inbox" has time to show.
