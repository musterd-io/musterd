# 666 — musterd.io agent discovery: content signals, freshness, icons, a linked graph, a real 404

- Status: accepted
- Date: 2026-10-19
- Deciders: nick (asked for the audit and approved the plan in-session), slippy (carried)
- Relates to: ADR 302 (the public site, and its 2026-09-01 amendment that added the crawler and
  agent text files), ADR 308 (who deploys the site), ADR 151/183 (perf budgets), lane
  01M5AQGRMZZ3D1N6410K4731X9; registry listing is lane 01M5AQGV8Y0TNVSVQ68PX9C7SY

## Context

nick asked for an SEO and agent-discovery pass over musterd.io on 2026-10-19, with three inputs:
an audit of the live origin, current research on what answer engines and coding agents actually
use, and the learnings from the same exercise on sandrise.io (repo `Nas4146/SandRise`).

The audit found the ADR 302 work holding: per-page title, description, canonical, OG and Twitter
tags; a robots.txt that is ours (Cloudflare's Managed robots.txt is off) and allows every AI
crawler by name; sitemap.xml; llms.txt and llms-full.txt; markdown mirrors of the docs; a
TechArticle and BreadcrumbList on every doc; `www` 301s to the apex; the crawler files serve from
cache at the TTLs `_headers` sets. Measured gaps:

- `/favicon.ico`, `/apple-touch-icon.png` and any manifest: 404.
- robots.txt states no Content Signals, so what a crawler may do with a page it reads is unsaid.
- No `lastmod` on any doc in sitemap.xml and no `dateModified` on any TechArticle — answer engines
  that rank on freshness (Ahrefs, 2025–26: ChatGPT and Perplexity cite fresher pages, newest first)
  cannot rank us on it at all.
- The Organization node has no logo and no `sameAs`, so musterd on GitHub, npm and Twitch are three
  unjoined entities; `codeRepository` sat on a SoftwareApplication, where schema.org does not
  define it, so the open-source fact had nowhere valid to live.
- llms.txt said "every page above is also served as markdown", and `/watch.md` and `/start.md` 404.
- An unknown path returned 404 with an empty body (`not_found_handling: "none"`): right for a
  crawler, a dead end for a person or an agent following a stale link.

Two findings are dashboard-only and are not this ADR's to change, but are recorded because they are
the larger effect: Python's stdlib client (`Python-urllib/*`) gets **403, error 1010** (Browser
Integrity Check) on every path, including llms.txt — a common fetcher in agent sandboxes — while
curl, Node, axios, aiohttp and Scrapy get 200; and Cloudflare's Markdown for Agents is off (an
`Accept: text/markdown` request gets HTML).

## Problem

What should the public origin itself ship so that answer engines and agents can find, date, attribute
and use musterd — without inventing facts, without a new dependency, and without loosening the
ADR 302 guarantee that the origin never falls back to the app shell?

## Decision

1. **robots.txt states Content Signals in our own file**: `Content-Signal: search=yes,
   ai-input=yes, ai-train=yes` under `User-agent: *`. Never by enabling Cloudflare's Managed
   robots.txt, which replaces the file wholesale (ADR 302's 2026-09-01 amendment; sandrise.io
   documented the same trap). All three are yes because the product is MIT, the site exists to be
   found and cited, and the named training crawlers were already allowed one by one.
2. **A doc is dated by the day its source file last changed in git** — sitemap `lastmod` and
   TechArticle `dateModified`, from one helper (`sourceLastModified` in `gen-site-content.ts`). On
   a shallow clone, or where git cannot answer, the date is omitted, never guessed: a shallow
   checkout dates every file to HEAD, and a lastmod that is really a build date teaches crawlers to
   ignore the field (the rule `siteUrls` already stated). Pages without a markdown source (`/`,
   `/watch`, `/start`) stay undated for the same reason.
3. **The icons an origin is asked for by path ship as committed files**: `/favicon.ico` (16/32/48
   PNG-in-ICO), `/apple-touch-icon.png` (full-bleed; iOS rounds it), `/icons/*` and
   `/site.webmanifest`, rendered once from the mark — the small cut at 16px, the full cut at 24px
   and up, as brand.md's two cuts require. A rasterizer in the build would
   be a dependency for five images that change only when the mark does.
