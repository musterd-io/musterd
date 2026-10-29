# 758 — Write commands answer --json with the daemon's reply

- Status: accepted
- Date: 2026-10-29

## Context

`--json` is a global CLI flag. The help footer described it as "machine-readable output", and
`musterd help done` listed it in its signature. But `musterd done --json` and every `musterd lane`
write (`open`, `claim`, `release`, `park`, `unpark`, `handoff`, `update`, `sample`, `submit`,
`resolve`) ignored it. They printed the human receipt: a ✓ line, the lane, warnings, nudges and
the routing report. `done` then went on to print what's next. Only the reads (`lane show`,
`lanes`) honoured the flag. A script that asked for JSON got prose and had to scrape it (lane
01M61VTS84).

## Problem

What should a write command print under `--json`? There are two choices. One is a new
CLI-shaped object. The other is the reply the daemon already returns for the write.

## Decision

Under `--json`, `done` and each `lane` write print the daemon's reply to the write, exactly as
received, as **one JSON line on stdout and nothing else**. Then they exit 0. The reply is
`{ lane, warnings, … }`, the same shape `lane show --json` already prints. `lane.state` says
what happened (`done`, `awaiting_acceptance`, `claimed`, …), and `review`, when present, says
who was asked to accept. Each reply carries whatever fields its write returns.

- The human-only text is left out: nudges, advisory notes, the branch-cleanup hint, and
  `done`'s what's-next chain.
- A failure prints nothing on stdout. It exits non-zero with the message on stderr, as before.
  An interrupted write still exits 7, which means the outcome is unknown. So a script tells
  success from failure by the exit code and an empty stdout.
- The passkey ceremony's prompts were already on stderr (lane 01M5ZE7F4G). An `--authorized-by`
  close therefore still prints one clean line on stdout.

The help footer now says `--json` gives machine-readable output **where the command lists it**,
and `lane`'s help lists it on its writes.

## Consequences

- No CLI-shaped wrapper needs to be versioned. The protocol schemas already describe the reply.
  When a field is added to the daemon's reply, it appears here too.
- Other commands that accept `--json` but print prose on some paths are not covered here. Each
  of them should either honour this contract or refuse the flag before it writes.
  Follows-up: 01M64CN3VYYFP05BHBDCC07SHA

## Observability & Evaluation

n/a — a CLI output contract with no agent-run behaviour of its own. `done.test.ts` parses the
one line for each verb, the submit, and the passkey path.
