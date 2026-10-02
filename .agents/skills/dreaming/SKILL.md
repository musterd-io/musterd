---
name: dreaming
description: How a seat consolidates overnight — save the day's traps and numbers as insights, promote anything seen twice into a wiki page with a date and a falsifier, as a PR that wiki:check gates. Use when Presence provenance is dream, or when you hold the dreaming write path.
---

# dreaming

You are idle, outside working hours, woken with provenance `dream`. You re-read the day's record and turn it into memory the team can find in the morning. You write insights, wiki pages, and your own seat note. You never write code.

The charter is the lane brief (Dreaming 3/5). This is the playbook. Where they disagree, the brief wins and this file has a bug.

## Authoritative sources (they win over this file)

1. ADR 494 (PR #1955) — when a seat dreams (idle, off-hours, per-night budget, a dream never rings the doorbell). Lane 1. `ringTargets` returns no one for `from_provenance: 'dream'`. A deferred dream costs nothing; a dream is always a fresh session.
2. Lane 2's write fence (`dreamMayWrite`) — the only tools that pass: `team_insight_save`, wiki-page writes under `docs/wiki/**`, `team_memory_save` on this seat. The server enforces the act row; this skill enforces the file row.
3. `docs/wiki/README.md` — H1 + one-sentence summary; defect claims dated and falsifiable; strike-and-date corrections; writes through a seat PR.
4. `.agents/skills/dated-and-falsifiable/SKILL.md` — a claim carries the date it was observed and an observation that would overturn it; a falsifier must be able to fail.
5. `docs/design/brand.md` §4–§5 — voice and glossary. Team, Member, Presence, Surface, Act keep their meanings.

## When you run

Presence provenance is `dream` (server-derived from the lease; the same signal `/live` keys the low lamp on). Wake derivation is `dream`. If either is missing, you are a normal session: stop and wait for a real task.

A dream never rings the doorbell. An Act you send is never a wake reason for another seat.

## The packet you read

Read it with `musterd dream` (optional `--since <epoch-ms>`). The command prints one JSON object, `{packet, used_bytes, truncated}`, for this seat only (lane 2, PR #1958). There is no MCP tool for it: the read happens once a night and does not take a slot on every seat's tool surface. `packet` is what `buildDreamPacket(db, team, seat, {since?, now?})` returns (`packages/server/src/store/dream.ts`). Window: last Act this seat sent with provenance `dream`, else 24h. 24 KB budget; oldest lane acts drop first; the seat note is never dropped.

```
{ seat, since, until,
  memory?: { body, truncated },
  lanes: [{ id, title, state, acts, omitted }],
  learned: [{ id, from, headline, body, tags, ts }] }
```

`lanes` is the day's record on **your own lanes**. `learned` is every insight the Team saved in the window — search it (and `team_insight_search`) before you re-derive.

## The loop

1. **Inventory.** From the packet, list each trap (something broke, went missing, or reached nobody) and each number (a count, a rate, a duration) you can state in one sentence.
2. **Save new observations as insights.** For each item with no matching insight since `since`: `team_insight_save {headline, body}`. Headline like a commit subject. Body carries the date and the observation. The server rejects an insight body over 2048 bytes. Never put secrets in it.
3. **Promote what you have seen twice.** Two dated observations of the **same claim**, on two different dates (see Promotion rule), become a wiki page — or an append to the page that already holds it.
4. **PR the wiki change.** Branch from `origin/main`, commit as this seat (ADR 109), open a PR. `pnpm wiki:check` must pass. Then `pnpm wiki:index` if you added a page, in the same commit as the page.
5. **Note.** `team_memory_save` on this seat: what you promoted, what you left as insights, where you stopped. Last-write-wins, private, no secrets.

Stop when the packet is processed or the nightly budget is spent. One promotion done well beats a sweep of undated pages.

## Promotion rule

**Seen twice** means two dated observations of the same claim, on two different dates. An observation is any one of:

- a saved insight (in the packet's `learned`, or earlier),
- an existing wiki page that already states the claim,
- a dated act in this dream's packet (a lane act, a status, an incident) that shows the claim.

Any two of these count — two insights, an insight and a page, or an earlier insight and tonight's lane act (the fixture walk's case). They must be two sightings, not one counted twice: the insight you save tonight *from* a packet act is the same observation as that act. A single vivid night stays an insight until a second dated observation arrives.

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

`dreamMayWrite(seat, w)` is the verdict (`packages/server/src/store/dream.ts`). Quote the reason it returns; do not work around it.

The server enforces the act row only. While this seat's live Presence has provenance `dream`, a send of any other Act is refused (403, audited `send.denied`, the act reason below). Lane 2 does not enforce the file row in the server (PR #1958; ryder agreed 2026-10-01, huddle `goal:dreaming`). This skill does. Before a file write or a note write, apply the same verdict. A refusal is a stop.

| `w.kind` | ok when | reason when refused |
| --- | --- | --- |
| `act` | `w.act === 'insight'` | `a dream sends only insight acts, not ${w.act}` |
| `memory` | `w.seat ===` this seat | `a dream writes only its own note, not ${w.seat}'s` |
| `file` | after a leading `./` is stripped, the path matches `docs/wiki/**/*.md` and no segment is `..` | `a dream writes only docs/wiki/**/*.md, never code (${w.path})` |
| `lane` | never | `a dream never moves a lane` |
| `other` | never | `a dream may not ${w.what}` |

`team_insight_save` is the insight Act. A path the file row allows is what you commit: the page lands as the PR in step 4 (branch from `origin/main`, this seat, `pnpm wiki:check`, and `pnpm wiki:index` in that same commit). The server does not write the file. A path outside that tree and a `..` segment both return the file reason above. `team_memory_save` is this seat's note. Everything else is refused.

## One walked fixture

`fixture-packet.json` is one packet. `fixture-walk.md` is this loop applied to it: the inventory, the one new insight, the one promotion, the note, and one write the fence refuses. The claims in those two files are fixture claims. Do not file them as team insights, and do not copy the promoted page into `docs/wiki/`.

## What the morning digest can cite

Lane 4 reads `learned` from the packet, plus wiki pages this dream promoted. You do not post the digest. The digest is an ordinary `message` to `@team` at the start of working hours (`meta.digest = { day: 'YYYY-MM-DD' }`, proposed by miley) and rings as normal.

## What you never do

- Write code, tests, or anything outside `docs/wiki/**`.
- Open, claim, or resolve a Lane.
- Send an Act that would wake a human or ring the doorbell.
- Promote a claim you have observed once.
- Author a wiki summary by hand in `INDEX.md` — generate it.
- Invent a second "dreaming" flag on Presence. Provenance `dream` is the signal.
