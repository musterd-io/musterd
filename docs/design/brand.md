# musterd — Brand Source of Truth

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

This file is the single source of truth from which all three Figma briefs and all CLI/README visual choices derive. If a brief and this file disagree, this file wins — fix the brief (with an ADR if the change is substantive).

---

## 1. Name & wordmark

- **Name:** `musterd` — always lowercase, even at the start of a sentence in body copy where possible. In headings it may be capitalized (`Musterd`) only when typographic convention forces it; prefer lowercase.
- **Etymology / story (for voice, not for repetition):** _muster_ ("assemble the team", "roll call" = presence) + the `-d` daemon suffix, with a deliberate mustard pun for warmth. Do not over-explain the pun in product copy; one wink in the README is enough.
- **Tagline (canonical):** _"Agents that work as a team alongside you."_ ([ADR 563](../decisions/563-the-claim-is-the-team.md), 2026-10-12, nick; it replaces _"Agents that answer for their work."_ of ADR 550.) "Alongside you" says the person is a member on the same roster, never that the person supervises the agents.
- **Subhead, short form and one-liner are being rewritten** under ADR 563 decision 2 in lane `01M4RCBNZ3P5SGG1ERDEC05H0B` (sloane): the chain stays as the subhead and the proof, and each of those strings must say what the chain buys the reader before it names how (claimed, model, accepted, declined). The three lines below are ADR 550's and stand until that lane lands; a surface carrying them is not drift until then.
- **Subhead (ADR 550, until rewritten):** _"On musterd, every member answers for its work: the agents and the people they work with."_
- **Short form (one line only — CLI banner, social bio, package description):** _"Every member answers for its work. Agents included."_
- **One-liner (canonical):** _"Claude Code, Codex, and the people you work with join one team as named members. Each claims its work, can say no, and ships only when someone else accepts it — and the record shows which model did what."_
- **Why these strings** ([ADR 563](../decisions/563-the-claim-is-the-team.md), 2026-10-12, nick: the claim is the team, and the chain is the subhead and the proof. The rest of this bullet is [ADR 550](../decisions/550-positioning-accountable-agents.md), accepted 2026-10-08, nick, whose decisions 2 to 7 still hold): the claim was accountability. The tagline states it; the subhead keeps the human on the team before anyone reads it as oversight; accountability runs both ways. They replace _"Muster your agents and humans into persistent teams."_ and the _"Named, persistent teams…"_ one-liner (ADR 320, decisions 1 and 4 superseded). A surface that still carries the old strings is drift to close, not an alternative. "Coordination layer" stays out of headlines and taglines; technical docs may use it.
- **Claim discipline:** these strings may not be extended into a guarantee the record does not hold. "Who asked" is only partly recorded, and the record shows the chain without proving it (ADR 550 §3, §7). Copy says "the record shows", never "proves" or "guarantees".

### Wordmark rules

