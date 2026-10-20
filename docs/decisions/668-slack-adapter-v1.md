# 668 — Slack adapter v1: interactive asks, signature check at the relay, one workspace

- Status: accepted
- Date: 2026-10-19

## Context

Away channels increments 1–4 are landed: the authority model (ADR 618), the wire and decision
record (ADR 623), the relay (ADR 659), and pairing with its binding store (lane
`01M50XPYZ9877E494X2SV1EGTB`). What is missing is the first provider adapter (spec increment 5,
lane `01M50XQ04M8E3X5QHY173Q18X7`): rendering an ask into Slack with Approve/Reject buttons,
checking Slack's signature on the way back, and redeeming the answer daemon-side. Increments 1–6
reach one team's own workspace; the distributed Slack app (OAuth install per workspace,
per-install tokens, app review) is increment 9 (lane `01M50ZQGWYNZKNWDNDDRP41W5B`), and the
shared-ingress Cloud transport is increment 10.

Two facts shape the boundary. Slack signs callbacks with a shared-secret HMAC, so a Slack answer
is A1 (ADR 618): advisory, releasing nothing, and a compromised relay or provider account can
forge one — accepted for the advisory class, excluded from every releasing one. And Slack gives a
distributed app exactly one interactivity Request URL, so callbacks arrive at the relay Worker's
per-ask route (`POST /callback/<slug>/<ask_ref>`, ADR 659 §2), not at the daemon.

## Problem

Name, in one place: where Slack's signature is verified, how a callback is dispatched to exactly
one team's daemon, what the daemon trusts when it parses the payload, where the bot token lives,
and how a delivery is rendered — so the adapter stays inside the ADR 618 authority model and the
Slack lane that follows (increment 9) can replace the single-workspace credential without
touching redemption.

## Decision

### 1. The adapter is daemon-side; the relay verifies Slack's signature

The adapter (`packages/server/src/notify/slackAdapter.ts`) does the three things the spec's
adapter interface names and nothing else: **deliver** renders one ask for Slack, **verify/parse**
turns a forwarded callback payload into `{provider identity, ask token, decision}`, and
**proveIdentity** turns a pairing callback into the immutable provider identity pairing stages.
Slack's signature (`X-Slack-Signature`, five-minute timestamp tolerance, HMAC-SHA256 over the
raw body) is verified at the relay Worker before anything is forwarded: the signing secret is a
Worker secret (`SLACK_SIGNING_SECRET`, set by the operator, never through an agent), so it never
reaches a daemon and is never copied to receivers (spec: Slack ingress §1). A callback with a
missing or invalid signature is refused at the Worker and never forwarded; the daemon therefore
treats a forwarded callback as ingress-attested, and still trusts nothing in it (decision 3).

### 2. Dispatch is by the install mapping, never by the caller

The Worker's route names the team in its URL (`/callback/<slug>/<ask_ref>`), and the Worker
holds the operator-set install mapping (`SLACK_TEAM_MAP_JSON`: Slack team id → team slug). A
callback is forwarded only when the payload's Slack team id maps to the slug in the URL. No
field in the request — team id, channel, user, or any body value — can select a different
destination: a payload naming another team's Slack workspace is refused at the Worker, never
re-routed. Increment 9 replaces this operator-set map with the OAuth install record; the rule
does not change.

### 3. The daemon re-checks everything that matters

