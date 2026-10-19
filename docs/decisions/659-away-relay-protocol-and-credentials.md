# 659 — Away relay: protocol v1, a per-team daemon credential, and metadata-only storage

- Status: accepted
- Date: 2026-10-19

## Context

ADR 618 fixed the authority model for channel answers (the delivery service is the actor, the bound
human the authorizer, A1 advisory, consumers enforce assurance) and ADR 623 fixed the wire and
storage half (server-controlled `action_class`, `channel_answer` provenance, the bound ask token
and one atomic decision record). Increments 2b–2d are built. What is missing is the transport the
spec (`docs/superpowers/specs/2026-10-15-away-channels-design.md`) decided on: the daemon is
loopback-bound (ADR 039/040) and cannot take inbound connections, so a relay the daemon dials out
to carries deliveries and answers. ADR 618 §Consequences left "the relay's trust boundary,
per-channel consent, retention, and the credentials the daemon uses to reach it" to a separate ADR,
written with this lane (`01M50XPXWEFMHND3GABXDSNTVW`).

Two facts from the spec shape the boundary. Slack signs callbacks with a shared-secret HMAC, so a
compromised relay can forge an A1 callback; ADR 618 already prices that (A1 is advisory, releases
nothing). And Durable Object SQLite storage can be restored up to 30 days back, so "no copy
outlives the entry" is false for anything written to it — nick accepted metadata-only rows under
that window on 2026-10-15.

## Problem

Name the relay protocol, the credential the daemon presents, what the relay may store, and what
happens on reconnect, in one place — before the pairing and Slack lanes build on it — so the relay
stays thin, a self-hoster can run their own, and no part of the path quietly gains authority the
ADR 618 model does not grant it.

## Decision

### 1. One hibernating WebSocket per team to a Durable Object

The relay is a Cloudflare Worker (`workers/away-relay`) with one Durable Object per team, named by
the team slug. The daemon opens one WebSocket to its team's object
(`GET /teams/<slug>/connect`, upgraded). The object holds the socket with the hibernation API, so
an idle team costs near zero and an answer reaches the daemon as it arrives. A second live socket
for the same team is refused (upgrade answered 409): a replaced socket is a credential event, not
a reconnect, and the kill switch and rotation below are how a daemon legitimately takes over.
_(Amended 2026-10-19: one exception — a socket presenting the operator map's current credential
replaces a live socket still holding a rotated-away credential, closing it with code 1008. Without
it, §4's "the daemon reconnects with the new credential" deadlocked against this section's 409
until the stale socket died on its own. A second socket with the same credential is still refused
409, and a credential the map does not name never replaces anything.)_

### 2. Relay protocol v1 — small, versioned, parsed at both ends

Frames are JSON, each carrying `protocol: 1` and a `type`. The daemon side parses every frame
through the zod schemas in `packages/protocol/src/relay.ts` (hard rule 4); the Worker validates
the same shapes in its own copy (`workers/away-relay/src/relay.ts`), because the Worker deploys
outside the pnpm workspace, as the seeds relay does (ADR 248).

- Daemon → relay: `reconcile` (the daemon's live pending set, §5), `deliver` (one rendered
  provider POST: `ask_ref`, `dedupe_id`, `expires_at`, and the POST to make), `resolve` (an ask
  resolved or expired daemon-side; drop its row).
- Relay → daemon: `reconciled` (kept / dropped ask refs), `delivered` (the provider POST's outcome
  and the provider coordinates it returned, if any), `callback` (a provider callback forwarded
  raw: `ask_ref`, content type, body — parsing it is the provider adapter's job, lane
  `01M50XQ04M8E3X5QHY173Q18X7`), `error` (a refused frame and why).
- Provider → relay: `POST /callback/<slug>/<ask_ref>` forwards to the connected daemon and acks
  202; with no daemon connected it answers 503 so the provider retries. The relay does not verify
  provider signatures — that check needs the provider secret and lands with the adapter that owns
  it (spec: Slack ingress); a callback is never trusted daemon-side until the adapter and the
  token redemption (ADR 623 §6) have both passed.

