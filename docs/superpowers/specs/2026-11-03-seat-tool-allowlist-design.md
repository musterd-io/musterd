# Seat tool allowlist — design

- Date: 2026-11-03
- Lane: `01M6HBSK3C`, goal `security`
- Brainstormed with nick, written by izzo. Parts marked **izzo's call** are mine. The rest is what
  nick said or decided.

## Why

On 2026-11-03 nick noticed that seats carry tools they shouldn't. These tools come from **his**
setup, not from musterd. On this laptop an interactive seat session loads:

- every Claude Code plugin he enabled globally (17 of them, e.g. PostHog, Bright Data, Hookify);
- five plugins synced from his claude.ai account;
- the skills in his personal `~/.claude/skills` folder;
- his claude.ai connectors (Gmail send, Neon and Supabase with project-delete tools, Slack).

None of those are tied to a musterd role. Two skills in that set (superpowers'
`subagent-driven-development` and `dispatching-parallel-agents`) are banned by musterd's own rule 8.
nick's `skillOverrides: "off"` for them has no effect. The Claude Code docs say plugin skills ignore
`skillOverrides`.

The same seat also behaves differently depending on how it was started:

- A **woken** Claude Code seat skips the user settings layer (ADR 426), so it gets **none** of the
  plugins, superpowers included. claude.ai connectors still load; ADR 426 leaves
  `--strict-mcp-config` as a later step.
- A seat opened **by hand**, through `musterd <member>` or a bare `claude` in the folder, gets
  **all** of them.
- The other harnesses (Codex, Grok, Cursor, OpenCode, Muse) do no user-layer isolation at all.

nick asked for "the best, most effective, most secure permanent fix", with no stopgap. A local
stopgap already exists in lane `01M6HB9156`: `enabledPlugins:false` and two `Skill(...)` denies in
16 `.claude/settings.local.json` files. This design replaces it.

## What it is

**A seat has exactly the tools its roles declare, plus a small shared set its team declares, and
nothing else.** This holds on every harness, whether musterd woke the seat or a person opened it.

"Tools" covers every kind of capability a harness can load:

- plugins (Claude Code and Codex);
- skills, from any source: the repo, a plugin, the human's personal folder, or synced from claude.ai;
- MCP servers, including claude.ai connectors and servers in the human's user config.

The human keeps every tool for their own sessions outside musterd. Isolation happens per seat
workspace, never by editing the human's global config.

## Goals

1. **Allowlist, not blocklist.** A tool reaches a seat only when a role toolkit or the team's shared
   set lists it. A plugin the human installs tomorrow never reaches a seat by accident.
2. **The same tools on every start path.** A wake, `musterd <member>` / `musterd pick`, and a bare
   harness started in the seat's folder all give the seat the same set.
3. **Every harness.** Claude Code, Codex, Grok, Cursor, OpenCode and Muse each get the strongest
   isolation that harness allows. A harness that can't isolate says so (see Visibility). It never
   silently passes.
4. **The banned skills are denied by the product.** `superpowers:subagent-driven-development` and
   `superpowers:dispatching-parallel-agents` are denied for every seat on every team, whatever
   either list says. Rule 8 is universal, so this is a floor and not a team choice.
5. **Granting is deliberate and recorded.** A human adds a tool to a role or to the team's shared
   set. The grant is audited, like a permission. An integration that acts on an outside account is
   only ever granted by a human.
6. **Visible.** `/live` shows each seat's effective tool set. `musterd doctor` reports any drift
   between what a seat should have and what its harness will actually load.

## Non-goals

- Changing the human's global harness config. Their own sessions keep everything.
- Designing outside integrations. Slack is ADR 668: a daemon-side adapter, so seats need no Slack
  plugin. Future integrations follow the same shape. This design only ensures that if one is ever a
  seat-side tool, it arrives through a grant.
- Sandboxing what a seat does with an allowed tool. That is the permission floor and the PreToolUse
  gate (ADR 150), which already exist.

## Anti-goals (a failure even if it technically works)

- A seat silently gets a tool because the human installed it for themselves.
- A woken seat and a hand-opened seat behave differently.
- Adding an integration later is so fiddly that people turn it on globally instead of granting it.
- Isolation that breaks a seat's ability to work: losing the musterd MCP server, the hooks, or the
  role skills from the repo.

## Constraints from what exists

All facts below are from the code on 2026-11-03.

