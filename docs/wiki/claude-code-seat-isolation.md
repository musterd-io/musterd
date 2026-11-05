# Claude Code seat isolation

What each Claude Code launch flag and local setting shuts out of a seat session, measured with
Claude Code on this laptop for the ADR 794 seat tool allowlist (plan Task 5, lane
`01M6HHSVAC3RRQ5AHBCDK0WQNV`).

## How to measure: read the init record, not the model (2026-11-03; falsify: a `claude -p` whose model-listed MCP servers match its init record's `mcp_servers` when a plugin server is connected) <!-- claim: other -->

Asking the session to list its own tools is unreliable. With `chrome-devtools-mcp` enabled, a
`claude -p` session's answer left out the plugin's server, while the session's init record listed
it as `connected`. Read the init record instead:

    echo "say ok" | claude -p --setting-sources project,local --max-turns 1 \
      --output-format stream-json --verbose | grep -m1 '"subtype":"init"'

Its `mcp_servers` (name and status), `plugins` and `skills` fields are what the session actually
loaded.

## A plugin enabled in local settings loads with the user layer excluded (2026-11-03; falsify: the init record of `claude -p --setting-sources project,local` in a folder whose `.claude/settings.local.json` has `enabledPlugins: {"figma@claude-plugins-official": true}` lists no `figma:` skill) <!-- claim: other -->

`--setting-sources project,local` excludes `~/.claude/settings.json`, so none of the human's
enabled plugins load. A plugin set `true` in the seat's own `settings.local.json` still loads from
the user-level plugin cache. That is how a declared plugin reaches a seat without touching the
human's config.

## `--setting-sources project,local` excludes personal and synced skills (2026-11-03; falsify: the same session's skill list containing a name from `~/.claude/skills/`, such as `impeccable`, or an `anthropic-skills:` entry) <!-- claim: other -->

With the user layer excluded, no skill from `~/.claude/skills/` loaded, and neither did the
claude.ai-synced skills under `~/.claude/skills/synced/`. Only the built-in skills and those of the
locally enabled plugin were listed. A bare `claude` (no flag) in the folder still loads them; the
folder-side complement has to deny them by name for that path.

## `--strict-mcp-config` drops claude.ai connectors and plugin MCP servers (2026-11-03; falsify: an init record under `--strict-mcp-config --mcp-config <empty file>` whose `mcp_servers` is non-empty) <!-- claim: other -->

Without the flag, the session connected 8 claude.ai connectors and
`plugin:chrome-devtools-mcp:chrome-devtools`. With `--strict-mcp-config --mcp-config` pointing at
`{"mcpServers":{}}`, `mcp_servers` was empty, the plugin's own server included, while the plugin
itself still loaded. So the strict config file musterd writes has to carry:

- the musterd server (its usual entry is local-scope in `~/.claude.json`, which strict mode skips);
- the repo's committed `.mcp.json` servers;
- the MCP servers of each declared plugin.

## A `permissions.deny` entry removes every tool of a connector (2026-11-03; falsify: an init record of a session with `"deny": ["mcp__claude_ai_Gmail"]` whose `tools` contain an `mcp__claude_ai_Gmail__` name) <!-- claim: other -->

With `mcp__claude_ai_Gmail` and `mcp__claude_ai_Supabase` in the local deny list and no launch
flag, the init record listed **0** tools for either, while `mcp__claude_ai_Slack` kept its 20. The
two servers still showed `connected`: the deny removes the tools, not the connection. This works on
every start path, bare `claude` included, so it is how a seat closes off connectors and user MCP
servers. musterd does not use `--strict-mcp-config` for seats (ADR 794, amended 2026-11-03): it
would also drop each plugin's own MCP servers and the musterd server, which a seat needs.

## `--setting-sources` is wake-only, because musterd's orient hooks live in the user layer (2026-11-03; falsify: `globalHooksPayload` in `harnesses/claudeCode.ts` no longer writing SessionStart and UserPromptSubmit to `~/.claude/settings.json`) <!-- claim: other -->

