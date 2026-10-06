# 526 — Insights can be retracted and superseded

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (took the lane, 2026-10-05); ryder for the shape below
- Lane: `01M46S3YBZ0PNEYEG5FQVSQXC6` (goal `memory-and-rules`)
- Design: [docs/design/memory-and-rules.md](../design/memory-and-rules.md) §Retract and supersede
- Builds on: ADR 327 (the `insight` act, append-only), ADR 505 (disputes — how one seat contests
  another's claim), ADR 494 (dreams), ADR 502 (the digest), ADR 522 (checks on read)
- Protocol change: yes (hard rule 1) — `meta.supersedes` on `insight`; `InsightStatus` on search
  hits; `superseded_by` on dream-packet insights; a `resolve` on an insight's own id is a retraction

## Context

Insights are append-only facts (ADR 327) and three readers re-broadcast them: `team_insight_search`,
every night's dream packet, and the morning digest. Nothing could take one back. On 2026-10-03/04
wanderer, miley and ghost each recorded the dream packet's 600-character body clip
(`01M40483V5`, `01M42P9CRR`, `01M42PBM2Q`); #2066 fixed it on 2026-10-04 and the wiki page about it
is struck "FIXED by #2066" — but all three insights kept coming back from search, the packet and
the digest, and dreams argued over them.

## Problem

A finding that has been fixed or shown wrong keeps being served as current, and the only way to
correct it — a later, contradicting insight — leaves the original in every reader beside it.

## Decision

1. **Insights stay append-only; their standing is derived.** Nothing edits or deletes an insight.
   Readers ask `insightVerdicts` (`packages/server/src/store/insightStatus.ts`) where each stands.
2. **Retract = a `resolve` on the insight's own id**, from its author or any human. `resolve`
   already takes `thread: <root id>` for a no-thread root, so no new act is minted; the body is the
   reason. A resolve on someone else's insight from a non-human seat is an ordinary resolve and
   retracts nothing.
3. **Supersede = a later insight with `meta.supersedes: [ids]`** (1..8). From the author or a human
   it hides the old one; from anyone else it only annotates it (`superseded_by`, `hides: false`).
   No seat can bury a teammate's finding: contesting another seat's claim stays ADR 505's
   `challenge`, and the author's concession is to retract or supersede their own.
4. **Hidden findings leave the three re-broadcasting readers.** Search drops them (`?all=1` keeps
   them, marked); the dream packet does not re-read them; the digest does not re-announce them.
   An insight superseded by another seat stays in all three with the pointer beside it.
5. **Surfaces.** `team_insight_save` gains `supersedes`; its description says how to retract
   (`team_send {act:'resolve', thread:<id>}`) — no new MCP tool. The CLI gains
   `musterd insight save --supersedes`, `musterd insight retract <id> --reason`. The dreaming skill
   tells a dream to supersede a contradicted insight and never promote a superseded one.

SPEC Appendix A.18 is the normative text.

## Consequences

- The lane's accept case is one act per insight: the three clip insights' authors (or nick) run
  `musterd insight retract <id> --reason "fixed by #2066"` and the findings stop appearing in
  search, tonight's packets and tomorrow's digest. Until they do, a superseding insight from any
  seat annotates all three in one save.
- Seat memory history and lane-detail history (folded into this lane's brief) are not built here:
  they are about overwritten notes, not findings, and want their own measurement first.
  Follows-up: deferred — no observed loss from an overwritten note yet; revisit on the first one (2026-10-05)
- Supersession is found with a `meta LIKE '%"supersedes"%'` scan per read. Findings are a small,
  slow-growing set; if a team's insights grow past where that is cheap, the scale stage in the
  design doc (an index over `supersedes`) is where to go.

## Observability & Evaluation

- **Traces:** none new — retractions and supersessions are ordinary `resolve` / `insight` acts in the
  log, attributed and dated.
- **Eval:** the number of nights a fixed finding is still served after its fix lands. Baseline: the
  clip insights, served from 2026-10-04 until this ADR. Target: zero nights after a retraction.
- **Experiment:** retract the three clip insights; confirm none is in the next night's dream packets
  or the next digest, and that search with `all=1` still finds them, marked retracted.
