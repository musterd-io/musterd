# 708 — Role toolkits: association and harness auto-provisioning

- Status: accepted
- Date: 2026-10-22
- Lane: `01M5GYFH21HFYAR4F8Z82F62B2`
- Relates to: ADR 026 (toolkits), ADR 027 (additive, reversible
  provisioning), ADR 030 (uninstall manifest), ADR 227 (roster roles), ADR 261 (permission
  ceilings), ADR 281 (harness reconcile), ADR 296 (role/toolkit split: a role may name a
  default toolkit; a toolkit may never assert a role), ADR 520/676 (the iOS app this equips),
  ADR 586 (role skills), ADR 619 (the muse harness), hard rules 1, 4 and 6

## Context

The `ios-engineer` role shipped with a skill and no equipment. Creating its seat exposed
three gaps in machinery that already half-exists:

1. **Toolkits provision only in interactive `init`.** `provisionToolkitTools`
   (`packages/cli/src/onboard/init.ts`) provisions a toolkit's MCP servers and permission
   defaults into the chosen harness. Seat creation (`musterd agent`, `provisionSeat`)
   records the toolkit's name in `provisioned.json` and reconciles the musterd wiring —
   but never provisions the toolkit's tools. A seat created for a role starts without the
   tools its role needs.
2. **The muse harness cannot provision at all.** The `Harness.provision` hook is optional;
   claude-code, codex, cursor, grok and opencode implement it, muse does not, so `init`
   warns "Tool provisioning isn't supported for Muse Code yet" and skips the toolkit.
3. **A role cannot name its toolkit.** ADR 296 settled the direction — a role may name a
   default toolkit, a toolkit may never assert a role — but `RoleFile` has no field for
   it, so the only association is the same-name convention the permission recompiler
   relies on. `ios-engineer` the role and `ios` the toolkit cannot be linked by name.

A fourth fact shapes the toolkit itself: Expo's MCP server is remote
(`https://mcp.expo.dev/mcp`, OAuth), and the toolkit schema represents only stdio servers
(`command`/`args`/`env`). An iOS toolkit that cannot name the Expo server is not the iOS
toolkit.

## Problem

Give every role an equipment path that works the same way on every harness the team
supports: the role names its toolkit once; creating or re-roling a seat provisions that
toolkit's tools into every harness the seat is wired for, additively and reversibly,
with whatever each harness cannot represent reported rather than dropped silently.

## Decision

1. **`RoleFile` gains an optional `toolkit` field** (a toolkit name, same shape as the
   `skill` field). This is a protocol change: the field is added to `RoleFileSchema`,
   parsed, serialized by `serializeRoleFile`, and projected nowhere else — the roster
   read path keeps treating the role file as the source. Absent, the association stays
   the existing same-name convention. `roleToolkitName(roleName, role)` mirrors
   `roleSkillName`. A toolkit still never asserts a role (ADR 296 is untouched).
2. **Toolkit MCP servers may be remote.** `ToolkitMcpServerSchema` gains an optional
   `url`; a server carries exactly one transport — `command` (stdio) or `url` (remote
   HTTP) — enforced at parse. Each harness adapter writes the shape its config uses for
   a remote server; env entries on a remote server are written where the harness
   supports headers/env for it, and any adapter that cannot represent a remote server
   skips that server and reports it in the provision result's activation/warnings
   rather than failing the whole provision.
3. **The muse harness implements `provision`/`unprovision`.** _(Amended 2026-10-22: the
   machine-global `mcp.musterd` entry additionally resolves its adapter from the installed
   daemon's checkout — read back from its plist the way `service refresh` reads it — so
   every checkout on one machine wants the same bytes. Falls back to the
   checkout-relative resolution where no daemon is installed. The muse binary was
   measured to offer no project-local MCP scope, so folder-scoping is not an option.)_
   Servers are written into the machine-global Muse settings (`mcpServers`, the same file and 0o600 handling as
   its musterd entry — machine-global is muse's existing scope for MCP, named in the
   result's target/scope). Permission defaults are not compiled for muse (its settings
   permission shape is not one musterd has verified); the result reports permissions as
   not applied, as codex already degrades permissions to declared intent. Reversal
   removes exactly the named servers.
4. **Seat creation auto-provisions.** After the reconcile step, `provisionSeat` loads
   the seat's recorded toolkit (skipping silently when it names none or the generalist
   default) and provisions its servers and permissions into every desired harness that
   implements `provision`, best-effort exactly as `init` is: a failure warns and is
   recorded, never failing the seat creation; what was added is recorded under the
   manifest's existing `role-tools` contribution key so `musterd uninstall` removes
   exactly it. One shared helper performs this so `init` and seat creation cannot drift
   into two provisioning behaviours.
