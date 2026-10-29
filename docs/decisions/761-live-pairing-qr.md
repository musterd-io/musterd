# 761 — /live draws the app pairing QR with uqr

- Status: accepted
- Date: 2026-10-29

## Context

Pairing the musterd app took two terminal steps: `musterd channels pair --channel app`, which prints
the QR (ADR 690), and `musterd channels confirm <id>`, which collects a passkey approval (ADR 676 §5).
On 2026-10-29 nick called the setup extremely cumbersome. Lane 01M64DSBQV moves both steps into
/live, under Settings → You → Your phone. The browser already signs ADR 662 descriptors with the
human's passkey (`authorityProof.ts`), so the confirm needs no new mechanism. The QR does: the web
package has no encoder. ADR 690's Consequences anticipated "`/live` can render the same payload
later without changing the wire".

## Problem

Drawing a QR in the browser needs a Reed–Solomon encoder. `packages/web` takes no new runtime
dependency without an ADR (hard rule 6), and every byte on /live counts against its perf budgets.

## Decision

`packages/web` takes `uqr` 0.1.3 as a runtime dependency, the same package and version the CLI took
under ADR 690. It uses only `encode`. The page draws the module grid itself as one SVG path, dark
modules on a white field with the standard four-module quiet zone, so the code scans the same in
either theme.

`uqr` is imported dynamically inside the click handler for "Pair a phone". It is therefore in
neither /live's initial graph nor the settings sheet's chunk until someone asks for a code. Measured
on 2026-10-29: `dist/index.mjs` is 28 KB raw and 7.8 KB gzipped.

Alternatives considered: the same ones ADR 690 rejected (`qrcode`'s dependency tree, the untyped
CommonJS `qrcode-generator`, or vendoring several hundred lines of an encoder). A daemon endpoint
that renders the SVG would keep the bytes off the browser, but it moves a pure rendering concern
into the server, and the server would need the dependency instead.

## Consequences

- A human pairs a phone from /live end to end: the code, the phone's key fingerprint, the passkey
  confirm, and a success line that names the phone. No terminal is needed. The CLI path is unchanged.
- An app pairing in the "Waiting for you" list moves to the phone panel, because confirming it
  needs the passkey proof, which the Slack row's plain Confirm never sent.
- A human with no passkey enrolled is told to run `musterd authority enroll` once. Enrolling a
  passkey from /live is not part of this decision.
- The phone's own check of the daemon fingerprint and receive key is unchanged here. big-body's
  2026-10-29 review asked for that binding to be verified before TestFlight, and it stays tracked on
  the phone side.

## Observability & Evaluation

- **Traces:** none new. A pairing confirmed from /live writes the same `channel.app_paired` and
  ADR 759 settings rows as one confirmed from the CLI.
- **Eval:** `PairPhone.test.ts` checks the SVG module count against uqr's grid, and the countdown.
  `pnpm perf:check` in CI holds the budgets.
- **Experiment:** n/a — a rendering dependency, not a tunable.
