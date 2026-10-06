# Memory and rules — what a seat may believe, and who may tell it what to do

> **Status: exploratory design, 2026-10-05** (lane `01M46PD8FG`, ryder, with nick). It freezes once
> its decisions land in ADRs; the work then lives on a Goal with its lanes. Builds on
> [ADR 259](../decisions/259-memory-git-truth-derived-indexes.md) (truth is git + the message log;
> every memory is a derived index) and does not reopen it.

## The incident

Before the demo (week of 2026-09-28) nick told **one** agent when the demo was. That agent proposed
pausing the daemon's autorefresh for the slot — sound, and the mechanism already existed
(`musterd service hold --for`, capped at 12h). Somewhere between that conversation and the rest of
the team, "pause the autorefresh for the slot" became "**no merges and no refreshes for anyone for
a couple of hours**", and it spread seat to seat. nick then had to tell seats one at a time that
there was plenty of time and to ignore whoever said not to merge.

No insight, ADR or commit records the freeze (searched 2026-10-05). It travelled through the
untracked channels — seat memory, message bodies, handoff notes, harness memory — by agents
restating it in their own words. Each restatement lost one more of the three things the original
carried:

1. **When it ends** — "until the demo" became open-ended.
2. **Who said it** — one human's word to one agent read as team policy.
3. **What it covers** — "pause autorefresh" widened to "nobody merges".

This is one example of a general failure: **a claim can spread with no author, no end, and no way to
take it back.** This doc is about closing that, now and at scale.

## What exists today (verified 2026-10-05)

| Store                                                                     | Author        | Expiry                     | Retract / supersede        | Checked against current state on read                   |
| ------------------------------------------------------------------------- | ------------- | -------------------------- | -------------------------- | ------------------------------------------------------- |
| Seat memory ([ADR 093](../decisions/093-persistent-seat-memory.md))       | implicit      | none                       | overwrite only, no history | carried lanes vs `origin/main` only, at orient          |
| Insights ([ADR 327](../decisions/327-team-insight-act.md))                | yes           | none                       | **none**                   | no — dreams re-read them, the digest re-posts them      |
| Handoff notes, digest posts                                               | yes           | none                       | none                       | advisory (ADR 505 §6 is prose)                          |
| Lane detail                                                               | audit only    | none                       | overwrite, no history      | no                                                      |
| Harness memory (`MEMORY.md` and the like)                                 | no            | no                         | no                         | no — outside musterd                                    |
| Goals                                                                     | yes           | stale flag at 7 days       | yes                        | yes — status derives from lanes                         |
| Team policy ([ADR 185](../decisions/185-sparse-team-policy.md), 367, 398) | yes (admin)   | **none, no review date**   | yes                        | server-enforced                                         |
| Halt ([ADR 501](../decisions/501-halt-as-revocation.md))                  | yes (human)   | none (until resumed)       | yes                        | server-enforced                                         |
| Autorefresh hold (`packages/cli/src/service/hold.ts`)                     | **no**        | **yes, ≤ 12h**             | yes                        | one machine only — **the team never sees it**           |

The last row is the irony. The one store with the right shape for the demo case — bounded, clears
itself — had no author and was invisible to the team. So the rule went where agents _could_ put it:
memory and messages, the stores with no end and no retraction.

Retrieval today is plain: insights are rows in the message log with an SQLite FTS5 keyword index
(Postgres `tsvector` on Cloud, [ADR 479](../decisions/479-two-store-backends.md)); seat memory is
one 8 KiB blob; the wiki is markdown in git. No embeddings, no vector store, no graph. A search for
"demo freeze" returns nothing even where the rule was written in other words.

## Four kinds of knowledge

Everything a seat stores is one of four kinds. Today musterd stores and reads them all the same way.

| Kind             | What it is                                                     | Must carry                                    | Source of truth                         |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| **State**        | lanes, goals, the board, git                                   | — (derived)                                   | the server and the repo                 |
| **Rule**         | what the team must or must not do                              | author with authority, scope, end             | the rule store (one place)              |
| **Finding**      | something observed — an insight, a wiki claim                  | author, date, falsifier                       | the message log / the wiki              |
| **Working note** | a seat's own "where I left off"                                | the seat, `saved_at`                          | seat memory — the seat's, nobody else's |

The demo freeze was a **rule**, stored as a **working note**, and repeated as **findings**. Nothing
could say "this is a rule, it ended, and you have no authority to state it."

## Principles

1. **Only the rule store says "must" or "don't".** Any other store may _mention_ a rule only by
   pointing at it. Directive-shaped text with no pointer is marked _unsourced_ on save and on read.
2. **Every rule has an author, a scope, and an end** — an expiry for a hold, a review date for
   policy.
3. **Only a human admin activates a rule. Only a human can be an admin.** Agents may _propose_ a
   rule; a human makes it live. (Admins-are-human was decided by nick on 2026-07-28 —
   [ADR 172](../decisions/172-model-family-posture.md) — and reconcile clamps `is_admin` off agent
   seats. See "Gaps" for where that is not yet airtight.)