5. **The built-in `ios` toolkit.** Ships in the toolkit seed library: XcodeBuildMCP
   (stdio, `npx -y xcodebuildmcp@latest mcp`), Apple developer documentation
   (stdio, `npx -y @kimsungwhee/apple-docs-mcp@latest`), and Expo (remote,
   `https://mcp.expo.dev/mcp` — the seat authenticates with its own Expo account on
   first use; no secret is stored in the toolkit). Resource scopes name the mobile
   package; permission defaults follow the `backend` toolkit's shape. The
   `ios-engineer` role names it (`toolkit = "ios"` in its role file), and the
   `ios-engineer` skill's `team.md` records the pairing. No new runtime dependency of
   musterd itself: the servers are referenced, never hosted or version-managed
   (builtins.ts's standing rule), and each remains the seat's own install.

## Consequences

- 2026-10-22: the machine-scope question is settled. Measured against the muse 1.4.11
  binary: MCP servers live only in `$CONFIG_DIR/muse/settings.json` (no project-local
  scope exists), and the remote shape is `{id, transport: "http", url}` — exactly what
  this record specified, so the ios toolkit's Expo entry was correct as written. The
  remaining conflict was checkout-relative adapter paths: every checkout wanted different
  bytes in one shared file, and the engine rightly refused to let a non-owner rewrite
  it. The machine-global entry now resolves from the installed daemon's checkout
  (decision 3, amended). Verified live: `wire` in two checkouts on one machine both
  read owned (one unchanged, one add-owner), and the shared file converged with a
  single deliberate hand-edit (the `enabled: true` field the current writer emits) —
  after the engine correctly refused every automatic route, including owner-side
  `configure` and deselect/reselect (release-blocked by design). Standing rule
  re-confirmed: machine-scope owned drift never auto-converges; a human rewrites it
  deliberately or it stays red.
- `musterd agent cider --role ios-engineer --profile ios` now equips the seat on every
  wired harness in one step; `--profile` stays the explicit override, and the recorded
  toolkit name in `provisioned.json` is what later re-provisions resolve.
- The muse `provision` writes machine-global Muse settings: provisioning one muse seat's
  role servers makes them visible to every muse workspace on the machine. That matches
  muse's existing musterd entry scope and is named in the provision target; a
  folder-scoped muse MCP scope, if muse ever grows one, retires this note.
- Remote-server support is only as uniform as the harnesses: shapes differ
  (TOML `url`, JSON `url`, opencode remote type, claude `--transport http`, muse
  `transport: "http"`). The muse remote shape is written from its settings' own
  `transport` convention for stdio entries and is a named falsifier below, not a
  verified fact.
- Role-assign's permission recompile resolves through `roleToolkitName` where the role
  file is readable (the roster home, where that command runs); where no role file is
  readable it keeps the same-name convention, so existing teams see no change.
- 2026-10-22: [ADR 713](713-role-equipment-on-every-harness.md) extends decision 4.
  Seat creation, `role assign`, `wire`, and `harness configure` equip the recorded
  toolkit and every held role's loaded toolkit into every desired harness, and install
  or bridge the role skill. `--profile` stays the explicit recorded name. `role assign
  --remove` does not unprovision; when the recorded name was only that role's toolkit,
  it is cleared and the servers stay until `musterd uninstall --role-tools`.

## Observability & Evaluation

- **Traces:** provisioning stays a local, recorded act: the manifest's `role-tools`
  contribution names every server written per harness, and seat creation's wiring
  result reports skips and failures. No new daemon audit rows; nothing about the
  phone's or Expo's accounts is logged, and no secret is written into any config
  (env values stay `${ENV}` references).
- **Eval:** each harness adapter's provision/unprovision is covered by its existing
  test file's shape, extended for remote servers and (for muse) for provisioning at
  all: a provision writes exactly the named servers, a second provision changes
  nothing, unprovision removes exactly those and nothing else. The schema rejects a
  server with both `command` and `url` and one with neither.
- **Experiment:** none.
- **Falsifier:** a muse session in a folder provisioned with the `ios` toolkit does not
  list the remote Expo server (its written shape is wrong for muse's settings), or a
  seat created with `--profile ios` on any harness lacks the toolkit's stdio servers
  afterwards — either means the write shape or the seat path is wrong, and decision 3
  or 4 is revisited before more toolkits depend on them.
