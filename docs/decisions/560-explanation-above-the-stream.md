# 560 — The explanation sits above the stream: ADR 428's section order is reopened

- Status: accepted (2026-10-12, nick; drafted by alfie in session with nick)
- Date: 2026-10-12
- Lane: `01M4RFC872BS8X9MBE9AFVY73F` (goal `home-page-cut`)
- Supersedes: [ADR 428](428-one-office-above-the-fold.md) decision 1, the clause that makes the
  stream the page's second section. ADR 428 decisions 2 to 5 stand.

## Context

ADR 428 (2026-09-21) fixed the home page order as hero, stream, explanation. Its reason was a
composition defect: two office blocks rendered 418 px apart at 390 px wide, and the fix was one
office, the stream, with the still as its offline state. The order was where that one office landed,
not a decision about where the explanation goes.

Since then three things moved under it.

1. [ADR 550](550-positioning-accountable-agents.md) (2026-10-08) made the chain the opening: work
   carries who claimed it, which model did it, and who accepted it. The waste number is the proof
   line and never the opening. The stream is "we build it on itself", a supporting claim.
2. The 2026-10-09 copy revision ([homepage-copy-spec](../design/homepage-copy-spec.md) §0) put a
   record card directly under the hero, above the stream, and in §0.5 recommended moving the
   explanation above the stream too. It said that reopens ADR 428 and needs nick's call. The call was
   not made, so the page shipped as the sum of the two orders.
3. The 2026-10-12 audit ([homepage-audit-2026-10-12](../design/homepage-audit-2026-10-12.md))
   measured the live page: 894 words, seven sections, one image; at 390 px wide the explanation
   starts on the third screen (y=1703) and the page runs 5,080 px. The audit's §5 reduces the page
   to five sections and asks for the order below. sloane's copy lane `01M4RCBNZ3P5SGG1ERDEC05H0B`
   and miley's build lane `01M4RCBXVYXXDMB1T3TZF787XJ` are written to work in either order and are
   waiting on this one.

## Problem

A first-time visitor gets a claim (the hero), a proof of it (the record card), then a live picture of
a room they do not yet understand, and only after that the sentences that say what the room is.
With the stream second, every sentence that explains the product sits a screen and a half below
the fold on a phone, and the first thing the page shows is the one thing it never explains.

ADR 428's own text has no stake in the order. Decisions 2 to 5 (one office; the still as the
player's offline state; `unknown` shows the still; the SDK player; the hero keeps the first screen)
are about what the office is, and all of them hold at any position on the page. Decision 1 fixed
the position only because the office had to go somewhere once `OfficeProof` was deleted.

## Decision

1. **The order is hero, the chain, why, the stream, getting started.** As route components:
   `SiteNav → LightHero → <the chain> → <why> → StreamSection → GettingStarted → Teasers → SiteFooter`.
   The record card of copy-spec §0.4 becomes the hero's right column, so the claim and its proof
   share the first screen. "The chain" and "why" are the two explanation sections of the audit's
   §5; their names and strings are the copy lane's, and this ADR fixes only their place.
2. **ADR 428 decision 1 is superseded in its order clause only.** `OfficeProof` stays deleted and
   its sentences stay in `StreamSection`. The stream is the page's one office, now its fourth section.
3. **The stream goes back below the fold, and its loading goes with it.** ADR 428 moved the still
   above the fold and made it eager with `fetchPriority="high"`. At the new position it is below
   the fold at 390 px and at 1414 px wide, so the still returns to `loading="lazy"` with no priority
   hint. The fixed-aspect slot, the overlay and the measured zero layout shift are unchanged.
4. **The ADR 302 viewer-count gate is unchanged, and fewer visitors reach it.** The player mounts
   only when its box is on screen; lower on the page, fewer visitors scroll to it, so fewer count as
   Twitch viewers. That cost is taken on purpose: on this page the stream's job is proof, and the
   chain is the opening (ADR 550).
5. **The order is a decision, not a side effect.** The next change to it is an ADR superseding this
   one, with a measurement at 390 px wide.

## Consequences

- miley's build lane `01M4RCBXVYXXDMB1T3TZF787XJ` implements the order with sloane's copy. The tests
  that pin the stream's position and loading strategy (`landing.test.ts`, `streamSection.test.ts`)
  change in that lane to pin the new position and `loading="lazy"`.
- copy-spec §0.5's open question is closed by this ADR; the spec gets a dated note pointing here in
  the copy lane.
- ADR 428 carries a dated marker on decision 1 and a dated note in its Consequences.
- Twitch's concurrent-viewer count from the home page falls by however many visitors never scroll
  to the fourth section. There is no telemetry for it; Twitch's own channel stats are the only
  reading, and the drop is accepted (decision 4).
- Nothing changes for `/watch`, `/live` or `/broadcast`, which have their own layouts.

## Observability & Evaluation

**Traces.** n/a — a prerendered marketing page; nothing is emitted or logged.

**Eval.** Dataset: the home page at 390x844 and 1414x761. Baseline, measured 2026-10-12 on the
live site: the explanation's heading at y=1703 at 390 px, page height 5,080 px, the stream at
y=777. After the build lane lands: the explanation's heading inside the second screen (y < 1688)
and the stream's box fully below the first screen at both widths, with the ADR 428 eval re-run
unchanged (one office in all three liveness states, layout shift under 0.01). Pinned by
`landing.test.ts` once the build lane updates it.

**Experiment.** n/a — one order at a time; the change is verified by re-measuring, not by a split.

## Falsifier

Open musterd.io at 390x844 after the build lane lands. The first explanation heading is on the
second screen and the stream is below it; block `player.twitch.tv/js/embed/v1.js` and the still is
what remains in the stream's slot, lazily loaded, with a caption that does not claim the channel is
live. Either a stream above the explanation or a second office block falsifies this ADR.
