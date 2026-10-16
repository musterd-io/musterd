# 623 — Channel answers on the wire: a server-controlled action class on asks, assurance on answers, and one atomic decision record

- Status: accepted — 2026-10-15. Implements the wire and storage half of
  [ADR 618](618-channel-answers-actor-is-not-authorizer.md) (the authority model, accepted 2026-10-15).
  ADR 618 said wire changes need their own ADR because protocol schemas do not change without one
  (hard rule 1); this is it.
- Date: 2026-10-15

## Context

ADR 618 fixed the authority model for answers that arrive through a channel (Slack and others) instead of
from a seat the daemon authenticated itself: the delivery service is the actor, the bound human the
authorizer; an A1 (provider-trusted) answer is advisory and releases no work; consumers enforce assurance;
the ask token is a bound reference; one decision per ask, atomically.

None of that has a representation yet. An ask carries no class. An answer carries no assurance. There is
no token record and no decision record. The daemon already has the pattern for "a meta key only the daemon
may set": `lane_review` (ADR 225), `dispute` (ADR 505) and `incident` (ADR 271) are stripped from a client
envelope in `protocol/route.ts` and stamped by the daemon, because a client copy would let a seat promote
itself. The same reasoning applies here with higher stakes.

## Problem

Name the fields, the tables and the rules that make ADR 618 enforceable in code, in one place, before any
of it is built, so the four implementing lanes (2b to 2d, and the channel lanes after them) cannot drift
and so no consumer of "a human answered" can be handed a weaker proof than it assumes.

## Decision

### 1. `meta.action_class` on an ask is server-controlled

- Values: **`privileged`** and **`advisory`**. The key is stripped from any client-supplied envelope
  (silently, like `lane_review`; the ask still lands) and stamped by the daemon at raise time.
- Derivation is a function of daemon-held state, never of a field the asking seat controls beyond the
  species it declared: an ask carrying `meta.gate` is `privileged`; an ask whose species is not in the
  class table is `privileged`; an ask of species `consult` with no `meta.gate` is `advisory`. Anything the
  function cannot establish is `privileged` (fail closed, ADR 618 §3).
- **`advisory` does not mean low risk.** It means "an A1 answer to this ask is information for the asking
  agent and authorizes nothing" (ADR 618 §4). A privileged request an agent mislabels as a `consult` is
  classed `advisory` and gets a Slack button, and the answer it draws releases nothing, because the
  consumers refuse it (§4 below). The safety property lives in the consumers, not in the label.
  `privileged` asks get no buttons on an A1 channel: the message names the ask and points at `/live` or
  the CLI.
- The table is a constant in protocol code with a test that pins it. In v1 no class lets an A1 answer
  release work; adding one is a reviewed change that also needs a trusted classifier and a redemption
  recheck (ADR 618 §4).

### 2. `meta.channel_answer` on an answer is server-controlled

- Shape: `{ channel, assurance, decision, binding_id, binding_generation, token_id }`. `channel` is the
  provider id; `assurance` is `A1` or `A2`; `decision` is `approve` or `reject`; the rest identify the
  binding and token the answer redeemed. It carries no secret, nonce or signature (hard rule 5).
- The key is stripped from any client envelope and stamped only by the daemon's channel-answer path. A
  seat cannot mark its own reply as a channel answer, and cannot unmark one.
- **An A1 answer is recorded as act `message`, never `accept` or `decline`** (ADR 618 §5), threaded to the
  ask with `in_reply_to`. Every existing consumer that reads an `accept` or `decline` from a human
  therefore does not see it. The decision lives in `meta.channel_answer.decision`.
- The message's `from` is the bound human, so the reply reads in their thread. That is a presentation
  choice, not authority: the stamp and the audit row say it came through a channel, and no consumer treats
  a `message` as authorization. The daemon never stamps `A2` until A2 exists; a request for it is refused.

### 3. One helper decides what an answer is worth

`answerAuthority(askMeta, answerMeta)` returns `authority` or `advisory`:

- An answer with no `channel_answer` is a plain answer from a seat the daemon authenticated: `authority`,
  exactly as today.
- An answer with `assurance: A1` is `advisory` in every class in v1.
- An answer with `assurance: A2` is `authority` only once A2 exists and verified a device signature.

Every consumer calls this helper. None re-implements the rule. As defence in depth, a consumer that finds
`channel_answer.assurance = A1` on an `accept` or `decline` (a channel-path bug that wrote the wrong act)
refuses it and audits `channel.answer.refused`.

### 4. The consumers to change

The gate release read (`gateAskHumanAnswer`, ADR 150), acceptance on a `lane_review` ask (ADR 202, 603)
and `request.decide` (ADR 127) each call `answerAuthority` and refuse an `advisory` answer. The last of
these is reached today only through `authAdmin` HTTP routes, which a relay does not hold; the check is
there so a future route cannot be reached by a channel by accident, and it is tested.