A `deliver` frame's POST body is content in flight: the relay makes the POST inside the request,
drops the body, and never writes it to storage (§3). Frames are capped at 64 KiB; a team holds at
most 1,000 pending rows; a provider POST times out at 5 s and is attempted once — a retry is the
daemon's decision, re-pushed from its own state (the daemon is the source of truth, so a lost
delivery is re-rendered, never replayed from relay storage).

### 3. Storage holds metadata only, until expiry

The object stores one SQLite row per pending delivery: `ask_ref` (primary key), `dedupe_id`
(unique — a re-pushed delivery with the same dedupe id is the same delivery), `expires_at`,
`status` (`pending` / `delivered` / `failed`), the provider coordinates needed to update the
message after it resolves (opaque strings, e.g. Slack's channel and message ts), and `created_at`.
No ask body, token, nonce, signature, or credential is ever written. Rows are deleted when the ask
resolves (`resolve`), when a decision receipt arrives, or at `expires_at`, whichever is first;
expired rows are swept on connect, on reconcile, and by the object's alarm. Cloudflare may restore
deleted metadata rows for up to 30 days; they hold no content (spec open question 5, accepted).

### 4. The daemon credential: one per team, a hash at the relay, a secret in team policy

Each team's daemon holds one relay credential. Relay-side it is never stored in clear: the
operator sets the Worker secret `TEAM_CREDENTIALS_JSON`, a map of team slug → `sha256` hex of the
credential, and the Worker compares the hash of the presented `Authorization: Bearer` value in
constant time. Daemon-side it is team policy — `away_relay_url` and `away_relay_token` beside
`seeds_relay_url` / `seeds_relay_token` (ADR 248's shape): admin-set, policy reads admin-only,
never in `team export`, masked on CLI display. Either unset (the default) means no outbound
connection, the ADR 149 posture. Rotation is: set the new hash, set the new policy token, the old
socket's next frame is refused and the daemon reconnects with the new credential. The credential
authenticates the daemon to its own team's object and nothing else; one team's credential used on
another team's object is refused (multi-tenant hardening and its falsifiers are lane
`01M50ZQCTWM5QBZ083782J9N6R`). Operator secrets are set directly by the operator, never through an
agent, and never logged (hard rule 5).

### 5. Reconnect reconciles from daemon state; silence is never consent

The relay's rows are a cache of what the daemon told it, so on every (re)connect the daemon sends
`reconcile` with its live pending set — unconsumed, unexpired ask tokens with no decision row
(ADR 623 §5 tables) — and the object deletes every row not in that set or past `expires_at`, then
answers `reconciled {kept, dropped}`. Buttons for a resolved or expired ask are therefore dead
after a restart even if the provider still shows them, and an answer that arrives for one is
refused at redemption (`expired` / `conflict`, ADR 623 §7). The daemon client
(`packages/server/src/notify/relay.ts`) reconnects with the sync stream's backoff (1 s doubling to
30 s, full jitter, ADR 552), re-runs reconcile on each open, and audits nothing per frame — the
audit rows are ADR 623's, written at redemption. Until the pairing lane lands a binding store,
every callback the client passes to redemption fails closed with `no_binding_store`.

### 6. What the relay cannot do

By construction of the model, not by the relay's good behaviour: it cannot create, change, or
complete a binding (ADR 618 §7); cannot mint or redeem a token (tokens are issued and redeemed
daemon-side, ADR 623); cannot set `authorized_by` or write an `accept` / `decline` (ADR 618 §5);
and a forged or replayed callback it forwards is refused at redemption unless every ADR 623 §6
recheck passes. It can suppress, delay, reorder, or flood — accepted in the spec, bounded by the
caps in §2, and never convertible into consent (an unanswered ask follows its tier contract,
ADR 147/153).

## Consequences

