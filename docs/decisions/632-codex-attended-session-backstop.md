# 632 — Codex attendance follows live process evidence

- Status: accepted
- Date: 2026-10-16
- Lane: `01M52Z4QWHWHVFW2B53X6G7EA2`
- Decider: nick, in chat, approving the Codex idle-session follow-up
- Extends: ADR 444 host backstop; leaves ADR 609 lease-window policy unchanged

## Context

On 2026-10-15 at 22:40 PDT, big-body's dream took the seat after its MCP adapter's
60-minute transcript-staleness release. The host's ten-minute transcript guard
allowed the wake. The attended-process backstop knew only Claude Code, so an
open idle Codex chat supplied no attendance evidence (investigation lane
`01M52YNSD4YTK9RGYM3JWXXAZ8`).

The local Codex app server (0.163.0, checked 2026-10-16) holds this chat's rollout
file open. Its metadata has `source: vscode` and the exact workspace `cwd`.
Completed subagent rollouts are also held open, but carry an object-valued
`source`; they must not count. A running app-server process alone says nothing
about which workspace is attended. Historical rollouts on disk say nothing about
whether a session is still loaded.

## Problem

An open quiet chat and a closed chat have equally old transcript timestamps.
Keeping every old capture live forever would defeat dreaming and orphan cleanup.
The backstop needs process-held interactive session evidence rather than old file
timestamps alone.

## Decision

For Codex, the existing host attended-process check reads open file names from
Codex processes, using `lsof` on macOS and `/proc/<pid>/fd` on Linux. Only open
`rollout-*.jsonl` files qualify for metadata inspection. A bounded 64 KiB prefix
supplies the first complete JSON line; only that line is parsed. No conversation
body is parsed or logged.

The local-only protocol boundary `parseCodexAttendedMeta` accepts a `session_meta`
record with a nonempty session id, cwd and exactly `source: cli` or `vscode`.
Headless `exec`, subagent objects, missing/unknown sources and malformed headers
are excluded. Attribution uses the recorded cwd, with canonical path/subdirectory
matching, never the rollout filename or the app-server process cwd.

A matching process defers the wake through the existing `attended-session-open`
outcome. A process with no held interactive rollout supplies no protection.
When process enumeration is unavailable the result remains unknown; the current
host policy does not defer on unknown, and this change does not reverse it.
Claude Code's existing process/cwd check and the server's claim rules are unchanged.
No wire schema or new runtime dependency is introduced.

## Consequences

An idle loaded Codex session can retain its seat without renewing transcript
activity. Unrelated desktop chats and completed headless/subagent runs do not
hold this workspace. Closing/unloading a session removes protection when its
process releases the rollout; app-server retention can conservatively delay that
release. This is evidence of a loaded interactive session, not proof that a human
is watching the window. Vendor changes to source values or file handling can make
the check unknown or absent; the falsifier below names that limit.

A native Codex TUI can delegate transcript ownership to a shared app server. A
Codex process with a controlling terminal and matching cwd also counts, unless its
command line contains a known headless command (`exec`/`e`, `app-server`,
`mcp-server`, `exec-server`, `review`). The exclusion is conservative: a prompt
containing one of those command words can miss this fallback, but cannot grant
attendance to a headless run. Desktop transcript evidence remains independent of
that fallback. The actual local `codex resume` process had a tty and this cwd but
held no rollout; the regression test deliberately supplies an empty held-file list.
No Codex database, setting, hook or vendor app file is written by this check.

## Observability & Evaluation

**Traces:** existing host log `wake deferred` and `residency.wake_deferred` with
reason `attended-session-open`, including the holding process pid in the local
log. No transcript text or session id is added to the daemon record.

**Eval:** tests cover interactive CLI/desktop, old timestamps, another workspace,
released file lists, headless and subagent metadata, missing/unreadable and bounded
headers; existing host tests prove an attended result prevents backend actuation.
A read-only local probe must identify this workspace from the real app server.

**Experiment:** n/a — regression and local evidence check, not a comparative trial.

**Falsifier:** an idle loaded interactive Codex thread whose process holds its
valid rollout is missed; or a closed/unloaded thread whose rollout has been released
continues to defer a wake. The latter would show this backstop is retaining stale
state rather than reading the process on each wake.
