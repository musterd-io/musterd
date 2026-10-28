# 747 — The team wiki is read from the team's repo

- Status: accepted
- Date: 2026-10-28

## Context

nick, 2026-10-28: a wiki overlay on /live and /broadcast, for whichever Team the page shows. The tall bookshelf on the office's left wall, near the corner, opens it, and it carries a sign like the settings and work-board signs. On where it comes from: "i dont want any extra mantainetence. Whereever the wiki is stored today, thats where it should come from so there is a signle source of truth. IM fine if we need to have a second format or location though".

A Team's wiki today is the `docs/wiki/` folder of its repo. ADR 259 made it the home for durable knowledge. The guidance every seat is served (`guidance.ts`) says to promote a proven insight into `docs/wiki/`, and the dream pass writes only `docs/wiki/**/*.md`. Pages reach `main` the same way code does: a PR. On this Team that is 137 pages, 1.5 MB.

The daemon serves /live but does not know where a Team's repo is. It has no repo field and no GitHub token. It already shells out to `git`: `sync/rosterRefresh.ts` runs `git pull --ff-only` with a timeout and `GIT_TERMINAL_PROMPT=0`.

## Problem

/live needs a Team's wiki without adding a second copy that someone must keep in step. Three ways were considered.

1. **A local checkout path per Team.** The daemon reads `docs/wiki` from a folder on its own disk. This works only where the daemon runs next to a checkout. It shows whatever branch that checkout is on, so it can quietly show a wiki that is not the one on `main`. A hosted Team or a teammate on another machine gets nothing.
2. **The GitHub API.** This reads `main` exactly. But it only works for GitHub, and private repos need a token stored on the hub.
3. **`git` against the repo's URL.** This reads `main` exactly, from any git host, with no host-specific code.

## Decision

**The source.** A Team's wiki is the markdown under a folder of its repo's default branch. Team policy gains an optional `wiki` knob: `{ repo, path }`.

- `repo` is an `https://` or `ssh` git URL.
- `path` defaults to `docs/wiki`, the folder musterd's own guidance names. A Team that keeps its wiki elsewhere names that folder instead.
- An admin sets it once from the Team panel in settings, through the same signed policy write as every other knob (ADR 662).
- Absent means "no wiki linked". The shelf still has its sign, and the overlay says how to link one.

**No review date for a source.** The `wiki` knob does not, on its own, give the policy doc an ADR 533 review date. Where a wiki comes from is a fact about the Team, not a rule it governs by. Asking admins to re-confirm it every 90 days is exactly the upkeep nick ruled out. A doc that also holds a governing knob still gets its review date, as before.

**Reading.** The daemon reads the wiki with `git` (`store/wiki.ts`). It never creates a working copy.

- Each Team gets one blobless shallow fetch of the default branch, in a bare cache under the daemon's state directory: `git fetch --depth 1 --filter=blob:none`.
- The index is `git ls-tree` of the folder. A page is `git cat-file` of one blob, fetched on demand.
- The cache is the "second location" nick allowed. It is derived, disposable, and never written by hand.

**Freshness.**

- On a read, if the last check is older than 5 minutes, the daemon runs `git ls-remote` for the default branch.
- It fetches again only when the commit has moved.
- A read never waits on the network: it is served from the cache, and the check runs behind it.
- The first read for a Team waits for the first fetch, bounded by the same 20 s timeout `rosterRefresh` uses.

**Safety.** The URL is typed by an admin, and the daemon runs `git` on it.

- Only `https://`, `ssh://` and scp-form `user@host:path` URLs are accepted. `GIT_ALLOW_PROTOCOL=https:ssh` holds the same line inside `git`. That shuts out `file://`, `ext::` and local paths, which would let a Team read the daemon's own disk.
- A URL may not begin with `-`.
- `path` is a relative folder: no `..`, no leading `/`.
- Fetches run with no credential helper, no system or global git config, and no SSH agent, so a Team cannot borrow the host's access to someone else's private repo. The wiki must therefore be a **public** repo; Consequences records the private-repo case.
- Caps: 2,000 pages, 1 MB per page.

**Rendering.** The daemon serves raw markdown.

- `GET /teams/:team/wiki` returns the index: each page's path, title (its first `#` heading, else the file name) and commit.
- `GET /teams/:team/wiki/page?path=` returns one page's markdown.
- Both take the same member read auth as the rest of /live.
- The web renders pages with `marked`, which is already a `@musterd/web` dependency, so no runtime dependency is added. Rendering lives in the overlay's lazy chunk. Raw HTML in a page is shown as text, never parsed, and only `http`, `https` and `mailto` links are followed.
- A link to another page in the folder opens in the overlay. A link elsewhere in the repo opens on its host when the host is GitHub, GitLab or Codeberg, and is plain text otherwise.

**The shelf.** The left-wall standard bookshelf (`BOOKSHELVES[1]`, `ly` 240, 66 high) opens the overlay. It is the taller of the two left-wall units and the nearer the corner. It carries an oak sign reading "wiki", built like the work board's.

- On /live, the shelf is a button.
- /broadcast has no viewer to click, so there the sign hangs as part of the room and nothing opens.

## Consequences

- One source of truth: whatever is merged to the folder on the default branch is the wiki, within 5 minutes of the next read. Nothing is copied by hand, and no new store, table or token is added.
- `PolicySchema` changes, so this is a protocol change. The knob is optional and absent by default, so every existing Team parses unchanged.
- A private-repo Team sees "the repo was not found, or it is private" until per-Team read access lands. _(Amended 2026-10-28: was git's own error line; see the note below.)_
  Follows-up: per-Team read access to a private wiki repo (a deploy key the Team gives the daemon), lane to be opened when a private-repo Team asks.
- Each daemon that serves /live keeps its own cache. A joiner node fetches from the repo host, not from the hub.
- 2026-10-28 (lane 01M61P6WG3, from miley's review of #3420): the URL shape check let a Team point the daemon at its own network — `https://127.0.0.1:4849/…`, an RFC1918 or tailnet host, the cloud metadata address — and git's first error line came back in `detail`, so the read worked as a port probe. Now, before each check, the repo's host is resolved and the read is refused if any address is loopback, private (RFC1918, CGNAT 100.64/10, ULA), link-local, unspecified, multicast or reserved, IPv4-mapped IPv6 included. git runs with `http.followRedirects=false`, so a public host cannot redirect it inward; a moved repo says so and the Team sets the new address. `detail` is one fixed line per kind (refused host, not found or private, redirects, unreachable, timed out); git's own line stays in the daemon log. An operator whose forge is on a private network sets `MUSTERD_WIKI_PRIVATE_HOSTS=allow` — the daemon's operator decides, never a Team. Residual: the host is resolved again by git, so DNS rebinding between the check and the fetch is not closed; pinning the address would mean git's `http.curloptResolve`, and an allowlist of public forges is the stricter option should a hosted daemon need it.

## Observability & Evaluation

- **Traces:** each fetch logs its Team, outcome (`fetched`, `current`, `failed`) and duration through the daemon log, as `rosterRefresh` does. A failed fetch records git's first line of error. _(Amended 2026-10-28: in the log only; the response carries a fixed line.)_ A read served from a stale cache because the check failed says so in the response (`stale: true`), so the overlay can show it.
- **Eval:** n/a. No agent-facing behaviour changes. Agents keep writing the wiki in the repo as they do today.
- **Experiment:** n/a. A viewing surface for existing pages has no rate to compare against.
