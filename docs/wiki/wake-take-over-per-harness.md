# Wake take-over and watch, per harness

What each harness records for a wake, and so what `musterd <seat>` can take over or watch today (survey for lane 01M4ECEXGTWA8FVF0VXHS8WSMS, ADR 546).

## What take-over and watch need

Take over needs the wake's **lease file** (`.musterd/wake-lease.json`) carrying a `session_id`, so the launcher can find the wake and resume its conversation. Watch needs the wake's **transcript**, found from that same id. A harness that writes no lease file is not found as a wake at all: `musterd <seat>` asks the plain "open a second session?" question (ADR 543) and a second session replaces the wake.

## The survey

Observed 2026-10-08 from `packages/cli/src/host/backends/*`, `trace/transcript.ts`, `trace/opencode.ts`, `trace/tail.ts`. Falsify any cell by reading the named file.

| Harness | Host wake backend | Lease file written | `session_id` in it | Transcript, local | Existing parser |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claudeCode.ts` | yes | yes (ADR 546, #2201) | `~/.claude/projects/<slug>/<id>.jsonl` | `parseClaudeTranscript` |
| Codex | `codex.ts` | yes (ADR 354) | **no** — the backend learns its thread id from stdout after the write | under `~/.codex/sessions` | `parseCodexTranscript` |
| Grok | `grok.ts` | **no** | n/a | `$GROK_HOME/sessions/<encoded cwd>/<id>/updates.jsonl` (default `~/.grok`) | `parseGrokTranscript` |
| opencode | `opencode.ts` | **no** | n/a | a SQLite store, `$XDG_DATA_HOME/opencode/opencode.db`, read with the `sqlite3` CLI | `parseOpencodeRows` |
| Cursor Agent | **none** — no host backend exists, so no headless wake exists to take over | n/a | n/a | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (desktop); `<id>.txt` for the `cursor-agent` CLI | `parseCursorTranscript` (jsonl only) |
| musterd native (`musterd`) | `native.ts` | **no** | n/a | none on disk — each turn posts a `wake-turn` row (usage + transcript, bounded) to the daemon | none |


## What this means

- **Watch for Codex is two small steps away**: record the thread id in the lease file, then read its transcript. Until then Codex take-over also falls back to the plain question, because the lease has no `session_id` (falsify: a Codex wake's `wake-lease.json` contains `session_id`).
- **Grok, opencode and native wakes are invisible to the launcher.** Their backends write no lease file (2026-10-08; falsify: `grep writeWakeLease packages/cli/src/host/backends/{grok,opencode,native}.ts` finds a call). Taking one over today replaces it (ADR 092). <!-- claim: defect -->
- **The yield marker's fast path needs a PreToolUse hook.** `musterd gate` is what turns the marker into a deny, and Codex has no gate hook (see [driver support matrix](driver-support-matrix.md)). On Codex the 10 s hard stop is the only stop (2026-10-08; falsify: Codex's `.codex/hooks.json` carries a PreToolUse entry that runs `musterd gate`). <!-- claim: defect -->
- **The existing transcript parsers do not carry tool calls.** They emit `assistant_text`, `reasoning` and `usage` records; tool calls travel on a separate rail (R1, from hooks, to the daemon). Watch shows `▸ Bash  ls` lines, so each harness needs a tool-call projection beside the parser, or watch shows words only (2026-10-08; falsify: a `parse*Transcript` output contains a record that names a tool call). <!-- claim: defect -->

## The seam

Landed 2026-10-08 (lane 2/6). One `WatchReader` per harness, in `packages/cli/src/launcher/watch/`: *find the transcript from the lease's `session_id`*, *project it into `WatchEvent`s*, *say whether it ended cleanly*. `watch/index.ts` asks the registry (`readers.ts`), not Claude Code. The rules about what watch may show live in one place, `events.ts`: a reader can only make an event through `textEvent` / `toolEvent`, which keep words and tool calls only (the constructors take no result field), run every line through `scrubCredentials`, and strip control characters.

The registry lives beside the readers, not on the onboarding harness adapters as the lane first said: those hold install-time config, and importing launcher code into them would point the dependency the wrong way.
