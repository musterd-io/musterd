# 794 — Seat tool allowlist: grants in team policy, a floor no grant lifts

- Status: accepted
- Date: 2026-11-03
- Design: `docs/superpowers/specs/2026-11-03-seat-tool-allowlist-design.md` (approved by nick 2026-11-03)
- Plan: `docs/superpowers/plans/2026-11-03-seat-tool-allowlist.md`

## Context

On 2026-11-03 nick found that seats carry tools from **his** setup, not from musterd. An
interactive seat on this laptop loaded 17 globally enabled Claude Code plugins, five plugins synced
from his claude.ai account, his personal `~/.claude/skills`, and his claude.ai connectors (Gmail
send; Neon and Supabase with project-delete tools). None of them is tied to a musterd role. Two of
them, superpowers' `subagent-driven-development` and `dispatching-parallel-agents`, are banned by
AGENTS.md rule 8, and his `skillOverrides: "off"` for them had no effect: plugin skills ignore it.

The same seat also loaded different tools depending on how it started. A woken Claude Code seat
skips the user settings layer (ADR 426), so it got none of the plugins, superpowers included. A
seat opened with `musterd <member>` or a bare `claude` got all of them. The other harnesses did no
user-layer isolation at all.

nick asked for "the best, most effective, most secure permanent fix", with no stopgap.

## Problem

Nothing declares which tools a seat should have. Toolkits (ADR 323) can declare MCP servers,
permissions and Codex plugins, but not Claude plugins or extra skills. A toolkit file under
`.musterd/toolkits/` is also local and unaudited, and the seat it governs can edit it. So even with
a field to declare tools, a seat could grant itself an outside-account integration.

## Decision

1. **A seat loads exactly its declared set.** The declared set is: what the repo commits (it lands
   through a reviewed PR), plus the team's shared set, plus the set for each role the seat holds,
   minus the product floor. Nothing else from the human's layer reaches a seat.
2. **Grants live in team policy, as a new key `seat_tools`** (`@musterd/protocol`
   `SeatToolsPolicySchema`): `shared` and `roles.<role>`, each a set of four lists:
   `claude_plugins` and `codex_plugins` (`PLUGIN@MARKETPLACE`; a claude.ai-synced plugin is
   `<name>@synced`), `skills` (skill names beyond the role's own skill) and `mcp_servers`.
   - `mcp_servers` are **names** of servers in the human's layer to let through, such as a claude.ai
     connector. Defining a new server stays in repo-committed toolkits.
   - Each list is the whole set: writing it replaces it, never merges into it.
   - A team that never set `seat_tools` shares `superpowers@claude-plugins-official` only.
3. **Only an admin human grants.** `seat_tools` is written through `POST /policy`, which is
   admin-only and human-only (ADR 172) and audited as `policy.change`. Every grant is human-only;
   no tool is classed as safe for a seat to grant itself. A local toolkit file can no longer add a
   plugin, a non-repo skill or a non-repo MCP server.
4. **Seats read their grants through `GET /teams/:slug/seat-tools`**, a scoped member read that
   returns `{seat_tools}` and nothing else, as `/guardian-tiers` and `/enforcement` do. The full
   policy stays admin-only because it holds secrets.
5. **The product floor denies the two banned skills** for every seat on every team
   (`FLOOR_DENIED_SKILLS`). No grant and no role lifts them. Each adapter renders them in its own
   deny syntax. Shipped first, in PR #3772.
6. **Fail closed.** When the declared set can't be read, a seat uses the set cached at its last
   good read, never anything wider. With no cache it gets the repo's tools and the floor only. A
   launch never fails because of this; the seat is marked stale.
7. **musterd never installs into the human's home.** A declared plugin that is not installed is
   reported with the install command for a human to run.
8. **Two isolation layers per harness.** Every musterd-launched session excludes the human's layer
   at launch: for Claude Code, ADR 426's `--setting-sources project,local` extends from wakes to
   the interactive launcher, and both gain `--strict-mcp-config` with a musterd-written MCP
   config. For a harness started bare in the folder, provisioning also writes an explicit "off"
   for everything the human's layer would load that is not declared, recomputed on every
   reconcile and at session start.
9. **Each adapter declares its strength per tool kind**: `excluded`, `denied` or `open`. An `open`
   kind is shown, never hidden; the seat is marked not isolated, with the reason.

This supersedes ADR 426's line that plugins are opted out of wakes, not seats: a seat's plugins
are now its declared set on every start path.

## Consequences

- Increment 2 (this PR) ships the schema, the default and the scoped read. No seat behaves
  differently yet: nothing reads `seat_tools` until increment 3.
- revive's first set is written by nick, not a seat, before increment 3 lands: shared =
  superpowers, github, chrome-devtools-mcp, cloudflare, security-guidance, slack,
  huggingface-skills; `designer` = figma, frontend-design, design@synced (his 2026-11-03 picks).
- The folder-side complement and the cached set are a courtesy wall, the ADR 658 posture: a seat
  that edits its own settings file walks past them. The launch argv is the enforcing layer, and a
  bare harness started by hand in the folder relies on the complement alone.
- Outside integrations stay daemon-side (Slack is ADR 668). A seat-side one arrives as a grant.
- The stopgap in lane `01M6HB9156` (13 `enabledPlugins: false` keys and the two `Skill` denies, in
  16 local settings files) is taken over by the increment 3 reconcile, not duplicated.

## Observability & Evaluation

- **Traces:** every grant is a `policy.change` audit row naming the admin human, with the stored
  doc as its detail. The wake spawn argv in `host.log` carries the isolation flags once increment 3
  lands.
- **Eval:** increment 5 reports, per seat, the effective tool set and any drift (a declared tool
  that won't load, an undeclared one that will). Falsifier: a seat whose effective set lists a
  plugin no grant names, after its first reconcile under increment 3.
- **Experiment:** n/a — no rollout choice to compare; the floor and the allowlist are not dials.
