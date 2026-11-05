# 810 — A wake over the resume price bound continues on a compacted brief

- Status: accepted
- Date: 2026-11-05
- Lane: `01M6PA2PWX` (goal `coordination-cost`), opened by lazara on
  [finding 032](../research/032-cooperbench-rider7-rerun.md) gap 2; nick asked for the build in session
- Amends: [805](805-resume-price-bound.md) (the price rung's refusal now has a second outcome; its third
  rejected option is built, behind the same knob, as that ADR said it could be); builds on
  [131](131-harness-residency-wake-ledger-host.md) §5 (the resume ladder), [427](427-resume-bound-gates-on-message-bytes.md)
  (what a resume replays), [583](583-metering-gateway-not-a-loop.md) (one price table, never a guess),
  [735](735-act-lane-the-seat-ends-its-turn.md) (the act lane)

## Context

ADR 805 bounds what a resume may cost: over `resume_max_usd` the host spawns fresh. Finding 032 ran
ten CooperBench pairs on the act lane with the bound at $0.25 and read the consequence: 24 of 26 wakes
were refused a resume and spawned fresh, each re-reading the seat primer and the task to answer one
act, $0.12–0.46 a wake and $4.72 over the run — cheap per wake, as the bound promised, and with no
memory of the turn before. The pair cost more than finding 028's loop ($25.04 against $18.45) because
every wake paid the boot and none carried its context. ADR 805 named this trade when it rejected
"compacting the transcript on resume" as a bigger change than its gap needed, and said it could land
behind the same knob later. Finding 032's "Decision for nick" put it as the only path to a cheaper
loop.

## Problem

Keep the seat's working context across act-lane wakes without paying to re-ingest the whole
transcript: a continuation whose cost the bound still governs, built from what the host already has,
with no new call to a model and nothing the host cannot attest.

## Decision

1. **A refusal on price compacts; a refusal for want of a price does not.** `priceRung` (ADR 805 §3)
   marks an over-bound refusal `over`. When the ladder admitted a target on bytes and the rung refused
   it `over`, the host builds a *continuation brief* from that transcript and spawns fresh with it.
   An unpriceable refusal (ADR 805 §4: no size, no model, no price row) builds none — a brief cannot
   be shown under the bound either — and the wake is bare fresh, as before.
2. **The brief is an extraction, not a summary.** `host/continuationBrief.ts` reads the transcript
   once and keeps, oldest to newest, one line a turn: the seat's own text, its tool calls (name and a
   clipped argument line), and the person's prompts (clipped). It never carries thinking, tool
   results, attachments, the API-request mirrors, or anything matching a credential pattern (hard
   rule 5). No model is called to write it: the brief is deterministic, free, and says only what the
   transcript said. _(Amended 2026-11-05: a tool call's arguments ride **by construction**, not by
   pattern — values only for an allowlist of path-like and identifier keys (`file_path`, `path`,
   `pattern`, `id`, `lane`, `to`, `act`, …), every other key by name alone; the credential patterns
   apply to the seat's text and the person's prompts, run on the whole text before any clip, and
   cover JSON-quoted keys, bearer headers, "the password is …" and long opaque tokens. See
   Consequences.)_ _(Amended 2026-11-05: later the same day — a key's NAME admits nothing; a value
   rides only when it parses as a grammar: a path with a slash, a musterd id, an act or lane state
   from the enum, an integer. `pattern`, `glob`, `name`, `to`, `seat` and every other argument ride
   as the key alone. See Consequences.)_
3. **It is fitted to the bound by the rung's own arithmetic.** The budget is what `resume_max_usd`
   buys at bytes ÷ 4 tokens × the model's input price (`briefBudgetBytes`), capped at 48 KiB
   (`BRIEF_MAX_BYTES` — a `-p` argument stays well under Linux's per-argument ceiling, and a longer
   brief is a transcript). Whole turns are dropped from the OLDEST end until the brief fits, and the
   brief says how many went. A budget that holds not one turn, or a transcript with no turn, yields no
   brief and a bare fresh spawn.
