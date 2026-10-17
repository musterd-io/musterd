# 652 — The delivery report says past cursor

- Status: accepted
- Date: 2026-10-17
- Lane: `01M562594H7X2DC9XVBRBPKASC`
- Builds on: [ADR 090](090-per-recipient-delivery-status.md) (the delivery ladder is a cursor watermark)

## Context

Dogfood lane `01M4EDCSJD` read the delivery report on 2026-10-17. `open_directed` held 16
unanswered `request_help` acts to nick, dated 2026-10-02 through 2026-10-14, and every one of them
printed `seen`. nick's inbox cursor stood at 2026-10-09 20:48Z. He says none of those acts came
through `/live` and he never opened them.

`recipientLedger` in `store/delivery.ts` sets `seen` when the recipient's inbox cursor is past the
act. `seen_by` is that cursor's `updated_at`. ADR 090 named this a watermark and refused a receipts
table. The audit row `continuity.cursor_advanced` stores only `{ last_read_message_id }`.

`/live` captions a member-addressed `request_help`, and the doorbell rings one for a signed-in
human who is connected when it arrives. A backfill is not a ring. A team-addressed `request_help`
captions nothing. A later read can mark the old acts seen without nick having watched them arrive.

## Problem

The report prints `seen`. A reader takes that to mean the person opened the act. The derivation is
the inbox cursor, so one read, including a catch-up, marks every older act the same way.
`peer_demand` does not use this state. The delivery line and `open_directed` do.

## Decision

1. **The wire state stays `seen`.** ADR 090's ladder is unchanged. There is no receipts table.
2. **Each delivery recipient carries `cursor_on`.** It is the cursor's `last_read_message_id` when
   the cursor is past the act, and null otherwise. One id covers every act that position passed.
   The server always sets it. The schema allows the key to be absent, so a client newer than its
   daemon still parses the report. Absence is not a receipt.
3. **The CLI and MCP print `past cursor` for that state, and name `cursor_on` when it is set.**
   `answered` stays `answered`. `seen_by` stays the cursor's `updated_at`.

## Consequences

- A bulk read still marks every older act. The line now says so and points at one cursor row.
- What moved nick's cursor on 2026-10-09 is not in the audit. The row stores the message id only,
  which is the id the report shows from here on.
- `/live` is unchanged.
- No SPEC change. The ladder lives in the protocol schema and in ADR 090.

## Observability & Evaluation

- **Traces:** n/a. A label and one derived field. No new span. `continuity.cursor_advanced` is unchanged.
- **Eval:** the delivery store test pins `cursor_on` for logged, seen, and an act tied with the cursor row. The MCP line says `past cursor on <id>`. The CLI delivery line says `past cursor` and that same id.
- **Experiment:** n/a. The misread was the word. The derivation is the one ADR 090 already accepted.
