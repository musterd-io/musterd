# Operating the away relay

> **Audience:** the operator who deploys the relay and the self-hoster who runs their own.
> **What it covers:** deploying `workers/away-relay`, the secrets it holds, per-team quotas, and
> pointing a daemon at a relay you run yourself (bring-your-own-relay). Design: ADR 659 (relay
> protocol and credentials), ADR 668 (Slack adapter), ADR 676 (the app channel).

## What it is

One Cloudflare Worker with one Durable Object per team. A laptop daemon takes no inbound
connections, so it dials out to its team's object over one WebSocket; the relay makes provider
POSTs (Slack), forwards signed provider callbacks, and pushes the app's sealed asks through APNs.
It stores delivery metadata only — never ask content, never a credential in clear.

The relay ships **undeployed**. Deploying it is an operator act, in the **dedicated musterd
Cloudflare account** — separate from the account that runs Cloud production, so a relay
compromise cannot reach production credentials or the team store (spec scale amendment).

## Deploy

```bash
cd workers/away-relay && wrangler deploy
```

Then set the secrets directly (never through an agent, never logged — hard rule 5):

| Secret | Shape | Notes |
| --- | --- | --- |
| `TEAM_CREDENTIALS_JSON` | `{"<team-slug>": "<sha256 hex of the credential>"}` | One credential per team; only its hash lives here. |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Lives only here (ADR 668 §1). |
| `SLACK_TEAM_MAP_JSON` | `{"<slack-team-id>": "<team-slug>"}` | Written by the authenticated install flow (lane 9 automates this). |
| `APNS_KEY_P8` | APNs `.p8` key, PEM | The app push key (ADR 676 §9). |
| `TEAM_QUOTAS_JSON` | `{"<team-slug>": {"per_minute": 60, "per_day": 10000}}` | Optional per-team overrides; see Quotas. |

The APNs key id, Apple team id and bundle id are plain `[vars]` in `wrangler.toml`.

## Per-team credentials and rotation

Each team's daemon holds its credential in team policy (`away_relay_token`, admin-set,
admin-read-only, masked on display). The relay re-checks the socket's credential hash against
`TEAM_CREDENTIALS_JSON` on **every frame**: to rotate, set the new hash in the secret and the new
token in team policy — the old socket's next frame is refused and the daemon reconnects with the
new credential. To revoke, remove the team's entry. One team's credential used on another team's
connect route is refused at the Worker, before any Durable Object is touched.

## Quotas

Every team has its own delivery quota, enforced by its own Durable Object — one team spending
its quota cannot spend another's. Defaults: **60 provider deliveries per minute, 10,000 per day**
(under Slack's `chat.postMessage` tiers), counting actual provider attempts; a duplicate frame
answered from its stored row burns nothing. A refused delivery is answered
`delivered {ok: false, reason: "rate_limited" | "quota_exceeded"}` and stored `failed`, so the
daemon's re-push retries it once the window passes. Override per team with `TEAM_QUOTAS_JSON`
(values are clamped to 600/minute and 100,000/day; a bad or partial map falls back to the
defaults, never to unlimited).

## Installing Slack into a workspace

The Slack app is distributed: each workspace installs it through OAuth and gets its own bot
token (ADR 668 decision 2). Set `SLACK_CLIENT_ID` as a plain `[vars]` entry in
`wrangler.toml` and the client secret as a Worker secret. Then, per team:

1. A human admin runs `musterd channels slack-install`. The daemon mints a one-time,
   ten-minute install state and prints the relay's install link.
2. The link opens Slack's authorize page. Whoever Slack permits to install apps in that
   workspace (a workspace admin, under Slack's own rules) authorizes — that is the
   workspace's act, separate from any person's pairing.
3. Slack returns to the relay, which exchanges the code, records the mapping
   (Slack team → musterd team), and holds the per-install token in the team's relay object.
4. The daemon picks the record up on its next connect and stores it — but only against the
   live state it minted. `musterd channels slack-installs` lists installs (never a token);
   `slack-revoke <slack-team-id>` revokes one.

Until a workspace installs, the pre-install path still works: the operator-set
`SLACK_TEAM_MAP_JSON` and the team-policy `slack_bot_token`. The install record takes
precedence where both exist.

**Hosted teams (Cloud-direct).** A hosted team's install link carries
`&dest=<its Cloud server origin>`. The relay then sends the install record and that
workspace's callbacks straight to the Cloud server — no relay hop — each signed with the
ingress's Ed25519 key (`INGRESS_SIGNING_KEY`, a Worker secret). The Cloud server holds only
the public half (`MUSTERD_INGRESS_PUBLIC_KEY`, PEM or base64url DER) and refuses any
unsigned, forged, or stale dispatch; it then re-checks team, binding, and ask token against
its own state exactly as it does for a relay-forwarded callback. Generate the pair with any
Ed25519 tool (for example `openssl genpkey -algorithm Ed25519`), set the private half only
here, and the public half only on the Cloud servers.

**App review.** Slack reviews a distributed app before public listing. What the review
sees: the OAuth scopes `chat:write`, `im:write`, `users:read` (exactly these), the
interactivity Request URL (this Worker's `/callback/<slug>/<ask_ref>` route), the OAuth
redirect URL (`/slack/oauth`), and the install URL (`/slack/install`). Submitting for
review, collecting the app's client credentials, and setting them here are operator acts.

## Bring your own relay

A self-hoster may run their own relay instead of musterd's: deploy `workers/away-relay` to your
own Cloudflare account, set the secrets above with your own credential hash, then set your team's
policy `away_relay_url` to your Worker's `https://` URL and `away_relay_token` to your credential.
The daemon refuses `http:`/`ws:` outright — the credential never rides a plaintext socket. The
relay protocol is versioned (`RELAY_PROTOCOL_VERSION`) for exactly this: your relay and your
daemon negotiate on the version, and a mismatch is refused, never guessed.
