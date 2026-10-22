# 694 — The phone's A2 verdict on a lane review

- Status: accepted
- Date: 2026-10-21
- Lane: `01M5BER5GX4WENE2CEST6CA8NB` (away channels 7a, increment 3b)
- Deciders: nick (in chat, 2026-10-21: build 3b against ADR 662 as it stands now, and hand the app a contract), ryder
- Relates to: [ADR 676](676-mobile-app-sealed-ask-client.md) §6–§7 (the phone signs what it shows; what can be answered where),
  [ADR 662](662-one-machine-per-hosted-seat.md) decisions 4–5 (listed acts, the descriptor, the phone as an authenticator),
  [ADR 623](623-channel-answer-wire-and-decision-record.md) §2 and §6 (A2, the token and its recheck),
  [ADR 618](618-channel-answers-actor-is-not-authorizer.md) §4, hard rules 1 and 4

## Context

Increments 1 to 3a of the app channel's daemon half shipped advisory asks only, as Slack does. ADR
676's 3a note left the rest to increment 3b: privileged asks, listed acts with the descriptor screen,
the notification rule, and the fatigue ceiling. It also said 3b is where ADR 623's "A2 does not exist
yet" ends, and that this change gets its own review.

ADR 676 was written on 2026-10-19. Since then ADR 662's gate has changed under it. HA1 to HA3 landed,
with their re-reviews. More acts were wired to the gate: lane submit, policy writes, the stream's
observer mint and service install. And lane 01M5DTPMXN showed what a refused verdict looks like when
the surface hides it. A human whose verdicts on /live did not count lost three stage-two verdicts in
one day, because the refusal was audited but the ask was answered away.

The app half (lane `01M50XQ1TG`) has started, so the contract it builds to has to be fixed now.

## Problem

1. Which privileged asks should the phone answer, and what is its answer?
2. How does a phone signature become a listed act without a second verifier beside ADR 662's?
3. How does the app render and sign exactly the bytes the daemon verifies? The app is React Native,
   and `authority.ts` imports `node:crypto`.
4. What happens to a refused answer?

## Decision

1. **The phone answers one kind of privileged ask: a human's verdict on a lane review.** This is an
   ask carrying the daemon-stamped `lane_review` that is not advisory (ADR 225, ADR 667). Its answer is
   ADR 662's `human_accept` on that lane, and the act path already gates it (`applyAcceptanceVerdict`).
   Other privileged asks (an `approve` or `escalate` from an agent, a gate release) are not delivered
   _(Amended 2026-10-21: asks whose answer act now has an ADR 662 authority gate are delivered with
   the descriptor for that answer; the phone still requires A2.)_
   to the app. The phone takes them once the act they answer has a gate of its own. Until then, an A2
   answer to them would be worth no more than the Bearer answer on /live.
   Follows-up: 01M5FZ5R2VF8YZB48DQ357YYWM

2. **The delivery carries an A2 token and one server-built descriptor per decision.**
   - The token is issued with class `privileged` and required assurance `A2`. Issue enforces that a
     privileged ask's token is A2 and an advisory ask's token is A1. Redemption re-checks both.
   - `approval.approve` and `approval.reject` are each `{descriptor, payload}`. The descriptor is built
     by `buildDescriptor` for the binding's human, over the payload `{lane, verdict}`, exactly as the
     act path builds it for the gate.
   - `lane {id, title}` names the lane. The title is a seat's own words.
   - A descriptor lives five minutes. A re-delivery or a body fetch re-issues the ask with fresh
     descriptors, so the app fetches the ask by ref when it opens the descriptor screen.

3. **The phone's verdict is performed as the human's own act, through the one door.**
   - The answer must carry `approval {key_id, nonce, signature}`, the binding's own phone key's DER
     signature over the chosen offer's descriptor. Without it the answer is refused (`no_signature`).
     An A1 answer never performs a listed act.
   - The daemon first runs, writing nothing:
     - every ADR 623 §6 redemption check, as a preflight;
     - ADR 662's `requireAuthority` itself, in a new check-only mode that stops before the nonce is
       spent.
   - Then it routes `accept` or `decline` as that human, `in_reply_to` the ask, with the proof as
     `meta.approval`. This is the same envelope /live sends after a passkey ceremony. The route's gate
     verifies it again for real and spends the nonce, and the lane moves.
   - Only then is the token redeemed and the decision recorded (`channel.answer.a2`).
   - The act carries no `channel_answer`. It is the human's own verdict, authenticated by their device
     key, not advice relayed for them. `answerAuthority` and ADR 623 §3's rule for channel answers are
     unchanged. A2 enters through ADR 662's gate, which every transport shares, not through a channel
     marker any consumer could read.