- **Toolkits** (`packages/cli/src/onboard/toolkit.ts:87`) have `mcp_servers`, `permissions`,
  `resource_scopes` and `codex_plugins` (ADR 323). They have no field for Claude plugins or for
  skills.
  - Built-ins are in `toolkits/builtins.ts`. User overrides go in `.musterd/toolkits/<name>.json`.
  - A role file names its toolkit and skill, each defaulting to the role's own name (ADR 586/708).
- **One provisioning path, per-harness adapters.** It runs through `provisionToolkitIntoHarnesses`,
  ADR 713 role equipment, and the reconciler with per-harness fragments.
  - **Gap:** Codex plugins are applied only through reconciler fragments (`codex.ts:276`), not
    through `toolkitProvision.ts`.
- **Wake argv per backend** (`packages/cli/src/host/backends/*`):
  - Only Claude Code excludes the user layer, with `--setting-sources project,local`.
  - **Gap:** the interactive launcher (`launcher/plan.ts`, Claude fresh argv `[]`) passes no
    isolation flags.
- **Team policy** (`PolicySchema`, `packages/protocol/src/credentials.ts:144`) has no key that
  provisioning reads today.
  - **Constraint:** adding one is a protocol schema change, so it needs an ADR (hard rule 1).
- **Muse** writes its MCP config to a machine-global file (`muse.ts:334`). That file is shared by
  every seat and the human on the machine.

## How it works (decided)

### 1. One declared set per seat

- A seat's **declared set** is: the repo's committed tools, plus the team's shared set, plus the
  role sets for every role the seat holds, minus the product floor's denies. A toolkit named only by
  `--profile` also counts (ADR 713 §2).
