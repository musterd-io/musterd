# 754 — The daemon renders the team wiki

- Status: accepted
- Date: 2026-10-28

## Context

ADR 747 put a Team's wiki on /live. The daemon reads the markdown from the Team's repo with `git` and serves it, and the overlay renders it in the browser with `marked`. ADR 747 kept the rendering rules strict: raw HTML is shown as text, a link is followed only to `http`, `https` or `mailto`, and every link is sorted (a wiki page, a repo file on its host, an outside page).

`marked` is about 11 KB of gzipped JS. That was most of the 16.1 KB WikiOverlay chunk. Lazy-loading the chunk keeps it out of the first paint, but it still counts against the client's total JS (ADR 183). On 2026-10-28 that total was raised four times in one day, 375,000 B → 391,000 B, and the trim lane (01M6286ZRC) set out to bring it back down.

## Problem

Every viewer downloads a markdown parser to render pages that only change when someone merges to the repo. The same page is parsed again in every browser on every open.

## Decision

**The daemon renders the page.** `GET /teams/:slug/wiki/page` answers with the page's `html` beside its `markdown`. The renderer moves from `packages/web/src/live/wiki/wikiRender.ts` into `packages/server/src/store/wiki.ts`, unchanged: the same `marked` configuration, the same escaping of raw HTML, the same link vetting, and the same heading anchors. A rendered page is cached per path and dropped when the read commit changes, so each page renders once per commit.

**The protocol gains one optional field.** `WikiPageSchema.html` is optional. A newer client talking to an older daemon shows the markdown as plain text; an older client ignores the field.

**The link helpers move to the protocol.** `repoWebBase` and `repoFileUrl` are pure functions that both sides need: the daemon to sort links, the overlay to link the wiki's repo. They move to `wiki.wire.ts`, the browser-safe module, so there is one copy.

**`marked` becomes a server runtime dependency.** It was already a `@musterd/web` dependency, for the site build (`gen-site-content.ts`) and the overlay. The server takes the same major version. The alternative considered was a small in-house renderer in the client, about 2 KB covering the markdown wikis use. It needs no new dependency, but it would render some markdown differently from `marked`, and the same rules would then live in two places.

## Consequences

- The client's total JS drops by about 12.6 KB gzipped: 379.4 KB → 366.8 KB measured locally, with WikiOverlay at 16.1 KB → 3.2 KB. The total budget tightens to 380,000 B.
- The trust boundary is unchanged. The HTML the overlay injects is the same function's output, now computed by the daemon instead of the browser. The overlay still injects it only into its own container, and the rules that make it safe (raw HTML escaped, links vetted) moved with it, tests included.
- A page's first open after a merge renders on the daemon, which takes milliseconds for the pages in this repo's wiki. Later opens at the same commit are served from the cache.
- `docs/architecture/03-server.md` describes `store/wiki.ts`. Its line gains the rendering once the lane holding that doc (01M5WX0ZXM) lets go of it; this ADR is the record until then.
- Follows-up: the `03-server.md` line for `store/wiki.ts` gains "renders each page to HTML once per commit (ADR 754)", lane 01M6286ZRC, once 01M5WX0ZXM releases the doc.

## Observability & Evaluation

- **Traces:** n/a — no new path worth a span. The page read already logs its fetches (`wiki_fetch`), and rendering runs inside the same request.
- **Eval:** n/a — no agent-facing behaviour changes. Agents read the wiki from the repo, not through this endpoint.
- **Experiment:** n/a — a size change, measured by `pnpm perf:check` (total JS) and recorded in `docs/perf/web-live-baseline.md`.