4. **What a seat reads is checked against current state first.** A stored claim that names a lane,
   PR, hold, goal or date is compared with that thing's current version before the seat sees it.
5. **Every finding can be retracted or superseded,** and the stores that re-broadcast findings
   (dreams, the digest, wake context) stop carrying retracted ones.
6. **Working notes are the seat's own.** Memory has no business telling the team what to do.

## The rule store

One store, three tiers. Hard rules stay where they are — in the repo, enforced by CI.

| Tier       | Scope                     | End                           | Set by                     | Today                                   |
| ---------- | ------------------------- | ----------------------------- | -------------------------- | --------------------------------------- |
| **Policy** | team                      | review date (new)             | human admin                | `POST /policy`; no review date          |
| **Hold**   | team, lane, seat, surface | required expiry (new)         | human admin; agent proposes | the autorefresh hold, local and unauthored |
| **Halt**   | one seat                  | until a human resumes         | human admin or sponsor     | ADR 501, shipped                        |

A **hold** is a time-bounded rule with a named scope: `{author, scope, effect, reason, starts_at,
expires_at}`. The demo case is
`{nick, team, autorefresh paused, "demo 14:00", 13:30 → 15:00}`. Merges are untouched, because that
is not what the hold says — and a seat that tells another "don't merge" either cites a hold that
says so or is marked unsourced.

Properties:

- **Visible everywhere it matters:** `team_next`, `team_status`, orient, and `/live` show active
  holds with author and time left. The autorefresh hold becomes a hold with
  `effect: autorefresh_paused`, written to the server instead of a local file.
- **Ends on its own.** When `expires_at` passes it is gone for every seat at once. No seat holds a
  private copy, so there is nothing to un-learn.
- **One lift reaches everyone.** Lifting a hold early is one act; every seat's next
  `team_inbox_check` shows "hold X lifted by nick".
- **Agents propose, humans activate** — a proposal is an `ask` (species `approve`) carrying the hold;
  the human's accept activates it. Presets ("demo freeze: 90m, autorefresh only") keep a human's
  decision to one tap.
- **Enforced where it can be.** Effects that map to a gate (merge, refresh, a costly class) are
  checked by the existing PreToolUse gate ([ADR 150](../decisions/150-structural-inducement-pretooluse-gates.md))
  and the autorefresh tick. Effects that cannot be gated are shown, not enforced, and say so.

## Checking on read

Generalize what orient already does for carried lanes (`packages/mcp/src/landed.ts`) to every
stored claim a seat reads — seat memory, handoff notes, insights in a dream packet, wake context.

