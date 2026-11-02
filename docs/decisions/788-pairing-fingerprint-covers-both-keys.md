# 788 — The pairing fingerprint covers both daemon keys

- Status: accepted
- Date: 2026-11-02

## Context

[ADR 676](676-mobile-app-sealed-ask-client.md) decision 5 pairs the phone from a QR on the
daemon's page. [ADR 727](727-phone-scans-pairing-qr.md) has the phone show "the daemon identity
fingerprint" after the scan and wait for the person to say it matches the page. The QR carries
both daemon public keys: the Ed25519 identity key, which signs deliveries, and the P-256 receive
key. The phone seals its pair request to the receive key, and every later answer too.

Today the page, `musterd channels pair` and the phone all show `keyFingerprint(identity)`:
sha256 of the identity key alone, first 16 hex. big-body's reviews of 2026-10-29 (#3571 and the
pairing lane 01M5K60EPK) sent pairing back on this point. A QR with the real identity key and a
swapped receive key passes the comparison, and the phone then seals its pair request and its
answers to a key the daemon does not hold.

## Problem

The comparison the person makes covers only one of the two keys the phone pins. Matching the
fingerprint does not mean the phone talks to this daemon.

## Decision

1. **One value commits to both keys.** The pairing fingerprint is

   `sha256( utf8("musterd/pairing-fingerprint/v1") ‖ identity_raw ‖ receive_raw )`

   where `identity_raw` is the 32-byte Ed25519 key and `receive_raw` the 65-byte uncompressed
   P-256 point, joined with no separators. It is shown as the first 16 hex characters,
   lowercase, in groups of four separated by single spaces — the same display as today, so a
   person compares the same shape.
2. **The tag is versioned.** A later change to the scheme changes the tag. The tag also keeps
   this hash from colliding with any other sha256 of the same key bytes.
3. **Every surface shows the same value.** The phone computes it from the scanned QR and from the
   stored pin (`daemonFingerprint(identity, receive)` in `pairingQr.ts`). The daemon's
   `daemon_fingerprint` uses the same function; the `/live` pairing page and
   `musterd channels pair` print it. `keyFingerprint` stays for the phone-key fingerprint the
   daemon shows when it approves a phone.
4. **One test vector, pinned on both sides.** Identity = 32 bytes of `0x01`; receive = `0x04`
   followed by 64 bytes of `0x02`; fingerprint = `bf07 79a6 2f44 eeb0`. `pairingQr.test.ts` pins
   it on the phone and `appPairing-http.test.ts` on the daemon.
5. **They ship in step.** The phone half (lane 01M64P9V5A) merges first and is not built for
   TestFlight until the daemon half (lane 01M64Q23YY, slippy) has landed, so a pairing never
   shows two different values on a released build.

## Consequences

- A swapped receive key now shows a different fingerprint, and the person stops before the phone
  generates keys or burns the single-use code.
- Between the phone merge and the daemon merge, a source build of the app disagrees with the
  page. No TestFlight build is cut in that window (decision 5).
- 16 hex characters are 64 bits, as before. A forger who controls the QR needs a receive key
  whose fingerprint prefix matches, which is a 2^64 search per pairing code. The code expires
  quickly and is single-use, so the length is kept.
- ADR 676's dated note on decision 5 and ADR 727's Context now point here; `09-mobile.md` says
  "the fingerprint of both daemon keys".

## Observability & Evaluation

- **Traces:** n/a for the hash itself — it is computed on both sides and shown, never sent.
  Pairing's existing audit rows (`channel.pair.proposed` and the approval) are unchanged.
- **Eval:** `pairingQr.test.ts` pins the vector, checks the value against Node's sha256 of the
  same bytes, and checks that changing either key changes it and that a wrong-length key is
  refused. The daemon half pins the same vector.
- **Experiment:** after both halves land and a TestFlight build carries the phone half, nick
  pairs the phone again and reads the phone's fingerprint against the `/live` page. Pass: they
  match. Falsified if they differ on a fresh pairing — then one side is not using the decision 1
  bytes.
