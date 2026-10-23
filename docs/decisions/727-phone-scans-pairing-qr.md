# 727 — The phone scans a pairing code with expo-camera

- Status: accepted
- Date: 2026-10-23
- Lane: `01M5K60EPKCZVXQCQ7Z32M7QJN` (goal `away-channels`)

## Context

ADR 676 decision 5 pairs the phone from a QR the daemon's own page shows. The QR text is
`AppPairingQrSchema` JSON (ADR 690): the relay route, the team, the pairing id, a one-time code,
and both daemon public keys. The page also prints the daemon identity fingerprint. The phone has
to read that code. `packages/mobile` had no barcode scanner. `expo-barcode-scanner` is retired;
barcode scanning in Expo SDK 58 lives in `expo-camera`.

## Problem

A new runtime dependency needs a decision (hard rule 6). The pairing lane cannot be done by
parsing a code the phone has no way to see. Putting an AVFoundation capture session inside the
existing keys module would be a second camera stack, with its own permission plugin, beside the
SDK module that already scans QR codes.

## Decision

The app depends on `expo-camera` at the SDK 58 version the lockfile resolves (`~58.0.12` as
installed). It is used on the pairing screen to scan a QR, and nowhere else. The config plugin
sets `NSCameraUsageDescription` and sets the microphone permission off, on iOS and Android, so
the app does not ask for a microphone it does not use. Barcode scanning stays enabled.

The alternative of pasting the JSON is not the pairing path. The screen still accepts a paste
when the camera is refused or unavailable, and that paste goes through the same parser. The
alternative of a hand-rolled scanner in `MusterdKeys` was rejected: it duplicates `expo-camera`
and still needs the usage string.

`expo-camera` is published by Expo under the MIT licence. It adds no protocol type and no server
import.

## Consequences

- The pairing screen shows the daemon fingerprint and waits for a tap before it generates keys
  or sends the request. That tap is the comparison with the page. The code is single-use.
- SHA-256 for the fingerprint and the App Attest challenge is in the app (`src/native/sha256.ts`),
  checked against Node's `createHash`. `expo-crypto` was not added.
- A relay `202` stores the pairing pin without a binding. The extension fills the binding from
  the first delivery it verifies. The phone does not approve itself.
- The camera preview, a scan of a real QR, App Attest, and Face ID on the new signing key were
  not run on a device. An EAS build is what produces one. The attestation call and the Swift
  that writes the binding are on the security review path before TestFlight.

## Observability & Evaluation

**Traces.** No new audit row. A pairing the daemon accepts still writes `channel.app_paired`
(ADR 676), with no key material and no camera frame. A refused scan stays on the phone.

**Eval.** `pairingQr.test.ts` checks the fingerprint and the challenge against Node's sha256 of
the same bytes the daemon hashes (`keyFingerprint`, `appPairingChallenge`). `pair.test.ts` checks
the sealed `AppPairRequest`, the relay callback, and that the stored pin has no binding. The
baseline is the daemon's own functions: a mismatch fails those tests. `logic-check.swift` checks
that an absent binding is filled once and an existing one is not replaced.

**Experiment.** None. A scan of a QR from `musterd channels pair --channel app` on a device, with
the fingerprint matching the page, is the check an EAS build owes. It is not a pre-registered
rate.
