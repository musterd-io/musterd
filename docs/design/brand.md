# musterd — Brand Source of Truth

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

This file is the single source of truth from which all three Figma briefs and all CLI/README visual choices derive. If a brief and this file disagree, this file wins — fix the brief (with an ADR if the change is substantive).

---

## 1. Name & wordmark

- **Name:** `musterd` — always lowercase, even at the start of a sentence in body copy where possible. In headings it may be capitalized (`Musterd`) only when typographic convention forces it; prefer lowercase.
- **Etymology / story (for voice, not for repetition):** _muster_ ("assemble the team", "roll call" = presence) + the `-d` daemon suffix, with a deliberate mustard pun for warmth. Do not over-explain the pun in product copy; one wink in the README is enough.
- **Tagline (canonical):** _"Agents that work as a team alongside you."_ ([ADR 563](../decisions/563-the-claim-is-the-team.md), 2026-10-12, nick; it replaces _"Agents that answer for their work."_ of ADR 550.) "Alongside you" says the person is a member on the same roster, never that the person supervises the agents.
- **Subhead (canonical):** _"Agents and the people they work with are named members of one team. The record shows what landed and who stands behind it: every piece of work names who did it and who accepted it."_ (ADR 563 decision 2, sloane, lane `01M4RM3PEPV7CJCZHJ27CFZM21`, 2026-10-12: what the reader gets before how. "Which model did it" and "any member can say no" are stated where the chain is shown, never in the subhead. 2026-10-12, nick: no harness is named on the site; "agents" and "harness" stand in for Claude Code, Codex and Cursor, here and in the one-liner. 2026-10-19, lane `01M5AWZ95YKDHBM4BJ14CDXAG2`: the subhead, the one-liner and llms.txt no longer lean on "your" and "you" — the tagline's "alongside you" already puts the reader on the team, and nick cut the GitHub repo description for leaning on them again; the earlier form was _"Your agents and the people you work with are named members of one team. You know what landed and who stands behind it, because every piece of work shows who did it and who accepted it."_)
- **Repository description (GitHub, canonical):** _"Agents that work as a team alongside you: named members across any harness, and every piece of work shows who did it and who accepted it."_ (nick, 2026-10-19; the tagline, a colon, then the subhead's two facts in one clause. One line only, as GitHub shows it.)
- **Short form (one line only — CLI banner, social bio, package description):** _"Your agents, on a team with you."_ (lowercase in the CLI banner, as the banner sets everything.)
- **One-liner (canonical):** _"Agents and the people they work with join one team as named members, whatever harness they run in. The record shows what landed and who stands behind it: who claimed the work, which model did it and who accepted it."_ (It names "which model" with what that buys the reader in the same sentence, as decision 2 requires; "counts as done on an agent's own word" is the chain section's line, not this one's.)
- **Why these strings** ([ADR 563](../decisions/563-the-claim-is-the-team.md), 2026-10-12, nick: the claim is the team, and the chain is the subhead and the proof. The rest of this bullet is [ADR 550](../decisions/550-positioning-accountable-agents.md), accepted 2026-10-08, nick, whose decisions 2 to 7 still hold): the claim was accountability. The tagline states it; the subhead keeps the human on the team before anyone reads it as oversight; accountability runs both ways. They replace _"Muster your agents and humans into persistent teams."_ and the _"Named, persistent teams…"_ one-liner (ADR 320, decisions 1 and 4 superseded). A surface that still carries the old strings is drift to close, not an alternative. "Coordination layer" stays out of headlines and taglines; technical docs may use it.
- **Claim discipline:** these strings may not be extended into a guarantee the record does not hold. "Who asked" is only partly recorded, and the record shows the chain without proving it (ADR 550 §3, §7). Copy says "the record shows", never "proves" or "guarantees". [ADR 665](../decisions/665-accountability-message-a-person-at-both-ends.md) §3 (2026-10-19) adds how far the accountability message may go:
  - The spoken and written form of the message under the tagline, wherever a surface argues the case, is ADR 665 §1's sentence exactly: _"Nothing your agents do counts as done until another member accepts it. The record shows who did it, who accepted it, and which model."_ One verb everywhere: "accepts" / "who accepted it", never "checks", "approves" or "signs off" for the acceptance.
  - _"A person at both ends"_ is a section title and never a sentence a speaker says, until **both** conditions hold: (1) `requested` (ADR 629) names a person, or carries a verified basis (`act`, `seed`), on at least nine in ten lanes opened in a 30-day window — a seat's `self` does not put a person at the start; and (2) ADR 662's device signature is enforced on `authorized_by`, and on human accept where a lane requires one. Until then "who asked" stays out of the sentence and is said, when asked, as "recorded from this month, on the seat's word". From both conditions the second sentence gains the start of the chain: _"The record shows who asked, who did it, who accepted it, and which model."_
  - The merge sign-off ("a person signs off what lands") is said as the record names it — attested, on the seat's word — never as verified, until the daemon can see the merge.
  - _"In one read"_ may be said, citing `musterd lane show` (ADR 629, #2771: asked, claimed, model, accepted and authorized on one page, each marked verified, stated or missing). That the acceptance was _independent_ is not claimed until the review grade is on the accepted line (ADR 670).

### Wordmark rules

- **CLI wordmark — the framed roll-call nameplate** (CLI banner; ADR 114): a rounded panel (dim borders) holding three presence dots (online · away · offline, the CLI's own glyphs), the lowercase **`musterd`** word with a trailing terminal cursor (`▊`), and the tagline (a terminal cannot draw the mark, ADR 497). Compact, bold, modern; **no multi-line letter-art** (block or outline, it reads as retro). The mark _is_ the product — `muster` = take the roll, a team present. Source of truth: `packages/cli/src/render/rows.ts` `renderBanner`. A plain lowercase `musterd` string is still the wordmark in the README header.
- **Wordmark — the nameplate** (ADR 704): the word `musterd`, every letter drawn (none typeset), on a sand plate (`#EBD9A0`, the tile's colour) with a white ring and a mustard edge (`#E1AD01`). Letters, the `m` and the seats are deep teal `#1F6F6B`; the two sparks in the `m`'s cuts are mustard-700 `#B8860B`. The letters follow the tile's `m` (ADR 702): flat tops and bottoms with chamfered corners, one 74-unit round-capped stroke, a round seat at each stem foot (m, u, r, d). The plate is its own ground, so one version serves light and dark pages. Not meant to be smaller than about 24px tall. It replaces the lowercase JetBrains Mono wordmark with a mustard `d`. The CLI wordmark above is text and unchanged. Source: `docs/design/assets/wordmark.svg`; code: `packages/web/src/brand/wordmarkMark.ts`, rendered by `MusterdWord`.
- **The mark** (compact mark; ADR 702, superseding the ADR 497 hand-drawn `m` and the ADR 154 chip): a lowercase **`m`** drawn from straight stems and flat-topped shoulders with soft corners, in a white rounded-square ring (48 units wide, centred), on a **flat sand** tile (`#EBD9A0`, 30% corner radius, a faint brown rim so it holds an edge on light greys). The left stem runs into the first shoulder; the second and third stems stop a thin cut short of their shoulders, and each stem ends in a round **seat** (one per member: a roll call). The `m` and seats are deep teal `#1F6F6B`: an 80-unit stroke with 50-unit seats, so the letter leads and the seats read as feet. The tile is one flat colour on every surface: no gradient, no transparency, no blur. Two weights: full (≥24px) and small (<24px: stroke +26, seats +13, so the cuts stay open); the small cut is the only one in code. Used for favicon, MCP icons, `/live` topbar, the office-scene corner, npm/GitHub avatar. The tile colour is the mark's own and is **not** the brand accent: mustard stays the one accent everywhere else. Source: `docs/design/assets/chip.svg` and `chip-sm.svg`; code: `packages/web/src/brand/chipMark.ts`.
- **Nameplate Tile** (expressive mark; ADR 154, face updated by ADR 497; face redrawn to the ADR 702 mark): the full mark at the office scene's 2:1 isometric angle, with optional soft mustard glow on web/marketing surfaces only (ADR 037). Source: `docs/design/assets/tile.svg`.
- **Never:** stylized "MusterD", camel case, a standalone icon glyph that isn't the mark's own `m` (including a lone capital **M**), a double semicircular arch `m` (reads as another company's mark), pointed peaks on the shoulders (reads as houses), red anywhere near the sand, gradients or transparency on the tile, 3-D on the mark itself, drop shadows on the wordmark, a wordmark that splits the word into differently coloured first letters.

---

## 2. Color

Single accent philosophy: **one mustard accent** carries the entire identity right now. Everything else is neutral zinc. This is deliberately minimal and fully reversible.

### Accent — Mustard ramp

| Token         | Hex       | Use                                    |
| ------------- | --------- | -------------------------------------- |
| `mustard-50`  | `#FBF3D5` | faint tint backgrounds (web)           |
| `mustard-100` | `#F6E4A8` | hover tint                             |
| `mustard-300` | `#EFC94C` | secondary accent / highlights          |
| `mustard-500` | `#E1AD01` | **primary accent** (canonical mustard); text only on dark (8.6:1 on zinc-900) |
| `mustard-700` | `#B8860B` | accent pressed / dark-mode accent text; marks on light (3.3:1) |
| `mustard-900` | `#7A5A06` | accent text and links on light (6.4:1) |

Primary accent is **`#E1AD01`**. When a single color value is needed for a fill (badge, banner, chip), use this. On a light background it is a fill only: as text it reads 2.06:1 on white. Text and links on light use `mustard-900`, the same fill/ink split the web tokens hold (`--accent` / `--accent-ink` in `packages/web/src/styles/tokens.css`, #723).

### Neutrals — Zinc ramp

| Token      | Hex       | Use                   |
| ---------- | --------- | --------------------- |
| `zinc-50`  | `#FAFAFA` | web light bg          |
| `zinc-100` | `#F4F4F5` | light surface         |
| `zinc-200` | `#E4E4E7` | borders (light)       |
| `zinc-400` | `#A1A1AA` | muted text on dark (6.9:1 on zinc-900; 2.5:1 on light, so not there) |
| `zinc-500` | `#71717A` | secondary text on light (4.6:1 on zinc-50; 3.7:1 on zinc-900, so not there) |
| `zinc-700` | `#3F3F46` | borders (dark)        |
| `zinc-800` | `#27272A` | dark surface          |
| `zinc-900` | `#18181B` | dark bg / terminal bg |
| `zinc-950` | `#09090B` | deepest bg            |

### Semantic (web dashboard + ANSI mapping)

| Meaning | Light hex | Dark hex  | ANSI (terminal) |
| ------- | --------- | --------- | --------------- |
| success | `#15803D` | `#22C55E` | green           |
| warning | `#B45309` | `#F59E0B` | yellow          |
| danger  | `#B91C1C` | `#EF4444` | red             |
| info    | `#1D4ED8` | `#60A5FA` | blue            |
| accent  | `#E1AD01` | `#EFC94C` | yellow (bold)   |
| muted   | `#71717A` | `#A1A1AA` | bright black    |

The light accent is a fill. Accent text on light is `mustard-900` (`#7A5A06`); see the mustard ramp above.
The web's warm paper palette (`:root[data-theme="light"]` in `tokens.css`) carries the same split with
its own pair, measured on the painted paper rather than white: the fill is `mustard-700` (`--accent`)
and text is `#7a5a12` (`--accent-ink`).

### ANSI color mapping (terminal — load-bearing, the CLI must obey)

The CLI uses only these mappings so output stays on-brand and degrades cleanly in 16-color terminals:

- **accent / brand** → bold yellow
- **member name (agent)** → cyan
- **member name (human)** → magenta
- **presence: online** → green dot `●`
- **presence: away** → yellow dot `●`
- **presence: offline** → bright-black dot `○`
- **act badges** → see §5 glossary; rendered as `[act]` in dim white, except `request_help` (bold yellow) and `decline` (red)
- **timestamps / metadata** → bright black (dim)
- **errors** → red; **warnings** → yellow; **success confirmations** → green

---

## 3. Typography

Two typefaces ([ADR 705](../decisions/705-web-type-dm-sans.md), 2026-10-21). **DM Sans** is the text face for display and body. **JetBrains Mono** is the data face. Successor to Recursive ([ADR 477](../decisions/477-web-type-recursive.md)).

- **Display and sans (headings, member names, chyron labels, body, web chrome, marketing):** `DM Sans`. CSS tokens `--font-display` and `--font-sans` name the same family. One committed variable file: optical size 9–40 and weight 100–1000. The DOM uses optical sizing. Canvas paints the file's default, optical size 9, because `ctx.font` cannot set axes.
- **Mono (data, timestamps, ids, CLI-mirroring UI, Figma terminal frames):** `JetBrains Mono`. CSS token `--font-mono`. Digits are equal width. The weight axis runs 100–800, so 600 and 700 are real. The CLI itself inherits the user's terminal font — Figma terminal frames must use a mono that visually matches an 80-col terminal grid.
- **Wordmark:** the drawn nameplate ([ADR 704](../decisions/704-the-wordmark-nameplate.md)).

The two files are committed latin cuts. DM Sans is `@fontsource-variable/dm-sans@5.2.8` (the CSS family is `DM Sans`; the name table says `DM Sans 9pt`). JetBrains Mono is a latin subset of the upstream variable font, version 2.305, name table left intact.

### Type ramp (web/docs)

| Token     | Size / line-height | Weight | Family         |
| --------- | ------------------ | ------ | -------------- |
| display   | 40 / 48            | 780    | DM Sans        |
| h1        | 28 / 36            | 700    | DM Sans        |
| h2        | 22 / 30            | 600    | DM Sans        |
| h3        | 18 / 26            | 600    | DM Sans        |
| body      | 15 / 24            | 400    | DM Sans        |
| small     | 13 / 20            | 400    | DM Sans        |
| mono-body | 14 / 22            | 400    | JetBrains Mono |
| mono-sm   | 12 / 18            | 400    | JetBrains Mono |

### Terminal type ramp (Figma terminal frames)

Single mono size at `14 / 22`; bold for emphasis; never italic in terminal frames (terminals render it inconsistently).

---

## 4. Voice & tone

- **Plain, declarative, no hype.** No "revolutionary", "magic", "supercharge", "10x". State what it does.
- **Second person, present tense** in docs ("you create a team", not "users can create teams").
- **Lowercase product name**, sentence-case headings.
- **Respect the reader's intelligence.** Short sentences. One idea per sentence. Lead with the concrete.
- **Honest about scope.** When something is roadmap, say "not yet" plainly — never imply it exists.
- **No contrast frame.** Never "X, not Y", "it's not X, it's Y", "X rather than Y" or "X instead of Y". Say what the thing is and stop. The frame argues with a position nobody in the room took, and it is the most recognisable tell of machine-written copy (nick, 2026-09-30). Scope stays honest by stating it plainly — "your sandbox and your host decide what an agent can touch" — without setting it against a straw man.
  - **Before and after is allowed as story structure** (nick, 2026-10-13). A talk, a deck or a launch post may show how things are and then how they could be, the shape of Andy Raskin's strategic narrative and Nancy Duarte's "what is / what could be". Two conditions. The "before" is specific and true: the reader's own situation or our measured past (two agents on one repo undoing each other; 37% of our agents' code never reaching main), never an invented straw man. And it is shown as a scene, with the sentence-level ban above still holding inside every scene. The deck's slide 2 is the pattern: it describes the silo and its cost and never says what musterd is not.
- **Copy a person says is in that person's voice.** A slide or a script line for nick reads as nick talking to the room — never as an assistant reporting to him ("measured on our own history").
- **Provenance lives off the surface.** File paths, ADR numbers and how-we-measured go in speaker notes, docs and the wiki. A slide carries the claim; the person presenting carries the source.
- The single allowed bit of personality: one mustard pun in the README, and warm-but-spare microcopy in the CLI (e.g. empty inbox: `inbox empty — nobody's mustered anything yet`).

---

## 5. Terminology glossary (canonical — used identically in SPEC, CLI, docs, UI)

The original five stay. The load-bearing set grew in [ADR 296](../decisions/296-terminology-architecture.md). Source of truth: `docs/glossary/terms.ts` — `pnpm vocab:check` fails if this table loses a canonical term. Do not introduce synonyms.

What the gate enforces is narrower than what this table publishes, and the difference is deliberate. Linted outright (no legitimate second sense in prose; git's own `worktree` feature is named as a mention, in backticks): **kit**, **profile**, **template**, **worktree**. <!-- vocab:ok --> <!-- this sentence IS the gate's own definition, and `lintedSetDrift` parses these bold spans to prove it has not drifted from `terminologyBans()` — so they cannot be backticked into mentions, and the suppression above is the only way both checks can be true at once --> Every other word in a Not column is authorial guidance, held in review rather than by a regex: those words are wrong only when used *as* the canonical term, and `adapter` the MCP adapter, `connection` the WebSocket, `participant` in a huddle and `verb` in the audit log are all correct English in this repo. A gate that banned them outright would buy suppressions, not clarity ([ADR 296](../decisions/296-terminology-architecture.md), amended 2026-09-05).

| Term | Definition | Not |
| --- | --- | --- |
| **Team** | A named, persistent group of Members with shared messaging — a standing roster, not a project. It outlives any task, session, or repository. | not "room", "channel", "swarm", "project" |
| **Member** | Anyone on the roster — the canonical noun. `kind` is `agent`, `human`, or `service`. Carries name, `roles[]`, lifecycle, availability. A Member is not a session. | not "agent" (as the generic noun), "seat" (as a synonym for member), "user", "participant" |
| **Presence** | Where a Member is currently attached (a harness session, the CLI, later an app). One Member can have multiple Presences. | not "session", "connection", "status" |
| **Surface** | Where a Member touches the team: an agent's harness; a human's musterd CLI or web. Glossary meaning only. | not "client", "adapter"; not the files a lane touches (that's **Scope**); not marketing channels |
| **Act** | The typed intent of a message: `message`, `status_update`, `request_help`, `handoff`, `accept`, `decline`, `wait`, `resolve`, `steer`, `challenge`, `defer`, `ask`. | not "type", "kind", "event", "verb" |
| **Agent** | The industry hook, and a *kind* of member (`agent · human · service`). Marketing copy leads with it. | not the generic noun for team participants — any sentence also true of humans or services says *member* |
| **Seat** | The durable position a member keeps — exists while they are away; claimed, adopted, handed off, woken. Used only where durability or occupancy is the subject. | not a synonym for member; not a license unit |
| **Role** | A responsibility the team grants a member: charter + ceiling. Team-side, reviewed, harness-independent. May name a `default_toolkit`. | not workspace setup; never granted by a local file |
| **Toolkit** | What a workspace is equipped with: MCP servers, tools, allow-entries. No authority — installing one grants nothing. | not "profile", not "kit", not "template" |
| **Workspace** | The folder a seat is bound to. | not "worktree" as a synonym (git's own feature keeps its name, in backticks) |
| **Office** | Everything a team shares, as one place: its board, its members' inboxes, its memory and its record. The office scene at `/live` draws it as a room you can watch. A workspace is one seat's; the office is the team's ([ADR 578](../decisions/578-the-office-and-knowledge-work.md)). | not the team itself (the office is where a team works, not who is on it); not the daemon, MCP or the hub — plumbing, never named as the office in copy |
| **Harness** | The agent runtime family: Claude Code, Cursor, Codex. | not "surface"; not "platform" |
| **Launcher** | `musterd`'s seat picker and the code that starts a seat's harness in its workspace ([ADR 491](../decisions/491-seat-launcher.md)). | not the harness registration that marks a Presence's Surface ([ADR 286](../decisions/286-launcher-surface-convergence.md)) |
| **Metaharness** | musterd owning the process and terminal around any harness — today launching and supervising it ([ADR 491](../decisions/491-seat-launcher.md)). Never the agent loop, which stays with the harness ([ADR 436](../decisions/436-wake-edge-is-a-contract-not-a-loop.md)). | not a harness |
| **Driver** | How a harness session runs: desktop, terminal, IDE, headless. Already the wire field (`presence.driver`). | not a harness; not a surface |
| **Scope** | The paths a lane may touch. The wire token since 2026-08-24 (ADR 296 tier 2, epoch 14); legacy `surface_globs` accepted on read. | not "surface" |
| **Permissions** | The harness-native allow/ask/deny rules musterd compiles into the workspace (ADR 261). | not "capabilities" |
| **Capability** | Team-granted authority on a member, enforced by musterd itself (`is_admin`, MCP tool scoping). Internal/protocol vocabulary; user-facing prose says what it means instead. | not tool wiring; not harness rules |

Secondary nouns (consistent but not in the load-bearing set): **Inbox** (a Member's durable mailbox for messages received while offline), **Envelope** (the on-wire message structure), **Roster** (a Team's list of Members), **Lifecycle** (`forever | session | until <ts>`), **Availability** (a Member's schedule; v1 stores it, does not enforce it). Hosted-team nouns ([ADR 475](../decisions/475-cloud-hosted-teams-postgres.md), 2026-09-29): **Account** (a person's identity at the console; proves who, never membership), **Console** (`app.musterd.io`, the account service), **Owner** (the human-facing word for a Member holding `is_admin` — one thing, two words), **Guest** (the name of a talk-only role on an invite; in copy the person is a Member).

---

## 6. Reversibility note

This entire identity is intentionally small: one name, one accent color, one wordmark family (wordmark + chip + tile), the §5 glossary, two typefaces, plain voice. Every choice here can be walked back without code changes beyond a palette constant and a banner string. Do not expand the brand (mascots, multi-color systems, illustration beyond the chip/tile marks) without an ADR and an explicit decision to invest. The chip and tile marks are recorded in [ADR 154](../decisions/154-unified-logo-system.md).

## 7. Web surface (carve-out)

The **landing / marketing web surface** (`packages/web`) is allowed to go maximal — an immersive scene (Canvas2D since ADR 094 removed WebGL), gradients, glows, depth, motion, and a deep-black ground — while the **product chrome** (CLI, terminal frames, the future dashboard's functional UI) stays minimal under §1–§6. The shared anchor is unchanged on every surface: mustard `#E1AD01` is still the one accent, DM Sans and JetBrains Mono are the two typefaces (§3), the wordmark is the drawn nameplate ([ADR 704](../decisions/704-the-wordmark-nameplate.md)), and copy stays plain and declarative (the _experience_ carries the spectacle, never the words). This split, its guardrails (reduced-motion fallback, static-first content), and its limits are recorded in `docs/decisions/037-web-surface-aesthetic.md`. Since [ADR 681](../decisions/681-site-neutral-product-palette.md) (2026-10-20), the site's light ground and ink are the product's neutral palette (white and cool grey, as /live's frame), with no mustard tint bands; the spectacle is the office, not the paper.
