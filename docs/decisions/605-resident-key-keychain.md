# 605 — A resident seat's key can come from the macOS Keychain

- Status: accepted
- Date: 2026-10-15

## Context

[ADR 588](588-resident-byok-seat.md) §1 has `musterd host` read a resident seat's API key from the
environment variable named at enrolment (`--key-env <VAR>`). It stores only the name, never the
value. In practice the variable reached the host through `launchctl setenv`, the only way to put a
value into a LaunchAgent's environment without writing it into the plist that `musterd service
install` regenerates.

On 2026-10-15 the Air rebooted at 10:24, `launchctl setenv` does not survive a reboot, and from
10:59 onwards every wake of the pilot's worker seat (`mason`) was a `residency.wake_deferred` row:
`API key variable ANTHROPIC_API_KEY is unset on this host`. That held for about an hour, until a
person read the audit.

## Problem

There are two defects, and both come from where the key lives:

1. **It does not persist.** A reboot silently stops every resident seat on the host, and nothing
   tells anyone. A deferral costs nothing and raises nothing.
2. **It leaks sideways.** `launchctl setenv` sets the variable for every process the user starts.
   The variable the pilot enrolled with was `ANTHROPIC_API_KEY`, which Claude Code and the Anthropic
   SDKs read on their own. On a laptop that more than one person uses under one macOS login, the
   operator's key funds everyone else's Claude use there, and the gateway that meters the seat never
   sees that spend. nick raised this on 2026-10-15.

## Decision

1. **When `<VAR>` is unset in the host's own environment, the native backend reads the Keychain
   item with service `musterd:<VAR>`** (`security find-generic-password -s musterd:<VAR> -w`) at
   each wake. A set variable still wins, so existing enrolments and non-macOS hosts are unchanged.
   The value goes to the engine as before and is never logged.
2. **The lookup is the one `musterd stream` already uses for its stream key** (ADR 157), moved to
   `packages/cli/src/keychain.ts`, so the two secrets share one reader.
3. **The deferred reason names both places**: the variable and the Keychain item.
   `musterd residency on --key-env` checks both and, when neither holds a key, prints the
   `security add-generic-password` line with `-w` last so the key is typed at a prompt, not on a
   command line.
4. **The seat cannot read the item through its own tools.** `security` is not on the jail's bash
   allowlist (ADR 588 §4), and a test now pins that.

## Consequences

- A key in the Keychain survives reboots. The host reads it per wake, so adding or rotating it
  needs no restart. A key in the environment still needs a kickstart, as before.
- No other program picks the key up by accident, since only `musterd host` asks for
  `musterd:<VAR>`. This is not isolation from someone who shares the macOS login. That person can
  run the same `security` command, and they could already read a same-user process's environment
  with `ps eww`. Separate macOS logins remain the boundary, and the wiki says so.
- Code a worker seat writes and runs under `pnpm test` executes as the host user (the residual
  ADR 588 §4 names) and could call `security` itself. This is the same exposure as before, not a
  new one: the scrubbed environment never protected the key from a process that can read the
  parent's environment. The OS sandbox lane under the security goal is still the answer.
- The `musterd:` prefix keeps these items apart from any other app's items in the login Keychain.
- No new dependency. `security` ships with macOS, and on other platforms the lookup returns null and
  the variable is the only source, as before.

## Observability & Evaluation

- **Traces:** none added. The existing `residency.wake_deferred` row names the Keychain item in its
  reason, so an outage like 2026-10-15's says where the key was expected.
- **Eval:** `native.test.ts` covers three cases: the fallback is read when the variable is unset, it
  is never read when the variable is set, and a miss defers naming both sources. `jail.test.ts` pins
  `security` as refused.
- **Experiment:** the pilot (lane `01M4VTAEJZ`) is the live check. Once mason's key is moved to
  `musterd:<VAR>`, a reboot during the window should leave no `wake_deferred` row naming the key.
