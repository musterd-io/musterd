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

## A `permissions.deny` entry hides a connector's tools (2026-11-03; falsify: a session with `"deny": ["mcp__claude_ai_Gmail"]` that lists a `mcp__claude_ai_Gmail__` tool) <!-- claim: other -->

With `mcp__claude_ai_Gmail` in the local deny list, the session's tools had no `claude_ai_Gmail`
prefix, while the other connectors were present. This is the complement's shape for a bare
`claude` started in the folder, where `--strict-mcp-config` is not on the argv.

## Where the human's layer is listed on disk (2026-11-03; falsify: the paths below missing on a machine that has synced plugins or connectors) <!-- claim: other -->

- Enabled plugins: `~/.claude/settings.json`, `enabledPlugins` entries set `true`.
- claude.ai-synced plugins: one directory per plugin under `~/.claude/plugins/synced/<bucket>/`.
  A `~g2` suffix on the directory name is not part of the plugin id: `langfuse~g2` is
  `langfuse@synced`.
- Personal skills: directory names under `~/.claude/skills/`. Synced skills are under
  `~/.claude/skills/synced/<bucket>/`.
- claude.ai connectors: `claudeAiMcpEverConnected` in `~/.claude.json`, as display names
  (`claude.ai Gmail`). The tool prefix replaces spaces and dots with `_`: `mcp__claude_ai_Gmail`.
  The list holds every connector ever connected, not only the current ones; denying an extra one
  costs nothing.
- User MCP servers: the top-level `mcpServers` in `~/.claude.json` (empty on this laptop).
