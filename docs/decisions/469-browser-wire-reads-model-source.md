# 469 — The browser's wire reader carries `presence.model_source`

- Status: accepted — 2026-09-28 (miley; a read of an existing field, no schema change)
- Date: 2026-09-28
- Lane: `01M3MSV3513JK3G231YXBR1MW4` (goal `launch`, ADR 464 lane 1)
- Builds on: ADR 101/158 (model attestation tiers), ADR 236 (absence is not an assertion),
  ADR 464 (the team column's model badge), the 2026-09-04 `guards.ts` re-baseline (the browser's
  validator-free door into the contract)

## Context

`MemberSummary.presences[].model_source` has been on the wire since lane 01M2PAFNAS (`member.ts`):
`observed` when a harness probe saw the model during the session, `environment` / `binding` when a
person or a config declared it, and null beside a real `model` when the tier is unknown. The zod
schema reads it. The browser does not parse with zod any more (the 2026-09-04 re-baseline moved
the eight web parse sites onto `protocol/guards.ts`, a hand-written reader), and `readPresence`
there never picked the field up — so every roster row the web sees has a `model` and no tier.

Nothing on `/live` read the tier until ADR 464's team column, whose one hard rule is that the
model badge never claims more than we know: `observed` bare, a declaration marked, an unknown
tier marked as unknown. With the reader dropping the field, every badge on the page read as the
same thing, which is the falsifier the column exists to pass.

## Problem

A field the schema carries and the browser reader silently drops is a contract fork in one
direction: the wire is honest, the surface is not. The fix is a one-field read, but it lives in
`packages/protocol/src/`, which hard rule 1 gates behind an ADR — correctly, since the same file
decides which roster rows the browser accepts at all (ADR 148).

## Decision

`readPresence` in `guards.ts` reads `model_source`:

- a value in `WIRE_ATTESTATION_SOURCES` is kept as is;
- `undefined` stays `undefined` (absent, ADR 236);
- any other value — including a tier a newer daemon added that this reader does not know — reads
  as **null** ("tier unknown"), and the row is **kept**. A new tier must not cost the roster a seat
  (ADR 148's degrade-calmly promise), and null can only make a surface understate.

No schema changes. The `guards.drift` corpus keeps the reader and the zod schema agreeing on
accept / reject / normalize for every row.

The web's `modelBadge` (ADR 464) reads the tier as: `observed` → observed; `environment` /
`binding` → "declared"; null / absent beside a model → "unverified" — a different fact from a
declaration, per `member.ts`, and never read as one.

## Consequences

- The team column and anything else on the web that reads the tier can now tell seen from said
  from unknown. Before this, the CLI could and the web could not.
- A reader that silently drops a schema field is the shape to look for next time a surface
  cannot say something the wire already says; the drift corpus checks accept/reject, not
  field coverage, and this slipped through it.

## Observability & Evaluation

- **Traces:** `packages/web/src/live/modelBadge.test.ts` pins the three-way read (observed /
  declared / unverified); the `guards` tests pin that an unknown tier reads as null and keeps the
  row. On a live page, the badge suffix is the trace: "· unverified" on a seat the daemon attests
  `observed` means the reader dropped the field again.
- **Eval:** open `/live` for a team whose seats attest `observed` models; every agent badge reads
  bare (no suffix). Falsifier: any "· unverified" badge on such a seat.
- **Experiment:** n/a — a one-field read with a pinned test; nothing to measure over time.
