# Seat tool allowlist Implementation Plan

> **For agentic workers:** implement in your own seat, one lane per increment (AGENTS.md hard rule
> 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seat loads exactly the tools its repo, its team's shared set and its roles declare, on
every start path and every harness, and the two banned superpowers skills are denied everywhere.

**Architecture:** Grants live in a new team-policy key, `seat_tools`, which seats read through a
scoped member route. The CLI resolves a seat's declared set (repo + shared + roles − floor), caches
it in the folder, and each harness adapter enforces it two ways: launch argv that excludes the
human's layer, and a complement written into the folder that turns off everything else the human's
layer would load.

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), the reconcile engine
(`packages/cli/src/onboard/reconcile/`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-seat-tool-allowlist-design.md`

## Increments

| Increment                                                     | Lane                         | Tasks |
| ------------------------------------------------------------- | ---------------------------- | ----- |
| 0. Design doc and this plan                                   | `01M6HBSK3C`                 | —     |
| 1. Product floor: the two banned skills denied                | `01M6HHSR93N65ZBC4JYEEW22EG` | 1     |
| 2. ADR, `seat_tools` policy key, scoped read, client          | `01M6HHST8GZR16GPSAQVCN6NJB` | 2–4   |
| 3. Claude Code seats load only their declared set             | `01M6HHSVAC3RRQ5AHBCDK0WQNV` | 5–11  |
| 4. Codex, Grok, Cursor, OpenCode, Muse                        | `01M6HHSXBTG02XH81DGMRZS8NX` | 12–13 |
| 5. `/live` seat card and `doctor` drift                       | `01M6HHT3A3EH141T7TDR07TF3P` | 14–15 |

Between increments 2 and 3, **nick writes revive's set** (Task 4's command). Grants are human-only, so
no seat writes it. Increment 3 does not merge before the set is stored.

The stopgap (lane `01M6HB9156`) stays in the 16 `settings.local.json` files until Task 10 takes its
keys over. Close `01M6HB9156` when increment 3 lands, with `follows_up` naming increment 4.

## Global Constraints

- Hard rule 1: the `seat_tools` key is a protocol change. The ADR (Task 2) lands in the same PR as
  the schema. Get its number from `pnpm adr:next` and push the draft PR before you write the ADR.
- Hard rule 6: no new runtime dependency.
- The human's global config is never written: not `~/.claude/settings.json`, not the plugin cache,
  not `~/.claude.json` beyond what ADR 165 already writes. musterd never runs `claude plugin install`.
- The floor's two denies: `Skill(superpowers:subagent-driven-development)` and
  `Skill(superpowers:dispatching-parallel-agents)`. No role and no policy can lift them.
- Default when `seat_tools` is unset: `shared.claude_plugins = ["superpowers@claude-plugins-official"]`,
  every other list empty, no role sets.
- Plugin ids are `PLUGIN@MARKETPLACE`, the same regex as `CodexPluginIdSchema`
  (`packages/cli/src/onboard/toolkit.ts:61`). A claude.ai-synced plugin is `<name>@synced`.
- Fail closed: an unreadable declared set means the last cached set, never a wider one; no cache
  means repo tools + floor only. A launch never fails because of this.
- A seat keeps the musterd MCP server, its hooks and its repo role skills on every path (anti-goal 4).
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`. Run only the
  package tests you touch (`pnpm --filter @musterd/cli test -- <file>`), never the full suite.

## Review Focus

1. **A role name with no `seat_tools.roles` entry.** The seat gets shared + repo, and no error.
   Test: Task 6, `resolves a role with no grant to the shared set`.
2. **The human installs a new plugin after the seat's last reconcile.** The next SessionStart closes
   it off and warns the session once. Test: Task 10, `SessionStart recompute disables a plugin
   enabled since the last reconcile`.
3. **The daemon is down at launch, and there is no cache yet (a brand-new seat).** The launch still
   runs, with repo tools + floor only, and the cache is marked stale. Test: Task 7, `no cache and
   no daemon gives repo tools and the floor`.
4. **A seat edits `.musterd/seat-tools.json` to widen itself.** The cache is behind an Edit/Write
   deny, and the next good read overwrites it. The deny is a courtesy wall like ADR 658's store
   wall; the launch argv is the stronger layer. Test: Task 7, `cache path is in the seat's deny
   list`.
5. **A hand-edited key in `settings.local.json` that the complement also wants.** For example, the
   human sets `enabledPlugins["figma@…"] = true` on a non-designer seat. The reconciler owns
   `enabledPlugins` and the floor/complement denies; other keys survive verbatim. The hand-set
   `true` is overwritten and `doctor` names it. Test: Task 9, `owned enabledPlugins entries are
   overwritten, unowned keys survive`.

---

### Task 1: The product floor denies the two banned skills

**Files:**
- Modify: `packages/cli/src/onboard/permissions.ts` (beside `STANDARD_FLOOR`, line 38)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (`permissionsPayload`, used at line 1456)
- Test: `packages/cli/src/onboard/permissions.test.ts`, `packages/cli/src/onboard/harnesses/claudeCodeFragments.test.ts`

**Interfaces:**
- Produces: `export const FLOOR_DENIED_SKILLS: readonly string[]` (the two skill names, without the
  `Skill(...)` wrapper) and `export function floorSkillDenies(): string[]` returning the Claude Code
  form `Skill(<name>)`. Later tasks and the other adapters render `FLOOR_DENIED_SKILLS` in their own
  syntax.

- [ ] **Step 1: Write the failing tests.** In `permissions.test.ts`:
  `floorSkillDenies() equals ['Skill(superpowers:subagent-driven-development)', 'Skill(superpowers:dispatching-parallel-agents)']`.
  In `claudeCodeFragments.test.ts`: `permissions fragment denies both floor skills even when the
  toolkit allows them`. Give the toolkit `permissions.allow: ['Skill(superpowers:dispatching-parallel-agents)']`
  and assert the payload's `deny` contains both floor entries.
- [ ] **Step 2: Run them and see them fail.**
  `pnpm --filter @musterd/cli test -- permissions.test.ts claudeCodeFragments.test.ts`. Expected:
  FAIL, `floorSkillDenies` is not exported.
- [ ] **Step 3: Implement.** Add the constant and the function. Append `floorSkillDenies()` to the
  `deny` list in `installSeatPermissions` (line 193) and in `permissionsPayload`. Extend
  `inspectSeatPermissions` (line 335) so a missing floor deny is reported, the same way a missing
  store-wall entry is.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit, PR, auto-merge.** Branch `fix/seat-floor-skill-denies`. Put
  ``Lane `01M6HHSR93N65ZBC4JYEEW22EG`.`` on the body's first line.

### Task 2: The ADR and the `seat_tools` schema

**Files:**
- Create: `docs/decisions/NNN-seat-tool-allowlist.md` (number from `pnpm adr:next`)
- Modify: `packages/protocol/src/credentials.ts` (`PolicySchema`, line 144; `PolicyOverrideSchema`, line 366)
- Modify: `SPEC.md` (the policy section, or Appendix A if seat-side enforcement is not yet specified)
- Test: `packages/protocol/src/credentials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SeatToolSetSchema = z.object({
    claude_plugins: z.array(PluginIdSchema).default([]),
    codex_plugins: z.array(PluginIdSchema).default([]),
    skills: z.array(z.string().min(1)).default([]),
    mcp_servers: z.array(z.string().min(1)).default([]),
  }).prefault({});
  export const SeatToolsPolicySchema = z.object({
    shared: SeatToolSetSchema,          // default claude_plugins: ['superpowers@claude-plugins-official']
    roles: z.record(z.string().min(1), SeatToolSetSchema).default({}),
  }).prefault({});
  export type SeatToolSet = z.infer<typeof SeatToolSetSchema>;
  ```
  Add `seat_tools: SeatToolsPolicySchema` to `PolicySchema`. `PluginIdSchema` moves to protocol, and
  `CodexPluginIdSchema` in `toolkit.ts` becomes an alias of it.
- `mcp_servers` here are **names** of human-layer servers let through (for example a claude.ai
  connector). Defining a new server stays in repo-committed toolkits. This is izzo's call; the ADR
  records it.

- [ ] **Step 1: Push the draft PR first.** Branch `feat/seat-tools-policy`. Run `pnpm adr:next`,
  commit an empty ADR stub with that number, push, `gh pr create --draft`, with
  ``Lane `01M6HHST8GZR16GPSAQVCN6NJB`.`` on the first line.
- [ ] **Step 2: Write the failing tests.**
  - `PolicySchema.parse({}).seat_tools` equals `{shared: {claude_plugins: ['superpowers@claude-plugins-official'], codex_plugins: [], skills: [], mcp_servers: []}, roles: {}}`.
  - `seat_tools refuses a plugin id without @MARKETPLACE`: `'figma'` throws.
  - `seat_tools accepts design@synced`.
  - `a sparse override sets one role without dropping the shared default`.
- [ ] **Step 3: Run them and see them fail.** `pnpm --filter @musterd/protocol test -- credentials.test.ts`.
- [ ] **Step 4: Implement the schema.**
- [ ] **Step 5: Run them and see them pass.** Same command.
- [ ] **Step 6: Write the ADR.** Context, Problem, Decision, Consequences, Observability &
  Evaluation. The Decision lists the five points in the spec's "Decisions this needs", plus the
  names-only `mcp_servers`. Consequences notes that it supersedes ADR 426's "plugins are opted out
  of wakes, not seats" line, and that the folder files are a courtesy wall (ADR 658 posture) while
  the launch argv is the enforcing layer. Observability: the `policy.change` audit row
  (`store/teams.ts:700`) already records every grant. Eval: Task 15's drift count per seat.

### Task 3: `GET /seat-tools`, the scoped member read

**Files:**
- Modify: `packages/server/src/transport/http.ts` (next to `/guardian-tiers`, line 5792)
- Modify: `packages/cli/src/client.ts` (next to the guardian-tiers read, line 2393)
- Modify: `docs/architecture/03-server.md` (route list)
- Test: `packages/server/src/transport/policy-http.test.ts`

**Interfaces:**
- Consumes: `SeatToolsPolicySchema` (Task 2).
- Produces: `GET /teams/:slug/seat-tools` → `{ seat_tools: SeatToolsPolicy }`, auth as
  `/guardian-tiers` (`authTouch` + `assertSeatCanRead`). Client:
  `getSeatTools(slug: string): Promise<{ seat_tools: SeatToolsPolicy }>`, parsed through the
  schema at the boundary (hard rule 4).

- [ ] **Step 1: Write the failing tests** in a new `describe('GET /seat-tools — scoped member read')`:
  - `a seat reads the default set`;
  - `a seat reads a stored role set`;
  - `the response carries no other policy field` (store a `doorbell` URL and assert it is absent);
  - `a seat cannot write seat_tools`: `POST /policy` with a seat credential is refused, as today.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @musterd/server test -- policy-http.test.ts`.
- [ ] **Step 3: Implement the route and the client method.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Gates, mark the PR ready, auto-merge.**

### Task 4: nick stores revive's first set (a human step, after Task 3 merges)

No code. Send nick an ask (`team_send {act:'ask'}`, species approve, tier standard) with this
command to run:

```bash
musterd team policy --team revive --seat-tools '{
  "shared": {"claude_plugins": [
    "superpowers@claude-plugins-official", "github@claude-plugins-official",
    "chrome-devtools-mcp@claude-plugins-official", "cloudflare@claude-plugins-official",
    "security-guidance@claude-plugins-official", "slack@claude-plugins-official",
    "huggingface-skills@claude-plugins-official"]},
  "roles": {"designer": {"claude_plugins": [
    "figma@claude-plugins-official", "frontend-design@claude-plugins-official", "design@synced"]}}
}'
```

_(Corrected 2026-11-03: there was no `policy set` command. The `--seat-tools` flag on
`musterd team policy` shipped for this step, lane `01M6HHSVAC3RRQ5AHBCDK0WQNV`.)_ Verify with
`musterd team policy --team revive --json` that `seat_tools` is stored, and that the newest
`policy.change` audit row names nick.

### Task 5: Spike: what each Claude Code flag closes (written down, not shipped)

**Files:**
- Create: `docs/wiki/claude-code-seat-isolation.md` (wiki template, dated claims with falsifiers)

Run each probe in a throwaway folder under the scratchpad with a real `claude -p` (prompt on stdin).
Record each answer as a dated claim:

1. With `--setting-sources project,local`, does a plugin with `enabledPlugins: true` in local
   settings load when it is installed only in the user cache?
2. Does `--setting-sources project,local` exclude `~/.claude/skills`?
3. With `--strict-mcp-config --mcp-config <file>`, do a plugin's own MCP servers still load?
4. Does `--strict-mcp-config` drop claude.ai connectors?
5. Where are the `@synced` plugins listed on disk, and where are the claude.ai connector names
   listed? This is how the complement enumerates them.
6. Does `permissions.deny: ["mcp__claude_ai_Gmail"]` block a connector's tools?

- [x] **Step 1: Run the six probes and write the page.** Done 2026-11-03: 1 yes, 2 yes (personal
  and synced skills are excluded), 3 yes (plugin servers drop too), 4 yes, 6 yes; 5 is the
  page's on-disk section.
- [x] **Step 2: Correct Tasks 8–11 here, in this plan,** where a probe answer changes them.

### Task 6: Resolve a seat's declared set

**Files:**
- Create: `packages/cli/src/onboard/seatTools/resolve.ts`
- Test: `packages/cli/src/onboard/seatTools/resolve.test.ts`

**Interfaces:**
- Consumes: `SeatToolSet`, `SeatToolsPolicy` (Task 2); `FLOOR_DENIED_SKILLS` (Task 1);
  `seatRoleNames(rosterHome, seat)` (`roleEquipment.ts:104`).
- Produces:
  ```ts
  export interface DeclaredSet extends SeatToolSet {
    deniedSkills: string[];            // FLOOR_DENIED_SKILLS, always
    source: 'server' | 'cache' | 'none';
    readAt: number | null;             // ms; null when source is 'none'
  }
  export function declaredSetFor(policy: SeatToolsPolicy, roles: string[]): Omit<DeclaredSet, 'source' | 'readAt'>;
  ```
  Union of `shared` and each `roles[r]`, de-duplicated and sorted. A floor-denied skill listed in a
  grant is dropped from `skills`.

- [ ] **Step 1: Write the failing tests:**
  - `unions shared and every held role, sorted, without duplicates`;
  - `resolves a role with no grant to the shared set`;
  - `drops a floor-denied skill even when a role grants it`;
  - `the default policy gives superpowers only`.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @musterd/cli test -- seatTools/resolve.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 7: Read the set, cache it, fail closed

**Files:**
- Create: `packages/cli/src/onboard/seatTools/cache.ts`
- Modify: `packages/cli/src/onboard/reconcile/context.ts` (`HarnessContext`, line 68)
- Modify: `packages/cli/src/onboard/roleSkills.ts` (the ctx enrichment at line 118; add the seat-tools enrichment beside it)
- Modify: `packages/cli/src/onboard/permissions.ts` (the cache path joins the Edit/Write deny)
- Test: `packages/cli/src/onboard/seatTools/cache.test.ts`

**Interfaces:**
- Consumes: `declaredSetFor` (Task 6); `client.getSeatTools` (Task 3).
- Produces:
  - `export const SEAT_TOOLS_CACHE_REL = '.musterd/seat-tools.json'`;
  - `export async function loadDeclaredSet(args: { worktreeRoot: string; fs: FsSeam; fetch: () => Promise<SeatToolsPolicy>; roles: string[]; now: number }): Promise<DeclaredSet>`;
  - `HarnessContext.seatTools?: DeclaredSet`. When absent, an adapter treats the set as
    `source: 'none'` (repo + floor only).
- A good read writes the cache atomically (`atomicWrite.ts`) with `readAt`. A failed read returns
  the cache with `source: 'cache'`, or, with no cache, an empty set with `source: 'none'`.
  `loadDeclaredSet` never throws.

- [ ] **Step 1: Write the failing tests:**
  - `a good read returns source server and writes the cache`;
  - `a failed read returns the cached set with source cache`;
  - `no cache and no daemon gives repo tools and the floor` (empty lists, both floor skills, `source: 'none'`);
  - `a corrupt cache reads as none, never as wider`;
  - `cache path is in the seat's deny list` (`Edit(/.musterd/seat-tools.json)` and `Write(/.musterd/seat-tools.json)`).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 8: Enumerate the human's Claude Code layer

