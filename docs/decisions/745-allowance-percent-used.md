# 745 — Allowance percents show used, and every account is named

- Status: accepted
- Date: 2026-10-27

## Context

[ADR 744](744-allowance-in-the-live-header.md) paints one chip per human in the `/live` top bar. The chip showed one number: the percent left of that human's lowest window, with no account name. The card named the accounts, in words that still said how much was left.

Swetha asked on 2026-10-27 for the percent used, and for Claude to be shown. On this machine Claude was often the tightest window, so the number was Claude's, and the chip did not say so. Cursor and Muse never appeared on the chip at all.

## Problem

A reader cannot tell which subscription the number belongs to. "Percent left" answers how much remains. The question she asked is how much has been used. The stored window is still the share remaining, and an amount window (characters, dollars) is still a count of what is left.

## Decision

The stored window field `left` (0 to 1, the share remaining) does not change. This is not a protocol change.

A percent window is painted as the share used: the whole percent `clamp(round((1 - left) * 100))`. The words are "{account} {used}% used". The bar fills with that used share. Other percent windows of the same account stay muted suffixes, "{name} {used}%", without the word "used". The title sentence is "{account} has {used}% of the {name} window used."

An amount window stays a count of what is left ("9,000 characters left"). Its bar stays the share left.

Warn ink stays where `left` is under 0.15. Order stays least `left` first, which is most used first. The chip's tone follows that first account.

The chip names every account, in that order, each with its words and its own bar. It no longer shows one unlabeled percent. The accessible name is "{name}'s allowance: " plus each account's words, joined by commas. It does not add "the lowest of N accounts". A stale reading still appends ", offline, last read …" or ", last read …". The card uses the same words.

Agents stay unpainted. One chip per human, in ADR 744's order.

## Consequences

This replaces the painted percent-left and lowest-window-only sentences in ADR 744's Decision. Those sentences keep dated markers; their words are unchanged. ADR 723's painted example "38% left" gets the same marker. The stored `left` field stays the share remaining. `docs/architecture/08-web.md` carries the current sentence.

A fuller bar now means more used. ADR 744's bar meant more left.

A chip with several accounts wraps. Its height stays at least 30px, and it stays within the top bar, so the 390px target-size floor still sees the button.

## Observability & Evaluation

Traces: none. The chips read the roster's existing `allowance` field and emit nothing.

Eval: `packages/web/src/live/allowanceLine.test.ts` and `AllowanceChips.render.test.ts`. A window with `left` 0.18 paints "82% used" and a bar at 82. A window with `left` 0.14 paints "86% used" and still warns. An amount window still says how many are left, and its bar stays the share left. Two accounts both appear in the chip's accessible name and in the button, most used first. The baseline is ADR 744's unlabeled percent left.

Experiment: none. Swetha asked to see the used percent, and to see Claude named on the chip.