### 5. Token and decision storage (migration, sqlite and pg)

- **`ask_channel_tokens`**: `token_hash` (primary key; the token is shown once to the relay and only its
  `sha256` is stored, hard rule 5), `team_id`, `ask_id`, `ask_digest` (a digest of the ask's body and
  action at issue time), `action_class`, `channel`, `binding_id`, `binding_generation`,
  `required_assurance`, `expires_at`, `created_at`, `consumed_at`.
- **`ask_decisions`**: primary key `(team_id, ask_id)`, plus `token_hash`, `decision`, `message_id`,
  `decided_at`. One row per ask across every channel. The insert is the atomic step: whichever of two
  racing answers inserts first wins and the other gets a primary-key conflict and is refused. The insert,
  the message write and the token's `consumed_at` happen in one transaction.
- `expires_at` is `raised_at` plus the tier's response window (`askContract(tier).timeout_ms`, ADR 147),
  stamped by the daemon. It is its own field so the response window can change without silently changing
  token lifetime. The daemon's clock is authoritative: an answer after `expires_at` is refused even if the
  row still exists.

### 6. Redemption rechecks current state

On an answer, in the same transaction: the token exists and is unconsumed and unexpired; the ask is still
open and its digest still matches `ask_digest`; the class **recomputed from current state** is still
`advisory` (an ask that became privileged after delivery refuses the answer); the binding's current
generation equals the token's and the binding is not revoked; the team and daemon authority match. The
binding store arrives with the pairing lane. Until it does, redemption **fails closed**: it refuses with
`no_binding_store` rather than assuming a binding is current. The unit tests use a stub standing.

### 7. Audit

`channel.answer.advisory` (an A1 answer recorded) and `channel.answer.refused` (with a reason: `expired`,
`consumed`, `stale_revision`, `class_changed`, `binding_stale`, `no_binding_store`, `conflict`,
`wrong_team`, `assurance`). `channel.answer.accepted` is reserved for the first class that can release
work. Each row's detail carries the human authorizer and the delivery actor separately, the ask id and
digest, the binding id and generation, and the assurance. Never the token, nonce, signature or body. The
rows are added to the audit action map.

## Consequences

- The wire grows two server-controlled meta keys and two tables. No new act, no change to `SPEC.md`'s
  act set; the meta keys and the stripping rule are documented in `docs/architecture/02-protocol.md` in
  the lane that implements them.
- _(2026-10-15, lane 2b, #2711)_ §1 is built: `classifyAskAction` and the pinned species table live in
  `packages/protocol/src/ask.wire.ts`; `route.ts` strips a client `meta.action_class` from every envelope
  and stamps one on every ask. A `null` meta, a prototype key as the species, and a `meta.gate` all
  classify `privileged`. A stripped client copy is not audited, as with the sibling server-controlled
  keys; add `ask.class_stripped` if abuse shows up.
- Stamping a class on every ask costs one pure function at raise time. The cost to existing consumers is
  one helper call each.
- `advisory` being the class of a mislabeled privileged request is deliberate and is the main thing a
  reviewer should check: the control is the consumers refusing the answer, so the 2d lane carries the
  falsifier tests that prove it (a privileged request mislabeled as a consult; an action that becomes
  privileged after delivery; an A1 answer offered to the gate release read, acceptance and
  `request.decide`).
- Whether an advisory `message` answer discharges the ask's clock, the way a human reply does for a
  `consult` (ADR 147), is checked and pinned in 2d rather than assumed here.
- The binding store, pairing, the relay and the Slack adapter are the later away-channels lanes; this ADR
  gives them the contract they plug into.
  Follows-up: lanes `01M515KT27S91S4547H24YXDTS` (2b), `01M515KYT64Z2FR1T15FT1CSAP` (2c),
  `01M515M0VMZR6AW0EDKS3WGJBY` (2d), `01M50XPYZ9877E494X2SV1EGTB` (pairing and binding store).

## Observability & Evaluation

**Traces** — `channel.answer.advisory` and `channel.answer.refused` audit rows (§7), one per redemption
attempt, none carrying a secret. Refusal reasons are a closed set so "why were answers refused" is one
query.

**Eval** — the falsifier suite from ADR 618 turns real in 2d. Headline: **no A1 answer ever produces a
gate release, an acceptance or a request decision** (zero, checked by the suite and by an audit query:
`channel.answer.*` rows with an `authorized_by`). Secondary: the **refusal-reason mix** (a spike in
`class_changed` or `stale_revision` points at a classifier or revision bug) and **p95 redemption
latency**, since the check runs in the answer's request path.

**Experiment** — n/a here; the answer-latency comparison against `/live` is pre-registered with the Slack
adapter increment.