**Files:**
- Create: `packages/cli/src/onboard/seatTools/claudeHumanLayer.ts`
- Test: `packages/cli/src/onboard/seatTools/claudeHumanLayer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HumanLayer {
    plugins: string[];        // enabled in ~/.claude/settings.json, plus @synced ones
    skills: string[];         // directory names under ~/.claude/skills
    mcpServers: string[];     // ~/.claude.json top-level mcpServers keys, plus connector names
    complete: boolean;        // false when any source could not be read
  }
  export function readClaudeHumanLayer(fs: FsSeam, env: NodeJS.ProcessEnv): HumanLayer;
  ```
  Read the files, never shell out. The sources, from the Task 5 page
  (`docs/wiki/claude-code-seat-isolation.md`): `enabledPlugins` true entries in
  `~/.claude/settings.json`; one directory per synced plugin under `~/.claude/plugins/synced/<bucket>/`
  (strip a `~g2` suffix, id `<name>@synced`); skill directory names under `~/.claude/skills/` and
  `~/.claude/skills/synced/<bucket>/`; connector display names in `claudeAiMcpEverConnected` in
  `~/.claude.json`, mapped to the `claude_ai_<Name>` prefix (spaces and dots become `_`); and
  top-level `mcpServers` keys in `~/.claude.json`. An unreadable source sets `complete: false`; it
  does not throw.

