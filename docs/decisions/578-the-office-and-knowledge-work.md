# 578 — The office is what a team gets, and knowledge work is named as the expansion

- Status: accepted (2026-10-13, nick; drafted by sloane in session with nick)
- Date: 2026-10-13
- Lane: `01M4V6TP8NQYRHPVBWG48019FX` (goal `accountable-agents-positioning`)
- Amends: [ADR 550](550-positioning-accountable-agents.md) §4 (audience). The claim stays
  [ADR 563](563-the-claim-is-the-team.md)'s.
- Relates to: [ADR 296](296-terminology-architecture.md) (the glossary),
  [ADR 079](079-live-isometric-office.md) (the office scene), [ADR 567](567-office-in-the-hero.md)
  (the office in the hero)

## Context

nick, 2026-10-13, on the standing pitch deck and musterd.io: should we say that teams get an office,
meaning everything a team uses musterd for that is shared across it (the project, memory, messages,
the daemon, MCP) and the office space itself at `/live`? And the "who musterd is for" slide should
start naming teams of every kind doing knowledge work, while product and dev teams stay the first
use case.

Where things stood:

- **"Office" was a picture, not a term.** About a dozen ADRs (079 onward) use it for the isometric
  scene at `/live`, and since ADR 567 that scene is the homepage hero's picture. It had no glossary
  entry. The thing nick describes, everything a team shares, had no single word either: the
  glossary's **Team** is the roster ("a standing roster, not a project"), and **Workspace** is one
  seat's folder.
- **Knowledge work was in view but unnamed.** ADR 550 §4 called it the second wave: none of the
  primitives is specific to code, copy says "work" not "PRs", and the waste proof stays with builders
  until a non-code measurement exists. The deck's third audience card mentioned it in a subordinate
  clause ("Organizations: team- and org-level context, for code and knowledge work"), and
  musterd.io did not mention it at all.
- **Our own record has a usage figure.** Of the 1,572 closed lanes on revive that declared a scope,
  257 (16%) touched only `docs/`, `content/` or `.md` files: specs, research, ADRs, copy (read
  2026-10-13 with `docs/demo/pitch/counts.sh`). It is a floor, since a lane that changed a doc and
  one line of code counts as code. It shows the work runs through musterd. It is not a waste
  measurement.

## Problem

Decide whether "office" becomes a word copy relies on, and what it covers; and how far audience
surfaces name knowledge work without blurring the first buyer.

## Decision

### 1. The office is a canonical term: everything a team shares, as one place

**Office:** everything a team shares, as one place: its board, its members' inboxes, its memory and
its record. The office scene at `/live` draws it as a room you can watch. A workspace is one seat's;
the office is the team's.

- Copy names the office by what a reader recognizes: the board, inboxes, memory, the record, the
  room. **The daemon, MCP and the hub are plumbing and are never named as the office**, though they
  are how it is shared. They stay in technical docs.
- The office is not the team. The team is who is on the roster; the office is where it works.
  "Room" stays in Team's Not column: the office may be drawn as a room, but a team is never called
  one.
- "The office scene" keeps its meaning in the existing ADRs and code: it is the office drawn.
- The entry lands in `docs/glossary/terms.ts` and `brand.md` §5 in this change.

The line surfaces use: **"Every team gets an office: one place its agents and people share."**

**Rejected: the office including the project, the daemon and MCP, as asked.** The project is on the
board, so it is included. The daemon and MCP describe how musterd works, not what a team gets, and
ADR 550 §1 retired "coordination layer" for the same reason: a reader who has to be told what the
plumbing does has not been told why to care.

**Rejected: leaving "office" as the scene's name only.** The picture is already the most
recognizable thing about musterd (ADR 567). Using the same word for what the picture shows lets
the room carry the idea.

### 2. Audience surfaces name knowledge work as the expansion (amends ADR 550 §4)

ADR 550 §4's first audience stands: small product and engineering teams, and solo builders, running
many agents. What changes is that the second wave is now **named** wherever audience is shown,
instead of only kept in view:

| tier | label | who |
| --- | --- | --- |
| feeds in | Solo builders | One person, many agents, several tools. |
| first buyer | Product and dev teams | A few people and their agents on one or more repos. |
| expansion | Any team doing knowledge work | Research, writing and ops, up to whole organizations. |

- The evidence a surface may cite is the usage figure in Context, as a floor ("one lane in six on
  our own team is writing"). The waste proof (37% to 0.9%, finding 006's 65–83% to under 11%) stays
  code-shaped and is never extended to knowledge work until a non-code measurement exists (ADR 550
  §4, unchanged).
- The first buyer and every code-shaped proof line keep their place. The hero's subhead (ADR 563)
  does not change.

### 3. Where it lands

- **The standing pitch deck** (`docs/demo/pitch/`, this change): slide 5 becomes "Every team gets
  an office"; slide 9's third card becomes "Any team doing knowledge work"; the script and its
  sources say both; `counts.sh` prints the writing share.
- **musterd.io**: three strings, specified in
  [homepage-copy-spec.md](../design/homepage-copy-spec.md) §0b (two on the homepage, one on
  `/watch`). miley builds them; the design role owns the UI (sloane's charter).

## Consequences

- One new canonical term. `vocab:check` holds the brand.md table to `terms.ts`; neither Not entry
  is a linted ban (ADR 296: Not columns are review guidance).
- The pitch and the site say the same two things in the same words, which is the point of putting
  the line in an ADR rather than in each surface.
- Risk: "office" can drift back toward meaning only the picture. The test is that a sentence about
  the office stays true with `/live` closed.
- Risk: naming knowledge work invites the question "show me a knowledge-work team using it". The
  honest answer today is our own team's 16%, and no outside team yet (`script.md`'s questions).
- The writing share is re-read before every event (`docs/demo/pitch/README.md`), like slide 7's
  counts.
- Follows-up: lane `01M4V6TP8NQYRHPVBWG48019FX` hands the three musterd.io strings to miley.

## Observability & Evaluation

**Traces** — n/a: a copy and glossary decision; no code path changes.

**Eval** — `docs/demo/pitch/counts.sh` re-reads the writing share before every event. Below 10% of
scoped closed lanes, "one lane in six" comes off the deck and the site; the figure is restated, not
kept.

**Experiment** — the falsifier: musterd.io or the pitch deck names the daemon, MCP or the hub as part
of the office; an audience surface puts knowledge-work teams above product and dev teams; or a
surface states the 37% or 65–83% waste figures about knowledge work. Any one means this decision is
not implemented.
