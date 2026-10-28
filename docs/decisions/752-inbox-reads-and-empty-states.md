# 752 — Inbox reads and view-specific empty states

- Status: accepted
- Date: 2026-10-28

## Context

Lane `01M61VT6BJ8ZYE3Q455TMQKYD4` follows Nick's CLI experience review. In an isolated two-member team on 2026-10-28, reading `musterd inbox --unread --json` twice returned the same act; reading the same view in text advanced the cursor. The help says a read advances it. A subsequent empty unread view said nobody had communicated, even though an act had just been read.

ADR 117 requires a bounded inbox to show every unread it consumes and only advance past what it shows. The CLI's JSON branch returns before its cursor update; this made output format choose whether a read counted, although `--peek` already names a non-consuming read. ADR 113 and the terminal brief pin an empty-state example that also misdescribes an empty personal inbox after someone sends a team message.

## Problem

A human and a script need the same meaning for the same read, and an empty view must describe that view. Changing JSON's existing side effect can surprise scripts that relied on an implicit peek.

## Decision

A normal or unread inbox read advances the cursor after showing the same rows, whether rendered as text or JSON. `--peek` is the explicit non-consuming form for either format. The existing `--id`, `--from`, `--act`, `--deferred`, `--waiting`, `--all`, `--watch` and `--wait` contracts remain as they are; a filtered or named read never consumes the unread window. The cursor advances only to the newest unread row actually shown, retaining ADR 117's bounded-view guarantee.

Replace the general empty state with `Your inbox is empty.`; `--unread` says `No unread messages.`; an empty filtered view says `No messages match these filters.` These lines describe the selected view, not the team's history. The terminal brief and brand example track the new general state (amending ADR 113's example).

## Consequences

Scripts that used `musterd inbox --json` or `musterd inbox --unread --json` as a non-consuming poll must add `--peek`; the message array stays unchanged. The CLI help and architecture name this migration. No wire schema or server cursor behavior changes.

## Observability & Evaluation

- **Traces:** Existing inbox read and mark-read requests show whether a cursor advanced; no new event or message content is logged.
- **Eval:** An isolated team exercises text and JSON reads, `--peek`, filters and `--id`, including an unread window larger than the default. Every displayed unread is consumed only by an ordinary read, and empty copy matches the view.
- **Experiment:** n/a — this fixes the documented read contract; the isolated before/after reproduction is the comparison.
