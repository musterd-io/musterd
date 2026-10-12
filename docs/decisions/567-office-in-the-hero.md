# 567 — The office is the hero's picture: ADR 560's order is reopened

- Status: accepted (2026-10-12, nick; drafted by miley in session with nick)
- Date: 2026-10-12
- Lane: `01M4RCBXVYXXDMB1T3TZF787XJ` (goal `home-page-cut`)
- Supersedes: [ADR 560](560-explanation-above-the-stream.md) decisions 1 to 4 (the order, the record
  card in the hero, the stream fourth and lazy). ADR 560 decision 5 (the order is a decision, changed
  by ADR with a measurement) stands and is used here.

## Context

ADR 560 put the record card of copy-spec §0.4 in the hero's right column and moved the stream to the
fourth section, below the fold. nick looked at the build on `pnpm dev` (draft #2397, 2026-10-12) and
named two problems:

1. The hero's card, "One lane from our own board", said the same thing as the chain section directly
   under it: the same lane, the same five facts. It was the page's one remaining duplicate.
2. "Watch the team build it" should be higher up and more prominent.

## Problem

The two are one problem. The hero's right column held a summary of the section below it, and the
thing people come to see, the team working in its office, sat fourth.

## Decision

1. **The hero's right column is the office.** `StreamSection` (the player, its still between
   sessions, its caption, one sentence and its two links) renders inside `LightHero`, beside the
   pitch. On a phone it follows the preview line.
2. **The record card is removed.** The chain section is the page's only statement of the lane's
   record. Its lead no longer points at a card above it.
3. **The order is: hero (with the office), the chain, why, getting started**, then `Teasers`, the
   boundary line and the footer. There is still exactly one office on the page (ADR 428).
4. **The still is eager again** (`fetchPriority="high"`, no `loading="lazy"`), because it is the first
   picture on the page. ADR 302's muted-autoplay viewer count is back to counting the first screen.

## Consequences

- `landing.test.ts` pins the new order, the office inside the hero exactly once, and the eager still.
- homepage-copy-spec §0a gets a dated note pointing here. The strings are sloane's; this ADR changes
  where they sit and removes the card's, and the chain's lead was rewritten to stand alone (sloane to
  confirm or replace).
- ADR 560 carries a dated note in its Consequences.

## Observability & Evaluation

**Traces.** n/a — a prerendered marketing page.

**Eval.** Measured 2026-10-12 on the dev build in headless Chrome at true size. At 390x844 the
office starts at about y=420, on the first screen, and the chain's heading is at y=841. At 1440x900
the office is in the first screen beside the tagline. No sideways scroll at either width.

**Experiment.** n/a.

## Falsifier

Open musterd.io at 390x844 after this lands. If the office's still or player is not on the first
screen, or a second office appears anywhere on the page, this ADR is not implemented.
