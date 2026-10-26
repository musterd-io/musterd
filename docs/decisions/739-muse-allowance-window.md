# 739 — Muse allowance window

- Status: accepted
- Date: 2026-10-26

## Context

`@musterd/allowance` reads ElevenLabs, OpenAI, Claude, and Cursor. Muse stayed on the list with the reason "No window we can read yet." The Muse CLI answers `muse usage --json`. On 2026-10-26, before a spend in the current window, that command returned `schemaVersion` 1 and `allowance: null`, reason `server_sent_no_usage`. The subscription shape, taken from the CLI's own fields and not from a spent window observed that day, is a current window (`usedPercent`, `windowDurationMins`, `resetsAtMs`) and a weekly block (`usedPercent`, `resetsAtMs`). The same fields appear in snake case.

ADR 723 keys a reading by provider and a one-way account key, and paints it on the member card. Its Decision says an agent sees Claude or OpenAI only. A seat whose live model is `muse-wonder` or `muse-spark` has no line under that sentence. The wake-token sum in the CLI is a different read and is not this window.

## Problem

Muse can report a subscription window, and the page has no reader for it. The roster cannot name provider `muse`, so a post that includes it is rejected. An agent running Muse cannot be matched to that reading.

## Decision

Read `muse usage --json` when Muse is chosen. The command is local. The limit is 5 seconds. A missing binary says "Muse is not installed on this machine." A command that does not finish says "Muse did not answer." A non-zero exit still parses JSON on stdout. A timeout wins over a partial stdout.

`schemaVersion` must be 1. Anything else is an error and no number. `allowance: null` is missing, and no number is invented:

- `server_sent_no_usage`, and any other reason, says "Muse sent no usage for this window yet."
- `no_allowance` says "Muse has no subscription allowance on this login."
- `api_key` says "This Muse login is an API key, which has no subscription window."
- Text that says the login is not signed in says "Sign in to Muse on this machine, then refresh."

The hint and `tier` are not copied out.

A window is painted only when it has a used percent and a reset. The current window also needs a duration in minutes, named the way Codex names a length (300 minutes is the 5-hour window). The fields are `usedPercent` or `used_percent`, `windowDurationMins` or `window_duration_mins`, and `resetsAtMs`, `resets_at_ms`, `resetsAt`, or `resets_at`. They are read from `allowance.window`. When `window` is absent, the same fields on `allowance` itself are that window. When both exist, `window` wins. `allowance.weekly` is the weekly window from a used percent and a reset. Used percent may be over 100. The card label is "Muse". A body with no usable window says "Muse left out the windows." A body that is not this shape says "Muse sent something we could not read."

The account key is `id:` plus `user_email` when that email is a public id, from the top of the auth file or from a `providers` entry, else the machine key. The file is `MUSE_AUTH_PATH` or `~/.config/muse/auth.json`. The access token is not hashed and is not posted.

`muse` is appended to `ALLOWANCE_PROVIDERS`. The package does not import `@musterd/protocol`. It posts the same plain JSON. An older daemon rejects a post that names `muse`, and that rejection drops the other accounts in the same body. The daemon and this package ship together. The default selection stays ElevenLabs, so an unchanged config does not post `muse`.

An agent sees a Muse reading when the live presence model matches `muse` as a word (`muse-wonder`, `muse-spark`) and exactly one Muse reading matches the presence node or the presence driver. `musterd` does not match. Cursor and ElevenLabs stay on humans. This amends ADR 723.

The package version in this change is 0.1.3. Publishing it is a separate cut.

## Consequences

Choosing Muse on a daemon that does not list `muse` stops the percent post until that daemon runs this enum. The page still shows the local read.

The reading stays in daemon memory and is not replicated, as ADR 723 decided. Two machines show one Muse percent only when both post to the same daemon.

`muse usage` on 2026-10-26 on this machine returned `allowance: null` with `server_sent_no_usage`. The window parse is held by fixtures. No spent window was observed that day.

## Observability & Evaluation

Traces: none new. The post is the ADR 723 allowance post. This read is not an Act.

Eval: the dataset is `packages/allowance/src/muse.test.ts` and the Muse cases in `packages/server/src/allowanceReadings.test.ts`. The baseline is a null allowance, which produces no window. `usedPercent` 35 on a 300-minute window paints 65% left of the 5-hour window. A model named `musterd` does not take the Muse reading. A `muse-wonder` presence does.

Experiment: n/a. No spent Muse window was observed on this machine on 2026-10-26, so a live percent is not the check.
