# ADR 571: A day in the life replaces the chain section on the home page

- **Status:** accepted (nick, 2026-10-12)
- **Date:** 2026-10-12
- **Lane:** `01M4S6956Z8GZ6QAWJRGB7ZKXF`

## Context

ADR 567 (2026-10-12) made the chain section, "One piece of work, from claimed to accepted", the
page's only statement of the lane's record: four stops on one real lane beside its board card. On the
demo day of 2026-10-09 the slide that landed was a different one, "A day in the life of a member"
(`docs/demo/demo-day-2026-10-09/deck.html`, slide 10): one session of a designer agent as ten steps
on a graph, each click lighting a node, drawing the edge into it and swapping a caption card. nick,
reading the live page on 2026-10-12, asked for that section in the chain's place, with its motion.

## Problem

The chain is four dated sentences and a cropped screenshot. It states the record, but it shows
nothing moving, and it says nothing about what a member's session is like: that the inbox is checked
after every tool call, that a teammate's question reaches an agent mid-build, that a review request
sends it to judge someone else's work. Those are what the room responded to, and the page had none
of them.

## Decision

1. **The chain section is replaced by `DayInTheLife`**: the deck's ten steps (join, orient, claim,
   build, inbox, a teammate asks, ask a person, ready for review, review, wrap up) on the deck's
   graph, with a caption card that swaps per step. ADR 567 decision 2 is reversed: the lane's record
   is no longer a section of its own.
2. **The record is still stated once, inside the steps.** Claim carries "the record names who holds
   the work"; Ready for review carries "landing is not the same as done" and that a member from
   another model family judges what landed; Review carries that the verdict goes on the record.
   "Who asked" stays out (ADR 550 §3). ADR 550 decision 2 (the chain stated exactly) is met by
   these three steps.
3. **Motion rules.** The walk advances by itself only while the section is at least a third on
   screen and the visitor is neither hovering nor focused inside it; it rests longer on the last step
   and then starts over. Under `prefers-reduced-motion` nothing moves by itself and every node and
   edge is shown; the controls still change the card. Every node is a button and the card has
   previous/next, so every step is readable in any order, and the card is `aria-live="polite"`.
4. **No harness is named** (nick, 2026-10-12, lane `01M4S1GJJ4D461QBDXB4GZ2Z2C`). The deck's "how"
   chips named one harness's hooks; the page's chips say when the moment happens ("after every tool
   call", "session start"), not whose hook fires it. The member is miley, a designer agent on our
   own team; the teammate is izzo and the person is nick, as in the deck.
5. **Order unchanged** from ADR 567 decision 3: hero with the office, this section, why, getting
   started, teasers, the boundary line, the footer.
6. **On a phone** the graph becomes a numbered row of the steps and the card follows it; the edges
   are not drawn.

## Consequences

- `Chain.tsx`, `Chain.css` and the board-card capture `board-lane-2026-10-12.webp` are deleted.
- `landing.test.ts` pins the order, the ten steps, the three record sentences, the no-harness rule,
  and the motion and reach rules.
- homepage-copy-spec §0a.3 is rewritten for this section; §0a.8 counts the text the visitor sees at
  once (heading, lead, one caption) and notes the text present in the DOM.
- ADR 567 carries a dated note in its Consequences; its Decision is untouched.
- _(2026-10-12, lane `01M4S7VG2FEB58837CNDYMSPK4`, nick: "it should be a continuous smooth animation, not a
  step jump".)_ Decision 3's motion is replaced: a walker carrying miley's mark travels the edges
  without stopping, the edge drawing under it; a node pops and the card swaps when the walker
  reaches it; return edges are travelled on the way; from Wrap up it takes the loop edge home while
  the graph fades and the day restarts. It runs whenever the section is on screen and the tab is
  visible, and hovering no longer holds it: a click, tap or arrow key moves the walker to that step
  and holds it for eight seconds, keyboard focus inside holds it while it lasts. The reduced-motion
  rule and the reach rules (every node a button, previous/next, `aria-live`) are unchanged.
- The site's CSS budget is measured in the lane's PR; a raise, if needed, is logged in
  `docs/perf/web-live-baseline.md` (ADR 183).

## Observability & Evaluation

**Traces.** n/a — a prerendered marketing page.

**Eval.** Measured in the lane's PR: `pnpm perf:check` on the built client, and the a11y leaves of
`gates`. Visually checked on the dev build at 390x844 and 1440x900.

**Experiment.** n/a.

## Falsifier

Open musterd.io after this lands. If the section after the hero is not the ten-step graph, if it
keeps moving while the pointer rests on it, if it moves at all under reduced motion, or if any node
cannot be reached by keyboard, this ADR is not implemented.
