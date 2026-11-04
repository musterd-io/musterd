# 802 — An app pairing that ended says so: the daemon records its key per binding, and a dead binding's fetch answers "pairing ended"

- Status: accepted
- Date: 2026-11-04

## Context

On 2026-11-04 fifty rotated the laptop daemon's app-channel key (`app-channel.key`, ADR 676
decision 3) for the hub-relocation rehearsal. Every phone paired under the old key stopped
working at once. Nothing said so. The phone kept showing its pairing, and /live kept listing the
binding as "Paired with … since …". nick re-paired by hand and called the whole thing "not a good
user experience" (lane 01M6KYZ1SM, item 4, split out as lane 01M6M06CHY).

The same thing will happen on hub-relocation switch day. The box's daemon gets a fresh key, and
every phone paired to the laptop goes dead without a word.

Two facts make it silent today:

- A `channel_bindings` row does not say which daemon key the phone pinned. The daemon cannot
  tell a binding paired under its current key from one paired under a key it no longer holds.
- The phone treats every failed check alike (ADR 676 decision 3): "an ask could not be verified",
  with no hint of which check refused, because that distinction would be an oracle. A delivery
  signed by a new daemon key fails the signature check, so a rotation looks exactly like a
  forgery, and that must stay true.

A revoked binding is silent too. Its body fetches answer 404, which the phone reads as "this ask
is gone", not "this phone is unpaired".

## Problem

How do the human on /live and the phone itself learn that a pairing has ended, without
weakening decision 3: the phone never trusts, and never distinguishes, anything it cannot verify?

## Decision

1. **The daemon records its key on each app binding.** When an app pairing is confirmed, the
   binding's `app_keys` gains `daemon_identity_public_key`: the daemon identity key the phone was
   shown in the QR, which is the current one at confirm time. This is a field inside the existing
   JSON column, so no migration is needed.

2. **A binding's standing is derived, never stored.** An active app binding is `superseded` when
   its recorded key differs from the daemon's current identity key, and `current` when they
   match. A binding with no recorded key predates this ADR. The first time the daemon reads it,
   the daemon records the current key if the binding was created after `app-channel.key` was
   written (file birth time, else mtime). Otherwise it records the marker `"unknown-before-key"`,
   which reads as `superseded`. The backfill writes once per binding, so a later copy or touch of
   the key file cannot change a verdict already recorded.

3. **/live flags it.** `GET /channels/bindings` adds `ended: 'superseded' | 'revoked' | null` to
   each app binding. /live shows a superseded binding as "Paired under this daemon's old key — it no
   longer gets asks. Pair again." and offers Remove. A revoked binding already reads as revoked.

4. **A dead binding's body fetch says "pairing ended" (wire change).** When the relay's
   `app_fetch` names a binding that is revoked or superseded, the daemon answers `app_body` with
   `sealed: null` and a new optional `ended: 'superseded' | 'revoked'`. The relay answers the
   phone `410 Gone` with `{"ended": "<reason>"}`. Without the field, the relay answers 404 as it
   does today. This applies to every body fetch: asks, the roster and portraits.
   - **Compatibility.** An old relay drops the unknown field and answers 404, as today. An old
     phone reads 410 as "unreachable", as it reads any non-404 failure today. An old daemon never
     sends the field. No side has to upgrade first.

5. **The phone says to pair again, and trusts nothing new.** A 410 with a known `ended` makes
   the phone show one note on Home and Seats: "Your team's daemon changed. Pair again to keep
   getting asks." for `superseded`, and "This phone was unpaired. Pair again to keep getting
   asks." for `revoked`. The note links to Pair, and nothing else changes. The phone does not
   forget its pin, delete anything, or treat the status as authenticated: the status is unsigned,
   and the phone acts only on what it can verify.
   - **Why an unsigned status is acceptable.** The worst a forged 410 can do is ask the human to
     pair again. Re-pairing runs through /live's QR, which the human scans from the real daemon
     page. A forged 410 can deny service, but so can a relay that drops every fetch. It grants
     nothing.
   - **Decision 3 is unchanged.** A delivery that fails a check still shows only the generic
     text, whatever the reason.

6. **Nothing is pushed to a superseded binding.** Every delivery sealed to it would only show the
   generic "could not be verified" text on the phone. The app adapter skips the binding, and the
   skip is recorded with reason `binding_superseded`, like the adapter's other skip reasons, so
   the skip is never silent.

7. **Who builds what.** The `RelayAppBodyFrameSchema` field and the relay's 410 path are a
   protocol lane (engineer). The daemon's recording, backfill, standing and `ended` on
   `app_body` and `/channels/bindings`, the phone's note, and /live's flag stay in lane
   01M6M06CHY (ios-engineer). The relay deploy is nick's.

   Follows-up: 01M6M9JMMENX695VGJW4VTK1EV (the wire and relay), 01M6M06CHYDXERM3FRA8RT1JB0 (daemon, phone, /live).

## Consequences

- The binding id becomes a weak oracle: anyone who knows a team slug and a binding id can learn
  through the relay whether that binding ended. Binding ids are ULIDs that travel only in the
  sealed QR flow and push routes, and the answer reveals no keys, asks or members. Accepted.
- A key file restored from a backup with an earlier birth time could mark a pre-ADR binding as
  current when it is in fact dead. The backfill is a one-time best guess for old rows. Bindings
  paired after this ADR carry the exact key.
- Hub relocation (ADR 796) inherits this. On switch day every laptop pairing reads superseded on
  the box's /live, and every phone says to pair again on its next fetch.
- 2026-11-04 (lane `01M6M9JMME`, fifty): decisions 4 and 6, wire half. `RelayAppBodyFrameSchema` gains `ended`, and `AskSkipReason` gains `binding_superseded` ("your phone was paired under this daemon's old key — pair again"). The relay keeps `ended` only with `sealed: null` (wallow) and answers the body fetch with `410 {ended}`, `no-store`. It goes live with the next relay deploy, which is nick's to run.

## Observability & Evaluation

- Traces: the daemon audits each `ended` answer once per binding per reason
  (`channel.app_fetch_ended`, detail `{binding, reason}`). The relay counts 410s in its existing
  fetch log line.
- Eval: n/a. This is not agent-facing behaviour; correctness is pinned by unit tests on standing
  and the backfill, the relay's 410 mapping, and the phone's miss parsing.
- Experiment: the next real rotation, the hub-relocation rehearsal (lane 01M6HWVB7F). Falsified if
  a phone paired before the rotation does not show the "pair again" note within one fetch, or if
  /live lists that binding without the flag.
