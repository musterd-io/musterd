# 690 — The app pairing QR is printed in the terminal, encoded by `uqr`

- Status: accepted
- Date: 2026-10-20
- Lane: 01M5DW5MV5587224H93S05P1DT
- Builds on: [ADR 676](676-mobile-app-sealed-ask-client.md) decision 5 (pairing)

## Context

ADR 676 decision 5 pairs the musterd app by a QR code holding the team's relay route, a one-time
code and the daemon's two public keys. Increment 2 (PR #3006) mints that payload at
`POST /channels/app/pairing` as `AppPairingQrSchema`, but nothing renders it: no CLI command and no
`/live` panel turns it into a code a phone can scan. The relay and the hub's away connection were
live on 2026-10-20, so pairing became the first missing step of a real phone push.

## Problem

Something must draw a QR code. The payload is about 400 bytes (version 13 at error correction L,
77 modules with the quiet zone), and no package in the monorepo encodes QR codes. Hard rule 6: no new
runtime dependency without an ADR.

## Decision

1. `musterd channels pair --channel app` calls `POST /channels/app/pairing`, parses the response
   through `AppPairingQrSchema`, and prints the QR followed by the daemon fingerprint, pairing id and
   expiry. The QR's text is the payload's JSON. `--json` prints the response instead. The one-time
   code appears only inside the QR, never as text, and is never logged.
2. `musterd channels confirm <id>` on an app pairing collects a `device_key_admin` passkey approval
   over the `enroll_payload` the daemon lists, and sends it with the confirm. `channels pairings`
   shows an app pairing's phone key fingerprint and device.
3. The CLI takes `uqr` (0.1.3, MIT, unjs) as a runtime dependency and uses only its `encode`. It is
   zero-dependency ESM with types. The CLI draws the modules itself as upper-half blocks with
   explicit black-on-white ANSI colours, so the code is dark-on-light whatever the terminal theme,
   in 77 columns.

Alternatives considered: `qrcode` pulls in `pngjs`, `dijkstrajs` and `yargs` for features the CLI
does not need; `qrcode-generator` is zero-dependency but CommonJS with no types; vendoring an encoder
is several hundred lines of Reed–Solomon and masking to own. `uqr`'s own renderers either rely on the
terminal's colours (`renderUnicodeCompact`, inverted on a dark theme) or use two columns a module
(`renderANSI`, 154 columns), which is why the CLI draws its own.

## Consequences

- A human can pair a phone from the hub's terminal today. `/live` can render the same payload later
  without changing the wire.
- The QR's text format is the payload JSON; the phone parses it with `AppPairingQrSchema`.
- One more runtime dependency in `@musterd/cli`.

## Observability & Evaluation

- Traces: n/a — the command prints locally; the daemon already audits the pairing
  (`channel.app_paired`).
- Eval: `channels.test.ts` checks the QR is drawn, the fingerprint shown, the one-time code absent
  from the text, and that an app confirm carries the approval while a Slack confirm does not.
- Experiment: n/a — the first real check is scanning it with the app (lane 01M50XQ1TG).