- 2026-10-19 — acceptance of the first landing (PR #2882) was declined on review: four places
  where the code did not do what this ADR says. All four are fixed in the follow-up landing, with
  no Decision change except the dated §1 amendment above: (1) the daemon's socket-URL mapping
  sent a `wss://` policy URL over plaintext `ws:` — it now keeps `wss:` and refuses `http:`/`ws:`
  outright, since the credential rides the socket; (2) a failed delivery could never be retried,
  because a re-push with the same `dedupe_id` was answered with the stored `ok:false` — a stored
  `failed` row now re-sends on re-push (§2's "a retry is the daemon's decision, re-pushed");
  (3) §4's rotation/revocation was not implemented — the credential was checked only at upgrade,
  so a live socket survived rotation; the verified credential hash is now attached to the socket
  and re-checked against the operator map on every frame, and the next frame after a rotation or
  revocation is refused and the socket closed (1008); (4) the Eval section below named tests for
  a second live socket and a cross-team credential that did not exist — both now exist by name in
  `workers/away-relay/src/relay.test.ts`, alongside the failed-retry and frame-recheck rules. The
  review also noted, non-blocking, that a half-open socket after laptop sleep could lock the
  daemon out until Cloudflare reaped it; the §1 amendment's replacement rule covers the rotation
  case, and a same-credential half-open socket still waits for the platform reap — accepted, since
  the daemon's reconnect backoff retries the upgrade and reconcile makes the wait lossless.
- Pairing (`01M50XPYZ9877E494X2SV1EGTB`) and the Slack adapter
  (`01M50XQ04M8E3X5QHY173Q18X7`) build on this protocol: pairing adds the binding store redemption
  currently fails closed without; the adapter renders the `deliver` POST and parses `callback`
  frames, and owns provider-signature verification.
  Follows-up: lanes `01M50XPYZ9877E494X2SV1EGTB`, `01M50XQ04M8E3X5QHY173Q18X7`.
- The shared Slack ingress (one Request URL dispatching by install mapping, spec "Slack ingress")
  is the Slack lane's to build; the `/callback/<slug>/<ask_ref>` route here is the per-ask form it
  dispatches to, and nothing in an incoming request selects a destination beyond the URL's team
  segment, which the daemon re-checks against its own team at redemption.
  Follows-up: lane `01M50XQ04M8E3X5QHY173Q18X7`.
- Multi-tenant hardening (per-team quotas, tenant-isolation falsifiers, bring-your-own-relay) is
  unchanged in scope; this ADR's credential is the per-team unit that work hardens.
  Follows-up: lane `01M50ZQCTWM5QBZ083782J9N6R`.
- Deploying the relay (a dedicated musterd Cloudflare account, secrets set by the operator) is an
  operator act, not part of this lane's code; the Worker ships undeployed with its `wrangler.toml`
  names unset, like the staging-jwks worker.
  Follows-up: deferred — an operator deploys `workers/away-relay` and sets `TEAM_CREDENTIALS_JSON` when the Slack lane is ready to wire a real provider (2026-10-19).
- The falsifier suite's relay entry ("answers after the daemon restarted: reconciled from daemon
  state, expired buttons refused") becomes a real test with this lane; the pairing and multi-tenant
  entries stay `todo` and keep naming their lanes.

## Observability & Evaluation

**Traces** — daemon: `away_relay_up` / `away_relay_down` log lines per team (once per outage), and
the existing `channel.answer.*` audit rows at redemption (ADR 623 §7) — a callback that arrives
over the relay and is refused is indistinguishable in the audit from any other refusal, which is
the point. Relay: Worker observability logs carry frame types, ask refs, and statuses, never a
body, token, or credential (hard rule 5).

**Eval** — the falsifier entry named above, plus the protocol tests: a frame over the size cap, a
second live socket, a cross-team credential, a duplicate `dedupe_id`, and an expired row at
reconcile are each refused or dropped by a named test. Headline check after the Slack lane lands:
**zero** `channel.answer.*` audit rows carrying `authorized_by` for A1 answers (ADR 623's query).

**Experiment** — n/a — no user-facing behaviour changes until the Slack adapter delivers a real
ask; the answer-latency comparison against `/live` is pre-registered with that lane (ADR 618).
