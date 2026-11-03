# 791 — Phone quick actions and the seat roster

- Status: accepted
- Date: 2026-11-03

## Context

ADR 779 added four quick actions (Start, Check inbox, Check PR, Resume). Each is a person's `steer`
with `meta.quick_action`, and the daemon composes the seat's line from it. `/live` sends them through
the ordinary send route, with the person's credential.

The phone cannot do that. It reaches the daemon only by sealed relay callbacks (ADR 676: `pair`,
`answer`, `redeliver`, `question_key`). It holds no human credential to post a steer, and it has no
list of seats to show. cider asked for both on 2026-11-03 (request_help `01M6H8DAFQ`, lane
`01M67E5DM8`).

nick decided the same day that a quick action from the phone needs no Face ID: the silent question
key (ADR 774 §5) signs it. A quick action carries the same risk as a question's answer. Its line is
daemon-composed from a fixed vocabulary, and it carries no text a seat reads.

nick also said he would not use "Start everyone" from the phone, and may not use it anywhere.

## Problem

The phone cannot send a quick action, and it cannot show the seats it would send one to.

## Decision

1. **A new callback kind, `quick_action`.** `{app: 1, kind: 'quick_action', binding, ref, expires_at,
   sealed}`, sealed to the daemon with purpose `quick_action`. `ref` is the body's nonce.
2. **The body names one seat and one action.** `AppQuickActionSchema`: `{v: 1, seat, action, nonce,
   ts, key, signature}`, where `action` is one of ADR 779's four. There is no Start everyone from the
   phone.
3. **The question key signs it, with no Face ID.** `key` is `question` (the silent key) or `signing`
   (the Face ID key, for a phone that sends from inside the app). The signature covers
   `appQuickActionSigningBytes`, under its own domain tag `musterd-app-quick-action/v1`, so no
   answer or decision signature verifies as a quick action. A revoked phone key revokes the
   question key with it, as for answers.
4. **Replay is closed.** The seal's `expires_at` must be in the future and at most 10 minutes ahead
   (`APP_QUICK_ACTION_WINDOW_MS`). The nonce is spent on the binding (`quick_action_nonces`, the
   newest 128, compare-and-swap) after every other check passes, so a refused request does not
   burn a nonce. A replay inside the window is refused as `replayed`.
5. **The daemon sends the steer as the binding's person.** It is the same `steer` that `/live`
   sends, through the ordinary route, so ADR 779's line, ADR 790's human pass and every gate apply
   unchanged. A seat that is not a standing agent seat is refused (`unknown_seat`) and nothing is
   sent.
6. **The result goes back sealed.** A `quick_action_result` delivery `{nonce, action, seat,
   result}`, where `result` is `started` (the seat is live, or enrolled with a host that can wake
   it) or `offline` (neither; the steer still waits in the seat's inbox). Its relay ref is
   `qa-<nonce>`.
7. **The phone gets a seat roster.** A `roster` delivery `{ts, seats: [{seat, online, wakeable,
   lane}]}` lists every standing agent seat, sorted by name, at most 64:
   - `online`: a live session is in the seat.
   - `wakeable`: the seat is enrolled for wakes and not halted.
   - `lane`: the seat's one live lane `{id, title}`, or null when it holds none or several.

   The daemon sends it after pairing and on every `redeliver`, under the relay ref `roster-<ts>`.
   _(Amended 2026-11-03: the roster is never pushed; the phone pulls it — see Consequences.)_
   A roster too large to push is fetched by that ref and rebuilt as of the fetch. `lane.title` is
   text the seat wrote, and the phone labels it as the seat's.
8. **Audit.** `app.quick_action {binding_id, action, key, result}`, with the seat as target. The
   steer's own `quick_action.sent` row is unchanged.

## Consequences

- The phone UI (cider, lane `01M67E5DM8`) can build the per-seat buttons and the question-card
  buttons against these shapes. Both need only decisions 1 to 6.
- No migration: the spent nonces live in the binding's `app_keys` JSON, beside the question-key
  nonces.
- The `/live` Start everyone (ADR 779 §3) is unchanged. The phone has no route to it.
- Each redeliver sends one more push (the roster). A phone that opens often costs one sealed roster
  per open.
- 2026-11-03 (lane `01M6HH8GWM`, cider's report `01M6HH730B`): the pushed roster was a regression
  on the live hub. The relay sends every delivery as an alert push. The phone's notification
  extension (build 43) refuses a kind it does not know, so each app open showed nick a "couldn't
  verify" notification and recorded a `check` refusal. A newer build cannot fix that alone: hiding
  an alert push needs Apple's filtering entitlement. The daemon no longer pushes the roster at all.
  The phone pulls it with `GET body/<binding>/roster-<ts>` (`ts` at or before now, inside 10
  minutes), and `fetchRoster` builds it as of the fetch. `quick_action_result` is still pushed: it
  only follows a button press, so a notification there is wanted.

## Observability & Evaluation

- **Traces:** `app.quick_action` per accepted request; `channel.sealed_delivered` with `kind`
  `quick_action_result` or `roster` for each reply; refusals return a plain reason to the relay
  (`expired`, `sealed_body`, `bad_request`, `nonce_mismatch`, `key_revoked`, `bad_signature`,
  `replayed`, `unknown_seat`).
- **Eval:** `appAdapter.test.ts` pins that a question-key action is sent as the person's steer with
  its result, that a wakeable seat is `started`, that each refusal above holds and sends nothing,
  that the Face ID key may sign one, that a roster reports online, wakeable and the one lane after
  redeliver and pairing, and that a roster is fetchable by its ref while a result is not.
  `appQuickAction.test.ts` (protocol) pins the shapes and the domain tag.
- **Experiment:** a week after the phone build ships, count `app.quick_action` rows by action
  beside the `/live` `quick_action.sent` rows. **Falsify:** fewer than one phone quick action a day
  across the team, which would mean the phone buttons are not where a person reaches for them.
