# Rehearsal A, 2026-09-26 — a real phone joins through the tunnel

The first real Claude client against the daemon found four blockers the load bench could not see, each fixed and dated here, and then two humans joined in under a minute each.

## The rig

- Fly app `musterd-loadbench`, machine `811096a9576268` (izzo's bench box, `performance-8x`), image built from a `main` containing #1735 and #1742. Only `@musterd/server...` was built in the image; the CLI needed `pnpm --filter "@musterd/cli..." build` on the box (bare `@musterd/cli` fails: `@musterd/mcp` unbuilt).
- Quick tunnel (`cloudflared tunnel --url http://127.0.0.1:4851`), so numbers here are **quick-tunnel**, not the named-tunnel route in [the runbook](../operations/public-demo-tunnel.md). Daemon on loopback with `--insecure-trust-proxy` and `MUSTERD_ALLOWED_HOSTS=<tunnel host>`; DB in `/tmp`; team `demo`, member `presenter`; invite minted with `team invite create --expires 3h`.
- Stand-up scripts were shipped to the box as one base64 line inside `fly ssh console -C`; a multi-line quoted `-C` command exits `4294967295` with no output (2026-09-26; falsify: pass a multi-line `sh -c '…'` to `fly ssh console -C` and see output). <!-- claim: other -->

## Outside-in probes (before any phone)

From a laptop on another network, via the tunnel: both discovery documents 200, `/health` 200, `/teams` and a made-up path 404. Plain `http://` is **403** from the quick-tunnel edge, not a redirect to https as the runbook expects of the named route (2026-09-26; falsify: `curl -sI http://<quick-tunnel-host>/mcp/demo` returning 301/308). <!-- claim: other -->

## Blocker 1 — "could not start sign in" (Claude iOS, cellular)

The app failed before the sign-in page loaded. The issuer is `https://<host>/oauth/demo`, so an MCP client fetches RFC 8414 path-inserted `/.well-known/oauth-authorization-server/oauth/demo`, then the two OpenID forms. All three 404'd; only the team-slug shorthand and the path-appended form existed. ~~Serves AS metadata at the wrong path (2026-09-26; falsify: `curl -s -o /dev/null -w '%{http_code}' https://<host>/.well-known/oauth-authorization-server/oauth/demo` returning 200)~~ FIXED 2026-09-26 by #1752 (test red on main, green with the fix). <!-- claim: defect -->

Why the bench missed it: `demo-audience-load.mjs` reads the metadata URL it already knows; it never discovers.

## Blocker 2 — token exchange 400 after the invite form (found by emulation)

Emulating the client from a laptop: register 201 → authorize 200 → invite form POST 302 with a code → token exchange **with** `resource=<MCP endpoint>` 400 `invalid_request`; the same code **without** it 200. The MCP auth spec (2025-06-18 §2.8) makes RFC 8707 `resource` mandatory for clients, and `OAuthTokenRequestSchema` was `.strict()`. ~~Rejects the resource indicator (2026-09-26; falsify: the token exchange above returning 200 with `resource=` set)~~ FIXED 2026-09-26 by #1754, [ADR 457](../decisions/457-oauth-resource-indicator.md). <!-- claim: defect -->

Nobody had reached this step on a real client; the bench does not send `resource` either.

## Blocker 3 — "Couldn't register with demo's sign-in service" (Claude iOS)

With blockers 1 and 2 patched on the box, the app reached RFC 7591 registration and was refused. The schema was `.strict()` with an enumerated member list and a two-value `token_endpoint_auth_method` enum; probing showed two refusals a real client can hit: extra members (`contacts`, `software_id`, `tos_uri`, …) and `client_secret_post`. RFC 7591 §2 says unknown metadata MUST be ignored. ~~Refuses real registration bodies (2026-09-26; falsify: POST the body with those members and get 201)~~ FIXED 2026-09-26 by #1758, [ADR 458](../decisions/458-dcr-tolerates-rfc7591-bodies.md). Which of the two the phone hit is unrecorded: the box was stopped before the log was read, and a stop wipes `/tmp` on this image (2026-09-26; falsify: `fly machine stop` then `start` and find `/tmp/daemon.log` intact). <!-- claim: defect -->

## Blocker 4 — "No server responded at this URL" (claude.ai web, both routes)

Every outside probe succeeded on the quick tunnel and, after moving the rig to `musterd-loadbench.fly.dev` with Fly's own TLS, on the direct route too; claude.ai's add-connector check still failed, and the daemon log showed nothing from Anthropic. Cause: the Host/Origin gate (`checkUpgrade`) refused any request carrying an `Origin` header that was neither allowlisted nor same-origin, on every Host, and sent the 403 before the request log. Anthropic's connector client sends one. Reproduced with `curl -H 'Origin: https://claude.ai'` → 403. ~~Origin refused on the public face, unlogged (2026-09-26; falsify: that curl returning 401)~~ FIXED 2026-09-26 by #1767: a `MUSTERD_ALLOWED_HOSTS` hostname is a bearer-only public face where Origin is not a refusal; loopback keeps the DNS-rebinding rule; refusals log `http_request_refused`. <!-- claim: defect -->

Note that this is the blocker behind the earlier "no server responded" on the quick tunnel as well: Cloudflare was never the problem, and the tunnel route was abandoned on a wrong hypothesis. The direct-Fly rig stays because it was already up.

## Client landscape (researched 2026-09-26)

- Claude iOS/Android: custom connectors on Free (one), Pro, Max, Team, Enterprise. Adding on mobile is beta; the primary path is add on claude.ai web or desktop, then it appears on the phone. Claude reaches the MCP server from Anthropic's cloud, so "a phone on cellular" only exercises the sign-in page.
- Cowork and Claude Desktop share the account's connectors: same family, one row.
- ChatGPT: custom MCP needs Developer mode on a paid plan and is web only; the mobile apps cannot add or use one. Rehearsal B stays a laptop.
- Codex CLI, desktop and IDE extension share `~/.codex/config.toml` and do OAuth (`codex mcp login <name>`, DCR + PKCE). Codex cloud and the Codex tab in the ChatGPT app: no documented MCP OAuth.

## Timings (direct Fly route, all four fixes on the box)

Daemon-log timestamps, UTC, 2026-09-27; "add check" is the unauthenticated `POST /mcp/demo` claude.ai sends when the connector is added.

| join | add check | register | form submitted | first tool call | add → first tool | on the form |
|---|---|---|---|---|---|---|
| Charm | 00:10:06 | 00:10:38 | 00:10:54 | 00:10:55 | 49 s | 15 s |
| Toto | 00:14:04 | 00:14:12 | 00:14:58 | 00:15:00 | 56 s | 46 s |

Both under the 3-minute target from [join-page-copy §7](../design/join-page-copy.md). Not measured this run: mistypes per admission (0 wrong-code 401s in the log across both joins), `/live` at 60 s, a deliberate wrong code, the link-value paste, cellular vs Wi-Fi, and which client each join used (phone app vs claude.ai web) — nick to fill in.

## Still open

- Rehearsal with three phones at once, one on cellular, and the `/live` observation.
- The bench harness should send `resource=` and an `Origin` header so it exercises the client shape that found blockers 2 and 4 (izzo, lane 01M3D4069F).
- Plain `http://` is 403 on the quick tunnel and on Fly's port 80 (the daemon's TLS refusal), not a redirect as the runbook's named route expects.
