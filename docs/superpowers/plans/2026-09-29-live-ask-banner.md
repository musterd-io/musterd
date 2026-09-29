# /live ask banner, in-room ask moment, "asking nick" (ADR 464, lane 3) Implementation Plan

> **For agentic workers:** execute this plan in your own seat with superpowers:executing-plans
> (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ask to a human is a room moment a stranger can read: a banner at the top of the office
in plain words, a hand raised at the asker's desk with a card resting at the human's desk while the
ask is open, and "asking nick" on the asker's team card.

**Architecture:**

- `askPhrase.ts` (pure, node-tested): the spec §6 phrase table (`askStatePhrase`) and the banner
  view-model `askBanner(asks, ctx, now)` → open / settled (~6s) / idle.
- `AsksStrip.tsx` keeps its machinery (derivation, the tier clock, answers, the sheet, the review
  queue, notify, sign-in offers, the tab title). Its **rail** becomes the banner: "✋ ryder is asking
  nick: *question* · holding until answered · 4:12", Approve / Deny inline for an answerer,
  "+N more waiting" → the sheet. Settled: the outcome for ~6s, then the banner shrinks. Idle: the
  "no open questions" pill. Operator terms stay in the sheet and the log.
- `asks.ts` gains `settledAt` on `AskView` (the ts of the envelope that closed it) — additive.
- `teamCards.ts` takes the derived asks and adds the `asking` state ("asking nick"), sorted after
  blocked (spec §4).
- The scene: `OfficeData.asks` (open asks, `{ id, from, to, state }`) diffed in `update()`. A new
  open ask raises the asker's hand (the existing `wave` gesture) with a ✋ cue, and rests a small
  card element at the human's plate while open. On settle the card shows ✓ / ✗ / "went ahead" for
  ~6s, then clears. Reduced motion: cards only, no gesture.
- `/broadcast`'s `AsksReel` is untouched.

**Spec:** `docs/superpowers/specs/2026-09-28-live-audience-first-design.md` §3.3, §4, §6. **ADR:** 464.

## Global Constraints

- No protocol, server or schema change. No new runtime dependency.
- The banner never says "approved" for a lapsed ask (the clock decided, not a person): the phrase
  is "expired"; `risk_accepted` is "went ahead after N min".
- Every existing `AsksStrip.render.test.ts` claim that is about the SHEET or about lying to the
  reader (no Approve on a lapsed ask, hue + clock fraction on the lead) stays green; rail wording
  claims move to the banner's words.
- Budgets hold: initial JS, total JS (~3 KiB free), Live.css (19.0 / 20.3 KiB), contrast
  (`?asks-open` still opens the sheet), tap targets at 390×844 (Approve / Deny ≥ 24px).
- `?still` holds the banner's clock and the room's ask moment, as it holds everything else.

## Review Focus

1. **A lapsed ask.** Banner reads "… · expired", no buttons, and the card in the room clears.
2. **An agent-routed review ask.** Not a human ask: no ✋, no card, banner lead only if nothing is
   routed to a human. `askAudience` decides, as today.
3. **Settled for 6s then quiet.** The outcome line is bound to `settledAt`; a page loaded a minute
   after the answer shows the idle pill, not a stale "nick approved ✓".
4. **The card's home.** A human who is offline has no plate; the card rests over the asker instead.
5. **Two open asks.** One banner lead (yours first, then urgency — unchanged), "+1 more waiting".

---

### Task 1: `askPhrase` — phrases + banner view-model
- [ ] Tests: the §6 table; banner open (lead, question one line, hold words, clock); settled within
      6s of `settledAt` → outcome text ("nick approved ✓", "nick said no ✗", "went ahead after
      5 min", "nobody answered"); settled older than 6s → idle; `more` count.
- [ ] `asks.ts`: `settledAt` set wherever a later envelope closes/defers an ask.
- [ ] Commit.

### Task 2: the banner in `AsksStrip`
- [ ] Rail markup → banner; keep quick answers, sign-in, notify, me chip, "+N more" → sheet.
- [ ] Update `AsksStrip.render.test.ts` rail claims to the banner's words; keep sheet claims.
- [ ] CSS `.lc-asks__rail` → the banner's type (14px question, ✋ glyph, settled/idle modifiers).
- [ ] Commit.

### Task 3: "asking nick" on the team card
- [ ] `teamCards(roster, board, goals, asks)`; state `asking`, label `asking ${to}`; order after
      blocked; tests. `TeamColumn` takes `asks`; `live.tsx` derives once (`deriveAsks` +
      `applyTierClock`) and passes them.
- [ ] Commit.

### Task 4: the in-room ask moment
- [ ] `types.ts`: `OfficeData.asks?: { id; from; to: string | null; state }[]`.
- [ ] `index.ts`: diff in `update()`; ✋ cue + `wave` gesture on a new open ask (not reduced); an
      `lc-gl-ask` element per open ask positioned beside the human's plate in `positionLabels`
      (or the asker's, when the human has no plate); settle → outcome glyph, cleared after 6s.
- [ ] `scene-loop.test.ts` structure tests; `OfficeScene.tsx` passes `asks` into `computeData`.
- [ ] CSS `.lc-gl-ask*`.
- [ ] Commit.

### Task 5: gates, browser, docs, PR
- [ ] `08-web.md` asks bullet + tree; `pnpm -r build`, per-package `tsc --noEmit`, lint,
      format:check, perf:check, a11y:check, a11y:targets:check.
- [ ] Browser at 1920×1080 with a real ask on the revive team (send one from this seat to nick with
      `team_send {act:'ask'}`, advisory tier): banner reads, hand + card appear, card state on the
      asker; 390×844: banner wraps, no horizontal scroll.
- [ ] PR, auto-merge, `lane_submit`.