- **The grant vocabulary has two new fields** (**izzo's call** on the names, mirroring `codex_plugins`).
  They are used in `seat_tools` sets (§1a), not in local toolkit files:
  - `tools.claude_plugins[]`: `PLUGIN@MARKETPLACE` ids. A claude.ai-synced plugin is `<name>@synced`,
    as Claude Code names it.
  - `tools.skills[]`: extra skill names a role may load beyond its own role skill. This is how a
    plugin skill or a user-folder skill gets granted.
- **Grants are a new team policy key, `seat_tools`**, with `shared` and per-role sets (§1a). Each
  set has the same shape as a toolkit's `tools` block. Defaults are in §1b.
- **Product floor:** the two banned skills are denied by a new list beside `STANDARD_FLOOR` /
  `storeWall`. Each adapter applies it in that harness's own deny syntax. It cannot be lifted by a
  role or by policy.

### 1a. Where grants live (**izzo's call**, from nick's "most secure")

- **The repo is already declared.** Everything the repo commits counts as team-declared, because it
  lands through a reviewed PR: `.agents/skills/`, the provisioned `.claude/skills` bridges, committed
  `.mcp.json` servers, and project plugin settings. The allowlist closes off what does **not** come
  from the repo or a grant: the human's layer, and anything a seat writes into its own folder that is
  not tracked.
- **Grants live on the server, not in local files.** A toolkit file under `.musterd/toolkits/` is
  local, unaudited and editable by an agent seat, so a seat could grant itself Gmail. Seat tool
  grants therefore live in team policy:
  - the shared set, `seat_tools.shared`;
  - per-role sets, `seat_tools.roles.<role>`.
  Only an admin human can write either, and every write is audited.
- **Every grant is human-only.** No tool is classed as "outside-account". A local toolkit file can
  still declare servers and permissions as it does today. It can no longer add a plugin, a
  non-repo skill or a non-repo MCP server.
- **Seats need to read it.** `GET /policy` is admin-only because it holds secrets. Seats get a scoped
  member read of their own declared set, the way `/enforcement` and `/guardian-tiers` already work.

### 1b. Defaults and revive's first set (**izzo's call**, from nick's 2026-11-03 picks)

- When a team has never set `seat_tools`, the server answers `shared:
  ["superpowers@claude-plugins-official"]` and no role sets. Existing teams get that too.
- revive's set is written **before** the reconcile lane ships, from what nick kept for seats on
  2026-11-03:
  - shared: superpowers, github, chrome-devtools-mcp, cloudflare, security-guidance, slack,
    huggingface-skills;
  - `designer`: figma, frontend-design, design@synced.
- nick turned off everything else on 2026-11-03.

### 1c. When the declared set can't be read: fail closed (**izzo's call**, from "most secure")

The daemon may be unreachable, the read may fail, or musterd may be unable to list the human's
layer. In each case the seat uses its **last-known declared set** (cached in the folder at the last
good reconcile) and **never anything wider**. A seat with no cached set gets only the repo's tools
and the product floor. A launch never fails because of this. The seat card and `doctor` say the set
is stale.

### 1d. A declared plugin that isn't installed: report, never install (**izzo's call**)

musterd never writes to the human's user-level config or plugin cache, so it never runs
`claude plugin install` for a seat. The adapter reports the plugin as declared but not installed, on
`/live` and in `doctor`, and gives the install command for a human to run. On a machine that only
hosts seats (the Hetzner VM), whoever runs that machine installs it the same way.

### 2. Two isolation layers per harness, both on

The seat is isolated from the human's layer in two ways, so either start path gives the same result.

- **Launch-time exclusion.** Every musterd-launched session excludes the human's user layer entirely
  and loads only the seat's project and local config. This covers wakes **and** the interactive
  launcher. For Claude Code that means:
  - `--setting-sources project,local` (already on wakes; added to `musterd <member>`/`pick`);
  - `--strict-mcp-config` with a musterd-written MCP config. That drops claude.ai connectors and
    user MCP servers, and keeps the musterd server and the toolkit's servers.
  - The declared plugins are enabled in the seat's local settings, so they load even with the user
    layer excluded.
- **Complement written into the folder.** For a harness started bare in the folder (no musterd
  argv), provisioning writes an explicit "off" for everything the human's layer would load that is
  not in the declared set. musterd enumerates the human's enabled plugins, synced plugins,
  user-folder skills, connectors and user MCP servers, and disables or denies each in the
  seat-local config.
  - Claude Code shapes: `enabledPlugins: {id: false}`, `permissions.deny: ["Skill(name)"]` and
    `mcp__<server>` denies. `Skill(...)` deny was tested on 2026-11-03: it blocks invocation, but
    the skill stays in the listing.
  - The complement is recomputed on every reconcile and at session start (the SessionStart hook
    musterd already installs), so a tool the human adds later is closed off by the next session.
  - The session that discovers it is warned. It is not silently allowed.

### 3. Per-harness strength is declared, not assumed

- Each adapter reports what it can enforce, per tool kind: `excluded` (never loads), `denied`
  (loads but cannot be invoked), or `open` (the harness offers no way to close it from a workspace).
- Muse's machine-global MCP file is the known `open` case today. Codex has `CODEX_HOME` and
  project-level `enabled = false`; how much each harness supports is a builder spike (below).
- An `open` result is never hidden. The seat is marked as not isolated, with the reason.

### 4. Visibility

- Each adapter's observation already fingerprints what it wrote. It now also reports the seat's
  **effective tool set**: what the harness will load, and the strength per tool.
- `/live` shows it on the seat card: a count, plus a "not isolated" marker when anything is `open`.
- `musterd doctor` lists drift: a declared tool that isn't loadable, or an undeclared one that is.
- Granting a tool (a toolkit or policy change) lands an audit row naming the human who made it.

## Left to the builder

- **Spike first, per harness:** confirm which start paths and tool kinds each harness lets a
  workspace close, and record the results as the adapter's declared strengths. Known open questions:
  - Does `--setting-sources project,local` still load a plugin that is enabled in local settings
    but installed in the user cache?
  - Does it exclude `~/.claude/skills`?
  - For Codex: does `CODEX_HOME` isolation keep auth working?
  - Can Grok, Cursor and OpenCode disable user-level skills and MCP servers per project?
- How the complement enumerates the human's layer on each harness (read the config files vs ask
  the harness CLI, e.g. `claude plugin list`).
- The exact `/live` presentation of the tool set, within the existing seat card.
- The migration for existing seats: the first reconcile after this ships writes the declared set and
  complement. It also removes the `01M6HB9156` stopgap keys it now owns. They are merge-preserved
  today, so the reconciler must take ownership of them, not duplicate them.
- Splitting this into lanes. Suggested order: product floor; toolkit fields and the policy key (the
  ADR); the Claude Code adapter; the other adapters; visibility.

## Decisions this needs

- **One ADR** covering:
  - the `seat_tools` team-policy key and a scoped member read of it (a protocol schema change,
    hard rule 1);
  - the two grant fields, and local toolkit files no longer granting plugins, non-repo skills or
    non-repo MCP servers;
  - fail-closed to the last-known set, and never installing into the human's home;
  - the product-floor skill denies;
  - extending ADR 426's exclusion to the interactive launcher and to `--strict-mcp-config`.
- ADR 426 is "proposed". The new ADR supersedes its "plugins are opted out of wakes, not seats" line.