- **CLI wordmark — the framed roll-call nameplate** (CLI banner; ADR 114): a rounded panel (dim borders) holding three presence dots (online · away · offline, the CLI's own glyphs), the lowercase **`musterd`** word with a trailing terminal cursor (`▊`), and the tagline (a terminal cannot draw the mark, ADR 497). Compact, bold, modern; **no multi-line letter-art** (block or outline, it reads as retro). The mark _is_ the product — `muster` = take the roll, a team present. Source of truth: `packages/cli/src/render/rows.ts` `renderBanner`. A plain lowercase `musterd` string is still the wordmark in the README header.
- **Vector wordmark** (Figma): lowercase `musterd` set in the brand mono typeface (see §3), letter-spacing `0`, single accent dot or the `-d` rendered in accent mustard is the only permitted flourish.
- **The mark** (compact mark; ADR 497, superseding the ADR 154 chip): a hand-drawn lowercase **`m`** with a tail, in a white rounded-square ring, outlined in zinc-900 (`#18181B`), on a flat mustard (`#E1AD01`) tile with ≈22% corner radius. The ground is the brand accent, never the logo art's original yellow. Two cuts: **full** (≥24px, with the ink outlines — a file) and **small** (<24px, outline dropped, glyph thickened — the only cut in code). Used for favicon, MCP icons, `/live` topbar, the office-scene corner, npm/GitHub avatar. Source: `docs/design/assets/chip.svg` (full) and `chip-sm.svg` (small); code: `packages/web/src/brand/chipMark.ts`.
- **Nameplate Tile** (expressive mark; ADR 154, face updated by ADR 497): the full mark at the office scene's 2:1 isometric angle, with optional soft mustard glow on web/marketing surfaces only (ADR 037). Source: `docs/design/assets/tile.svg`.
- **Never:** stylized "MusterD", camel case, a standalone icon glyph that isn't the mark's own `m` (including a lone capital **M**), recoloring the mark's ground away from mustard, gradients or 3-D on the mark itself, drop shadows on the wordmark.

---

## 2. Color

Single accent philosophy: **one mustard accent** carries the entire identity right now. Everything else is neutral zinc. This is deliberately minimal and fully reversible.

### Accent — Mustard ramp

| Token         | Hex       | Use                                    |
| ------------- | --------- | -------------------------------------- |
| `mustard-50`  | `#FBF3D5` | faint tint backgrounds (web)           |
| `mustard-100` | `#F6E4A8` | hover tint                             |
| `mustard-300` | `#EFC94C` | secondary accent / highlights          |
| `mustard-500` | `#E1AD01` | **primary accent** (canonical mustard) |
| `mustard-700` | `#B8860B` | accent pressed / dark-mode accent text |
| `mustard-900` | `#7A5A06` | accent on light, high-contrast text    |

Primary accent is **`#E1AD01`**. When a single color value is needed (badge, link, banner), use this.

### Neutrals — Zinc ramp

| Token      | Hex       | Use                   |
| ---------- | --------- | --------------------- |
| `zinc-50`  | `#FAFAFA` | web light bg          |
| `zinc-100` | `#F4F4F5` | light surface         |
| `zinc-200` | `#E4E4E7` | borders (light)       |
| `zinc-400` | `#A1A1AA` | muted text            |
| `zinc-500` | `#71717A` | secondary text        |
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

One family, **Recursive**, in three cuts ([ADR 477](../decisions/477-web-type-recursive.md), 2026-09-29; it replaced Inter + JetBrains Mono here and the Inter + Space Grotesk + Space Mono the web had drifted to).

- **Display (headings, member names, chyron labels):** `Recursive Casual` — Recursive's casual axis. CSS token `--font-display`.
- **Sans (body, web chrome, marketing):** `Recursive` — the linear cut. CSS token `--font-sans`.
- **Mono (data, timestamps, ids, CLI-mirroring UI, Figma terminal frames):** `Recursive Mono`. CSS token `--font-mono`. The CLI itself inherits the user's terminal font — Figma terminal frames must use a mono that visually matches an 80-col terminal grid.

The three cuts are committed files cut from the upstream variable font by `scripts/fonts/instance-recursive.py` (latin only, weight axis 400–800). The **wordmark** is unchanged: lowercase JetBrains Mono, as drawn.

### Type ramp (web/docs)

| Token     | Size / line-height | Weight | Family           |
| --------- | ------------------ | ------ | ---------------- |
| display   | 40 / 48            | 780    | Recursive Casual |
| h1        | 28 / 36            | 700    | Recursive Casual |
| h2        | 22 / 30            | 600    | Recursive Casual |
| h3        | 18 / 26            | 600    | Recursive        |
| body      | 15 / 24            | 400    | Recursive        |
| small     | 13 / 20            | 400    | Recursive        |
| mono-body | 14 / 22            | 400    | Recursive Mono   |
| mono-sm   | 12 / 18            | 400    | Recursive Mono   |

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

The **landing / marketing web surface** (`packages/web`) is allowed to go maximal — immersive WebGL, gradients, glows, depth, motion, and a deep-black ground — while the **product chrome** (CLI, terminal frames, the future dashboard's functional UI) stays minimal under §1–§6. The shared anchor is unchanged on every surface: mustard `#E1AD01` is still the one accent, Recursive (§3) is still the only type family, the wordmark is still lowercase JetBrains Mono, and copy stays plain and declarative (the _experience_ carries the spectacle, never the words). This split, its guardrails (reduced-motion fallback, static-first content), and its limits are recorded in `docs/decisions/037-web-surface-aesthetic.md`.