A forwarded payload is parsed at the boundary into `{team_id, user_id, token, decision}`. The
daemon looks the binding up **by the provider identity in the payload**; the answer's authorizer
is the human that binding names (read from the daemon's member table), never a name the payload
carries. _(Amended 2026-10-19: `binding_id` from the token row is the source of the authorizer;
the signed payload identity and callback route ask id must match the token binding, and unsigned
generic JSON callbacks are refused.)_
Redemption is ADR 623 §6 unchanged: the token must be unconsumed and unexpired, the ask
still open with the same digest (now computed over the stored ask body and meta, at delivery and
again at redemption) and the same recomputed class, and the binding current at the token's
generation. A payload whose Slack user is not the bound user for that token redeems nothing. The
pairing form of a callback (a button value carrying the pairing nonce) stages the provider
identity through `recordPairingIdentity` and binds nothing, exactly like the generic pairing
frame.

### 4. Delivery: one token, one interactive message, through the relay

When an advisory ask is routed to a human with an active Slack binding, the daemon issues one
ask token (ADR 623 §5, expiry stamped from the tier's response window), renders a Slack
`chat.postMessage` body — the ask text with Approve and Reject buttons whose values carry the
token — and sends it as a relay `deliver` frame. The relay makes the POST and drops the body
(ADR 659 §3); a failed POST is the daemon's to retry by re-push (ADR 659 as amended). Privileged
asks get no token and no buttons. Delivery is detached from the send path, like the ADR 149
webhook: a dead Slack or a dead relay can neither delay nor fail the ask itself.

### 5. The bot token is team policy; the signing secret is not

`slack_bot_token` joins `away_relay_token` in team policy (`@musterd/protocol` credentials, this
ADR being the gate hard rule 1 requires): admin-set, policy reads admin-only, never in
`team export`, masked on CLI display, shown nowhere after it is set. It authenticates the
daemon-rendered POST to the team's own workspace and nothing else. The Slack **signing** secret
is deliberately not policy: it lives only at the Worker (decision 1), so a daemon compromise
cannot mint valid Slack callbacks, and a Worker compromise cannot call Slack as the bot.
Increment 9 moves the bot token to per-install storage; the policy key is then retired by its
own change.

## Consequences

- 2026-10-19 — callback ingress is Slack-only: the Worker detects the parsed `payload` field
  independent of form order, verifies the Slack signature and install mapping, and refuses
  unsigned JSON callbacks. Redemption resolves the authorizer through the token's binding row and
  requires the signed provider identity and callback route's ask id to match the token binding.
  Falsifiers cover identity mismatch, route mismatch, and forged JSON answer and pairing inputs.

- 2026-10-19 — acceptance review of the first landing caught §1/§2 failing open on missing
  config: with `SLACK_SIGNING_SECRET` unset a Slack-shaped callback was forwarded unverified,
  and with `SLACK_TEAM_MAP_JSON` unset any signed callback went to whatever slug the URL named.
  The callback route now refuses a Slack-shaped body with 503 when either secret is unset
  (401 on a bad signature, 403 on an unmapped team), each case covered by a fetch-handler test
  in `workers/away-relay/src/index.test.ts`. At that first landing, generic (non-Slack) callbacks
  kept the plain forward and carried no Slack trust claim; the 2026-10-19 validation change
  retired that path until a separate adapter is reviewed.

- Increments 1–6 are now completable on one workspace: pair (`musterd channels pair`), complete
  the Slack sign-in, confirm, and ordinary asks arrive with buttons whose answers are advisory.
  Follows-up: lane `01M50XQ5YXXPJ8KVCV31KFB2N8` (channel settings: per-channel on/off, presence
  gating) builds on the delivery hook this lane adds.
- The three shared-ingress falsifiers are real tests at the Worker (signature refusal, dispatch
  by mapping only, cross-team payload refused); the multi-tenant hardening they belong to at
  scale (quotas, flood isolation, bring-your-own-relay) stays lane `01M50ZQCTWM5QBZ083782J9N6R`.
  Follows-up: lanes `01M50ZQGWYNZKNWDNDDRP41W5B`, `01M50ZQCTWM5QBZ083782J9N6R`.
- The ask digest at redemption is now computed from stored state on both sides; the relay test's
  hand-written digest is replaced by the shared helper, so a changed ask body after delivery is
  refused as `stale_revision` for real.
- The Worker stays undeployed (ADR 659): an operator deploys it and sets
  `SLACK_SIGNING_SECRET` + `SLACK_TEAM_MAP_JSON` directly when wiring the real workspace.
  Follows-up: deferred — operator act at first real Slack wiring, with lane `01M50ZQGWYNZKNWDNDDRP41W5B`'s app review (2026-10-19).
- 2026-10-20 — increment 9 (lane 01M50ZQGWYNZKNWDNDDRP41W5B) replaced the operator-set map
  with the OAuth install record, as decisions 2 and 5 named. A human admin mints a one-time
  install state daemon-side (`musterd channels slack-install`, stored only as sha256); the
  relay's `/slack/install` / `/slack/oauth` flow exchanges Slack's code with the client
  secret and writes the Slack team → team mapping to an install registry — that flow is the
  only writer, so the rule in decision 2 is unchanged. The per-install bot token is held by
  the team's relay object until its daemon syncs it (`install_sync` / `installs` /
  `install_ack` frames, SPEC A.29) and stores it daemon-side only against the live state it
  minted; the team-policy `slack_bot_token` remains the pre-install fallback until its own
  retirement change. Installing a workspace (Slack's admin act) and pairing a person (the
  binding flow) stay separate acts. The Worker still ships undeployed; Slack's app review
  and the client credentials are operator acts, listed in `docs/guides/away-relay.md`.
- 2026-10-20 — increment 10 (lane 01M50ZQQW95YDYVWE2BTCMKKH7) added the Cloud-direct
  transport the ingress section designed: an install link naming a hosted team's Cloud
  server (`dest`) makes the ingress dispatch the install record and that workspace's
  callbacks straight to that server — no relay hop — each signed with the ingress's
  Ed25519 key over `<timestamp>.<raw body>`. The receiving server holds only the public
  key (`MUSTERD_INGRESS_PUBLIC_KEY`), refuses unsigned/forged/stale dispatches and any
  dispatch when it holds no key, and re-checks team, binding and token against its own
  state through the same `handleRelayCallback` path. Same adapter, same token model;
  SPEC A.29 carries the wire rule.
- 2026-10-20 — increment 9 re-review (lazara, declined #3039): the relay accepted any
  state string, so whoever held an install link could re-bind it to another team before
  the daemon's check ran. Fixed the same day: the daemon registers `sha256(state)` with
  its own relay object over its authenticated socket at mint time and on every connect
  (`install_state` frame), the install flow accepts a state only when the named team's
  object holds its hash, and the registry's state write is insert-only — a state bound
  to one team can never be re-bound, and its consumption and clock never reset.

## Observability & Evaluation

**Traces** — the existing audit rows carry the story: `channel.answer.advisory` /
`channel.answer.refused` with `delivery_actor: 'slack'`, the `doorbell.surfaced`-style delivery
outcome logged as `away_slack_delivered` / `away_slack_delivery_failed` (ask ref and status,
never a token, body, or credential — hard rule 5). Worker logs carry frame types and statuses
only (ADR 659).

**Eval** — the Worker ingress and adapter falsifier tests: unmapped or unsigned callbacks are
refused, a payload naming an unbound Slack user or mismatching its token's ask redeems nothing,
a changed ask after delivery is refused `stale_revision`, and a pairing callback stages without
binding. Headline check after wiring:
**zero** `channel.answer.*` audit rows carrying `authorized_by` for A1 answers (ADR 623's query).

**Experiment** — n/a — no user-facing behavior changes until an operator wires a real workspace;
the answer-latency comparison against /live is pre-registered with the channel-settings lane
(ADR 618).