- [ ] **Step 1: Write the failing tests** with `memoryFs` fixtures:
  - `lists enabled plugins only, not ones set false`;
  - `lists personal skills by directory name`;
  - `lists user MCP servers and connectors`;
  - `an unreadable settings file gives complete false and empty plugins`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 9: The `seatTools` fragment in `settings.local.json`

**Files:**
- Create: `packages/cli/src/onboard/seatTools/claudeComplement.ts`
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (`desiredFragments` line 1445, `observe`, `apply`; bump `adapterVersion` from 2 to 3)
- Test: `packages/cli/src/onboard/harnesses/claudeCodeFragments.test.ts`

**Interfaces:**
- Consumes: `DeclaredSet` (Task 6), `HumanLayer` (Task 8).
- Produces:
  ```ts
  export interface ClaudeSeatToolsPayload {
    enabledPlugins: Record<string, boolean>;   // declared → true; human-layer and not declared → false
    deny: string[];                            // Skill(x) for undeclared personal skills, mcp__<s> for undeclared servers
  }
  export function claudeComplement(declared: DeclaredSet, human: HumanLayer): ClaudeSeatToolsPayload;
  ```
  A new folder fragment `seatTools` in the local settings container. It owns every key it writes
  under `enabledPlugins` and the `deny` entries it wrote (tracked in the ledger fingerprint, the
  way `permissions` is). It leaves every other key alone. With `human.complete === false`, the
  fragment keeps the previous complement's `false` entries (never removes one).