- **Links are written at save time, not found later.** A save records the things a claim is about —
  `refs: [{lane}, {pr}, {hold}, {goal}, {until: <date>}]`. Most are already cheap to collect (the
  seat's own lane, the PR it just merged).
- **The check is lookups, not an LLM re-reading text.** For each ref: is the lane still open, the PR
  merged, the hold active, the date past? The reader sees the claim with a verdict beside it —
  `✓ current`, `⚠ hold expired 2h ago`, `⚠ unsourced rule`.
- **Directive-shaped text is detected at save.** A cheap pattern check (imperatives aimed at the
  team: "don't merge", "nobody should", "freeze") without a hold ref prompts the saver to link one;
  if it can't, the text is stored flagged _unsourced_.
- The dream packet gains `saved_at` on seat memory (today it drops it, `store/dream.ts`).

## Retract and supersede

- A new act shape (or `meta` on `resolve`) that names the finding it **retracts** or
  **supersedes**. The insight index, dreams and the digest filter on it.
- Seat memory keeps history (last N saves) so a bad note can be traced, not just overwritten.
- Lane detail keeps prior text in the audit, not only the changed field names.

## Harness memory

Harness memory (Claude Code's `MEMORY.md`, Cursor rules, and their peers) stays **the user's
choice** — musterd cannot see it and should not try to own it. The default boundary:

- **It holds facts about the human** — preferences, how they like to work. Personal, per-harness,
  fine.
- **It never holds team facts or rules.** They cannot be dated, retracted or checked there. Team
  knowledge goes to the wiki, insights or the rule store; a seat's continuity goes to seat memory.

musterd states this in its managed guidance (guidance v46, 2026-10-05). ADR 259 migrated the harness
corpus to the wiki on 2026-08-13 ([archive.md](../wiki/archive.md)); _(corrected 2026-10-05 — an
earlier draft of this doc said the migration had not happened)_. The last step it named — an edit to
nick's user-level `CLAUDE.md` — is nick's alone, and could not be confirmed from a seat.

## Retrieval

**Better retrieval would not have fixed the incident; it would have spread it faster.** The missing
piece was structure (author, end, supersede links), not recall.

Graph memory has the right idea in its _temporal_ form (Graphiti / Zep-style): every fact has a
validity interval, what invalidated it, and where it came from. The design above gives the message
log exactly that — kind, author, `expires_at`, `supersedes`/`retracts`, `refs` — which is a graph
whether or not a graph database exists.

Staged, and every stage keeps ADR 259's contract (derived, rebuildable, nothing lives only in the
index):

| Items per team      | Retrieval                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| hundreds (today)    | FTS keyword + the structure above                                          |
| tens of thousands   | + embeddings: `pgvector` on Cloud, `sqlite-vec` locally — each needs an ADR |
| millions            | + compaction summaries, a graph view over `refs`, retention by kind        |

Not: Cognee, or any external memory service, as the team's truth. It is a user-level plugin on one
machine today, woken sessions do not load it ([ADR 426](../decisions/426-wake-loads-project-settings-only.md)),
and the August measurement found it reporting `ok:true` on data it could not query.

## At scale — thousands of humans, very many agents

"Billions of agents" is mostly billions of **sessions** over a much smaller number of Members
(hard rule 7: one Member is not one session), spread across many Teams. Memory and rules are
team-scoped, so the questions are how big one Team gets and how many Teams one deployment hosts.
The second is tenancy: partition by team, which Cloud on Postgres already does.

What changes with size:

1. **The problem flips from spread to burial.** At twenty seats a bad claim spreads; at a thousand,
   good ones drown. Retrieval ranks by **authority** (human, or evidence), **freshness** (expired
   dropped), and **corroboration** (seen by more than one seat or family). Writes are bounded
   (a per-seat finding quota), and **compaction** — dreams promoting a few findings to the wiki —
   becomes the main path, not a side one.
2. **Provenance is security.** Once a Team includes agents from different owners, memory is an
   attack surface: one careless or compromised agent can inject "rules" every other agent reads.
   Principle 1 (only the rule store says "must") and principle 3 (only humans activate) are what
   make that safe. Isolation between Teams is absolute; sharing across Teams is federation, out of
   scope.
3. **Human attention is the bottleneck.** If only humans activate rules, rules must be few and
   broad and activation cheap: agents propose, humans batch-approve or pick a preset, and scopes
   nest (organization → team → lane → seat) so one decision covers many agents. Human-only stays
   absolute; what scales is how few decisions humans need to make.
4. **Checking a rule must be nearly free.** Tool calls cannot each query for active holds. The rule
   set carries a version; it is pushed to Presences and cached; a gate compares versions locally,
   and a change pushes an invalidation.
5. **Checking on read has a fixed cost** — index lookups on `refs`, which is why refs are written at
   save time.
6. **Retention by kind.** Expired holds and superseded findings move to cold storage; working notes
   are short-lived by design; state and rules keep their audit.

The point of this section is to set the **data model now** — rule scopes, the rule-set version,
`refs`, a retention class per kind, a write quota — so nothing has to be migrated later. Build only
the first stage.

## Gaps found while writing this

- ~~**`authAdmin` checks the flag, not the human** (`packages/server/src/transport/http.ts:1466`).~~
  **FIXED 2026-10-05** (lane `01M46QJ9GW`): `resolveCapabilities` now returns `is_admin: false` for any
  non-human row, so every admin gate refuses a pre-clamp agent or service row (a full-blob stale row
  got 200 on `/policy` before). No sweep needed — on revive only nick holds `is_admin`. See the
  [ADR 172](../decisions/172-model-family-posture.md) dated note.
- **The autorefresh hold is invisible and unauthored** — the exact shape of the incident.
- **Insights have no retraction**, and the digest re-posts them.
- **Team policy has no review date** — a knob set once stays forever without anyone looking again.

## Proposed sequence

ADRs first, then a Goal with these lanes:

1. ~~**Human-only admin, airtight**~~ — done 2026-10-05 (lane `01M46QJ9GW`); no ADR
   beyond ADR 172.
2. **Holds** — the rule store's hold tier, server-side; the autorefresh hold folds in; visible in
   `team_next` / `team_status` / orient / `/live`; propose-then-activate; one-act lift. Protocol
   change → ADR + SPEC Appendix A.
3. **Check on read** — `refs` on save, verdicts on read, unsourced-rule detection; dream packet gains
   `saved_at`.
4. **Retract / supersede for findings** — the act, plus filtering in the index, dreams and the digest.
5. **Harness-memory boundary** — guidance text; nick's `CLAUDE.md` edit named as his.
6. **Policy review dates** — later.
7. **Retrieval stage 2** (embeddings) — only when search measurably fails.

Lanes 1–3 together fix the incident.

## Open questions

- Should a hold's effect be a closed enum (gateable effects only) or free text plus an optional
  gate? Closed is safer; free text covers "please don't touch the deck".
- Does the unsourced-rule check run in the server (protocol-level, every surface) or in the MCP
  adapter (cheaper, Claude/Codex only)?
- How many saves of seat memory history are worth keeping — and does history make the 8 KiB note
  feel like a diary again (ADR 259 increment 3 trimmed it back to continuity)?
