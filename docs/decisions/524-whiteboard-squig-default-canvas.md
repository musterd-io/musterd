# 524 — Squig is the whiteboard's default canvas; tldraw stays as the fallback

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (asked for it), lazara (lane `01M476418N4RR2BM2ZGWEXFJZE`, handed over by sloane)
- Relates to: ADR 330 (the agent whiteboard and its provider port), AGENTS.md hard rule 6 (no new runtime dependency without an ADR)

## Context

ADR 330 built the brainstorm whiteboard behind a provider port (decision 3) so the canvas could
be swapped by writing one adapter. Its only adapter is tldraw. On 2026-10-05 nick asked for
Squig — a canvas he already runs, with its own local editor and MCP server — to become the
brainstorm canvas. tldraw stays until Squig has proven itself in a few real sessions.

Squig has no npm package. It runs from a local checkout (`~/.squig/src`, or `SQUIG_CHECKOUT`)
built with `pnpm build:local`. `squig.ts mcp <file>` opens one file, takes a sibling `.lock`,
serves the editor on a loopback port, and prints an editor URL whose fragment carries a bearer
token. The same token authorizes its tools over HTTP (`POST /api/v1/tools/<name>`). One file is
one document.

The team already has a Squig companion (`scripts/squig-mcp.mjs`). It writes
`docs/wireframes/team.squig.json` into the repository, which ADR 330 decision 6 forbids for
brainstorm boards.

## Problem

Three things in Squig do not fit the port as it stands:

- **No container.** Squig has notes (boxed text), labels (text) and arrows bound to node ids.
  It has no frame and no label on an arrow.
- **No version counter.** Its `revision` is a content hash, not a monotonic number.
- **No change notice.** A human's edit in the browser reaches the file by the editor's own
  autosave and is announced to nobody, so the port's `since` read has nothing to stand on.

The open question is also where brainstorm boards live, and what happens on a machine without
Squig.

## Decision

1. **A second adapter, `packages/whiteboard/src/squig/`, behind the unchanged port.** The
   `whiteboard_*` tools, SKILL.md, attribution, the edit policy and `since` reads stay as they
   are.
2. **Squig is the default whenever a usable checkout exists.** That means a checkout with a
   local editor build, run on Node 22.6 or newer. Otherwise the service uses tldraw, and
   `whiteboard_open` says why in its result. `WHITEBOARD_PROVIDER=tldraw|squig` pins the choice.
3. **The adapter drives one Squig companion per board, over loopback HTTP.**
   - It talks to Squig's REST mirror of its tools with plain `fetch`, so there is no MCP client
     dependency.
   - A companion lives from open to close, so the human's editor tab keeps working.
   - A dead owner's stale `.lock` is cleared. A live owner's lock is respected.
4. **Boards live under the whiteboard's data dir:** `~/.whiteboard/squig/<board>.squig.json`
   (ADR 330 decisions 1 and 6), never in a repository. The team companion in
   `scripts/squig-mcp.mjs` is a different surface and is left as it is.
5. **The vocabulary maps as follows:**
   - A *cluster* is a dashed rect frame plus a title text node.
   - *Membership is geometric*: a note belongs to the smallest cluster whose frame contains its
     centre. So a human dragging a note out of a cluster takes it out, which is ADR 330's
     dissent mechanic with no extra rule.
   - A *link label* is a text node tied to its arrow.
   - Freehand, images and components are `other`, which sets `hasUnrepresentable`.
6. **A sidecar, `<board>.meta.json`, holds what Squig cannot hold reliably:**
   - who placed each item;
   - a note's `detail`;
   - which hidden nodes are cluster titles and link labels;
   - the change ledger.

   Every port call reads the live document and diffs node fingerprints against the ledger. Each
   batch of changes bumps the board's version once. A node with no sidecar entry came from a
   human hand.

**Dependency (hard rule 6).** The new runtime dependency is external and optional: a local
Squig checkout plus Node 22.6 or newer. No npm package is added to `@musterd/whiteboard`. The
alternative considered was vendoring Squig, or depending on its source as a git dependency.
That was rejected: Squig is a Next.js app with its own toolchain, and pulling it into the
workspace would put its build into every install for a feature most machines will not use.

## Alternatives rejected

- **Store authorship on the node.** Squig's agent path keeps unknown fields: a `meta` key
  round-tripped in a spike on 2026-10-05. The browser editor's save path was not verified to
  keep them, and losing authorship silently would break the edit policy. The sidecar does not
  depend on Squig's internals.
- **Clusters as Squig groups (`groupIds`).** A group of one dissolves, membership cannot be
  read off the canvas, and a human cannot leave a group by dragging. Geometry can do all three.
- **Speak Squig's MCP over stdio from the service.** That would add an MCP client dependency
  for what four REST calls already do.
- **Replace tldraw outright.** It is the fallback on every machine without Squig, and the proof
  that the port really is swappable.

## Consequences

- A brainstorm on a machine with Squig opens in Squig's editor. The URL handed to the human
  carries the companion's access token. It is loopback-only, held in memory, and never logged.
- The board's version is the sidecar's counter. A human's edit shows up in the next port call,
  not the moment it lands. There is no push from Squig.
- A cluster's members and frame size are re-laid out by the adapter after membership changes,
  as the tldraw adapter does. A human's free placement inside a frame is kept until the next
  relayout of that cluster.
- The package's suite gates the adapter against an in-memory Squig, so CI needs no checkout.
  `squig.integration.test.ts` runs the same contract against a real companion wherever a
  checkout exists.
- One more idle local process per open board, until `whiteboard_close` or service shutdown.

- **2026-10-05, folded into one server ([ADR 527](527-one-whiteboard-mcp.md)):** the team
  companion this ADR left alone (`scripts/squig-mcp.mjs`) is retired. Its file is now the
  whiteboard's linked board `team`, and Squig's tools reach every board through `whiteboard_*`.

## Observability & Evaluation

- **Traces:** the service logs which provider it chose, and why it fell back, at start. The
  provider name rides on every `whiteboard_open` result, and `/healthz` reports it.
- **Eval:** the round-trip suite (`src/squig/provider.test.ts`) covers:
  - write half readable by read half;
  - attribution and detail surviving a restart;
  - `since` covering human edits and removals;
  - edit-policy refusals;
  - links deleted with their endpoints.

  Its baseline is ADR 330's tldraw suite; the same contract must hold for both adapters.
- **Experiment:** nick's "a few real sessions". If three brainstorms on Squig end without a
  fallback to tldraw and without lost attribution, the next step is to retire the tldraw
  default text from SKILL.md. If a session loses authorship or a `since` read misses a human
  edit, the sidecar design is the thing to revisit.
