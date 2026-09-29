# /live motion means something (ADR 464, lane 4) Implementation Plan

> **For agentic workers:** execute this plan in your own seat with superpowers:executing-plans
> (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walking stops meaning "working". A working member stays at their desk (micro-gestures
only); every purposeful walk wears a short verb tag over the walker's plate; a small key in the
office corner says what the room's four postures mean.

**Architecture (spec §3):**

- `ambientSeed.ts` gains a pure `ambientPool(placements, nodes)`: the members every viewer's shared
  decision draws from (present desk members, as today), the `errands` subset (posture ≠ `working`)
  and the chat `pairs` filtered to two non-working neighbours. `fireAmbient` reads it; the
  `member` beat for a working member is the micro-gesture list with the three errands removed.
- `headline.ts` gains `walkTag(kind, to)`: "handing off → dolly" · "asking for help" ·
  "redirecting izzo" — the ticker's home, one shared function.
- `actors.ts` answers `actWalkingFor(name)`; `index.ts` keeps `walkTags` (set when an act walk
  starts on `walk-help` / `walk-handoff` / `steer`, shown on the plate as `lc-gl-label__walk` while
  that member's act walk is in flight, dropped after).
- `OfficeKey.tsx`: a corner card on `/live` (never `/broadcast`), open by default, closable, the
  choice in `localStorage` (`musterd.live.key`).

**Spec:** `docs/superpowers/specs/2026-09-28-live-audience-first-design.md` §3. **ADR:** 464.

## Global Constraints

- No protocol/server change; no new dependency. The shared ambient decision stays deterministic
  across viewers (E1 spec): the pool is a pure function of roster-derived inputs.
- The dog beat is unchanged. Real act walks are never gated by posture.
- Budgets hold (Live.css has ~1 KiB; the key and the tag are small). Contrast: the key's ink on
  its paper, the tag on the plate.

## Review Focus

1. **Falsifier 1.** `ambientPool` never lists a `working` member under `errands` or in a pair —
   pinned by a unit test over a fixture with working and between-tasks desk members.
2. **A working member still moves.** Stretch / glance / sip stay; the room is not a statue.
3. **A tag outlives nothing.** The tag is gone the frame the act walk ends; an ambient stroll never
   wears one.
4. **The key is quiet.** Closed once, it stays closed on that browser; it is never on `/broadcast`.

---

### Task 1: ambient pool + errand guard
- [ ] Test (`ambientSeed.test.ts`): pool fixture → members includes all present desk members;
      `errands` excludes working; pairs exclude any pair with a working member.
- [ ] Implement `ambientPool`; use it in `fireAmbient`; guard the errand beats in `playAmbientBeat`.
- [ ] Commit.

### Task 2: walk tags
- [ ] Tests: `walkTag()` wording (headline.test); structure tests: tag set on a successful act walk,
      rendered in the plate, cleared when `actWalkingFor` is false.
- [ ] Implement `actWalkingFor`, `walkTags`, the plate span, CSS `.lc-gl-label__walk`.
- [ ] Commit.

### Task 3: the key
- [ ] Render test: four lines; a close control; `data-open`.
- [ ] `OfficeKey.tsx` + CSS; mounted in `OfficeScene` on `/live` only.
- [ ] Commit.

### Task 4: gates, browser, docs, PR
- [ ] `08-web.md`; build; per-package tsc; lint; format:check; perf; a11y; targets.
- [ ] Browser: a working member on the revive team does not leave their desk over ~2 min of
      ambient beats; `/office-preview` script shows a "handing off → …" tag on the handoff walk;
      the key closes and stays closed on reload.
- [ ] PR, auto-merge, `lane_submit`.
