# 618 — Channel answers: the delivery service is the actor, the human is the authorizer, and assurance decides what an answer is worth

- Status: accepted — 2026-10-15. Records the authority model of the away-channels design
  ([spec](../superpowers/specs/2026-10-15-away-channels-design.md), approved by nick and accepted by
  big-body at `1bcf7533a`, 2026-10-15). This is the ADR 129 trigger for a path where actor and authorizer
  genuinely differ.
- Date: 2026-10-15

## Context

An `ask` reaches a human today on `/live` and in the CLI, both of which need the human at the computer
(ADR 147, 149). ADR 149 added Slack as a one-way webhook and left interactive answers unbuilt because the
daemon is loopback-bound (ADR 039/040). nick wants asks to reach him off the computer, over channels he
switches on and off, and to be answerable from them.

Answering from a channel changes who the daemon is listening to. Today a human answer arrives from a human
seat the daemon authenticated itself (`gateAskHumanAnswer` reads an accept or decline from a
`members.kind = 'human'` seat, ADR 150). A channel answer arrives through a relay, from a provider, with
the provider's idea of who the user is. ADR 129 audited every writer of `actor` and found none where actor
and authorizer diverge on an admin path; this is the first.

big-body's security review (thread `01M50X3BRQYGHWP0PX59TE75N1`) and its send-back of the first spec
revision found two facts the design has to be built around:

1. **Slack signs callbacks with a shared-secret HMAC, not a public key.** Whoever holds the signing secret,
   including the relay, can fabricate a callback that names the bound user. A claim that a compromised
   relay cannot forge a Slack approval is false.
2. **A class derived from fields the agent controls is not a class.** Species `consult` and the absence of
   a gate or risk tag are chosen by the asking agent. An agent can phrase a privileged approval as a
   consult.

## Problem

Define what a channel answer is, who the record names as authorizer, and which answers may release work,
such that a compromised relay or provider cannot turn a forged callback into an authorization, and so that
no consumer of "a human said yes" can be fed a weaker proof than it assumes.

## Decision

### 1. The delivery service is the actor; the human is the authorizer

A channel answer is recorded with **both**. The `actor` is the delivery path (the relay and provider
adapter). The authorizer is the bound human, named by the daemon's own binding for the provider identity
(never by the relay). `authorized_by` (ADR 127/129) is set only when the answer is accepted as
authorization under section 4; an advisory answer sets none. The audit rows keep the two separate.

### 2. Two assurance levels, stated wherever an answer is used

- **A1, channel-trusted.** The proof is the provider's own authentication as checked by the relay (Slack's
  HMAC, a provider token) and forwarded to the daemon. It does **not** survive a compromised relay or
  provider. Slack, Discord, Telegram and email links are A1.
- **A2, device-signed.** The proof is a signature, by a key enrolled on the human's device, over the exact
  ask digest, verified by the daemon, confirmed on a native surface outside the relay's Cloudflare account.
  A relay-hosted passkey page is **not** A2: a compromised origin can show one ask and request an assertion
  for another.

Every channel answer is recorded with its assurance level. Documents and code never describe shared-HMAC
verification at both hops as end-to-end.

### 3. Unknown consequences are privileged; an agent-supplied field never lowers the class

The daemon stamps a class on the ask at raise time. Nothing the agent supplies (species, tier, tags, free
text) may lower it. A class the daemon cannot establish from authoritative state it holds is **privileged**.
A gate-raised ask (`meta.gate`, ADR 150) is privileged and gets no buttons.

### 4. What an A1 answer is worth

- **Advisory only for a `consult`.** The asking agent may read it as information. It sets no `authorized_by`,
  releases no gate, satisfies no acceptance, and is never sufficient for a deploy, export, delete,
  credential, grant or admin action, however the ask was worded.
- **It may release work only for a listed operation class**, and a class is listed only when the daemon
  has a **trusted, operation-specific classifier** (it derives the class from state it holds, such as the
  lane and its recorded risk tags, not from what the asking seat set) and **re-reads that state at
  redemption**. A lane that gained a risk tag, or an action that became privileged after the buttons were
  sent, refuses the answer. In v1 the list is **empty**. A class is added by a reviewed change to a table in
  protocol code, with a test that pins the table.
- **A2 answers** may authorize privileged classes once A2 exists; until then, privileged asks are
  notify-only on every channel.

### 5. Consumers enforce it; the buttons are a courtesy

An A1 answer is **never written as a plain human `accept` or `decline`**. Every consumer that treats a human
answer as authority checks assurance and refuses an A1 answer for a privileged or unlisted class: the gate
release read (`gateAskHumanAnswer`, ADR 150), acceptance (ADR 192/603) and `request.decide` (ADR 127). A1
cannot be laundered through the general human accept path. Hiding a button on a privileged ask is not the
control.

### 6. The ask token is a bound reference

The daemon issues one token per ask per channel. The daemon-side record binds the team and daemon authority,
the ask id and revision (or a payload digest) and the exact action, the intended binding id and **binding
generation**, an expiry and nonce, and the required assurance. On an answer the daemon checks the token
against the **current** ask state and the human's **current** standing. Approve and Reject consume one
shared decision record in one transaction with recording the decision, so a duplicate, concurrent,
opposite-button, cross-team, stale-revision, expired, revoked or restarted-daemon case yields at most one
decision and never reopens it. A transport acknowledgement means "received"; the answer shows as approved
only after the daemon's durable receipt.

