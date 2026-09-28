# 464 — /live is read by a room: office + team column, headline ticker, asks as a room moment

- Status: accepted — 2026-09-28 (nick, in the brainstorm)
- Date: 2026-09-28
- Lane: `01M3MPYT3M31WHKTXKY777R8KW` (goal `launch`)
- Design: `docs/superpowers/specs/2026-09-28-live-audience-first-design.md`
- Supersedes: ADR 079's companion toggle; ADR 149 / 222's asks strip as `/live`'s ask surface.
  Their answer semantics are kept.
- Builds on: ADR 079 (office on /live), ADR 086 (ambient life), ADR 137/138 (posture), ADR 151/183
  (perf budgets), ADR 301 (per-act model stamp), ADR 441 (`Live.css` budget)

## Context

At the 2026-09-27 demo, `/live` was on a projector for the whole talk, and the room watched it
throughout. The room could not read it:

- They asked what each member was working on, and the work board did not answer that.
- The mix of models, which is part of the pitch, was invisible.
- They asked whether walking meant working.
- The presenter never used the roster rail or the asks bar to explain anything.
- The team stream added nothing.
- Space around the office floor sat empty.

The decision to redesign `/live` itself was taken in a brainstorm with nick on 2026-09-28. There
is no separate presenter mode.

## Problem

`/live` is laid out for the person running the team.

- **Roster rail:** posture chips, trace buttons, feature-epoch skew.
- **Asks strip:** operator states such as "stranded", "risk accepted" and "timed out — agent
  holding".
- **Stream column:** raw act bodies.
- **Lane titles:** exist on the page, but only in a small bottom-left box. They are switched off
  on nameplates (`WORK_CUES='stack'`).
- **Models:** appear only as a provider glyph on a nameplate, readable after a click.

The office's motion also misleads. Ambient errands (coffee, fridge, phone pacing) go to every
present **desk** member, and a desk member is a **working** member. So the busiest agents are the
ones seen wandering.

## Decision

1. **Layout.** `/live` is a full-height office plus a collapsible team column on the right (~380px,
   collapsing to a 56px rail; collapsed by default below 1280px). A top bar carries the busyness
   meter. A headline ticker runs under the office. The roster column, the stream column, the
   `WorkStack` box, the asks strip, and companion mode are retired from `/live`. The office fits
   to its floor's drawn bounds at a ~0.99 margin.
2. **The team column shows who, which model, and what.** Each card shows:
   - the member's avatar in their hue;
   - a model badge: **provider logo + readable model name**, from the live presence's
     `model`/`model_source`. A declared model is marked "declared"; a missing one reads "model
     unknown", never a guess; humans get a "human" badge;
   - a plain-language state;
   - the in-flight lane title, with its goal and elapsed time.

   A card expands to today's operator detail (role, harness, chips, trace). Nameplates add the
   short model name beside the provider logo. Lane titles do not go on plates.
3. **Motion means something.** Members whose posture is `working` get no ambient errands or desk
   chats, only in-place micro-gestures; errands go to members between lanes. Every purposeful walk
   (handoff, help, steer) carries a verb tag. An open ask to a human is shown in the room as a
   raised hand and a card resting on the human's desk until it resolves. A closable "how to read
   the office" key is shown by default.
4. **Headlines, not traffic.** Notable acts become one-line headlines. One pure function, from
   names and lane titles, words both the ticker and the walk tags, and never uses an act body
   verbatim except an ask's clipped question. The full stream remains, unchanged, in a log drawer
   one click (or `L`) away.
5. **Asks as a banner.** An open ask shows as a banner over the office: who is asking whom, what,
   the hold state, and the clock, with inline Approve/Deny for a signed-in answerer. Operator
   states map to plain phrases. `deriveAsks` / `holdState` semantics and the answer path are
   unchanged.
6. **No protocol, server or schema change, and no new dependency.** Everything draws on data
   `/live` already fetches.

## Considered and rejected

- **A presenter mode beside an unchanged operator `/live`.** The screen people see first should
  tell the story. Operator detail moves one click down rather than getting its own mode.
- **Building on `/broadcast`.** It is a fixed 1920×1080 stage tuned for Twitch, with no roster
  or log. It adopts the new parts afterwards (spec §8, lane 5).
- **Full-bleed office with overlays.** Most immersive, but the overlays cover the floor, and a
  bottom card strip with 8+ members crowds.
- **Three columns (team | office | headlines).** The office ends up smallest.
- **Lane titles on nameplates.** They make plates long and bring back the overlap #1772 fixed.

## Consequences

- Operators lose the always-visible roster and stream columns. Both are one click away (card
  expand, log drawer), and the `?lane=` / `BoardOverlay` paths are unchanged.
- `RosterPanel`, `Stream`, `AsksStrip` and `WorkStack` stop being `/live` columns. Their
  components survive where other routes or the drawer use them.
- `docs/architecture/08-web.md` changes with each implementation lane, not with this ADR.
- The contrast gate must measure the faded "declared" badge and the provider-tinted chips.
  Budgets are expected to hold, because four retired surfaces pay for the new ones. That is
  measured per lane.

## Observability & Evaluation

- **Traces:** n/a. A UI layout change emits no acts or `TraceEvent`s.
- **Eval:** the spec §1 success test. A first-time viewer, with no narration, answers in under 10s
  at 1920×1080: who is on the team, what each member is doing, which model each agent runs,
  whether the team is busy, and whether an agent is waiting on a human. The five falsifiers in
  spec §1 are checkable, and falsifiers 1–3 are unit-tested.
- **Baseline:** the 2026-09-27 demo, where the room could answer none of these without
  narration (nick's debrief, 2026-09-28).
- **Experiment:** at the next live showing, count the audience questions of the form "what is X
  doing / which model / is it working". The target is none that the screen already answers.
