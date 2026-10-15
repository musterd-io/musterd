# Away channels: asks that reach you and can be answered off the computer (design)

Lane `01M50XMB1K0BYJEZTJP88Q9K63`. **Status: draft for nick's review, 2026-10-15.** Brainstormed with nick the same
day; big-body (security seat) reviewed the design before this was written and its findings are folded in
(thread `01M50X3BRQYGHWP0PX59TE75N1`). No code is written. Everything below that says "decided" was
decided by nick in that conversation; everything under [Open questions](#open-questions) is not.

## Intent

An `ask` reaches a human today on `/live` and in the CLI. Both need the human at the computer. nick wants
asks to reach him when he is away from it, over channels he can switch on and off one by one (Slack, iOS
push, in-app notifications, and later others), and to **answer from the channel**: approve, reject, reply.
A notification that only says "go answer on /live" is not the goal.

Success: with Slack enabled and paired, nick on his phone sees an ask, taps Approve or Reject, and the
asking agent receives the answer with the record showing who answered and through which channel. In v1 a
Slack answer is advice to the agent, not authorization (see "Where the class comes from"). A privileged
ask reaches him too, but says plainly that it needs a stronger surface.

## What exists (checked 2026-10-15, read-only)

- **Slack is one-way** (ADR 149, `packages/server/src/notify/slack.ts`): one fire-and-forget webhook POST
  per `ask` raised, best effort, no retry. Interactive answers were not built because the daemon is
  loopback-bound and has no public ingress (ADR 039/040).
- **A generic doorbell webhook** (ADR 443, `notify/webhook.ts`) posts a record with no message body to
  anything that takes a POST (ntfy, Pushover, an iOS Shortcut), with a pinned connection (`pinnedPost.ts`).
- **Presence informs the ask clock** (ADR 155): an away human gets the loud surface at raise time. The
  hold ceiling and the `stranded` terminal (ADR 153) do not move.
- **A human's accept or decline releases a gate** (ADR 150, `store/gateAsk.ts`): `gateAskHumanAnswer`
  reads an accept or decline from a `members.kind = 'human'` seat naming the ask in `in_reply_to`. A
  gate-raised ask carries `meta.gate = { class, fingerprint }`.
- **`authorized_by`** (ADR 127/129) is the stable key for "who authorized this". ADR 129 says a path where
  actor and authorizer genuinely differ needs an ADR. A channel answer is such a path.
- **`packages/mobile`** is an Expo app (calendar only today) with an EAS and TestFlight pipeline.

## The two facts that shape the design

1. **The daemon cannot take inbound connections.** An answer from a phone needs a way in. Decided: a
   **relay** that the daemon dials out to. Tailscale-direct and notify-only were offered and not chosen.
2. **Slack cannot prove a human to a compromised relay.** Slack signs its callbacks with a shared-secret
   HMAC, not a public key (verified against Slack's docs by big-body and again by me). Whoever holds the
   signing secret can fabricate a callback naming the bound user. If the relay holds that secret, "a
   compromised relay cannot forge an approval" is **false for Slack**. The first draft of this design
   claimed it; this version does not.

So there are two assurance levels, stated everywhere they matter:

| Level | What proves the human | Survives a compromised relay? | Channels |
| --- | --- | --- | --- |
| **A1, channel-trusted** | The provider's own authentication, checked by the relay (Slack HMAC, a provider token) and forwarded to the daemon. | **No.** The relay and the provider are trusted for this class. | Slack, Discord, Telegram, email links |
| **A2, device-signed** | A key held on nick's device (Secure Enclave or equivalent), enrolled once, signing the exact ask digest. The daemon verifies the signature. The confirming screen is a native app, not a relay page. | **Yes**, for forgery and substitution. Suppression and delay remain possible. | The musterd app (later increment) |

A relay-hosted passkey page is **not** A2. A compromised origin can show ask A while requesting an assertion
for ask B, because WebAuthn binds the challenge and origin, not the text the user read. The trusted display
has to sit outside the Cloudflare account.

## Decided: what an A1 answer may authorize

**Ordinary asks only.** Until A2 exists:

- **Ordinary** asks may be answered with Approve or Reject on an A1 channel. In v1 the answer is **advisory**
  to the asking agent and authorizes nothing; it can release work only for an operation class added later
  under the rules below. This trusts the relay and the provider for that class. The ADR states that as an
  accepted risk.
- **Privileged** asks are **notify-only** on A1 channels: the message names the ask and says to answer on
  `/live` or the CLI. No buttons. Privileged means credential or grant issuance, rotation and recovery,
  membership or admin changes, export or delete, deploys, and irreversible external effects.

Tier alone is not risk: a `blocking` ask can be harmless and a `standard` one can carry a privileged
consequence. So the class comes from what the ask is, not how loud it is.

### Where the class comes from, and what an A1 answer is worth

_(Amended 2026-10-15 on big-body's acceptance review of #2690: the first version derived the class from the
ask's species and the absence of a gate or risk tag. That does not establish the security property. An agent
chooses the species and the tags, so it can phrase a privileged approval as a `consult`. The rules below
replace it.)_

1. **Species and the absence of a tag are not evidence that a consequence is reversible.** The daemon stamps
   a class on the ask at raise time, but the stamp is only as trustworthy as its inputs. Nothing an agent
   supplies (species, tier, tags, free text) may lower the class. **Unknown consequences are privileged**
   (fail closed).
2. **An A1 answer to a `consult` is advisory only.** The asking agent may read it as information. It is
   never recorded as human authorization: it sets no `authorized_by`, releases no gate, satisfies no
   acceptance, and is never sufficient for a deploy, export, delete, credential, grant or admin action, no
   matter how the ask was worded.
3. **An A1 answer may release work only for an operation class that has a trusted, operation-specific
   classifier.** "Trusted" means the daemon derives the class from authoritative state it holds (the lane,
   its recorded risk tags, the gate class), not from fields the asking agent set. At **redemption** the daemon
   re-reads that state as it is *then*, not as it was at delivery. A lane that gained a risk tag, or an
   action that became privileged, after the buttons were sent refuses the answer. In v1 this list is
   **empty**; each class is added by a reviewed change to a table in protocol code, with a test that pins it.
   Candidates for nick to decide on: a `lane_review` acceptance for a lane with no risk tags, once the
   daemon (not the submitting seat) is the one classifying the diff (ADR 612 has the submitting seat label
   it, which is not trusted for this).
4. **Consumers enforce it, not only the buttons.** Every channel answer is recorded with its assurance level
   (`A1` or `A2`). Every consumer that treats a human answer as authority refuses an `A1` answer for a
   privileged or unlisted class: the gate release read (`gateAskHumanAnswer`, ADR 150), acceptance and
   `request.decide`. **A1 cannot be laundered through the general human accept or gate path.** A channel
   answer is never written as a plain human `accept` that those consumers would honour without checking
   assurance. Hiding the button on a privileged ask is a courtesy, not the control.
5. An ask carrying `meta.gate` is privileged and gets no buttons.

nick's decision to answer ordinary asks from Slack stands, with this meaning: in v1 a Slack answer to a
`consult` reaches the asking agent as advice, and the list of classes where a Slack answer can release work
grows one reviewed class at a time. Which classes to add first is in [Open questions](#open-questions).

## Architecture

```
agent ──ask──▶ daemon (loopback) ──WS, daemon dials out──▶ relay: Cloudflare Worker + Durable Object per team
                    ▲                                              │  ▲
                    │ decision (verified, recorded atomically)     │  │ provider callback (Slack interactivity)
                    └──────────────────────────────────────────────┘  │
                                                          Slack ◀──────┴── nick's phone
```

### Relay

- A Cloudflare Worker with one **Durable Object per team**. The daemon opens one **hibernating WebSocket**
  to its team's object. Idle cost is near zero and an answer reaches the daemon the moment it arrives.
- The Worker is the public URL providers call (Slack's interactivity Request URL). It checks the
  provider's signature and acknowledges inside Slack's 3 seconds.
- **The relay stores only**: an opaque ask reference, the rendered per-channel message while delivery is
  in flight, delivery status, an expiry, and dedupe ids. No ask body after delivery, no logs of tokens,
  keys or bodies. Retention is a stated number in the ADR (open question 2).
- It authenticates each daemon separately per team, rejects a second socket replacing a live one for the
  same team, and caps payload size, queue depth and retries.
- It is **thin on purpose**: the relay protocol is small and versioned, the daemon-side client is the
  portable part, and a self-hoster leaves the feature off exactly as ADR 149 does today. Durable Objects
  were rejected for the Cloud *server* because of the rewrite and the self-hosting story
  (cloud design §3.1); neither applies to a relay that holds only pending references.

### Channels (provider adapters)

One interface, one adapter per provider. An adapter does three things and nothing else:

1. **deliver**(ask, binding) renders the message for that provider and sends it.
2. **verify**(request) checks the provider's signature on an incoming answer and extracts
   `{ provider identity, ask token, decision }`.
3. **proveIdentity**(request) turns a pairing callback into an immutable provider identity.

Each adapter declares its capabilities: `buttons`, `text-reply`, `link-only`, and its assurance level.
A `link-only` provider (email, SMS, ntfy) delivers a link to a relay-hosted answer page and is A1 at best.
Slack is first because it proves the relay and the token design without an app release.

### The ask token is a bound reference, not a credential

The daemon issues one token per ask, per channel. It is not a bearer credential for "a human said yes".
The daemon-side record binds:

- team and daemon authority id;
- ask id and revision (or a digest of the ask payload) and the exact action;
- the binding id and **binding generation** of the intended human;
- expiry, a nonce, and the **required assurance** (server-derived, from the action class).

On an answer the daemon verifies the token against **current** ask state and the human's **current**
standing. The relay cannot downgrade the required assurance.

**One decision, atomically.** Approve and Reject consume the same decision record in one transaction with
recording the decision. Duplicate, concurrent, opposite-button, cross-team, stale-revision, expired,
revoked and restarted-daemon cases yield at most one decision and never reopen it. A transport ack means
"received". The relay shows "approved" only after the daemon's durable receipt. An approval authorizes
the ask as it was shown, never a later changed command.

## Pairing

Pairing binds one provider identity to nick as a musterd human. The **binding lives in the daemon**, keyed
by immutable provider ids (for Slack, enterprise or workspace id plus user id), never by email or display
name. The relay cannot complete or change a binding alone.

1. On `/live` or the CLI, already authenticated as nick, he starts "Add channel, Slack". The daemon mints a
   **high-entropy pairing nonce**: single use, 5 minutes, scoped to his session, the team and the binding
   generation, with strict attempt limits.
2. `/live` shows a QR code and link, and a two-digit number. The number is a **UX check only**; two digits
   are about 6.6 bits and never the authorization secret.
3. nick scans on his phone. The provider authenticates him with its own login. The relay receives the
   provider's signed payload and the nonce and forwards both to the daemon.
4. The daemon checks the nonce and the provider payload, then asks nick to **confirm on the original
   surface**, which shows the exact provider tenant and user it is about to bind. Only that confirmation
   stores the binding.
5. Binding, revoking and the kill switch are audited. There is no unbind or rebind from a button.

A stolen unlocked phone or a taken-over provider account is an authority compromise for A1. The design does
not claim number matching excludes it. The mitigation is the class split: an A1 answer is advisory, or releases work only for a listed class.

Enrolling a device key for A2 later is its own authenticated enrollment and recovery flow. The relay's
assertions are never enough to enroll one.

## Channel settings

Settings are **per human**, stored in the daemon, and nothing is on by default. Each channel has:

- **deliver**: send me asks here.
- **answer**: let me reply from here. Turning it off does not stop delivery; turning delivery off says
  whether it also removes answer authority.
- an optional tier floor, and **presence gating**: the default is "notify me here when I'm away"
  (ADR 155), so he is not pinged while he is at `/live`.

Surfaces: `musterd notify channels` in the CLI and a channel panel on `/live`. ADR 149's team-level
`ask_slack_webhook` consent does **not** carry over to a new user or provider; each channel is a separate
opt-in to a private destination.

**Kill switch.** One local command disables all channel answers, revokes every binding generation and
outstanding decision token, and disconnects the relay. It works without the relay's cooperation.

## Availability and failure

- A compromised or failing relay can **suppress, delay, reorder or flood**. It cannot create a privileged
  approval and, for A2, cannot create any approval.
- On reconnect the daemon **reconciles from its own state**; buttons for resolved or expired asks are
  expired. Silence is never consent: an unanswered ask follows its existing tier contract (ADR 147/153),
  and an expired ask cannot become approved because it was queued.
- Proposed, not yet discussed with nick: reachability for ADR 153 counts a channel only if its delivery is
  confirmed, not merely configured.

## Audit (in the daemon)

Pair proposed, confirmed and revoked; immutable provider identity and binding generation; ask, action and
revision; the assurance method used; the **human authorizer separately from the delivery service actor**;
decision outcome or refusal reason; expiry and replay attempts; the durable result receipt; channel
disable. **Never** the raw nonce, button token, signature, cookie or body (hard rule 5). Privileged changes
still pass their existing server authorization; a channel never fabricates a generic human envelope.

## Falsifier suite

Before anyone calls this secure, a suite must let a **malicious relay**: forge provider callbacks; swap one
ask or action for another; replay after revoke; race both buttons; pair a different provider identity; and
lie in the confirmation UI. It also covers the class rules above: a privileged request **mislabeled as a
`consult`**; a lane whose **risk tags are missing or were removed**; an action that **becomes privileged
after delivery** (redemption must re-read current state); and an A1 answer **offered to the gate release
read, acceptance and `request.decide`** (each must refuse it). It also states, in the ADR, **exactly which attacks remain excluded** by the
trust assumptions (for A1: a compromised relay or provider forging an advisory or listed-class answer; a stolen
unlocked phone; a provider workspace admin acting as the user).

## ADRs this needs

1. **Channel answers as actor-is-not-authorizer** (ADR 129): the daemon records the human authorizer and the
   delivery actor separately. This one carries the assurance levels and the class split.
2. **Interactive extension of ADR 149 and 443**: the relay, the new outbound dependency, the remote trust
   boundary, the per-channel consent rule and the retention number.
3. **The relay protocol and its credentials**: how the daemon authenticates to its team object, and the
   new secret class (hard rule 5 applies to every new secret even without a new prefix).
4. **Protocol additions** for the ask's `action_class` and the answer envelope's channel provenance, if the
   wire changes (hard rule 1: no schema change without an ADR).
5. Later: **A2 device-signed answers** with the musterd app.

## Increments

Goal `away-channels`. The lanes are open but unclaimable: increment 1 depends on this spec's own lane
(`01M50XMB1K0BYJEZTJP88Q9K63`), which stays open until nick approves the spec, and each later increment
depends on the ones before it. Parking is a human choice, so dependencies carry the wait.

| # | Lane | Increment | Depends on |
| --- | --- | --- | --- |
| 1 | `01M50XPVRM2VZXVDQPET1E865N` | ADR 1 and 2 above, plus the falsifier suite as failing tests | this spec |
| 2 | `01M50XPWSQBHDNBG3M5XYWZCAP` | Daemon: action class derivation, bound ask token, atomic decision record, audit | 1 |
| 3 | `01M50XPXWEFMHND3GABXDSNTVW` | Relay: Worker and Durable Object, daemon WebSocket client, reconcile on reconnect | 1, 2 |
| 4 | `01M50XPYZ9877E494X2SV1EGTB` | Pairing: nonce, `/live` and CLI confirmation, binding store, revoke and kill switch | 2, 3 |
| 5 | `01M50XQ04M8E3X5QHY173Q18X7` | Slack adapter: interactive messages, signature check, deliver and answer for advisory (and later listed-class) asks | 3, 4 |
| 6 | `01M50XQ5YXXPJ8KVCV31KFB2N8` | Channel settings: CLI, `/live` panel, presence gating | 2 |
| 7 | `01M50XQ1TGXNVXRF0481TCK4AA` | Mobile app as an ask client and A2 device-signed answers (own spec and ADR) | 1 to 6 |

Increments 1 to 6 reach nick on Slack with advisory answers. Increment 7 is what makes privileged asks
answerable off the computer.

## Out of scope

Other providers' adapters (the interface is defined here; Discord, Telegram, email and ntfy each get a lane
when wanted). A Slack app distributed to other workspaces (this is a single-workspace app for nick's team).
Answering from a machine that is asleep: if the laptop is asleep the daemon is down and no ask exists to
answer. Changing the hold ceiling or `stranded` (ADR 153).

## Open questions

1. **Which operation classes an A1 answer may release work for, after v1.** v1 is advisory-only for
   `consult` and the releasing list is empty (see "Where the class comes from"). nick decides what is added
   first and when; each needs a daemon-side classifier and a redemption re-check.
2. **Relay retention.** What is stored, for how long, and whether a pending ask's rendered message may sit
   in the Durable Object until delivery or only until expiry. big-body asks that this is set with nick.
3. **Who owns the Cloudflare account and the Slack app**, and where the signing secret lives, given that
   its holder is the A1 trust anchor.
4. **Does a per-channel "answer off" also remove delivery to privileged asks**, or only the buttons.
   Proposed: only the buttons; delivery is its own switch.
