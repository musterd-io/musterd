# 495 — A Codex seat wakes with no hand edits: the wake trusts its own folder, and the musterd entry approves its own tools

- Status: proposed
- Date: 2026-10-02
- Deciders: izzo (nick asked for the lane to be built on 2026-10-02)
- Lane: `01M3WARASAVVPAKMES5S7ZRQ9N` (goal `seat-continuity`)
- Relates to: ADR 031 (Codex config is project-local; musterd never writes `~/.codex/config.toml`),
  ADR 286 (the launch marker), ADR 359 (the wake bypasses Codex hook trust), ADR 491 (`musterd agent`
  wires through reconcile)

## Context

On 2026-10-01 izzo created lazara with `musterd agent lazara --harness codex` for the demo. Its first
wake failed: headless `codex exec` had no musterd tools, fell back to the CLI, and the daemon refused
the claim with "no roster Presence attesting this wake lease". gptbot's log shows the same failure
twice since 2026-09-22. izzo repaired lazara and gptbot by hand. Three things were missing:

1. **The launch marker.** `.codex/config.toml` had `command` and `args` but no
   `MUSTERD_LAUNCH_SURFACE`, so the adapter threw at start (ADR 286). #1945 fixed this the same
   afternoon: `musterd agent` now wires through the reconcile engine, whose Codex fragment carries the
   marker (ADR 491).
2. **Folder trust.** Codex loads a project's `.codex/config.toml` only when the project is trusted,
   and it grants trust at an interactive prompt. A wake spawns `codex exec` with no TTY, so the
   prompt never shows. The hand repair added `[projects."<dir>"] trust_level = "trusted"` to
   `~/.codex/config.toml`, which ADR 031 says musterd never writes.
3. **Tool approval.** A headless `codex exec` refuses a tool call that would ask for approval. The
   hand repair added fifteen `[mcp_servers.musterd.tools.<tool>] approval_mode = "approve"` tables, one
   per tool, so any tool added later still prompts.

Measured on codex-cli 0.159.3 (2026-10-02, a throwaway git folder whose `.codex/config.toml` defines
one server, read back with `codex mcp list` / `codex mcp get`):

- Untrusted, the project's server is absent. `-c 'projects."<dir>".trust_level="trusted"'` (dotted
  key) leaves it absent. `-c 'projects={"<dir>"={trust_level="trusted"}}'` (an inline table) makes it
  present for that invocation. Trusting the folder through a scratch `CODEX_HOME` agrees.
- `[mcp_servers.<name>] default_tools_approval_mode` is a real key: `"bogus"` fails config load, and
  `"approve"`, `"prompt"` and `"auto"` load. An unknown key in the same table is ignored.
- `-c 'mcp_servers.musterd.default_tools_approval_mode="approve"'` on a folder whose config has no
  musterd server fails config load ("invalid transport in `mcp_servers.musterd`").

## Problem

After #1945, a fresh Codex seat still cannot wake without someone editing two files by hand. The
seat's own MCP entry is invisible to the wake until a human trusts the folder, and once it is
visible, every musterd tool call is refused for lack of an approval nobody can give.

## Decision

1. **The wake trusts its own workspace, for that run only.** `buildCodexFreshArgs` and
   `buildCodexResumeArgs` (`packages/cli/src/host/backends/codex.ts`) both pass
   `-c projects={"<workspace>"={trust_level="trusted"}}`, the inline-table form, since Codex ignores
   the dotted one. Nothing is written to `~/.codex/config.toml`, so ADR 031 stands. This follows ADR
   359's argument: musterd wrote the config being trusted, and the prompt being skipped is one a
   headless wake could never show.
2. **The musterd entry approves its own tools.** The managed `[mcp_servers.musterd]` fragment
   (`codexAdapter.desiredFragments`) gains `default_tools_approval_mode = "approve"`. One server-level
   key covers every tool the adapter has now and adds later. It lives in the fragment, not on the
   spawn line, because a spawn-time override for a server the folder does not define stops Codex
   from loading at all, and would turn an unwired folder's degraded wake into a crash.
3. **No approval or sandbox bypass flag on the wake.** The wake still never passes
   `--dangerously-bypass-approvals-and-sandbox` or any sandbox override. Only the musterd entry's own
   tools are approved, and only by its own table.

The TOML helper (`codexToml.ts`) learns the one key: it writes it, reads it back, and validates it
against the three values Codex accepts. It still leaves `[mcp_servers.musterd.tools.*]` subtables
alone, so the hand repairs on lazara and gptbot survive a rewrite.

## Consequences

- A fresh `musterd agent X --harness codex` plus `musterd residency on` should wake and attest with
  no hand edits. That is the lane's done-when, and it is checked live, not only in tests (below).
- **Existing seats pick up the approval key on their next reconcile.** An entry musterd owns that
  is unchanged since it was written observes as a different fingerprint from the new intent. The
  engine's owned-exact path then updates it in place (`classifyFragment`, `owned-exact` → `create`). An
  entry someone edited by hand is `owned-drifted` and is left alone, as before. lazara and gptbot
  already work through their hand repairs.
- Trust admits the whole project config for the wake: the musterd entry, the hooks, and any setting
  the seat's owner added. That is the same trust lazara and gptbot have had since 2026-10-01 by hand.
  It is narrower than that, because it lasts only for the wake's own process.
- An interactive Codex session that a human opens in the folder still shows Codex's own trust
  prompt. The human can answer it, and the human-facing activation text ("it must be a trusted
  project") stays true.
- The Codex keys and the inline-table behavior were measured on 0.159.3 only. An older Codex that
  lacks `default_tools_approval_mode` ignores it, since unknown keys in the table are ignored.

## Observability & Evaluation

**Traces.** No new trace event. The existing wake records answer it: `~/.musterd/host.log`
(`run for <seat> settled:` versus `wake FAILED`), the seat's `residency.wake_cost` rows, and its
roster Presence attesting the wake lease.

**Eval.** Dataset: Codex wakes in `host.log`, plus one fresh seat created after this lands with
`musterd agent <name> --harness codex` and `residency on`, with no hand edit to either Codex config.
Baseline: lazara on 2026-10-01 (first wake failed with "no roster Presence attesting this wake
lease") and gptbot (the same failure twice since 2026-09-22), both working only after hand repair.
Target: the fresh seat's first wake settles with a Presence attesting its lease and at least one
`team_*` tool call.

**Experiment.** n/a. A wake either attests or it does not; there is no rate to compare.

Falsifier: a Codex seat provisioned and enrolled as above, with no hand edit, whose wake ends in "no
roster Presence attesting this wake lease" or calls no `team_*` tool.