4. **It rides the wake line.** The spawn is the fresh path — minted session id, the same argv
   posture, the same verify — with the `-p` line as the wake line first (it is the instruction;
   ADR 774's recap line when there is one) and the brief after. Nothing is written to the workspace
   and nothing crosses to the daemon but the outcome.
5. **The report says so.** The wake report's `session` axis gains `compacted`; `delivery_outcome`
   gains `compacted` (a compacted wake that followed a failed resume stays `fresh_fallback`, as any
   fresh fallback does). `report residency` counts them beside `resumed`; `residency status` prints
   the bound as `resume ≤ $N, compacted over`. No new knob: the bound is the knob, as ADR 805 said.
6. **Nothing else moves.** The byte bound, the exact-match rung, the portable/fresh order, the ADR
   427 weighing, the price rung's arithmetic and log line, and the resume path itself are unchanged.
   Without `resume_max_usd` set no brief is ever built.

### Rejected

- **A model-written summary.** It would cost a call the host would have to pay for and could not
  price before making, and it would put words in the seat's mouth the transcript never held. An
  extraction is attestable; a summary is a second author.
- **A brief file in the workspace the seat is told to read.** Under `seat-policy` the Read tool may
  not be allowed, and a brief the seat never opens is a continuation in name only. On the line it is
  ingested exactly once, which is what a resume's history would have been.
- **Compacting on every resume, under the bound too.** A resume that prices under the bound carries
  more than any brief can; the bound already says when that stops being worth it.
- **A separate `resume_compact` knob.** Finding 032's reading of ADR 805 is that the trade belongs to
  the person setting the bound; a second knob to make the first one not throw context away is a
  default nobody would want off.

## Consequences

- _(2026-11-05, acceptance read)_ big-body declined the first landing (#3915) on the credential
  boundary: `JSON.stringify`'d tool inputs were redacted by a pattern that expected `password` to be
  followed directly by `:` or `=`, so `{"password":"…"}` kept its value, clipping ran before
  redaction, and the fixed prefixes covered no arbitrary secret. The fix makes the tool-argument
  layer structural (`toolInputLine`: safe keys with values, every other key by name — a Bash
  `command`, a Write `content`, a `body`, a `password` never ride), runs the prose patterns on the
  whole text before clipping, widens them (quoted keys, bearer, "is/was", 24+ character opaque
  tokens), and adds a regression that drives a JSON password, a bearer header and a written secret
  through the real builder into the spawned `-p` argument.
- _(2026-11-05, second acceptance read)_ big-body then showed the name-based allowlist admitting a
  secret under an innocent key: `{pattern: 'hunter2'}` rode as `pattern=hunter2`, and so would any
  free-form `path`, `name` or `id`. A field name is not a grammar. `constrainedValue` now admits a
  value only when it parses as one — a path containing a slash in path characters, a Crockford
  ULID, an act or lane state from the enum, an integer — under a key that means that thing;
  everything else is the key alone. The regressions drive `{pattern:'hunter2'}`, `{to:'hunter2'}`,
  `{id:'hunter2'}` and `{file_path:'hunter2'}` through the real builder and the spawned `-p`.
- On the act lane with the bound set, a wake past the bound keeps the thread of its own prior
  session for the price of the brief instead of none for the price of the boot. The boot itself is
  unchanged: this ADR does not make a fresh wake cheaper, it makes it less forgetful.
- The brief's cost is bounded by construction; whether it *buys* anything — fewer re-reads of the
  primer and task, fewer repeated board reads, a cheaper or shorter pair — is the pre-registered read
  in lane `01M6PA2PWX`: rider 7's ten `core` pairs again with R7b against finding 032's $25.04 and
  its wake dollars ($4.72 over 26 wakes).
- A seat's transcript lines now ride a process argument on the host. They were already on the host's
  disk in the transcript; the credential patterns are redacted; and the argument is visible to the
  host's own process table only. A team that runs seats on a shared machine should know this.
- `rider7.py` reports `compacted` beside `resumed`.

## Observability & Evaluation

- **Traces:** the host log line per compacted wake (`resume skipped for <seat>: resume would
  re-ingest … — compacted continuation: N turns kept, M dropped, X of Y (budget Z)`); the wake report's
  `session: compacted` / `delivery_outcome: compacted`; `report residency --json` `compacted` beside
  `resumed`, and `delivery.compacted`.
- **Eval:** the lane's pre-registered rider 7 re-run on the same ten `core` pairs, same rules: R7b
  (model dollars) against $25.04, wake dollars against $4.72, and the share of wakes `compacted`.
  Acted if R7b ≤ $18 (finding 028's $18.45 beaten); did not if ≥ $25. Falsifier for the mechanism: a
  compacted wake that re-reads the primer and task anyway, or one whose cost exceeds a bare fresh
  wake by more than the brief's priced bytes, means the brief is not being read as context, or the
  divisor under-counts.
- **Experiment:** none beyond that read; before/after on the same pairs.