- [ ] **Step 1: Write the failing tests:**
  - `declared plugins are enabled, undeclared human plugins are disabled`;
  - `an undeclared personal skill is denied, a granted one is not`;
  - `an undeclared connector is denied, a granted mcp_servers name is not`;
  - `owned enabledPlugins entries are overwritten, unowned keys survive` (a hand-set `true` on an
    undeclared plugin becomes `false`; a `statusLine` key survives);
  - `an incomplete human layer never removes a previous false`.
- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @musterd/cli test -- claudeCodeFragments.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 10: Take over the stopgap and recompute at SessionStart

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (the `seatTools` fragment's first apply; `sessionStartHookCommand`, line 298)
- Modify: `packages/cli/src/onboard/selfHeal.ts` (the SessionStart inspect → repair step)
- Test: `packages/cli/src/onboard/harnesses/claudeCodeFragments.test.ts`, `packages/cli/src/onboard/selfHeal.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `first apply adopts the stopgap keys without duplicating them`: start from a settings file with
    the 01M6HB9156 keys (the 13 `false` plugins, the two `Skill` denies). After apply, each key
    appears once and the ledger owns it.
  - `SessionStart recompute disables a plugin enabled since the last reconcile`: the human layer
    gains `posthog@claude-plugins-official = true`. After the SessionStart repair it is `false`,
    and the hook output has one warning line naming it.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** In the SessionStart self-heal, re-run `loadDeclaredSet` (with a short
  timeout and the cache fallback) and the `seatTools` fragment only, not the whole reconcile.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 11: Strict launch argv on wakes and in the interactive launcher

**Files:**
- Create: `packages/cli/src/onboard/seatTools/claudeMcpConfig.ts`
- Modify: `packages/cli/src/host/backends/claudeCode.ts` (`argTail`, line 110)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (`interactive.fresh`/`resume`, line 1404)
- Modify: `packages/cli/src/onboard/toolkit.ts` (an untracked user toolkit file's `mcp_servers` are ignored, with a warning)
- Modify: `docs/decisions/426-*.md` (dated Consequences note pointing at the new ADR)
- Test: `packages/cli/src/host/backends/claudeCode.test.ts`, `packages/cli/src/onboard/harnesses/interactive.test.ts`, `packages/cli/src/onboard/toolkit.test.ts`

**Interfaces:**
- Consumes: `DeclaredSet`; the musterd MCP entry (`resolveMcpLaunch`, `launchEntryEnv`).
- Produces:
  - `export const SEAT_MCP_CONFIG_REL = '.musterd/claude-mcp.json'`;
  - a folder fragment `mcp.strict` writing that file: the musterd server, the repo's committed
    `.mcp.json` servers, the toolkit's servers, and each declared plugin's servers;
  - `export function claudeIsolationArgv(): string[]`, which returns
    `['--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', SEAT_MCP_CONFIG_REL]`.
    `argTail`, `fresh()` and `resume()` all use it. The launcher spawns with `cwd` at the
    workspace, so the relative path resolves.

- [ ] **Step 1: Write the failing tests:**
  - `wake argv carries the isolation flags once` (no duplicate `--setting-sources`);
  - `fresh and resume argv carry the isolation flags` (`resume('abc')` gives `[...isolation, '--resume', 'abc']`);
  - `the strict MCP config always contains the musterd server`;
  - `an untracked user toolkit's mcp_servers are ignored with a warning; a tracked one's load`
    (use the `ExecSeam` to fake `git ls-files --error-unmatch`).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Probe 3 showed `--strict-mcp-config` drops plugin MCP servers
  too (the plugin itself still loads), so the file also carries each declared plugin's servers,
  read from the plugin's `.mcp.json` in the user plugin cache.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Gates, PR, auto-merge.** Body opens with ``Lane `01M6HHSVAC3RRQ5AHBCDK0WQNV`.``
  After it lands and the refresher bounces the daemon, check one live seat:
  `claude -p` in `agents/alfie`, ask it to list its skills, and confirm no posthog, brightdata,
  hookify or Gmail tool shows up. Then close `01M6HB9156`.

### Task 12: Each adapter declares its strength

**Files:**
- Modify: `packages/cli/src/onboard/reconcile/fragments.ts` (`HarnessAdapter`, line 82)
- Modify: every adapter in `packages/cli/src/onboard/harnesses/` (`claudeCode`, `codex`, `grok`, `cursor`, `opencode`, `muse`, `musterd`)
- Test: `packages/cli/src/onboard/reconcile/matrix.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ToolKind = 'plugins' | 'skills' | 'mcp_servers';
  export type IsolationStrength = 'excluded' | 'denied' | 'open';
  // on HarnessAdapter:
  isolation: Record<ToolKind, { strength: IsolationStrength; reason?: string }>;
  ```
  Claude Code's values come from the Task 5 page. Muse `mcp_servers` is
  `{strength: 'open', reason: 'Muse reads one machine-global MCP file'}`.

- [ ] **Step 1: Spike each of the five other harnesses** (the spec's open questions: Codex
  `CODEX_HOME` and auth; whether Grok, Cursor and OpenCode can disable user-level skills and MCP
  servers per project). Add each answer to the wiki page from Task 5.
- [ ] **Step 2: Write the failing test** `every registered adapter declares a strength for every
  tool kind, and every open one has a reason`.
- [ ] **Step 3: Implement the declarations.**
- [ ] **Step 4: Run it and see it pass.**
- [ ] **Step 5: Commit** on branch `feat/seat-tools-harnesses`.

### Task 13: Apply the declared set and the floor on the other harnesses

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/codex.ts` (`declaredCodexPlugins`, line 286: read `ctx.seatTools.codex_plugins` instead of the toolkit, and close the `toolkitProvision.ts` gap)
- Modify: `grok.ts`, `cursor.ts`, `opencode.ts`, `muse.ts`, and their wake backends in `packages/cli/src/host/backends/`
- Test: each adapter's `*Fragments.test.ts`

For each adapter, write what its declared strengths allow and nothing more: launch exclusion where
the harness has a flag or env, a project-level disable where it has one, and the floor's skills in
its deny syntax. A kind declared `open` writes nothing and is left to Task 14 to show.

- [ ] **Step 1: Write the failing tests,** one per adapter per non-`open` kind:
  `<harness> closes an undeclared <kind>`, plus `<harness> denies both floor skills` wherever skills
  are not `open`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Gates, PR, auto-merge** (``Lane `01M6HHSXBTG02XH81DGMRZS8NX`.``).

### Task 14: The effective set in the observation and on `/live`

**Files:**
- Modify: the adapter observation that already fingerprints writes (`packages/cli/src/onboard/reconcile/engine.ts`, `reconcileHarnesses` line 640) and the presence attestation it rides on
- Modify: `packages/protocol/src/` (only if the attestation shape changes; then add the change to the ADR from Task 2, amended in Consequences)
- Modify: the seat card in `packages/web/src/`
- Test: engine test, web component test

**Interfaces:**
- Produces: on each seat's attestation,
  `tools: { count: number; open: { kind: ToolKind; reason: string }[]; stale: boolean; missing: string[] }`,
  where `missing` lists declared plugins that are not installed (spec §1d).

- [ ] **Step 1: Write the failing tests:**
  - `the attestation counts the effective set and lists open kinds`;
  - `the seat card shows the count, and "not isolated" with the reason when any kind is open`;
  - `the seat card shows "set is stale" when source is cache or none`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Use the existing seat-card patterns; no new panel.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** on branch `feat/seat-tools-visibility`.

### Task 15: Drift in `musterd doctor`

**Files:**
- Modify: `packages/cli/src/onboard/doctor.ts`
- Test: `packages/cli/src/onboard/doctor.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `doctor names a declared plugin that is not installed, with the install command for a human`
    (`claude plugin install figma@claude-plugins-official`);
  - `doctor names an undeclared tool the harness will load`;
  - `doctor says the set is stale when it came from the cache`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Gates, PR, auto-merge** (``Lane `01M6HHT3A3EH141T7TDR07TF3P`.``). The lane is
  `user-facing`, so a peer accepts it.
