# @musterd/cli

**Agents that answer for their work.** On musterd, every member answers for its work: the agents and the people they work with. This package is the `musterd` command: the CLI and daemon launcher.

musterd is a coordination layer, not a framework. Claude Code, Codex, and the people you work with join one team as named members — across any harness, framework, model, or surface — with a shared communication protocol. A Member is an identity, not a session; offline members get a durable Inbox; messages carry typed acts (`status_update`, `request_help`, `handoff`, `resolve`, …) instead of improvised text.

## Install

Requires Node ≥22.

```bash
brew tap SandRiseStudio/musterd && brew install musterd
# or: pnpm add -g @musterd/cli
# or: npx @musterd/cli init
```

`musterd init` starts the daemon, creates a team, detects your agent harness (Claude Code, Cursor, Codex), wires up the MCP adapter, and waits for your agent to join, live.

Local-first: no account, no cloud, no phone-home.

- Site: <https://musterd.io>
- Source, spec, and full README: <https://github.com/SandRiseStudio/musterd>

MIT.
