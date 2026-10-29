# 769 — An admin vouches for a first passkey from /live

- Status: proposed
- Date: 2026-10-29

## Context

Past team genesis, a human with no active key cannot enroll a passkey alone. Another human admin
with a standing key must countersign: they sign `device_key_admin` over
`{action: 'enroll', kind: 'passkey', member}` (ADR 662, ADR 728 §4). The rule exists because the
server cannot tell a real authenticator from a fabricated registration. Once a team has keys, the
admin's countersign is the anchor and the ceremony is not (ADR 662 Consequences, 2026-10-20).

Today the countersign takes three terminal steps and a hand-copied proof:

1. The member runs `musterd authority enroll --confirmed-by <admin>`, which prints what the admin
   should run.
2. The admin runs `musterd authority approve --act device_key_admin --target <member> --payload …`
   on the hub, which prints the proof JSON.
3. The member pastes that proof into `--countersign-proof`.

ADR 767 moved every other enrollment case into /live. This is the one left (lane 01M64SXW85).

## Problem

Carrying the countersign in /live is easy to wire, because every route it needs already exists. The
hard part is that the countersign is the anchor. An admin who taps "vouch" on a request that came
from a stolen browser session has enrolled an attacker's key for that member. The admin's screen
has to make "this really is them asking" a deliberate check, not a reflex.

## Decision

Proposed, pending design (slippy) and a security read (big-body). Nothing is built yet.

1. **The member asks.** In Your passkeys, past genesis, "Ask an admin to vouch" lists the team's
   human admins who have a standing key. Picking one makes the member's browser create the
   descriptor with that admin as its actor (`POST /authority/descriptors {actor: admin, act:
   'device_key_admin', target: member, payload: {action: 'enroll', kind: 'passkey', member}}`), an
   existing route. The browser then sends a `request_help` to that admin carrying the descriptor
   nonce. The member's sheet shows a **check code** derived from the nonce (for example six digits
   of its sha256) and "tell <admin> this code".
2. **The admin vouches.** The admin's /live shows the request under Waiting for you: who is asking,
   the same check code, and "confirm this code with <member> in person or on a call before you
   vouch". **Vouch with passkey** signs that exact descriptor with the admin's passkey and parks the
   proof (`POST /authority/approvals`), the same path every in-page approval already uses.
3. **The member finishes.** The member's sheet polls `GET /authority/approvals/:nonce`. When the
   proof is parked, it shows "<admin> vouched — finish enrolling". That click runs the ADR 767
   ceremony with `countersign: {confirmer: admin, approval: proof}`. A click is needed because
   browsers require one before `credentials.create`.

No route, schema or guard changes. `enrollPasskeyGuarded` still verifies the countersign: a
different human admin, a standing key, current admin capability.

Open questions:

- **Time box.** A descriptor lives five minutes (`DESCRIPTOR_TTL_MS`), so both people must be
  online together. Is that the right shape for vouching ("on a call together"), or should the
  request outlive the descriptor, with a fresh descriptor minted when the admin opens it? The
  second option needs a server-side request record.
- **Binding.** The countersign payload names the member but not the credential being enrolled, so a
  parked proof enrolls any registration for that member until it expires. Should the payload also
  commit to the member's enrollment challenge? That would be a server and guard change.
- **Joiners.** ADR 728 §4 and §9 serve the countersign from the hub's origin. An admin vouching
  from a joiner's /live would be refused, so the admin side should say so and link to the hub.

## Consequences

To be written once the open questions are settled.

## Observability & Evaluation

- **Traces:** the existing `device_key.enrolled` audit row (actor the member) and the countersign
  verification inside `enrollPasskeyGuarded`. The request itself is a `request_help` act.
- **Eval:** to be set with the design.
- **Experiment:** n/a — a consent ceremony, not a tunable.