### 7. Bindings are the daemon's, keyed by immutable provider ids

A binding links an immutable provider identity (for Slack, enterprise or workspace id plus user id; never
email or display name) to a human. It lives in the daemon, is created only by a confirmation on the original
authenticated surface that shows the exact provider tenant and user, and is revoked, listed and expired
there. The relay cannot create, change or complete one. A local kill switch disables all channel answers,
revokes every binding generation and outstanding token, and disconnects the relay without the relay's
cooperation.

### 8. Audit

The daemon audits pair proposed, confirmed and revoked; the immutable provider identity and binding
generation; ask, action and revision; the assurance method; the human authorizer separately from the
delivery actor; the outcome or refusal reason; expiry and replay attempts; the durable result receipt; and
channel disable. It never records a raw nonce, button token, signature, cookie or body (hard rule 5).

### 9. The claim is tested, and its exclusions are stated

Increment 1 ships the falsifier suite as named, pending tests (below). The claim "a compromised relay cannot
forge an authorization" holds for **A2** and for **A1 outside the advisory and listed classes**. It does not
hold for an A1 answer in a listed class, a stolen unlocked phone, or a provider workspace admin acting as
the user; those are excluded by the trust assumptions and accepted as risks for the classes that admit
them.

## Consequences

- The relay and Slack are trusted, explicitly, for advisory answers. A forged advisory answer can mislead an
  agent; it cannot release a gate, satisfy an acceptance, or set `authorized_by`.
- In v1 a Slack tap is advice. nick accepted that reading on 2026-10-15; releasing work from a channel
  needs a later class with a trusted classifier (spec open question 1) or A2.
- Every human-authority consumer gains an assurance check. That is a cross-cutting change and the main
  cost; it is increment 2.
  Follows-up: lane `01M50XPWSQBHDNBG3M5XYWZCAP`.
- Wire changes (an assurance and channel-provenance field on the answer, an `action_class` on the ask)
  need their own ADR when designed, because protocol schemas do not change without one (hard rule 1).
  Follows-up: lane `01M50XPWSQBHDNBG3M5XYWZCAP`.
- The relay's trust boundary, per-channel consent (ADR 149's team webhook consent does not carry over),
  retention, and the credentials the daemon uses to reach it are a separate ADR, written once nick has
  decided relay retention and account ownership (spec open questions 2 and 3).
  Follows-up: lane `01M50XPXWEFMHND3GABXDSNTVW`.
- Pairing, the Slack adapter and channel settings build on this model.
  Follows-up: lanes `01M50XPYZ9877E494X2SV1EGTB`, `01M50XQ04M8E3X5QHY173Q18X7`, `01M50XQ5YXXPJ8KVCV31KFB2N8`.
  - 2026-10-19: the pairing lane (`01M50XPYZ9877E494X2SV1EGTB`) landed §7 as designed — the binding
    store in the daemon (schema v110), a single-use 5-minute pairing nonce stored only as sha256,
    the provider identity staged daemon-side by the relay path and bound only on the human's
    confirmation (CLI `musterd channels` or the /live pairing panel, both showing the daemon-held
    tenant and user), revoke and the kill switch consuming outstanding tokens in the same
    transaction, audited as `channel.pair.*` / `channel.killswitch`. Redemption now rechecks
    against this store instead of failing closed with `no_binding_store`. The daemon HTTP shapes
    are parsed at the boundary with local schemas; no `@musterd/protocol` schema changed. The
    three pairing falsifiers (different identity, confirmation-UI lie, kill switch) are real tests.
- A2 and the musterd app are their own spec and ADR.
  Follows-up: lane `01M50XQ1TGXNVXRF0481TCK4AA`.

## Observability & Evaluation

**Traces** — daemon audit rows, none of which carry a secret: `channel.pair.proposed|confirmed|revoked`,
`channel.answer.accepted|advisory|refused` (detail: provider, binding generation, ask id and revision,
assurance, refusal reason), and `channel.killswitch`. The authorizer and the delivery actor are separate
fields on each.

**Eval** — the falsifier suite is the primary evaluation: it lets a malicious relay forge provider callbacks,
swap one ask or action for another, replay after revoke, race both buttons, pair a different provider
identity, and lie in the confirmation UI; and it adds a privileged request mislabeled as a `consult`, a lane
whose risk tags are missing or removed, an action that becomes privileged after delivery, and an A1 answer
offered to the gate release read, acceptance and `request.decide`. In increment 1 these are named, pending
tests (`it.todo`); each is implemented with the increment that builds the code it exercises, and a todo that
is still pending when its increment lands fails review. Secondary: **share of A1 answers refused by a
consumer** (expected non-zero only for the falsifiers) and **latency-to-human-answer split by channel**
against the `/live` baseline (ADR 149).

**Experiment** — n/a for this ADR; the latency comparison is pre-registered with the Slack adapter
increment.
