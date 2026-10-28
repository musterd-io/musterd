# 744 — Allowance in the /live header, on humans only

- Status: accepted
- Date: 2026-10-27

## Context

[ADR 723](723-allowance-on-the-member-card.md) put what's left on a subscription on the member card: one 28px line per account, under the name, on any seat that carried a reading, humans and agents alike. An agent carried a reading when its live model matched one account on its node or driver.

Swetha asked on 2026-10-27 for two changes. Agents do not show allowance. A human's subscriptions stay on that human: nick's agents spend nick's accounts and swetha's agents spend swetha's, so the agent's line repeated its human's account a second time, and two humans must never be merged into one line. The lines leave the team cards for the /live top bar, with one named cluster per human who has a reading, offline humans included.

Slippy drew three placements (lane 01M5ZFNPKA): one line per human beside the meter, a ledger before the tools, and a face chip that shows only the lowest window. Nick picked the chip.

## Problem

ADR 723 placed the line on the card and painted it for agents. Neither holds now, and the top bar has no room for a cluster per human beside today's 28px wordmark and the tour's entry button.

## Decision

On `/live`, allowance is painted in the top bar and nowhere else. The member card no longer carries a what's-left line. `/broadcast` carries none, as before.

Only humans are painted. One chip per human whose roster row has an `allowance` reading, online or offline. A human with no reading has no chip, and with no chips nothing renders. An agent's reading stays on the roster, attributed as ADR 723 says, and is not painted.

A chip is a button: the human's face, then the name, then the percent of that human's lowest window across all their accounts (least left, the soonest reset on a tie), then a 28px bar of what is left. _(Amended 2026-10-27: the chip names every account, and a percent window shows the share used. See [ADR 745](745-allowance-percent-used.md).)_ The window and colour rules are ADR 723's: warn ink under 15% left, muted type once the reading is older than two minutes, no new colour. A quiet chip dims its face, never its words. Below 440px the name hides.

A click opens a card under the chip, with one row per account, lowest first, in ADR 723's words ("Codex Pro 9% left", other windows as muted suffixes) _(Amended 2026-10-27: a percent window's words are the share used. See [ADR 745](745-allowance-percent-used.md).)_ and a 56px bar. A stale reading adds a muted line: "last read 3h ago", or "offline · last read 3h ago" for an offline human. The units are "just now", "4 min ago", "3h ago" and "2d ago". Only one card is open at a time. Escape and a press outside close it. The card keeps 12px from the viewport's edge.

The chip's accessible name starts from what it shows: "nick's allowance: Codex Pro 9% left, the lowest of 2 accounts". _(Amended 2026-10-27: the name lists each account and drops the count clause. See [ADR 745](745-allowance-percent-used.md).)_ A single account drops the count clause. A stale reading appends ", offline, last read 3h ago" or ", last read 3h ago". The copy is alfie's (comms).

Chips sit after the Now slot. The signed-in viewer's chip comes first, then online humans, then offline humans, by name within each group. The tour's entry button leaves the `/live` top bar; `/board` keeps it. `/live`'s top-bar wordmark is 20px; `/board` and the site keep 28px.

## Consequences

The roster, the `POST /allowance` route and ADR 723's attribution are unchanged; this is a `/live` painting change. ADR 723's Decision still describes the card line; its Consequences carry a dated note pointing here.

Amended 2026-10-27, [ADR 745](745-allowance-percent-used.md). A percent window paints the share used, and the chip names every account. The stored `left` field and the warn threshold are unchanged. Amount windows still say what is left.

A human who wants to start the tour on `/live` has no entry button there now. `/board` still offers it, and the tour's own resume pill is unaffected.

## Observability & Evaluation

Traces: none. The chips read the roster's existing `allowance` field and emit nothing.

Eval: the dataset is `AllowanceChips.render.test.ts`, covering humans only, offline humans kept, the lowest account leading, the viewer-first order, the label and stale-note strings, and the empty state. `TeamCard.render.test.ts` checks that the card no longer paints the line. The baseline is ADR 723's card line, which painted for agents too.

Experiment: none. Checked by eye on a fixture daemon at 1440, 1920 and 390, with a card open, before landing.
