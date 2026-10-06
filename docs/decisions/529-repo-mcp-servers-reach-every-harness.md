# 529 — The repo's MCP servers reach every harness

- Status: accepted
- Date: 2026-10-05
- Deciders: the human at Air 2 (asked whether every musterd member can use the whiteboard MCP, then "yes" to making it so), lazara (lane `01M47C1WY65MVWWQYZWR9GM6HG`)
- Relates to: ADR 527 (one whiteboard MCP), ADR 026/027 (toolkit provisioning, additive and reversible), ADR 030/281 (the provisioning manifest), ADR 408 (self-heal at session start and before a wake)

## Context

ADR 527 put the brainstorm whiteboard and Squig's tools behind one server, declared in the
repo's `.mcp.json`. Claude Code reads that file natively. Codex, Cursor, OpenCode and Grok each
read only their own project config: `.codex/config.toml`, `.cursor/mcp.json`,
`.opencode/opencode.json` and `.grok/config.toml`.

On 2026-10-05, neither gptbot's Codex config nor dreamy's OpenCode config carried the whiteboard.
Half the team could not reach a server the repo declares for everyone.

Every adapter already has `provision(plan)`, the ADR 026 path that registers a toolkit's MCP
servers additively and by name. It runs only at `musterd init`, only for a chosen toolkit, and
only in the process's own working directory.

## Problem

A server declared once in the repo should reach every seat, whatever its harness. That has to
hold without re-running init, without touching musterd's own seat-specific entry or the user's
other servers, and with a way back out.

## Decision

1. **Mirror the repo's `.mcp.json` into the other harnesses.** `mirrorRepoServers(cwd)` reads
   `.mcp.json` and provisions every server except `musterd` into each harness in the folder's
   provisioning `desired` set, except Claude Code, which reads the file itself. It goes through
   that adapter's own `provision`, so it is additive and by name.
   - `musterd` is excluded because init wires it per seat.
   - A relative argument that names a file in the folder is made absolute, so the entry does
     not depend on the cwd a harness starts its servers from.
   - Environment values pass through unchanged.
2. **It runs where every harness's session begins:**
   - `musterd <seat>` (`launchSeat`), before the harness starts;
   - the host's pre-wake step (`host/loop.ts`), awaited before the spawn;
   - the SessionStart probe (`musterd init --check-build`), for a Claude Code folder that is
     also provisioned for another harness.

   Each run is best-effort and never blocks a launch or a wake.
3. **It is idempotent and reversible.**
   - `.musterd/repo-servers.json` holds a hash of the servers and the harness set, so an
     unchanged repo writes nothing.
   - A server removed from `.mcp.json` is unprovisioned on the next run.
   - What was added is recorded in the manifest as `repo-server <harness> <name>` under
     `repo-servers`. `musterd uninstall` unwinds it exactly as it unwinds a toolkit's
     `role-tools`.
   - A folder with no other harness, and nothing mirrored before, is left untouched.
4. **`Harness.provision` and `unprovision` take an explicit `cwd`.** It defaults to the process's
   own, as before. The launcher and the host run outside the seat's folder.

## Alternatives rejected

- **Add the whiteboard to every toolkit.** Most folders have no toolkit, a toolkit is chosen
  once at init, and a server the repo declares would be declared twice.
- **Make each harness read `.mcp.json`.** They do not, and musterd does not own their config
  formats.
- **A protocol field for repo servers in the drift report.** The self-heal report body
  (`WorkspaceRepairBody`) is a wire type, and widening it is ADR-gated for a count nobody acts
  on. The mirror prints its own one line when it changes something.

## Consequences

- A Codex, Cursor, OpenCode or Grok seat gets the whiteboard on its next launch, wake or Claude
  Code session start in that folder, once its checkout has a built whiteboard.
- Each harness still has to load the new config, and the mirror's line says so. An already
  running session keeps the config it started with.
- The whiteboard's linked board path (`team=docs/wireframes/team.squig.json`) is still resolved
  against the server's cwd. Every harness starts seats in the workspace folder, so this holds
  in practice. An env value is not rewritten, because the mirror cannot know which values are
  paths.
- A future server added to `.mcp.json` reaches every harness the same way. Nothing in this ADR
  is whiteboard-specific.

## Observability & Evaluation

- **Traces:** the launcher prints the mirror's line on stderr, the host logs `wake mirror:
  <seat> — …`, and the SessionStart probe prints it to the session.
- **Eval:** `repoServers.test.ts` runs through the real OpenCode and Codex adapters into real
  files:
  - the server is added beside musterd's entry, with an absolute path;
  - an unchanged repo writes nothing;
  - a dropped server is removed while the user's own entry stays;
  - a Claude-only folder is untouched;
  - the manifest records the change and then forgets it.

  The CLI suite around it (probe, launcher, host loop, uninstall, adapters) stays green.
- **Experiment:** within a day of landing, gptbot's `.codex/config.toml` and dreamy's
  `.opencode/opencode.json` should carry a `whiteboard` entry after their next launch or wake.
  If either still lacks it, one of the call sites is not reached for that harness.
