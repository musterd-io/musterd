# 812 — The fixed words for a passkey-enrollment approval

- Status: accepted
- Date: 2026-11-05
- Lane: `01M6P6WKEF6BR20VJ789S1KY69` (ADR 808 inc C, phone side)
- Deciders: cider (nick asked for the lane, 2026-11-05)
- Relates to: [ADR 808](808-passkeys-survive-an-origin-move.md) inc C (a new passkey approved from the phone),
  [ADR 676](676-mobile-app-sealed-ask-client.md) §6 (the app's own fixed wording, the phone signs what it shows),
  [ADR 694](694-phone-a2-lane-verdicts.md) (the descriptor screen), hard rule 1

## Context

ADR 808 inc C lets /live ask the human's own phone to approve a new passkey when no passkey signs
on the page's origin. The daemon sends a listed-act ask with two offers. The approve offer is the
`device_key_admin` descriptor /live minted over `{action:'enroll', kind:'passkey'}`. The reject
offer is a second descriptor over the same payload plus `decision:'reject'`, which the enrollment
guard never accepts.

The phone already checks the digest, rebuilds the descriptor and signs it with the answer under one
Face ID, whatever the act. It words the header with `approvalWording` from
`@musterd/protocol/approval`.

## Problem

`approvalWording` gave `device_key_admin` one string for every payload: "Change the device keys of
<member>". So the descriptor screen showed the same words in the header and in "If you decline".
The human could not tell from the fixed words what approve does or what decline does. The only text
that said "passkey" was the ask body, which the screen labels as the asker's.

## Decision

1. `approvalWording` reads a `device_key_admin` payload only as fixed enums. For
   `{action:'enroll', kind:'passkey'}` with no `decision`, the headline is "Add a new passkey for
   <target>". With `decision:'reject'`, it is "Don't add a new passkey for <target>".
2. Any other payload on the act keeps "Change the device keys of <target>". This includes a revoke,
   another key kind, or a `decision` that is not `'reject'`. Free text never reaches the headline.
3. The origin stays out of the descriptor and out of the headline. The descriptor has no origin
   field, and the daemon pins the enrollment payload digest. The daemon writes the ask body ("Approve
   a new passkey for <member> on <host>"), and the screen shows it below the rule.
4. No schema, signing-byte or digest change. The words are the contract every authenticator shows,
   so this ADR records them (hard rule 1).

## Consequences

- The phone's descriptor screen now says what each choice does. /live and any other caller of
  `approvalWording` get the same words.
- A future `device_key_admin` payload (a passkey revoke from the phone, say) needs its own words
  here, or it shows the generic line.

## Observability & Evaluation

n/a: this changes only the display wording of one listed act. It is not agent-facing and emits no new
trace. The existing `channel.answer_reported` rows still record a "Decline — I did not expect this"
from this screen.
