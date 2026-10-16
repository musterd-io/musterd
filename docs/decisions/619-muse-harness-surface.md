# 619 — Muse Code is a musterd harness surface

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50ZJ7B3SS6EPJHDVMZFDVP6`
- Sources: dev.meta.ai muse-code docs + binary `muse` 1.4.9, measured on the dogfood machine 2026-10-15 (no Meta credentials; every claim below that needs auth is marked as such)

## Context

Muse Code is Meta's terminal coding agent (beta, `muse` native binary via
`curl -fsSL https://dev.meta.ai/install.sh | bash`). musterd speaks five CLI harnesses; Muse is
the sixth the team asked for, and the audit lane (`01M50ZJ9WD`) will hold every harness to the
same E2E shape. The integration-relevant surface, verified against docs and the installed binary:

- headless: `muse exec [--prompt-file] [--json] [--max-model-steps] [--session-id] [--allow-workspace-switch]`, approval posture `--disable-approval` / `--yolo` / `--approval-mode`, `--model`, `--reasoning-effort`, `--trust-workspace`; resume is `exec --session-id` (`muse resume` is interactive-only); `muse export --session` audits a run;
- settings: `~/.config/muse/settings.json` (`schema_version: 1` mandatory), `mcp_servers` block (stdio `command/args/env` or streamable_http, `enabled`, `mode: required|optional`, `${VAR}` interpolation, `MUSE_SESSION_ID` passed to stdio children);
- hooks: `<project>/.muse/hooks.json`, Claude-style nesting `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "..."}]}]}}` — measured, not documented (a wrong guess fails startup validation with a named warning, which is how the shape was found);
- instructions: `AGENTS.md` (nearest-wins walk), skills under `.agents/skills` (shared with musterd's own), memory under `.agents/memory`.

## Problem

No musterd surface names Muse: no bin resolve, no onboard adapter, no wake backend, no session
enumeration, no prices. A seat cannot stand on Muse at all.

## Decision

1. `SURFACES` gains `'muse'` (protocol, this ADR — the only closed-enum change; `HarnessId` is an open string and needs none).
2. Onboarding writes the two machine files Muse actually reads: the musterd MCP stdio entry into `mcp_servers` (with `MUSE_SESSION_ID`-style env passthrough noted, `mode: required`), _(Amended 2026-10-16: the entry is `optional` — `required` wedged every non-musterd repo on the machine. See Consequences.)_ and SessionStart + Stop hooks into `.muse/hooks.json` in the measured nesting. Trust follows Muse's own rule: user settings need none, project hooks need `--trust-workspace` (which wakes pass).
3. The env channel (`MUSTERD_WAKE_LEASE`/`MUSTERD_PROVENANCE` on the spawn) does NOT reach Muse's MCP stdio children — measured: only `MUSE_SESSION_ID` arrives. So the ADR 354 lease file is the primary attestation for Muse (as for Codex), with `${MUSTERD_WAKE_LEASE}` interpolation in the server entry as a secondary to verify live.
4. `--provider echo` runs with no credentials and is the offline E2E vehicle for spawn/verify/settle mechanics (measured: exit 0, JSONL session streams, `--session-id` resume, `export --session`). Model behavior, usage metering shape, and `${VAR}` interpolation still need a credentialed run — the lane 3 human gate.

## Consequences

- A `muse` seat attests `surface: muse`; enumeration, wake and provisioning speak the name.
- The hooks.json nesting is pinned by a test against the measured shape, not by docs (which show none) — if Meta changes it, startup validation names the breakage and the test is the tripwire.
- The SitePoint install path (`npm install -g @meta-ai/muse-code`, `~/.muse-code/config.json`) is wrong — that package 404s and no such config exists on 1.4.9. Nothing in this lane trusts unverified third-party docs; the ADR cites only dev.meta.ai and the binary.
- _(Amended 2026-10-16, on izzo's send-back of #2697: `mode: required` in the machine-global settings.json aborts EVERY muse run whose musterd MCP child exits — including repos that are not musterd workspaces, where no binding exists by construction. Reproduced on 1.4.9: required + failing server refuses the run; optional warns and proceeds. The entry is now `mode: 'optional'`; a wake that needs the channel fails honestly at verify (lease unattested) instead. Two further measurements from the same session: the binary reads both `mcp_servers` and `mcpServers` but canonicalizes to camelCase on write (stripping `enabled`/`mode` it does not persist) — so onboarding writes camelCase and migrates only its own snake_case entry.)_

## Observability & Evaluation

- **Eval:** onboard writes the MCP entry + hooks on a real checkout; `muse --version` resolves; a `--provider echo` wake spawns, writes the lease file, verifies occupy, and settles (lane 2). Credentialed behaviors (usage shape, interpolation) are lane 3's human gate.
- **Traces:** existing onboard ledger + wake audit rows; no new emission points.
- **Experiment:** n/a.
