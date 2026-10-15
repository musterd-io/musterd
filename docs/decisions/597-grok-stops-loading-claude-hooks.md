# 597 — Grok stops loading Claude hooks

- Status: accepted
- Date: 2026-10-14
- Builds on: [ADR 352](352-grok-first-class-harness.md) (Cursor hook compat off), [ADR 370](370-grok-interrupt-injection.md) (native interrupt is PreToolUse + Stop)
- Lane: `01M4YE8CGD00JF7FZ46RVK0T7V`

## Context

ADR 352 turns `[compat.cursor] hooks` off so Grok does not also run `.cursor/hooks.json`. It leaves Claude compatibility at Grok's default, which scans `.claude/settings.json` and `.claude/settings.local.json`.

ADR 370 moved the Grok interrupt off PostToolUse. Measured on Grok 1.0.13, that event's stdout never reached the model. The native hook is PreToolUse `additionalContext`, plus one Stop block.

Grok 1.0.52 (2026-10-14) delivers PostToolUse stdout to the model. Claude's project hook still runs `musterd inbox --interrupt-check --hook claude-code` with stdout kept. Grok loads that file beside `.grok/hooks/musterd.json`.

## Problem

On lazara's Grok session `01a13687` (2026-10-14) the same interrupt line arrived twice per tool call: once from `project/musterd:pre_tool_use[0]` and once from `project/settings.local:post_tool_use[1]`. The session recorded 210 of those injections. The Claude copy is also probed as harness `claude-code`, so a Grok seat's interrupt rows are attributed to Claude.

The native PreToolUse hook is doing its job. The second copy is the inherited Claude file. Silencing one script, or rewriting the Stop hook, leaves the other seam in place.

## Decision

`musterd init` and `musterd init --refresh-hooks` write `[compat.claude] hooks = false` into the project `.grok/config.toml`, beside the existing Cursor switch.

Leave Claude's other compat cells alone (`mcps`, `skills`, `rules`, `agents`). Do not edit `.claude/settings.local.json`: Claude Code still needs that interrupt hook's stdout. Do not move the native Grok interrupt back onto PostToolUse. An existing `[compat.claude]` table gets `hooks = false` inside it. Unprovision still leaves the key, same as Cursor: deleting it would turn the scan back on.

## Consequences

- A Grok session that has been refreshed loads `.grok/hooks/musterd.json` and does not load Claude's hook files. The interrupt line is injected once, from PreToolUse.
- Claude Code sessions are unchanged.
- Grok stops running the Claude-only trace and `record-subagent` hooks that were arriving through this scan. Those were not part of the Grok hook set.
- A session that is already open keeps the hooks it loaded at start. The switch applies on the next Grok start.
- ADR 352's cursor bullet gains a dated pointer here. ADR 370's wiring stays.

## Observability & Evaluation

- **Traces:** `inbox.interrupt_check` rows for a Grok seat after refresh should carry `hook: grok` from the native probe. A row with `hook: claude-code` from a Grok session means the Claude file still ran.
- **Eval:** `packages/cli/src/onboard/harnesses/grok.test.ts` and `grokFragments.test.ts` assert `[compat.claude] hooks = false`, including inside a table that already exists.
- **Experiment / falsifier:** a Grok 1.0.52 session started after this switch whose `updates.jsonl` still names `project/settings.local:post_tool_use` for the interrupt hook. One such run falsifies the switch.