4. **A refused answer writes nothing and leaves the ask open.**
   - Covered: no proof, a proof for the other decision's descriptor, another key's signature, an
     expired or spent nonce, a stale binding or a changed ask.
   - In each case no verdict message is written in the human's name and no decision is recorded. The
     token stays live, so the phone can fetch fresh descriptors and try again.
   - Only `authority.refused` or `channel.answer.refused` records the attempt.

5. **The app renders and signs with protocol's own code.**
   - `approval.ts` is the node-free half of human authority. It holds the closed list,
     `canonicalJson`, the descriptor schema, `descriptorSigningBytes`, the proof schema and
     `approvalWording`: fixed header words per listed act, a `Record` over the list, so a new act does
     not compile until it has words.
   - `authority.ts` re-exports it beside the node-only `payloadDigest`.
   - The app imports `@musterd/protocol/approval` and `@musterd/protocol/app-channel`. A test keeps
     both modules free of `node:` imports.
   - The app must:
     - hash `canonicalJson(payload)` with its own SHA-256;
     - show nothing if the result differs from `payload_digest`;
     - build the header from `approvalWording` (the lane id and the verdict's two fixed values, never
       the title);
     - show the title below the header, labelled as the seat's words;
     - sign `descriptorSigningBytes` of the descriptor it rebuilt.
   - Both of an answer's signatures are made under one Face ID evaluation.
   - `approval.vectors.json` holds test vectors, recomputed and verified in `gates`: payload, canonical
     JSON, digest, descriptor, signing bytes, wording and DER signatures under a fixed public key.

6. **The fatigue ceiling (ADR 676 §8) is the next increment of this lane.** That covers one open
   listed-act ask per human, six an hour from agent seats with one summary, and the /live flag for "I
   did not expect this". No phone can pair until the app half ships, so a daemon without the ceiling
   exposes no one in the meantime.
   Follows-up: 01M5BER5GX4WENE2CEST6CA8NB

## Consequences

- ADR 623's "A2 does not exist yet" (§2) ends for the app channel. An A2 token exists and redeems
  only after ADR 662's gate takes the act. Slack stays A1, and a privileged ask still gets no buttons
  there.
- ADR 662 decision 5's third authenticator, the phone, is wired for `human_accept` end to end on the
  daemon. The launch gate's "phone key in pairing" condition still waits on the app half.
- `requireAuthority` gains `checkOnly`. It is the same gate, run once without the spend and once for
  real, so there is no second verifier to keep in step with the first.
- The protocol package gains two subpath exports and three optional schema fields: `approval` and
  `lane` on an ask delivery, and `approval` on an answer. All are additive. An advisory delivery and
  answer are byte-for-byte what 3a sent.
- _(2026-10-21, lane 01M5FZ5R2VF8YZB48DQ357YYWM: the phone now also carries other privileged asks
  whose answer act is gated, using `human_accept` descriptors bound to the ask id and verdict.
  Lane-review verdicts keep their existing queue and lane transition; generic privileged answers
  use the same route and A2 gate without a lane transition.)_

## Observability & Evaluation

**Traces.** A redeemed verdict writes three rows:
- `authority.approved` {act `human_accept`, assurance A2, kind `phone`, key id};
- the verdict act itself, from the human, `in_reply_to` the ask;
- `channel.answer.a2` {ask, binding, authorizer, delivery actor `app`}.

A refusal writes `authority.refused` with its reason, or `channel.answer.refused`. No signature,
nonce, token or descriptor payload is logged (hard rule 5).

**Eval.** The away-channels falsifiers gain these cases, in `appAdapter.test.ts`. Each is refused, and
each leaves the lane, the ask and the message log untouched:
- an answer with no A2 proof;
- "approve" carrying the reject descriptor's signature (`descriptor_mismatch`);
- a signature by a key that is not the binding's phone key;
- a proof naming another key id;
- a replay of a redeemed answer;
- an answer under a token a re-delivery spent.

`authority.test.ts` pins a P-256 DER signature verifying as a phone key, and `checkOnly` leaving the
nonce live.

**Experiment.** ADR 676's experiment covers this. Over 30 days from the first signed answer, it
measures the share of nick's asks answered from the app while he had no live laptop presence. This
ADR adds one count to read beside it: phone verdicts refused by the gate, by reason. A
`descriptor_mismatch` from a real phone means the app and the daemon disagree about bytes, which is
the failure decision 5 exists to prevent.