musterd's SessionStart (orientation, self-heal, the seat-tools narrowing) and UserPromptSubmit
(orient nudge) hooks are written to the human's `~/.claude/settings.json`. `--setting-sources
project,local` excludes that file, so adding it to `musterd <member>` would lose them. An
interactive seat is therefore closed off by its folder settings alone: `enabledPlugins: false`
keeps an undeclared plugin from loading at all, and `Skill(...)` / `mcp__...` denies block the
rest. A personal skill stays in the listing there (its invocation is denied); on a wake it is not
loaded.

## Where the human's layer is listed on disk (2026-11-03; falsify: the paths below missing on a machine that has synced plugins or connectors) <!-- claim: other -->

- Enabled plugins: `~/.claude/settings.json`, `enabledPlugins` entries set `true`.
- claude.ai-synced plugins: one directory per plugin under `~/.claude/plugins/synced/<bucket>/`.
  A `~g2` suffix on the directory name is not part of the plugin id: `langfuse~g2` is
  `langfuse@synced`.
- Personal skills: directory names under `~/.claude/skills/`, invoked by that name. Synced skills
  are directories under `~/.claude/skills/synced/<bucket>/`, invoked as `anthropic-skills:<name>`.
- claude.ai connectors: `claudeAiMcpEverConnected` in `~/.claude.json`, as display names
  (`claude.ai Gmail`). The tool prefix replaces spaces and dots with `_`: `mcp__claude_ai_Gmail`.
  The list holds every connector ever connected, not only the current ones; denying an extra one
  costs nothing.
- User MCP servers: the top-level `mcpServers` in `~/.claude.json` (empty on this laptop).

On 2026-11-04, [Anthropic's Claude Code security mod documentation](https://github.com/anthropics/claude-code/blob/main/mods/sec-default/README.md) describes tool names as replacing every character outside ASCII letters, digits, hyphens and underscores with an underscore. The seat complement applies this to user server and connector names; grants use the resulting prefix, and distinct observed names that become the same prefix are denied together. Falsify by observing a Claude Code tool name whose prefix differs for such a character.

## Other harnesses (2026-11-05)

Same question as Task 5, for the five harnesses in plan Task 12 (lane `01M6HHSXBTG02XH81DGMRZS8NX`). One strength per kind. `excluded` means the harness does not load it. `denied` means it can load and a rule blocks invocation. `open` means this seat folder writes nothing for that kind. Counts below are type counts from the probe, not an inventory. No secret, command, or argument is recorded.

### Codex 0.166.0: a trusted project file can disable an MCP server (2026-11-05; falsify: `codex mcp list --json` in a trusted project whose `.codex/config.toml` sets that server `enabled = false` still reports it enabled) <!-- claim: other -->

From `/private/tmp/seat-tools-spike/codex-proj`, a project file containing only `[mcp_servers.node_repl]` / `enabled = false`, plus `-c 'projects={"/private/tmp/seat-tools-spike/codex-proj"={trust_level="trusted"}}'`, changed `node_repl` from enabled to disabled. The same file without the trust override left it enabled. Codex loads project config only for a trusted project. Wakes already pass that inline trust table. `CODEX_HOME` was not used: a throwaway `CODEX_HOME` reported "Not logged in", so it is not a way to isolate a seat. The user `~/.codex/config.toml` was not written.

Plugins and skills stay open. `codex debug prompt-input` did not show a project plugin `enabled = false`, and did not show a project `skills.config` entry set `enabled = false`. `codex plugin list` is marketplace availability; a `--json` run produced no stdout. App connectors were not probed.

### Grok 1.0.70: project disables do not take those three layers off the inspect list (2026-11-05; falsify: a trusted `grok inspect` whose hooks list omits a plugin named in project `plugins.disabled`, or whose skill list drops a skill named in `skills.disabled`, or whose MCP list drops a server whose project table sets `enabled = false`) <!-- claim: other -->

`grok` 1.0.70 (`f50904eaee6c`). Project `.grok/config.toml` is parsed even when the folder is untrusted. Trust was toggled for one probe and `~/.grok/trusted_folders.toml` was restored afterward. `~/.grok/config.toml` was not written.

`plugins.disabled` removed that plugin's skills from `grok inspect` and left the plugin row enabled, including its hook once the folder was trusted. `[mcp_servers.<name>] enabled = false`, without restating the server's command, left a config-toml server and an mcpJson server in the list. `[skills].disabled` plus a `permission.deny` of `Skill(...)` left the skills in the list; each rule was skipped as an unknown tool prefix. All three kinds are open. A full server restatement and a `GROK_HOME` inspect were not run. Hook execution was not run; the hooks list is the instrument.

### Cursor 2026.10.22: `mcp disable` writes a per-project denylist under the home directory (2026-11-05; falsify: `cursor-agent mcp disable <name>` in a folder leaves that name out of `~/.cursor/projects/<slug>/mcp-disabled.json`) <!-- claim: other -->

`cursor-agent mcp disable spike-not-a-server` in an empty temp folder printed that the server will no longer be loaded, and wrote `~/.cursor/projects/private-tmp-seat-tools-spike-cursor-empty/mcp-disabled.json` as a one-element array. The slug is the absolute path with the leading slash removed and each slash replaced by a hyphen. `~/.cursor/mcp.json` did not change. The probe directory was removed afterward. `cursor-agent plugin` is marketplace only, and the help that was read has no skill command, so plugins and skills are open. The denylist is the MCP close. It is not `~/.cursor/mcp.json`, which musterd still does not write.

### OpenCode 2.2.5: project `permission` denies merge into the build agent (2026-11-05; falsify: `opencode debug agents` for `build` lacks the skill, plugin, or mcp deny when the project `permission` object sets it) <!-- claim: other -->

`permission.skill`, `permission.plugin`, and `permission.mcp` in the project `.opencode/opencode.json` were the only difference in `opencode debug agents` for the build agent, including a `"*"` resource and a named resource. That is a deny on the effective permission list, not a live tool call. A `policies` array with `skill.use` / `plugin.use` / `mcp.use` did not change that document. A project `mcp.servers` entry that was only `{enabled: false}` was dropped, and `opencode mcp list` printed no servers either way, so it is not the instrument. The global file is inspected and not written. All three kinds are denied. Floor skills go in `permission.skill`, not in Claude `Skill()` strings.

### Muse 1.4.14: a project skill disable writes the machine-global settings file (2026-11-05; falsify: `muse skills disable <id> --scope project` leaves `~/.config/muse/settings.json` unchanged, or resolves a user skill id to `off` for that project only) <!-- claim: other -->

`muse skills disable spike-skill --scope project` returned `activation: off` and wrote `skills.activation.projects` in `~/.config/muse/settings.json`. The settings file was restored. A later probe under `XDG_CONFIG_HOME` returned `unknown-skill` for a user skill id and for a user skill path, and the real settings file did not change. Project scope only resolved a skill that lived in the workspace. `muse plugins disable` has no `--scope`, and `muse plugins list --json` was an empty object. MCP stays open because Muse reads one machine-global MCP file. Plugins and skills are open. musterd does not call `muse skills disable` and does not edit `skills.activation`.
