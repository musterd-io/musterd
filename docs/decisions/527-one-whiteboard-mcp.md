# 527 — One whiteboard MCP: Squig's tools on any board, and the team canvas is a linked board

- Status: accepted
- Date: 2026-10-05
- Deciders: the human at Air 2 ("i dont want separate mcp (whiteboard and squig). i just want whiteboard, but lets not drop any functionality"; chose "any board"), lazara (lane `01M47ABYEZ6ZNMQEA6123QTCC3`)
- Relates to: ADR 330 (the agent whiteboard — decisions 2 and 6 amended), ADR 524 (Squig as the default canvas)

## Context

After ADR 524, a session in this repo registered two MCP servers for the same canvas:

- **`whiteboard`** ran the brainstorm tools and, since ADR 524, its own Squig companion per
  board under `~/.whiteboard/squig/`.
- **`squig`** (`scripts/squig-mcp.mjs`) ran one companion for the repo's team canvas,
  `docs/wireframes/team.squig.json`, and exposed Squig's thirteen tools on that file only.

Two servers meant two companions, two vocabularies and two answers to "where is the drawing".
The `squig` server also failed silently at session start when the checkout was missing,
because nothing fell back.

## Problem

Fold everything into `whiteboard` without losing anything `squig` could do. That covers:

- raw drawing with components and variations;
- render, export and measure;
- the component catalog;
- comments, history and restore;
- the team canvas living in the repo;
- several local sessions sharing one companion.

The constraint is ADR 330. Decision 2 fixed the tool set at six, and decision 6 says the
service never writes into a repository.

## Decision

1. **The whiteboard MCP re-exposes Squig's local tools under its own names, for any board.**
   Each takes `board` plus `args`, which pass through to Squig verbatim:
   - `whiteboard_document` (get_document) and `whiteboard_draw` (edit_document);
   - `whiteboard_replace`, `whiteboard_render`, `whiteboard_export`, `whiteboard_measure_text`;
   - `whiteboard_catalog`;
   - `whiteboard_comment`, `whiteboard_resolve_comment`;
   - `whiteboard_history`, `whiteboard_restore`.

   A PNG render comes back as an MCP image. `squig_documents` and `squig_local_session` have no
   twin: a board is one document, `whiteboard_list` lists boards, and `whiteboard_open` returns
   the editor URL. This amends ADR 330 decision 2: the six brainstorm tools stand, plus these
   eleven.
2. **Mutating Squig tools need a seat** (`whiteboard_open`), like `whiteboard_add`. What a seat
   creates with `whiteboard_draw` is attributed in the sidecar (ADR 524) the same way as
   `whiteboard_add`. Read-only tools need no seat.
3. **A linked board** binds a board name to a `.squig.json` the workspace chose.
   - The binding comes from `WHITEBOARD_LINKED_BOARDS` in the MCP server's environment, with
     paths resolved against the workspace.
   - It is bound with the service on first use, so it can be opened, drawn on and listed like
     any board.
   - This repo links `team` to `docs/wireframes/team.squig.json`.
   - This amends ADR 330 decision 6. The service still never *chooses* to write into a
     repository; a linked board writes where the workspace explicitly pointed it. The sidecar
     for a linked board stays in `~/.whiteboard/squig/`, so nothing new lands in the repo.
4. **The `squig` MCP server is retired.**
   - `.mcp.json` lists only `whiteboard`.
   - `scripts/squig-mcp.mjs` and its test are deleted.
   - The `squig` skill now names the whiteboard tools.
   - Sharing one companion across sessions is kept by construction: the whiteboard service is
     the one shared local process, and it holds one companion per open board.

## Alternatives rejected

- **Squig tools only on the team canvas.** That is simpler, but brainstorm boards would lose
  render, comments and history, which the human ruled out.
- **One generic `whiteboard_squig {tool, args}` tool.** It has fewer names, but every call
  would read the same, and the tool descriptions — the only schema hint a model gets — would
  collapse into one.
- **Re-declare Squig's full zod schemas in the whiteboard.** That would be a second copy of
  another project's contract, drifting at every Squig release. Passing arguments through
  verbatim keeps Squig the authority, and its schema stays at `https://squig.sh/llms-full.txt`.

## Consequences

- A session in this repo has one canvas server. Squig's capabilities appear only when the
  service runs Squig. On a tldraw fallback, every Squig tool answers that it needs the Squig
  canvas and repeats the fallback reason.
- The team canvas is reached as `whiteboard_open {board: "team"}`. Its file, git history and
  "share by committing the `.squig.json`" are unchanged.
- One fewer startup failure mode. The old `squig` server died at session start without a
  checkout; now the board falls back and says why.
- Tools that pass arguments through are only as described as their description strings. A
  Squig release that renames an argument surfaces as Squig's own validation error, not a
  whiteboard one.

- **2026-10-05, the service is guarded (lane `01M47FADGV`; miley's flag):** as first landed,
  every `/api` route took unauthenticated requests. The link route also took a file path
  straight from the request body. Binding to 127.0.0.1 does not stop a web page in the user's
  browser: a cross-site `text/plain` POST, or a DNS-rebound one, could link a board to any
  `*.squig.json` path, create its folder and write to it.

  The service now guards three ways:
  - a random token in `<data dir>/service-<port>.token` (mode 0600) is required on every `/api`
    call; the MCP client and `musterd huddle` read it from disk;
  - the `Host` must be `localhost` or `127.0.0.1` at the service's port;
  - a websocket from a foreign `Origin` is refused.

  A linked board no longer creates folders.

## Observability & Evaluation

- **Traces:** the service logs its provider choice at start. Squig tool calls go through
  `POST /api/boards/:name/squig/:tool`. A refused call on tldraw is a 409 naming the fallback.
- **Eval:**
  - `mcp.test.ts` pins the 17-tool registry and the tldraw refusal.
  - `provider.test.ts` covers passthrough, attribution of raw edits and linking rules.
  - `squig.integration.test.ts` runs against a real Squig: a linked board, an attributed
    `edit_document`, a PNG render and history.
- **Experiment:** if a week of wireframing on `team` goes by without anyone re-adding a direct
  `squig` server, the fold held. A re-added server, or a Squig capability someone could not
  reach through `whiteboard_*`, means a gap in this list to close.
