# 522 — Stored claims are checked on read

- Status: accepted
- Date: 2026-10-05
- Deciders: nick ("the approach that is most effective and will not cause agents to waste time
  exploring/checking stuff at the same time"; all three stores in the first increment — answered
  2026-10-05)
- Lane: `01M46S3S89SAYQ7TWHZ5K2HK1A` (goal `memory-and-rules`)
- Design: [docs/design/memory-and-rules.md](../design/memory-and-rules.md) §Checking on read
- Builds on: ADR 516 (holds — the authoritative rule store a claim is checked against), ADR 093 /
  366 (seat memory), ADR 430 (the wake context v2 block), ADR 494 (the dream packet), ADR 049 (the
  brief's handoff `why`), ADR 088 (composable-only SessionStart block)
- Protocol change: yes (hard rule 1) — `ClaimCheck`; `checks` on `GET /memory`, on the wake
  context block, on `NextBrief.why`; `saved_at` + `checks` on the dream packet's memory, `checks` on
  each dream insight

## Context

The pre-demo freeze (week of 2026-09-28) spread because a stored note can say anything forever. A
seat wrote "no merges or refreshes until the demo" into memory or a handoff; the next seat read it
as current, restated it, and so on — nothing on the read path said "the demo is over" or "no rule
says that". ADR 516 gave the Team one place a pause actually lives (holds). This ADR is the other
half: when a seat reads a stored note, the note's claims arrive already checked against that place
and against the board.

Today the only such check is the orient skill's carried-lane reconcile (`packages/mcp/src/landed.ts`,
lanes vs `origin/main`), and only for memory, and only at orient.

## Problem

A seat reading a stored note has to decide, on its own, whether each thing the note asserts is
still true. Either it trusts the note (the freeze spreads) or it goes and checks — and when several
seats read the same stale note, several seats run the same checks. Both are the waste.

## Decision

1. **The daemon checks a stored note's claims when it is read, and the verdict travels with the
   note.** No tool call, no flag, nothing an agent supplies. One function, `checkClaims(text)`
   (`packages/server/src/store/claimCheck.ts`), serves every read surface, so every surface gives
   the same verdict.
2. **Claims are found in the text, not declared at save.** A bounded, deterministic pass — notes
   are ≤ 8 KiB — and indexed lookups, never a model re-reading prose. It covers every note already
   saved, including any stale freeze, and asks nothing of the agent that wrote it. Three kinds:
   - **lane ids** — reported only when the lane has ended (`done`, `abandoned`) or been parked; a
     live lane is as the note left it and says nothing;
   - **hold ids** — reported with the hold's real state (in force until when; lifted by whom; ended);
   - **Team-rule phrases** — a stopping word near a landing verb ("don't merge", "no refreshes",
     "hold off on pushing") or a named freeze ("merge freeze", "code freeze"). `current` when an
     active hold carries the matching effect (`merges_paused` for merge/push, `autorefresh_paused`
     for refresh/restart/deploy, any enforced hold for a bare freeze), otherwise `unsourced`.
     Reminders and reports are not rules: "don't forget to merge", "I merged", "never merged".
3. **Verdicts are conclusive.** Each check carries one sentence that ends the question — "no active
   Team hold says this, so the Team is not paused" — never "possibly stale, please verify", which
   would send every reader off to verify the same thing. Only what changes the reading is reported,
   at most six per note (`CLAIM_CHECKS_MAX`), rules first.
4. **Where it rides.**
   - `GET /memory` (`team_memory_read`): `checks`, rendered above the body.
   - The wake context block (ADR 430): `context.checks`, from the seat's memory and any handoff in
     the waking thread, each tagged `source` (`memory` | `handoff`) and, for a handoff, `source_id`.
     Read from the whole bodies, before the budget cuts them; counted inside the block cap.
   - The dream packet (ADR 494): `memory.saved_at` (it was dropped) and `memory.checks`; `checks` on
     each learned insight — a dream promoting a "freeze" insight sees no hold backs it.
   - `NextBrief.why` (the latest handoff, ADR 049): `checks`, rendered under it in `team_next` and
     `musterd next`.
   All optional and additive: omitted means none (or an older daemon).
5. **The SessionStart orient block is unchanged.** It shows the memory headline only, and a check
   line quotes the note's text; ADR 088 keeps free text out of that block. The checks arrive with
   the body, on `team_memory_read`.
6. **Explicit refs at save are not built.** The design doc proposed recording a note's references
   as structured fields when it is saved. That makes every agent do bookkeeping on every save, only
   covers new notes, and is only needed when text scanning stops being cheap or precise enough —
   a measured condition, not today's.

Protocol: `ClaimCheckSchema` `{kind: lane|hold|rule, ref, verdict: current|ended|unsourced, line}`
and `claimCheckLines` in `@musterd/protocol`; the fields above. SPEC Appendix A.17 is the normative
text.

## Consequences

- The demo case reads back corrected wherever it lives: a memory saying "nobody merges until the
  demo" returns, beside it, "no active Team hold says this, so the Team is not paused"; once a
  human sets `merges_paused`, the same note reads "backed: merges paused by nick until 15:30".
- A seat's "carrying 01M…" memory line about a lane that has since closed now says so on every
  read surface, not only through the orient skill's reconcile.
- The rule matcher is a heuristic and will miss phrasings (a freeze said in other words reads as no
  claim at all) and occasionally catch a private working note ("don't merge until CI is green") —
  for which the line says so plainly: if it was a note to yourself, it binds only you. Misses cost
  what they cost before this ADR; nothing is denied on a check.
- A read costs one regex pass over ≤ 8 KiB plus, per id found, one indexed lookup — at most a
  handful per note. Recorded so that the scale section's "check on read must have a fixed cost"
  stays true: if notes or teams grow past that, Decision 6's explicit refs is where to go.

## Observability & Evaluation

- **Traces:** none new — the checks are a deterministic projection of rows that are already
  audited (holds, lanes). The verdicts are visible in every response that carries them.
- **Eval:** the incident's measure, shared with ADR 516 — seat messages that restate a pause (a
  Team-rule phrase) while no hold backs it. Baseline: the demo week. Target: such restatements stop
  after the read that would have carried an `unsourced` check. Secondary: how often a seat that read
  an `ended` lane check still reports carrying that lane.
- **Experiment:** seed a stale "no merges until the demo" seat memory on a test seat, wake it, and
  check that it neither repeats the rule nor spends a tool call verifying it.