4. **The graph is linked and valid**: the Organization carries `logo` and `sameAs` (the GitHub org
   and repo, the npm package, the Twitch channel — accounts musterd controls, nothing else); the
   repository moves to its own `SoftwareSourceCode` node (`codeRepository`, MIT `license`,
   language, `targetProduct` → the app); the app gains `license`.
5. **llms.txt promises markdown only where it ships**: "every doc (and post) above", not "every
   page".
6. **An unknown path gets a static 404 page with a 404 status**: `not_found_handling:
   "404-page"`, serving a self-contained `404.html` (no bundle, no font, no script, `noindex`). It
   refuses the SPA fallback exactly as `"none"` did; `site-routes.test.ts` now admits only those two
   values and rejects `single-page-application`.

Not done, with reasons: a `/.well-known/mcp/server-card.json` (the path is contested between
SEP-1649/2127 and two IETF drafts, and `@musterd/mcp` is a local stdio server, which the drafts
mostly do not describe — the registry listing in lane 01M5AQGV8Y is the discovery route that
exists today); more llms.txt work (Ahrefs, mid-2026: ~97% of llms.txt files received no AI
requests; SE Ranking found no citation correlation); A2A agent cards and agents.json (nothing
consumes them for a site like this); pay-per-crawl (the opposite of the goal).

## Consequences

- Ten new files on the public origin, each added to `PUBLIC_ALLOW` and pinned by
  `stage-site.test.ts` and `site-files.test.ts`.
- `sitemap.xml` and the doc pages now change when a doc's source is committed, not only when a doc
  is added. A deploy from a shallow checkout ships them undated — correct, but worth knowing:
  `deploy:site` should build from a full clone to carry the dates.
- The dashboard half is nick's, in this order: turn off Browser Integrity Check for musterd.io (or
  a Configuration Rule that skips it on the zone) — it is 403ing agents today; confirm Super Bot
  Fight Mode does not challenge "definitely automated"; enable Markdown for Agents; set AI Crawl
  Control's Search and Agent crawlers to Allow; enable Crawler Hints; set Browser Cache TTL to
  "Respect existing headers" (sandrise.io: a non-zero value silently raised shorter origin TTLs).
  Leave Managed robots.txt off.
- The `workers.dev` duplicate origin ADR 302 named is still open and still the deploy owner's
  (ADR 308).

## Observability & Evaluation

**Traces.** n/a — no server or agent runtime path changes; the site is static assets. Cloudflare's
request logs and AI Crawl Control's per-crawler view are the traffic signal. sandrise.io's measured
lesson applies: Cloudflare counted ~3,000 page views/day against PostHog's 1–4 — about 99.9% of
HTML hits were crawlers — so crawler load (Cloudflare) and readership must be read from different
instruments and never summed.

**Eval.** Dataset: `site-files.test.ts`, `stage-site.test.ts`, `site-routes.test.ts`,
`siteMeta.test.ts` — Content-Signal present, every emitted file staged, only a no-fallback 404 mode
admitted, the source node carrying the repository and the Organization its sameAs. Baseline
(production, 2026-10-19): favicon/touch-icon/manifest 404, no Content-Signal, zero dated docs, empty
404 body. Success: after the deploy, all of those resolve on musterd.io, the three docs carry a
`lastmod`, and the Rich Results test parses the home graph with no invalid-property warning.

**Experiment.** Whether answer engines cite musterd more is the question this cannot answer alone:
the largest measured predictor is off-site brand mentions (Ahrefs, 75k brands, ρ≈0.66), and the
registry and docs-index listings ride lane 01M5AQGV8Y. Read AI Crawl Control's crawler counts and
AI-referral sessions (chatgpt.com, perplexity.ai, claude.ai referrers) for the 30 days before and
after the dashboard half lands; a rise in fetches with no rise in referrals says we are read but not
cited, which points at the off-site work rather than more on-site metadata.
