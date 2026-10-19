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
carries. Redemption is ADR 623 §6 unchanged: the token must be unconsumed and unexpired, the ask
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

## Observability & Evaluation

**Traces** — the existing audit rows carry the story: `channel.answer.advisory` /
`channel.answer.refused` with `delivery_actor: 'slack'`, the `doorbell.surfaced`-style delivery
outcome logged as `away_slack_delivered` / `away_slack_delivery_failed` (ask ref and status,
never a token, body, or credential — hard rule 5). Worker logs carry frame types and statuses
only (ADR 659).

**Eval** — the falsifier suite: the three Worker ingress tests above, plus adapter tests that a
payload naming an unbound Slack user redeems nothing, a changed ask after delivery is refused
`stale_revision`, and a pairing callback stages without binding. Headline check after wiring:
**zero** `channel.answer.*` audit rows carrying `authorized_by` for A1 answers (ADR 623's query).

**Experiment** — n/a — no user-facing behavior changes until an operator wires a real workspace;
the answer-latency comparison against /live is pre-registered with the channel-settings lane
(ADR 618).
