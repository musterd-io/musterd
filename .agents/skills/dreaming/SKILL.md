---
name: dreaming
description: How a seat consolidates overnight — save the day's traps and numbers as insights, promote anything seen twice into a wiki page with a date and a falsifier, as a PR that wiki:check gates. Use when Presence provenance is dream, or when you hold the dreaming write path.
---

# dreaming

You are idle, outside working hours, woken with provenance `dream`. You re-read the day's record and turn it into memory the team can find in the morning. You write insights, wiki pages, and your own seat note. You never write code.

The charter is the lane brief (Dreaming 3/5). This is the playbook. Where they disagree, the brief wins and this file has a bug.

## Authoritative sources (they win over this file)

1. ADR 494 (PR #1955) — when a seat dreams (idle, off-hours, per-night budget, a dream never rings the doorbell). Lane 1. `ringTargets` returns no one for `from_provenance: 'dream'`. A deferred dream costs nothing; a dream is always a fresh session.
2. Lane 2's write fence (`dreamMayWrite`) — the only tools that pass: `team_insight_save`, wiki-page writes under `docs/wiki/**`, `team_memory_save` on this seat.
3. `docs/wiki/README.md` — H1 + one-sentence summary; defect claims dated and falsifiable; strike-and-date corrections; writes through a seat PR.
4. `.agents/skills/dated-and-falsifiable/SKILL.md` — a claim carries the date it was observed and an observation that would overturn it; a falsifier must be able to fail.
5. `docs/design/brand.md` §4–§5 — voice and glossary. Team, Member, Presence, Surface, Act keep their meanings.

## When you run

Presence provenance is `dream` (server-derived from the lease; the same signal `/live` keys the low lamp on). Wake derivation is `dream`. If either is missing, you are a normal session: stop and wait for a real task.

A dream never rings the doorbell. An Act you send is never a wake reason for another seat.

## The packet you read

Lane 2's `buildDreamPacket(seat, since)` is the input. `since` is the last `residency.woke {derivation:'dream'}` for this seat, else 24h. It carries:

- the day's Acts on **your own lanes**
- your seat note
- insights saved since `since`

Search before you re-derive: `team_insight_search` on the trap or number in front of you.

## The loop

1. **Inventory.** From the packet, list each trap (something broke, went missing, or reached nobody) and each number (a count, a rate, a duration) you can state in one sentence.
2. **Save new observations as insights.** For each item with no matching insight since `since`: `team_insight_save {headline, body}`. Headline like a commit subject. Body carries the date and the observation. Never put secrets in it.
3. **Promote what you have seen twice.** A second dated observation of the **same claim** (this dream's insight plus an earlier insight, or this dream plus an existing wiki page) becomes a wiki page — or an append to the page that already holds it.
4. **PR the wiki change.** Branch from `origin/main`, commit as this seat (ADR 109), open a PR. `pnpm wiki:check` must pass. Then `pnpm wiki:index` if you added a page, in the same commit as the page.
5. **Note.** `team_memory_save` on this seat: what you promoted, what you left as insights, where you stopped. Last-write-wins, private, no secrets.

Stop when the packet is processed or the nightly budget is spent. One promotion done well beats a sweep of undated pages.

## Promotion rule

**Seen twice** means two dated observations of the same claim, in two insights or one insight plus an existing wiki page. A single vivid night stays an insight until a second dated observation arrives.

A new wiki page:

```
# <Topic>

<One sentence: what this page knows.>

## <Section>

<The claim> (YYYY-MM-DD; falsify: <an observation that comes out differently if the claim is false>) <!-- claim: defect -->
```

Use `<!-- claim: other -->` when the claim is not defect-shaped. The marker sits at the end of the claim line. `wiki:check` fails a defect-shaped claim that has no date, a heading with no body, a broken intra-wiki link, index drift, or a leftover conflict marker. The shape, as a file: `page.example.md` next to this skill (outside `docs/wiki/`, so it is not indexed).

**The falsifier must be able to fail.** Ask: if this claim were false, what would this check show? If the answer is "the same thing", it is a ritual — keep it an insight until you have a check that discriminates.

**Corrections invalidate, dated.** Strike the old claim, keep it visible: `~~never installs (2026-07-31)~~ FIXED 2026-08-03 by #570`. Never overwrite.

**One page per topic.** Link related pages with relative links. Do not re-narrate an ADR; link it.

## What you write through

Lane 2's fence is the authority. Until it lands, treat this as the contract:

| Allowed | Refused |
| --- | --- |
| `team_insight_save` | code, tests, package source |
| writes under `docs/wiki/**` | `lane_*`, `team_send` to a human, the doorbell |
| `team_memory_save` on this seat | any other tool |

A refused write is the fence working. Do not work around it.

## What the morning digest can cite

Lane 4 reads what you left: new insights, and wiki pages this dream promoted or appended. You do not post the digest. The digest runs at the start of working hours, as a normal Act, and rings as normal.

## What you never do

- Write code, tests, or anything outside `docs/wiki/**` and this skill.
- Open, claim, or resolve a Lane.
- Send an Act that would wake a human or ring the doorbell.
- Promote a claim you have observed once.
- Author a wiki summary by hand in `INDEX.md` — generate it.
- Invent a second "dreaming" flag on Presence. Provenance `dream` is the signal.
