# Front door — the seat launcher: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in your own seat and lane (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare `musterd` on a terminal opens a seat picker, and `musterd <seat>` launches that seat's harness in its Workspace, with musterd as the harness's parent process.

**Architecture:** Lean TypeScript inside `@musterd/cli`. `bin.ts` loads commands lazily, so the launcher's first screen paints from a secret-free snapshot in `~/.musterd/launcher.json` without loading the protocol package. A post-paint catalog scan and one unauthenticated, time-boxed roster read per team patch the rows in place. A picked seat goes through a pure launch plan (each harness adapter declares its interactive entry) and a supervisor that runs the harness with the terminal handed over and prints one receipt line.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Node ≥ 22 ESM, zod, picocolors, `node:readline` keypress events, vitest (`pool: forks`, `NO_COLOR=1`).

**Spec:** `docs/superpowers/specs/2026-10-01-front-door-launcher-design.md` (approved by nick 2026-10-01) and `docs/decisions/491-seat-launcher.md`. Read both; this plan argues from them.

## Global Constraints

- No `@musterd/protocol` schema change (hard rule 1) and no new runtime dependency (hard rule 6).
- Relative imports end in `.js`; type-only imports use `import type` or an inline `type` (`verbatimModuleSyntax`). Index access is `T | undefined` (`noUncheckedIndexedAccess`). Optional properties are never set to `undefined` unless declared `| undefined`.
- External input is parsed through zod at the boundary (hard rule 4): `binding.json`, `provisioned.json` and `workspace.json` through the protocol loaders, `launcher.json` through `LauncherFileSchema`, and the roster through `MemberSummarySchema`.
- No secret ever enters the catalog, the snapshot, `launcher.json` or any output. Tests check with `containsMusterdCredential` from `@musterd/protocol`, which knows every registered prefix.
- Tests never touch the operator's machine. `MUSTERD_CONFIG` is pinned by `tests/setup/isolate-machine-state.ts`, so `launcher.json` lives at `machineConfigRoot()`. `HOME` is **not** pinned, so every function that reads `~/musterd` takes `home` as a parameter.
- The paint path (`launcher/index.ts` and its static imports) may load only `zod`, `picocolors` and Node built-ins. `importClosure.test.ts` enforces this.
- User-facing words: say Workspace, never the git term (the vocabulary gate covers `packages/cli/src/help/**` and `render/**`). Seat, member, team, harness, Presence keep their glossary meanings.
- Docs change in the same commit as the code (hard rule 3). Every new non-test `.ts` file gets a described line in `docs/architecture/04-cli.md`'s `packages/cli/src/` tree, because `pnpm format:check` runs `arch-trees:check`. New screens get frames in `docs/design/figma-brief-terminal.md` (hard rule 2).
- Git (ADR 106): one branch per lane from fresh `origin/main`, squash PR, `gh pr merge --squash --auto --delete-branch`. Fast gates before every push: `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check`. Every commit ends with these lines:

  ```
  Co-authored-by: stanley <stanley@revive.musterd>
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Review Focus

1. **A Workspace whose files are broken.** A legacy or invalid `binding.json`, or a legacy `provisioned.json`, must still appear in the catalog, flagged `needs repair`, with the exact command to fix it. Launching it must refuse with that command, not crash. Pinned in Task 7 and Task 12.
2. **The terminal left in raw mode or on the alternate screen** after a throw inside the picker, a rejected launch, or a crash. `runPicker` restores on every path, including `process.on('exit')`. Pinned in Task 17 with a reducer that throws.
3. **`⌃C` while the harness runs.** It must reach the harness and not kill musterd, so the receipt still prints and the harness's exit code comes back. Pinned in Task 11 (signal seam) and Task 13 (real spawn through `dist/bin.js`).
4. **A word that is not a seat.** `musterd --json`, `musterd -r`, a typo, or a name shadowed by a command must behave exactly as today: `unknown command … · musterd help`, exit 2, with a command suggestion first and a seat suggestion second. Pinned in Task 12 and Task 13.
5. **A wedged daemon** (accepts the socket, never answers). The roster read must give up at its time box, and both the picker and `musterd <seat>` must stay usable. Pinned in Task 10 with a server that never responds.

---

## Increments

| Increment | Lane | Branch | Delivers |
| --- | --- | --- | --- |
| Design | `01M3WA6YT5FBW479G07YKTJSWB` | `docs/front-door-spec` | Spec, ADR 491, this plan (PR #1928) |
| 1 | `01M3WA77DFGCEV344M9WTFX6NG` | `feat/front-door-1-fast-entry` | Tasks 1–4: lazy command table, light `bin.ts`, import-closure test, bench |
| 2 | `01M3WA7J4YRC21TCGGW9PSDK9E` | `feat/front-door-2-launch-by-name` | Tasks 5–13: catalog, recents, resolve, interactive entries, roster, plan, supervisor, `musterd <seat>`, `musterd -`, `musterd seats` |
| 3 | `01M3WA7W55F50XC6TFV33K21PR` | `feat/front-door-3-picker` | Tasks 14–19: fuzzy search, picker state, view, terminal layer, bare `musterd` |
| 4 | `01M3WA85HQRSA7V08FEQQ489HM` | `feat/front-door-4-create` | Tasks 20–25: base ref, reconcile wiring and revoke, `provisionAgentSeat`, create flows |

Each increment opens with: `git fetch origin main && git switch --detach origin/main && git checkout -b <branch> origin/main`, then `lane_claim` the lane and `team_send {act:'status_update'}`. It closes with the PR steps in its last task, `lane_submit` with `{pr, sha}` after the merge, and the local-branch cleanup that `lane resolve` prints.

## File structure

**Increment 1**
- Create `packages/cli/src/nodeVersion.ts`: the Node ≥ 22 gate, moved out of `runtime.ts` (which imports the protocol root).
- Create `packages/cli/src/commandTable.ts`: every command word → a lazy loader.
- Modify `packages/cli/src/bin.ts`: static imports cut to `args`, `commandTable`, `errors`, `exit`, `nodeVersion`, `render/theme`, `render/ui`, `version`.
- Modify `packages/cli/src/runtime.ts`: re-export the gate.
- Create `packages/cli/src/commandTable.test.ts` and `packages/cli/src/importClosure.test.ts`.
- Create `scripts/bench-cli-start.ts`; modify the root `package.json` (one script).

**Increment 2**
- Create `packages/cli/src/launcher/{labels,address,store,catalog,resolve,live,plan,supervise,rows,byName}.ts`, each with a `.test.ts`.
- Create `packages/cli/src/launcher/byName.e2e.test.ts`, which spawns `dist/bin.js`.
- Create `packages/cli/src/cursorAgentBin.ts` and `packages/cli/src/commands/seats.ts`, each with a test.
- Modify `packages/cli/src/onboard/reconcile/fragments.ts` (`InteractiveLaunch`), every adapter in `onboard/harnesses/` plus `musterdCoreAdapter`, `commandTable.ts`, `bin.ts`, and `help/catalog.ts`.

**Increment 3**
- Create `packages/cli/src/launcher/fuzzy.ts`, `launcher/index.ts` and `launcher/picker/{state,view,tty}.ts`, each with tests.
- Modify `bin.ts`, `launcher/byName.ts` (ambiguous name on a TTY opens the picker), `importClosure.test.ts` and `scripts/bench-cli-start.ts`.

**Increment 4**
- Modify `packages/cli/src/onboard/workspace.ts` (`base`, `resolveBaseRef`), `onboard/provisionSeat.ts` (reconcile wiring, revoke), `commands/agent.ts`, `host/provisioner.ts` and the picker files.
- Create `packages/cli/src/onboard/agentSeat.ts` and `packages/cli/src/launcher/create.ts`, each with a test.

---

## Increment 1 — fast entry (lane `01M3WA77DFGCEV344M9WTFX6NG`)

### Task 1: Split the Node gate out of `runtime.ts`

**Files:**
- Create: `packages/cli/src/nodeVersion.ts`
- Modify: `packages/cli/src/runtime.ts:9-29` (the three gate exports)
- Test: `packages/cli/src/nodeVersion.test.ts`

**Interfaces:**
- Produces: `MIN_NODE_MAJOR: 22`, `nodeUpgradeHint(): string` and `nodeVersionTooOld(version?: string): string | null`, all exported from `nodeVersion.ts` and re-exported by `runtime.ts` unchanged.

- [ ] **Step 0: Record the baseline before changing anything**

On the fresh branch, build once and time the unchanged CLI. Task 4 compares against this.

```bash
pnpm --filter @musterd/cli build
uptime
for i in $(seq 15); do /usr/bin/time -p node packages/cli/dist/bin.js --version 2>&1 >/dev/null | awk '/^real/{print $2}'; done | sort -n | sed -n '8p'   # median, seconds
for i in $(seq 15); do /usr/bin/time -p node -e 0 2>&1 >/dev/null | awk '/^real/{print $2}'; done | sort -n | sed -n '8p'                             # the floor
```

Save the two medians and the load average for the PR body and the ADR note in Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/nodeVersion.test.ts
import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, nodeVersionTooOld } from './nodeVersion.js';
import * as runtime from './runtime.js';

describe('nodeVersion (ADR 156, split for ADR 491)', () => {
  it('refuses Node below the floor and accepts the floor', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    expect(nodeVersionTooOld('v20.11.0')).toMatch(/needs Node >=22 \(you are on v20\.11\.0\)/);
    expect(nodeVersionTooOld('v22.0.0')).toBeNull();
    expect(nodeVersionTooOld('garbage')).toBeNull();
  });

  it('runtime.ts re-exports the same functions, so its callers are unchanged', () => {
    expect(runtime.nodeVersionTooOld).toBe(nodeVersionTooOld);
    expect(runtime.MIN_NODE_MAJOR).toBe(MIN_NODE_MAJOR);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/nodeVersion.test.ts`
Expected: FAIL — `Failed to resolve import "./nodeVersion.js"`.

- [ ] **Step 3: Create `nodeVersion.ts`**

```ts
// packages/cli/src/nodeVersion.ts
/**
 * The Node ≥22 gate (ADR 156), split from `runtime.ts` so `bin.ts` can run it without loading
 * `@musterd/protocol`: `runtime.ts` imports the protocol root, which measured ~740 ms on a cold
 * import (ADR 491). `runtime.ts` re-exports these three, so its callers are unchanged.
 */

/** Matches monorepo `engines.node` and published package engines (ADR 156). */
export const MIN_NODE_MAJOR = 22;

/** One-line fix shown whenever we refuse Node <22 (bin gate + service install). */
export function nodeUpgradeHint(): string {
  return `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && musterd <cmd>`;
}

/**
 * If `version` (default `process.version`) is below {@link MIN_NODE_MAJOR}, return a refusal
 * message; otherwise null.
 */
export function nodeVersionTooOld(version: string = process.version): string | null {
  const m = /^v(\d+)\./.exec(version);
  const major = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `musterd needs Node >=${MIN_NODE_MAJOR} (you are on ${version}). ` +
    `Put a matching node first on PATH, e.g.\n  ${nodeUpgradeHint()}`
  );
}
```

- [ ] **Step 4: Replace the three definitions in `runtime.ts`**

Delete `MIN_NODE_MAJOR`, `nodeUpgradeHint` and `nodeVersionTooOld` (lines 9–29), and put these lines after the existing imports:

```ts
import { MIN_NODE_MAJOR, nodeUpgradeHint, nodeVersionTooOld } from './nodeVersion.js';

export { MIN_NODE_MAJOR, nodeUpgradeHint, nodeVersionTooOld };
```

If `grep -n "nodeUpgradeHint\|MIN_NODE_MAJOR\|nodeVersionTooOld" packages/cli/src/runtime.ts` shows no other use inside `runtime.ts`, the re-export line alone is enough. Use `export { … } from './nodeVersion.js';` and drop the import.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/nodeVersion.test.ts src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/nodeVersion.ts packages/cli/src/nodeVersion.test.ts packages/cli/src/runtime.ts
git commit -m "refactor(cli): Node gate in nodeVersion.ts so bin.ts can skip the protocol root" \
  -m "Lane: 01M3WA77DFGCEV344M9WTFX6NG" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The lazy command table

**Files:**
- Create: `packages/cli/src/commandTable.ts`
- Test: `packages/cli/src/commandTable.test.ts`

**Interfaces:**
- Consumes: `Parsed` from `args.ts`, `CATALOG` from `help/catalog.ts` (test only).
- Produces: `type CommandFn = (parsed: Parsed) => Promise<number> | number`, `COMMANDS: Readonly<Record<string, () => Promise<CommandFn>>>` and `isCommand(word: string | undefined): word is string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commandTable.test.ts
import { describe, expect, it } from 'vitest';
import { COMMANDS, isCommand } from './commandTable.js';
import { CATALOG } from './help/catalog.js';

/** Dispatched but deliberately uncatalogued: hook and plumbing entry points nobody types. */
const UNCATALOGUED = ['codex-hook', 'gate', 'nudge'];

describe('command table (ADR 491)', () => {
  it('has a loader for every catalogued command', () => {
    for (const c of CATALOG) expect(Object.hasOwn(COMMANDS, c.name), c.name).toBe(true);
  });

  it('dispatches nothing the catalog does not name, except the plumbing entry points', () => {
    const extra = Object.keys(COMMANDS)
      .filter((name) => !CATALOG.some((c) => c.name === name))
      .sort();
    expect(extra).toEqual(UNCATALOGUED);
  });

  it('every loader resolves to the command function', async () => {
    for (const [name, load] of Object.entries(COMMANDS)) {
      expect(typeof (await load()), name).toBe('function');
    }
  }, 120_000);

  it('isCommand answers own keys only — never a prototype member or a seat name', () => {
    expect(isCommand('status')).toBe(true);
    expect(isCommand('wake-context')).toBe(true);
    expect(isCommand('toString')).toBe(false);
    expect(isCommand('stanley')).toBe(false);
    expect(isCommand(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/commandTable.test.ts`
Expected: FAIL — `Failed to resolve import "./commandTable.js"`.

- [ ] **Step 3: Create `commandTable.ts`**

The 54 entries are the 54 dispatch arms in today's `bin.ts`. The module paths and export names below are taken from its import list.

```ts
// packages/cli/src/commandTable.ts
import type { Parsed } from './args.js';

/** A command's entry point: every command takes the parsed argv and returns its exit code. */
export type CommandFn = (parsed: Parsed) => Promise<number> | number;

/**
 * Every command word → a lazy loader (ADR 491). `bin.ts` used to import all 53 command modules
 * before it dispatched one; loading on demand keeps `musterd --version`, help and the launcher off
 * that graph. Adding a command is one line here plus its catalog entry (`help/catalog.ts`);
 * `commandTable.test.ts` keeps the two in step.
 */
export const COMMANDS: Readonly<Record<string, () => Promise<CommandFn>>> = {
  agent: async () => (await import('./commands/agent.js')).agentCommand,
  archaeology: async () => (await import('./commands/archaeology.js')).archaeologyCommand,
  audit: async () => (await import('./commands/audit.js')).auditCommand,
  availability: async () => (await import('./commands/availability.js')).availabilityCommand,
  board: async () => (await import('./commands/board.js')).boardCommand,
  broadcast: async () => (await import('./commands/broadcast.js')).broadcastCommand,
  claim: async () => (await import('./commands/claim.js')).claimCommand,
  'codex-hook': async () => (await import('./commands/codexHook.js')).codexHookCommand,
  done: async () => (await import('./commands/done.js')).doneCommand,
  doorbell: async () => (await import('./commands/doorbell.js')).doorbellCommand,
  fmt: async () => (await import('./commands/fmt.js')).fmtCommand,
  gate: async () => (await import('./commands/gate.js')).gateCommand,
  goal: async () => (await import('./commands/goal.js')).goalCommand,
  harness: async () => (await import('./commands/harness.js')).harnessCommand,
  host: async () => (await import('./commands/host.js')).hostCommand,
  huddle: async () => (await import('./commands/huddle.js')).huddleCommand,
  human: async () => (await import('./commands/human.js')).humanCommand,
  inbox: async () => (await import('./commands/inbox.js')).inboxCommand,
  init: async () => (await import('./commands/init.js')).initCommand,
  insight: async () => (await import('./commands/insight.js')).insightCommand,
  integration: async () => (await import('./commands/integration.js')).integrationCommand,
  lane: async () => (await import('./commands/lane.js')).laneCommand,
  lanes: async () => (await import('./commands/lane.js')).lanesCommand,
  live: async () => (await import('./commands/live.js')).liveCommand,
  memory: async () => (await import('./commands/memory.js')).memoryCommand,
  next: async () => (await import('./commands/next.js')).nextCommand,
  node: async () => (await import('./commands/node.js')).nodeCommand,
  notify: async () => (await import('./commands/notify.js')).notifyCommand,
  nudge: async () => (await import('./commands/nudge.js')).nudgeCommand,
  reap: async () => (await import('./commands/reap.js')).reapCommand,
  reclaim: async () => (await import('./commands/reclaim.js')).reclaimCommand,
  reload: async () => (await import('./commands/reload.js')).reloadCommand,
  report: async () => (await import('./commands/report.js')).reportCommand,
  requests: async () => (await import('./commands/requests.js')).requestsCommand,
  reset: async () => (await import('./commands/reset.js')).resetCommand,
  residency: async () => (await import('./commands/residency.js')).residencyCommand,
  role: async () => (await import('./commands/role.js')).roleCommand,
  seed: async () => (await import('./commands/seed.js')).seedCommand,
  send: async () => (await import('./commands/send.js')).sendCommand,
  serve: async () => (await import('./commands/serve.js')).serveCommand,
  service: async () => (await import('./commands/service.js')).serviceCommand,
  session: async () => (await import('./commands/session.js')).sessionCommand,
  status: async () => (await import('./commands/status.js')).statusCommand,
  store: async () => (await import('./commands/store.js')).storeCommand,
  stream: async () => (await import('./commands/stream.js')).streamCommand,
  surface: async () => (await import('./commands/surface.js')).surfaceCommand,
  team: async () => (await import('./commands/team.js')).teamCommand,
  toolkit: async () => (await import('./commands/toolkit.js')).toolkitCommand,
  trace: async () => (await import('./commands/trace.js')).traceCommand,
  unbind: async () => (await import('./commands/unbind.js')).unbindCommand,
  uninstall: async () => (await import('./commands/uninstall.js')).uninstallCommand,
  'wake-context': async () => (await import('./commands/wake-context.js')).wakeContextCommand,
  whoami: async () => (await import('./commands/whoami.js')).whoamiCommand,
  wire: async () => (await import('./commands/wire.js')).wireCommand,
};

/** A command word this CLI dispatches — own keys only, so `toString` is never a command. */
export function isCommand(word: string | undefined): word is string {
  return word !== undefined && Object.hasOwn(COMMANDS, word);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/commandTable.test.ts`
Expected: PASS (4 tests). The "every loader" test imports all 53 modules and takes several seconds.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commandTable.ts packages/cli/src/commandTable.test.ts
git commit -m "feat(cli): lazy command table — one loader per command word (ADR 491)" \
  -m "Lane: 01M3WA77DFGCEV344M9WTFX6NG" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: A light `bin.ts`, held by an import-closure test

**Files:**
- Modify: `packages/cli/src/bin.ts` (whole file)
- Test: `packages/cli/src/importClosure.test.ts`

**Interfaces:**
- Consumes: `COMMANDS`, `isCommand` (Task 2); `nodeVersionTooOld` (Task 1).
- Produces: `staticClosure(entry: string): { files: Set<string>; packages: Set<string> }`. It is exported from the test file and reused by Task 18 inside the same file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/importClosure.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** `import … from '…'` / `export … from '…'`, skipping `import type` / `export type`. */
const FROM_RE = /^\s*(?:import|export)\s+(?!type[\s{])[^'";]*?\sfrom\s*['"]([^'"]+)['"]/gm;
/** `import '…'` (side effect). A dynamic `import('…')` matches neither — it is not static. */
const SIDE_EFFECT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm;

/**
 * The static import closure of a source file (ADR 491): every local `.ts` file it loads before
 * its first line runs, and every bare package. `node:` builtins are ignored. `@musterd/*` keeps
 * its subpath, because a subpath like `@musterd/protocol/build-stamp` is light where the root is not.
 */
export function staticClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(FROM_RE), ...text.matchAll(SIDE_EFFECT_RE)].map((m) => m[1]!);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
        if (!existsSync(target)) throw new Error(`${file}: unresolved import ${spec}`);
        queue.push(target);
        continue;
      }
      const parts = spec.split('/');
      packages.add(spec.startsWith('@musterd/') ? spec : spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
    }
  }
  return { files, packages };
}

const rel = (files: Set<string>) => [...files].map((f) => f.slice(SRC.length + 1)).sort();

describe('static import closures (ADR 491)', () => {
  it('bin.ts loads no command, client, config, telemetry or protocol root before it runs', () => {
    const { files, packages } = staticClosure(join(SRC, 'bin.ts'));
    expect(rel(files).filter((f) => f.startsWith('commands/'))).toEqual([]);
    expect(rel(files)).not.toContain('client.ts');
    expect(rel(files)).not.toContain('config.ts');
    expect([...packages].sort()).toEqual(['@musterd/protocol/build-stamp', 'picocolors']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/importClosure.test.ts`
Expected: FAIL. Today's closure contains `commands/agent.ts` and dozens more, `client.ts`, `config.ts`, and packages including `@musterd/telemetry` and `@opentelemetry/api`.

- [ ] **Step 3: Rewrite `bin.ts`**

```ts
#!/usr/bin/env node
import { parseArgs, type Parsed } from './args.js';
import { COMMANDS, isCommand } from './commandTable.js';
import { CliError } from './errors.js';
import { exitAfterFlush } from './exit.js';
import { nodeVersionTooOld } from './nodeVersion.js';
import { setColorEnabled, theme } from './render/theme.js';
import { sym } from './render/ui.js';
import { cliVersion } from './version.js';

/*
 * Everything heavy loads on demand (ADR 491): a command module only when it runs, help and its
 * catalog only when help is asked for, telemetry only when an OTLP endpoint is configured, and
 * the reachability nudge and the tab title only after a command returned. `importClosure.test.ts`
 * holds this file's static import graph to that.
 */
async function main(argv: string[]): Promise<number> {
  // Honor `--no-color` before any render. NO_COLOR / non-TTY are handled by picocolors' auto-detect;
  // this is the one place the flag is wired, and every command renders through the theme seam.
  if (argv.includes('--no-color')) setColorEnabled(false);

  const command = argv[0];
  const rest = parseArgs(argv.slice(1));

  // `--version`/`-v`/`version` print the CLI version and exit (ADR 067) — checked before help so
  // `musterd --version` isn't swallowed by the help path. Allowed on Node <22 (ADR 156).
  if (
    command === 'version' ||
    command === '--version' ||
    command === '-v' ||
    rest.flags['version'] === true ||
    argv.some((a) => a === '--version' || a === '-v')
  ) {
    process.stdout.write(cliVersion() + '\n');
    return 0;
  }

  // Fail fast on Node <22 before serve/service/init can load better-sqlite3 under a bad ABI (ADR 156).
  const tooOld = nodeVersionTooOld();
  if (tooOld) {
    process.stderr.write(`${theme.err('✗')} ${tooOld}\n`);
    return 1;
  }

  // `--help`/`-h` anywhere prints usage and exits — never runs the command.
  const wantsHelp =
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    rest.flags['help'] === true ||
    argv.slice(1).some((a) => a === '--help' || a === '-h');
  if (wantsHelp) {
    const help = await import('./render/help.js');
    if (rest.flags['json'] === true) {
      process.stdout.write(help.renderHelpJson() + '\n');
      return 0;
    }
    const topic = command === 'help' ? rest.positionals[0] : undefined;
    if (topic) {
      const detail = help.renderCommandHelp(topic) ?? help.renderGroupHelp(topic);
      if (detail) {
        process.stdout.write(detail + '\n');
        return 0;
      }
      const near = help.nearestCommand(topic);
      process.stderr.write(
        `${theme.warn(sym.warn)} no command "${topic}"${near ? ` — did you mean "${near}"?` : ''}\n`,
      );
    }
    process.stdout.write(help.renderHelp({ full: rest.flags['full'] === true }) + '\n');
    return 0;
  }

  // The other word order: `musterd agent help`. `wantsCommandHelp` only ever answers yes to exactly
  // one `help` positional, so the help module loads only then.
  if (rest.positionals.length === 1 && rest.positionals[0] === 'help') {
    const { renderCommandHelp, wantsCommandHelp } = await import('./render/help.js');
    if (wantsCommandHelp(command, rest.positionals)) {
      process.stdout.write(renderCommandHelp(command)! + '\n');
      return 0;
    }
  }

  const code = await instrumentedDispatch(command, rest);
  // Agent-side reachability (ADR 046) and the seat tab title (ADR 160): best-effort postambles.
  const { reachabilityNudge } = await import('./commands/helpers.js');
  const nudge = await reachabilityNudge(command, rest);
  if (nudge) process.stderr.write(nudge + '\n');
  const { emitTerminalTitle, terminalTitleFor } = await import('./render/title.js');
  const title = terminalTitleFor(command, rest);
  if (title) emitTerminalTitle(title);
  return code;
}

/**
 * CLI telemetry (ADR 089): run the command inside a `musterd.cli.command` span when an OTLP
 * endpoint is configured — the command word only, never argv. Skipped for `serve` (the daemon owns
 * that process's telemetry), `codex-hook`, `inbox --interrupt-check`, `gate` and `trace` (each rides
 * a tool-call budget an SDK boot would blow). Both modules load only when telemetry may run.
 */
async function instrumentedDispatch(command: string, rest: Parsed): Promise<number> {
  const skip =
    command === 'serve' ||
    command === 'codex-hook' ||
    (command === 'inbox' && rest.flags['interrupt-check'] === true) ||
    command === 'gate' ||
    command === 'trace';
  if (skip) return dispatch(command, rest);
  const { startTelemetry, telemetryEnabled } = await import('@musterd/telemetry');
  if (!telemetryEnabled()) return dispatch(command, rest);
  const telemetry = await startTelemetry({ serviceName: 'musterd-cli' });
  const { SpanStatusCode, trace } = await import('@opentelemetry/api');
  try {
    return await trace
      .getTracer('musterd-cli')
      .startActiveSpan('musterd.cli.command', async (span) => {
        span.setAttribute('musterd.command', command);
        try {
          const code = await dispatch(command, rest);
          span.setAttribute('musterd.exit_code', code);
          span.setStatus({ code: code === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
          return code;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      });
  } finally {
    await telemetry.shutdown({ timeoutMs: 1000 });
  }
}

async function dispatch(command: string, rest: Parsed): Promise<number> {
  const load = isCommand(command) ? COMMANDS[command] : undefined;
  if (!load) {
    const { nearestCommand } = await import('./render/help.js');
    const near = nearestCommand(command);
    const suggestion = near ? ` — did you mean "${near}"?` : '';
    throw new CliError(`unknown command "${command}"${suggestion}  ·  musterd help`, 2);
  }
  const run = await load();
  return run(rest);
}

main(process.argv.slice(2))
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`${theme.err('✗')} ${err.message}\n`);
      exitAfterFlush(err.exitCode);
      return;
    }
    process.stderr.write(`${theme.err(sym.err)} ${(err as Error).message}\n`);
    exitAfterFlush(1);
  });
```

- [ ] **Step 4: Run the closure test, then the CLI suite**

Run: `pnpm --filter @musterd/cli exec vitest run src/importClosure.test.ts`
Expected: PASS.

Run: `pnpm --filter @musterd/cli build && pnpm --filter @musterd/cli test`
Expected: PASS. `wall.canary.e2e.test.ts` spawns the rebuilt `dist/bin.js`, so it exercises the lazy dispatch end to end.

- [ ] **Step 5: Smoke the built binary by hand**

```bash
node packages/cli/dist/bin.js --version          # the version string, exit 0
node packages/cli/dist/bin.js help | head -5     # the banner, exit 0
node packages/cli/dist/bin.js statuss; echo $?   # ✗ unknown command "statuss" — did you mean "status"?  ·  musterd help → 2
node packages/cli/dist/bin.js status | head -3   # the roster (the daemon is up), exit 0
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/bin.ts packages/cli/src/importClosure.test.ts
git commit -m "perf(cli): bin.ts loads commands, help and telemetry on demand (ADR 491)" \
  -m "Lane: 01M3WA77DFGCEV344M9WTFX6NG" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Bench, docs, PR

**Files:**
- Create: `scripts/bench-cli-start.ts`
- Modify: `package.json` (root, `scripts`), `docs/architecture/04-cli.md` (file tree), `docs/decisions/491-seat-launcher.md` (a dated `## Consequences` note)

- [ ] **Step 1: Write the bench**

```ts
// scripts/bench-cli-start.ts
/*
 * Cold-start bench for the CLI front door (ADR 491). Spawns the built CLI N times per probe and
 * prints the median and p90 wall time. Report the numbers; never assert them in CI — on
 * 2026-10-01 a machine at load average 44 measured `--version` at 1.4–2.4 s.
 *
 *   pnpm bench:cli-start             # 15 runs per probe
 *   pnpm bench:cli-start --runs 30
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'packages', 'cli', 'dist', 'bin.js');
const at = process.argv.indexOf('--runs');
const RUNS = at > 0 ? Number(process.argv[at + 1]) : 15;

interface Probe {
  name: string;
  argv: string[];
  env?: Record<string, string>;
}

export const PROBES: Probe[] = [
  { name: 'node -e 0 (floor)', argv: ['-e', '0'] },
  { name: 'musterd --version', argv: [BIN, '--version'] },
  { name: 'musterd help', argv: [BIN, 'help'] },
];

function once(p: Probe): number {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, p.argv, {
    stdio: 'ignore',
    env: { ...process.env, NO_COLOR: '1', ...p.env },
  });
  if (r.status !== 0) throw new Error(`${p.name}: exit ${r.status}`);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

for (const p of PROBES) {
  const xs = Array.from({ length: RUNS }, () => once(p));
  console.log(
    `${p.name.padEnd(28)} median ${quantile(xs, 0.5).toFixed(0).padStart(5)} ms · p90 ${quantile(xs, 0.9).toFixed(0).padStart(5)} ms`,
  );
}
```

- [ ] **Step 2: Add the root script**

In the root `package.json` `scripts`, beside `adr:next`:

```json
"bench:cli-start": "node --disable-warning=ExperimentalWarning scripts/bench-cli-start.ts",
```

- [ ] **Step 3: Measure after, against Task 1's baseline**

```bash
pnpm --filter @musterd/cli build && uptime && pnpm bench:cli-start
```

Compare the `musterd --version` median with Task 1 Step 0's. Measure at a similar load average, or say in the note that the loads differ.

- [ ] **Step 4: Docs**

In `docs/architecture/04-cli.md`'s tree, replace the `bin.ts` and `runtime.ts` lines and add two lines in alphabetical place:

```
  bin.ts              // shebang entry: version, Node gate, help, then dispatch through the lazy command table — commands, help, telemetry, the nudge and the tab title load on demand (ADR 491); map errors -> exit codes
  commandTable.ts     // every command word → a lazy loader, so `--version`, help and the launcher never load the 53 command modules (ADR 491); commandTable.test.ts keeps it in step with the help catalog
  nodeVersion.ts      // the Node ≥22 gate, split from runtime.ts so bin.ts runs it without loading @musterd/protocol (ADR 156/491)
  runtime.ts          // packaged-vs-checkout detection for doctor / bin (ADR 156); re-exports the Node gate from nodeVersion.ts
```

Append to `docs/decisions/491-seat-launcher.md` `## Consequences` (Consequences stays editable; `## Decision` is frozen once this lands):

```md
- **2026-10-xx — increment 1 measured.** `pnpm bench:cli-start` at load average <N>: `musterd --version`
  median <before> ms → <after> ms, `musterd help` <before> ms → <after> ms, against a `node -e 0` floor of
  <floor> ms (lane `01M3WA77DFGCEV344M9WTFX6NG`).
```

Fill in the measured numbers. The `<…>` markers above are data to read off Step 3's output, not text to keep.

- [ ] **Step 5: Gates, commit, PR**

```bash
pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check
git add scripts/bench-cli-start.ts package.json docs/architecture/04-cli.md docs/decisions/491-seat-launcher.md
git commit -m "chore(cli): cold-start bench + docs for the lazy entry (ADR 491)" \
  -m "Lane: 01M3WA77DFGCEV344M9WTFX6NG" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/front-door-1-fast-entry
gh pr create --title "Front door 1/4: bin.ts loads commands on demand (ADR 491)" --body "<lane, bench table, test list; end with the Claude Code attribution footer>"
gh pr merge --squash --auto --delete-branch
```

After the merge: `lane_submit {pr, sha}` for lane `01M3WA77DFGCEV344M9WTFX6NG`, and do what its reply says.

---

## Increment 2 — launch by name (lane `01M3WA7J4YRC21TCGGW9PSDK9E`)

### Task 5: Labels and seat addresses

**Files:**
- Create: `packages/cli/src/launcher/labels.ts`, `packages/cli/src/launcher/address.ts`
- Test: `packages/cli/src/launcher/address.test.ts`

**Interfaces:**
- Produces: `harnessLabel(id: string): string`, `LAUNCHABLE_HARNESSES: readonly string[]`, `seatAddress(team, project, member, host?): string` and `serverHost(server): string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/address.test.ts
import { describe, expect, it } from 'vitest';
import { seatAddress, serverHost } from './address.js';
import { harnessLabel, LAUNCHABLE_HARNESSES } from './labels.js';

describe('seat addresses (ADR 491)', () => {
  it('is team/project/member, host-qualified only when asked', () => {
    expect(seatAddress('revive', 'agents', 'stanley')).toBe('revive/agents/stanley');
    expect(seatAddress('revive', 'agents', 'stanley', 'musterd.io')).toBe(
      'revive@musterd.io/agents/stanley',
    );
  });

  it('serverHost keeps the port and passes a non-URL through', () => {
    expect(serverHost('http://127.0.0.1:4849')).toBe('127.0.0.1:4849');
    expect(serverHost('https://musterd.io/')).toBe('musterd.io');
    expect(serverHost('not a url')).toBe('not a url');
  });
});

describe('harness labels', () => {
  it('says the word a person types', () => {
    expect(harnessLabel('claude-code')).toBe('claude');
    expect(harnessLabel('codex')).toBe('codex');
    expect(harnessLabel('shell')).toBe('shell');
    expect(harnessLabel('something-new')).toBe('something-new');
  });

  it('lists the launchable harnesses in registry order', () => {
    expect(LAUNCHABLE_HARNESSES).toEqual(['claude-code', 'cursor', 'codex', 'opencode', 'grok']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/address.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement both modules**

```ts
// packages/cli/src/launcher/labels.ts
/** Short harness labels for rows and receipts: the word a person types to start it (ADR 491). */
const LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  cursor: 'cursor',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
  musterd: 'musterd',
  shell: 'shell',
  human: 'human',
};

export function harnessLabel(id: string): string {
  return LABELS[id] ?? id;
}

/**
 * The harnesses with a terminal entry, in ADR 281 registry order. Kept here, not read from the
 * registry, because the picker paints before any adapter loads; `interactive.test.ts` holds the
 * two in step.
 */
export const LAUNCHABLE_HARNESSES: readonly string[] = [
  'claude-code',
  'cursor',
  'codex',
  'opencode',
  'grok',
];
```

```ts
// packages/cli/src/launcher/address.ts
/**
 * A seat's address (ADR 491): `team/project/member`, or `team@host/project/member` when two servers
 * on this machine host a team with the same name.
 */
export function seatAddress(team: string, project: string, member: string, host?: string): string {
  return `${host ? `${team}@${host}` : team}/${project}/${member}`;
}

/** The host part of a server URL (`127.0.0.1:4849`, `musterd.io`), or the input when it is not a URL. */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/address.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/labels.ts packages/cli/src/launcher/address.ts packages/cli/src/launcher/address.test.ts
git commit -m "feat(cli): launcher labels and seat addresses (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: `launcher.json` — recents and the catalog snapshot

**Files:**
- Create: `packages/cli/src/launcher/store.ts`
- Test: `packages/cli/src/launcher/store.test.ts`

**Interfaces:**
- Consumes: `machineConfigRoot` (`machinePaths.ts`).
- Produces: zod schemas `SeatSchema`, `SnapshotSchema` and `LauncherFileSchema`; types `Seat`, `SeatProblem`, `TeamEntry`, `Snapshot`, `Recent` and `LauncherFile`; `EMPTY_LAUNCHER_FILE`, `launcherFilePath(env?)`, `readLauncherFile(path, now?)`, `writeLauncherFile(path, file)`, `withLaunch(file, seat, harness, mode, at)`, `withExit(file, address, at, exit)`, `withSnapshot(file, snapshot)` and `lastUsedAt(seat, file)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/store.test.ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LAUNCHER_FILE,
  lastUsedAt,
  launcherFilePath,
  readLauncherFile,
  type Seat,
  withExit,
  withLaunch,
  withSnapshot,
  writeLauncherFile,
} from './store.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-launcher-store-'));
  path = join(dir, 'launcher.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'revive/agents/stanley',
  team: 'revive',
  project: 'agents',
  member: 'stanley',
  server: 'http://127.0.0.1:4849',
  path: '/tmp/stanley',
  kind: 'agent',
  harnesses: ['claude-code'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});

describe('launcher.json (ADR 491)', () => {
  it('lives beside config.json', () => {
    expect(launcherFilePath({ MUSTERD_CONFIG: '/x/y/config.json' })).toBe('/x/y/launcher.json');
  });

  it('a missing file reads as empty', () => {
    expect(readLauncherFile(path)).toEqual(EMPTY_LAUNCHER_FILE);
  });

  it('round-trips launches, exits and the snapshot, 0600', () => {
    let f = withLaunch(EMPTY_LAUNCHER_FILE, seat(), 'claude-code', 'fresh', 1_000);
    f = withExit(f, 'revive/agents/stanley', 61_000, 0);
    f = withSnapshot(f, { taken_at: 500, seats: [seat()], teams: [{ team: 'revive', here: true }] });
    writeLauncherFile(path, f);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = readLauncherFile(path);
    expect(back.last).toBe('revive/agents/stanley');
    expect(back.seats['revive/agents/stanley']).toEqual({
      path: '/tmp/stanley',
      harness: 'claude-code',
      mode: 'fresh',
      launched_at: 1_000,
      ended_at: 61_000,
      exit: 0,
    });
    expect(back.snapshot?.seats[0]?.member).toBe('stanley');
  });

  it('sets a corrupt file aside and reads empty — never throws', () => {
    writeFileSync(path, '{not json');
    expect(readLauncherFile(path, 42)).toEqual(EMPTY_LAUNCHER_FILE);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toContain('launcher.json.corrupt-42');
  });

  it('treats an off-schema file as corrupt too', () => {
    writeFileSync(path, JSON.stringify({ version: 9 }));
    expect(readLauncherFile(path, 7)).toEqual(EMPTY_LAUNCHER_FILE);
    expect(readFileSync(join(dir, 'launcher.json.corrupt-7'), 'utf8')).toContain('"version":9');
  });

  it('refuses to write an invalid object', () => {
    expect(() =>
      writeLauncherFile(path, { ...EMPTY_LAUNCHER_FILE, last: 3 as unknown as string }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('last used is the newer of the launcher record and the captured session start', () => {
    const s = seat({ last_session: { harness: 'claude-code', started_at: 5_000, ended_at: null } });
    expect(lastUsedAt(s, EMPTY_LAUNCHER_FILE)).toBe(5_000);
    const f = withLaunch(EMPTY_LAUNCHER_FILE, s, 'claude-code', 'fresh', 9_000);
    expect(lastUsedAt(s, f)).toBe(9_000);
    expect(lastUsedAt(seat(), EMPTY_LAUNCHER_FILE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store.js"`.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/store.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { machineConfigRoot } from '../machinePaths.js';

/*
 * ~/.musterd/launcher.json (ADR 491 Decision 8): the launcher's recents and a secret-free snapshot
 * of the last seat catalog — what the first screen paints from, so the paint never waits on the
 * protocol schemas. Beside config.json, so MUSTERD_CONFIG isolates it in tests (ADR 190). Zod is the
 * only package this module loads: it is on the paint path.
 */

export const LAUNCHER_FILE = 'launcher.json';

const SessionSchema = z
  .object({
    harness: z.string().min(1),
    started_at: z.number().int(),
    ended_at: z.number().int().nullable(),
  })
  .strict();

const ProblemSchema = z
  .object({
    kind: z.enum(['binding-legacy', 'binding-invalid', 'provisioning-legacy', 'provisioning-invalid']),
    fix: z.string().min(1),
  })
  .strict();
export type SeatProblem = z.infer<typeof ProblemSchema>;

/** One seat the launcher can start — no secret, and no harness session id (a resume reads it fresh). */
export const SeatSchema = z
  .object({
    address: z.string().min(1),
    team: z.string().min(1),
    project: z.string().min(1),
    member: z.string().min(1),
    server: z.string(),
    path: z.string().min(1),
    kind: z.enum(['agent', 'human']),
    harnesses: z.array(z.string()),
    remote: z.string().nullable(),
    last_session: SessionSchema.nullable(),
    problem: ProblemSchema.nullable(),
  })
  .strict();
export type Seat = z.infer<typeof SeatSchema>;

export const TeamEntrySchema = z.object({ team: z.string().min(1), here: z.boolean() }).strict();
export type TeamEntry = z.infer<typeof TeamEntrySchema>;

export const SnapshotSchema = z
  .object({
    taken_at: z.number().int(),
    seats: z.array(SeatSchema),
    teams: z.array(TeamEntrySchema),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

const RecentSchema = z
  .object({
    path: z.string().min(1),
    harness: z.string().min(1),
    mode: z.enum(['fresh', 'resume']),
    launched_at: z.number().int(),
    ended_at: z.number().int().nullable(),
    exit: z.number().int().nullable(),
  })
  .strict();
export type Recent = z.infer<typeof RecentSchema>;

export const LauncherFileSchema = z
  .object({
    version: z.literal(1),
    last: z.string().nullable(),
    seats: z.record(z.string(), RecentSchema),
    snapshot: SnapshotSchema.nullable(),
  })
  .strict();
export type LauncherFile = z.infer<typeof LauncherFileSchema>;

export const EMPTY_LAUNCHER_FILE: LauncherFile = { version: 1, last: null, seats: {}, snapshot: null };

export function launcherFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(machineConfigRoot(env), LAUNCHER_FILE);
}

/** Read launcher.json. Missing → empty. Unreadable, not JSON, or off-schema → set aside as
 *  `<file>.corrupt-<now>` and empty. Never throws: recents must never block a launch. */
export function readLauncherFile(path: string, now: number = Date.now()): LauncherFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return structuredClone(EMPTY_LAUNCHER_FILE);
  }
  try {
    const parsed = LauncherFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // not JSON — set aside below
  }
  try {
    renameSync(path, `${path}.corrupt-${now}`);
  } catch {
    // best effort
  }
  return structuredClone(EMPTY_LAUNCHER_FILE);
}

/** Validate, then publish atomically (tmp + rename, 0600). Throws only on an invalid object. */
export function writeLauncherFile(path: string, file: LauncherFile): void {
  const valid = LauncherFileSchema.parse(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function withLaunch(
  file: LauncherFile,
  seat: Seat,
  harness: string,
  mode: 'fresh' | 'resume',
  at: number,
): LauncherFile {
  return {
    ...file,
    last: seat.address,
    seats: {
      ...file.seats,
      [seat.address]: { path: seat.path, harness, mode, launched_at: at, ended_at: null, exit: null },
    },
  };
}

export function withExit(file: LauncherFile, address: string, at: number, exit: number): LauncherFile {
  const prior = file.seats[address];
  if (!prior) return file;
  return { ...file, seats: { ...file.seats, [address]: { ...prior, ended_at: at, exit } } };
}

export function withSnapshot(file: LauncherFile, snapshot: Snapshot): LauncherFile {
  return { ...file, snapshot };
}

/** When a seat was last used: the newer of the launcher's record and the captured session start. */
export function lastUsedAt(seat: Seat, file: LauncherFile): number | null {
  const mine = file.seats[seat.address]?.launched_at ?? null;
  const captured = seat.last_session?.started_at ?? null;
  if (mine === null) return captured;
  if (captured === null) return mine;
  return Math.max(mine, captured);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/store.ts packages/cli/src/launcher/store.test.ts
git commit -m "feat(cli): launcher.json — recents + the secret-free catalog snapshot (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The seat catalog

**Files:**
- Create: `packages/cli/src/launcher/catalog.ts`
- Test: `packages/cli/src/launcher/catalog.test.ts`

**Interfaces:**
- Consumes: `loadBinding(dir)` and `type Config` (`config.ts`), `loadProvisioning(dir)` (`onboard/manifest.ts`), `canonicalServer` (`host/registry.ts`), `TOKEN_PREFIXES` (`@musterd/protocol`), `seatAddress` and `serverHost` (Task 5), and the `Seat`, `SeatProblem`, `Snapshot` and `TeamEntry` types (Task 6).
- Produces: `interface CatalogInput { home: string; config: Pick<Config, 'bindings' | 'identities' | 'knownIdentities'>; now?: number }`, `interface Catalog extends Snapshot { stale: string[] }`, `buildCatalog(input): Catalog` and `originRepoName(dir): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/catalog.test.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog, originRepoName } from './catalog.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-catalog-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const emptyConfig = { bindings: {}, identities: {}, knownIdentities: [] };
const binding = (team: string, name: string, extra: Record<string, unknown> = {}) => ({
  version: 2,
  server: 'http://127.0.0.1:4849',
  team,
  claim: { mode: 'seat', name },
  ...extra,
});
const provisioned = (desired: string[]) => ({
  version: 3,
  toolkit: '',
  desired,
  contributions: {},
  provisionedAt: '2026-10-01T00:00:00.000Z',
});

function seatDir(
  team: string,
  project: string,
  member: string,
  b: unknown,
  p?: unknown,
  root = join(home, 'musterd'),
): string {
  const dir = join(root, team, project, member);
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(join(dir, '.musterd', 'binding.json'), typeof b === 'string' ? b : JSON.stringify(b));
  if (p !== undefined) writeFileSync(join(dir, '.musterd', 'provisioned.json'), JSON.stringify(p));
  return dir;
}

describe('buildCatalog (ADR 491)', () => {
  it('lists every layout Workspace with its team, project, member, harnesses and last session', () => {
    seatDir(
      'revive',
      'agents',
      'stanley',
      binding('revive', 'stanley', {
        agent_key: 'mskey_SECRET',
        session: { harness: 'claude-code', id: 'sess-SECRET-ID', started_at: 1_000 },
      }),
      provisioned(['claude-code', 'musterd']),
    );
    seatDir('revive', 'agents', 'gptbot', binding('revive', 'gptbot'), provisioned(['codex']));
    const cat = buildCatalog({ home, config: emptyConfig, now: 99 });
    expect(cat.taken_at).toBe(99);
    expect(cat.seats.map((s) => s.address)).toEqual(['revive/agents/gptbot', 'revive/agents/stanley']);
    expect(cat.seats[1]).toEqual({
      address: 'revive/agents/stanley',
      team: 'revive',
      project: 'agents',
      member: 'stanley',
      server: 'http://127.0.0.1:4849',
      path: join(home, 'musterd', 'revive', 'agents', 'stanley'),
      kind: 'agent',
      harnesses: ['claude-code', 'musterd'],
      remote: null,
      last_session: { harness: 'claude-code', started_at: 1_000, ended_at: null },
      problem: null,
    });
    expect(cat.teams).toEqual([{ team: 'revive', here: true }]);
  });

  it('carries no secret and no session id — the snapshot is written to disk', () => {
    seatDir(
      'revive',
      'agents',
      'dolly',
      binding('revive', 'dolly', {
        agent_key: 'mskey_a1',
        grant: 'msgr_b2',
        seat_credential: 'msac_c3',
        session_lease: 'msls_d4',
        session: { harness: 'codex', id: 'sess-zzz', started_at: 1 },
      }),
    );
    const text = JSON.stringify(buildCatalog({ home, config: emptyConfig }));
    expect(containsMusterdCredential(text)).toBe(false);
    expect(text).not.toContain('sess-zzz');
  });

  it('reads a human seat from its credential prefix, without copying it', () => {
    seatDir('revive', 'agents', 'nick', binding('revive', 'nick', { agent_key: 'mscr_human' }));
    const [nick] = buildCatalog({ home, config: emptyConfig }).seats;
    expect(nick?.kind).toBe('human');
  });

  it('flags a broken Workspace with the exact fix instead of dropping it', () => {
    const legacy = seatDir('revive', 'agents', 'old', {
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'old' },
    });
    const broken = seatDir('revive', 'agents', 'bad', '{not json');
    const v2 = seatDir('revive', 'agents', 'mid', binding('revive', 'mid'), {
      version: 2,
      profile: '',
      desired: ['claude-code'],
      contributions: {},
      provisionedAt: 'x',
    });
    const byMember = new Map(buildCatalog({ home, config: emptyConfig }).seats.map((s) => [s.member, s]));
    expect(byMember.get('old')?.problem).toEqual({
      kind: 'binding-legacy',
      fix: `cd ${legacy} && musterd harness configure`,
    });
    expect(byMember.get('bad')?.problem).toEqual({
      kind: 'binding-invalid',
      fix: `cd ${broken} && musterd init --check`,
    });
    expect(byMember.get('mid')?.problem?.kind).toBe('provisioning-legacy');
    expect(byMember.get('mid')?.problem?.fix).toBe(`cd ${v2} && musterd harness configure`);
  });

  it('adds registry Workspaces outside the layout and counts entries whose folder is gone', () => {
    const outside = seatDir('x', 'y', 'ext', binding('dawn', 'ext'), undefined, join(home, 'elsewhere'));
    const gone = join(home, 'deleted', 'seat');
    const cat = buildCatalog({
      home,
      config: {
        ...emptyConfig,
        bindings: { [outside]: { team: 'dawn', seat: 'ext' }, [gone]: { team: 'dawn', seat: 'gone' } },
      },
    });
    expect(cat.seats.map((s) => s.address)).toEqual(['dawn/y/ext']);
    expect(cat.stale).toEqual([gone]);
  });

  it('host-qualifies one address served by two servers', () => {
    seatDir('revive', 'agents', 'stanley', binding('revive', 'stanley'));
    seatDir(
      'revive',
      'agents',
      'stanley',
      { ...binding('revive', 'stanley'), server: 'https://musterd.io' },
      undefined,
      join(home, 'elsewhere'),
    );
    const outside = join(home, 'elsewhere', 'revive', 'agents', 'stanley');
    const cat = buildCatalog({
      home,
      config: { ...emptyConfig, bindings: { [outside]: { team: 'revive', seat: 'stanley' } } },
    });
    expect(cat.seats.map((s) => s.address).sort()).toEqual([
      'revive@127.0.0.1:4849/agents/stanley',
      'revive@musterd.io/agents/stanley',
    ]);
  });

  it('lists a team this machine holds an identity for, even with no Workspace here', () => {
    const cat = buildCatalog({
      home,
      config: {
        ...emptyConfig,
        identities: { acme: { name: 'nick', key: 'mscr_x', surface: 'cli' } },
      },
    });
    expect(cat.teams).toEqual([{ team: 'acme', here: false }]);
    expect(JSON.stringify(cat)).not.toContain('mscr_x');
  });

  it('reads the origin remote name from git files, without a subprocess', () => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Org/musterd.git'], { cwd: repo });
    expect(originRepoName(repo)).toBe('musterd');
    expect(originRepoName(join(home, 'nope'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/catalog.test.ts`
Expected: FAIL — `Failed to resolve import "./catalog.js"`.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/catalog.ts
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TOKEN_PREFIXES } from '@musterd/protocol';
import { loadBinding, type Config } from '../config.js';
import { canonicalServer } from '../host/registry.js';
import { loadProvisioning } from '../onboard/manifest.js';
import { seatAddress, serverHost } from './address.js';
import type { Seat, SeatProblem, Snapshot, TeamEntry } from './store.js';

/*
 * The seat catalog (ADR 491 Decision 7): every Workspace on this machine, read from
 * config.bindings plus a scan of the ADR 447 layout (~/musterd/<team>/<project>/<member>). Each
 * binding is parsed through the protocol schema by `loadBinding` (exact folder, no env, no walk),
 * and only named non-secret fields are copied out. It runs AFTER the first paint: it loads the
 * protocol package, which measured ~740 ms cold.
 */

export interface CatalogInput {
  /** The `~` the layout hangs off. A parameter, not `homedir()`: tests do not pin HOME. */
  home: string;
  config: Pick<Config, 'bindings' | 'identities' | 'knownIdentities'>;
  now?: number;
}

export interface Catalog extends Snapshot {
  /** Registry entries whose folder is gone — `musterd init --prune-bindings --apply` drops them. */
  stale: string[];
}

type Draft = Omit<Seat, 'address'>;

export function buildCatalog(input: CatalogInput): Catalog {
  const roof = join(input.home, 'musterd');
  const realRoof = realpathOr(roof);
  const stale: string[] = [];
  const dirs = new Set<string>();
  for (const dir of Object.keys(input.config.bindings)) {
    if (!existsSync(join(dir, '.musterd', 'binding.json'))) {
      stale.push(dir);
      continue;
    }
    dirs.add(realpathOr(dir));
  }
  for (const dir of layoutWorkspaces(roof)) dirs.add(realpathOr(dir));

  const drafts: Draft[] = [];
  for (const dir of [...dirs].sort()) {
    const draft = readSeat(dir, realRoof);
    if (draft) drafts.push(draft);
  }
  const seats = addressed(drafts);
  const teamNames = new Set<string>([
    ...Object.keys(input.config.identities),
    ...input.config.knownIdentities.map((i) => i.team),
    ...seats.map((s) => s.team),
  ]);
  const teams: TeamEntry[] = [...teamNames]
    .sort()
    .map((team) => ({ team, here: seats.some((s) => s.team === team) }));
  return { taken_at: input.now ?? Date.now(), seats, teams, stale: stale.sort() };
}

function readSeat(dir: string, roof: string): Draft | null {
  const layout = layoutParts(dir, roof);
  const got = loadBinding(dir);
  if (got.kind === 'missing') return null;
  if (got.kind !== 'valid') {
    if (!layout) return null; // an unreadable binding outside the layout has no name to show
    const problem: SeatProblem =
      got.kind === 'legacy'
        ? { kind: 'binding-legacy', fix: `cd ${dir} && musterd harness configure` }
        : { kind: 'binding-invalid', fix: `cd ${dir} && musterd init --check` };
    return {
      ...layout,
      server: '',
      path: dir,
      kind: 'agent',
      harnesses: [],
      remote: null,
      last_session: null,
      problem,
    };
  }
  const b = got.value;
  const remote = originRepoName(dir);
  const project = layout?.project ?? remote ?? basename(dirname(dir));
  const prov = loadProvisioning(dir);
  const problem: SeatProblem | null =
    prov.kind === 'legacy'
      ? { kind: 'provisioning-legacy', fix: `cd ${dir} && musterd harness configure` }
      : prov.kind === 'invalid'
        ? { kind: 'provisioning-invalid', fix: `cd ${dir} && musterd harness configure` }
        : null;
  return {
    team: b.team,
    project,
    member: b.claim?.mode === 'seat' ? b.claim.name : (layout?.member ?? basename(dir)),
    server: b.server,
    path: dir,
    // The prefix is read, never copied: a human Workspace's binding carries their `mscr_` (ADR 069).
    kind: b.agent_key?.startsWith(TOKEN_PREFIXES.credential) ? 'human' : 'agent',
    harnesses: prov.kind === 'valid' ? prov.value.desired : [],
    remote: remote !== null && remote !== project ? remote : null,
    last_session: b.session
      ? { harness: b.session.harness, started_at: b.session.started_at, ended_at: b.session.ended_at ?? null }
      : null,
    problem,
  };
}

/** `team/project/member`; host-qualified when one address is served by two servers; `~2` for a duplicate. */
function addressed(drafts: Draft[]): Seat[] {
  const byBase = new Map<string, Draft[]>();
  for (const d of drafts) {
    const base = seatAddress(d.team, d.project, d.member);
    byBase.set(base, [...(byBase.get(base) ?? []), d]);
  }
  const out: Seat[] = [];
  for (const [base, group] of byBase) {
    const servers = new Set(group.map((d) => canonicalServer(d.server)));
    group.forEach((d, i) => {
      const address =
        servers.size > 1
          ? seatAddress(d.team, d.project, d.member, serverHost(canonicalServer(d.server)))
          : i === 0
            ? base
            : `${base}~${i + 1}`;
      out.push({ address, ...d });
    });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

function layoutWorkspaces(roof: string): string[] {
  const out: string[] = [];
  for (const team of childDirs(roof))
    for (const project of childDirs(join(roof, team)))
      for (const member of childDirs(join(roof, team, project))) {
        const dir = join(roof, team, project, member);
        if (existsSync(join(dir, '.musterd', 'binding.json'))) out.push(dir);
      }
  return out;
}

function layoutParts(dir: string, roof: string): { team: string; project: string; member: string } | null {
  if (!dir.startsWith(roof + '/')) return null;
  const parts = dir.slice(roof.length + 1).split('/');
  if (parts.length !== 3) return null;
  const [team, project, member] = parts as [string, string, string];
  return { team, project, member };
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The `origin` remote's repo name for the checkout at `dir`, read from git's own files — `.git`
 * (a file in a linked checkout), `commondir`, `config` — never a `git` subprocess, which would cost
 * ~10 ms per Workspace.
 */
export function originRepoName(dir: string): string | null {
  try {
    let gitDir = join(dir, '.git');
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = resolve(dir, m[1]!.trim());
    }
    const commondir = join(gitDir, 'commondir');
    const common = existsSync(commondir) ? resolve(gitDir, readFileSync(commondir, 'utf8').trim()) : gitDir;
    const config = readFileSync(join(common, 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
    const url = section ? /^\s*url\s*=\s*(.+)$/m.exec(section[1]!)?.[1]?.trim() : undefined;
    if (!url) return null;
    const tail = url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '');
    return tail ? tail : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/catalog.test.ts`
Expected: PASS (8 tests). If the legacy-binding case fails, check that the fixture matches `LegacyIdentitySchema` (`server`, `team`, `surface`, optional `claim`, and no `version`), because `loadBinding` classifies only that shape as `legacy`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/catalog.ts packages/cli/src/launcher/catalog.test.ts
git commit -m "feat(cli): the seat catalog — every Workspace on this machine, secret-free (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Resolving `musterd <word>`

**Files:**
- Create: `packages/cli/src/launcher/resolve.ts`
- Test: `packages/cli/src/launcher/resolve.test.ts`

**Interfaces:**
- Consumes: `Seat` (Task 6).
- Produces: `type Resolution = { kind: 'seat'; seat: Seat } | { kind: 'ambiguous'; candidates: Seat[] } | { kind: 'none'; nearest: string | null }` and `resolveSeatWord(word, seats, last): Resolution`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { resolveSeatWord } from './resolve.js';
import type { Seat } from './store.js';

const seat = (address: string): Seat => {
  const [teamPart, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team: teamPart.split('@')[0]!,
    project,
    member,
    server: 'http://127.0.0.1:4849',
    path: `/w/${address}`,
    kind: 'agent',
    harnesses: [],
    remote: null,
    last_session: null,
    problem: null,
  };
};
const SEATS = [
  seat('revive/agents/stanley'),
  seat('revive/agents/miley'),
  seat('revive/site/miley'),
  seat('dawn/agents/ada'),
];

describe('resolveSeatWord (ADR 491 Decision 2)', () => {
  it('a member name unique on this machine is enough', () => {
    expect(resolveSeatWord('stanley', SEATS, null)).toEqual({ kind: 'seat', seat: SEATS[0] });
  });

  it('an exact address always wins', () => {
    expect(resolveSeatWord('revive/site/miley', SEATS, null)).toEqual({ kind: 'seat', seat: SEATS[2] });
  });

  it('a project/member suffix resolves when unique', () => {
    expect(resolveSeatWord('site/miley', SEATS, null)).toEqual({ kind: 'seat', seat: SEATS[2] });
  });

  it('several matches are an ambiguity, with every candidate', () => {
    expect(resolveSeatWord('miley', SEATS, null)).toEqual({
      kind: 'ambiguous',
      candidates: [SEATS[1], SEATS[2]],
    });
  });

  it('`-` is the seat launched last, and none when there is no last', () => {
    expect(resolveSeatWord('-', SEATS, 'dawn/agents/ada')).toEqual({ kind: 'seat', seat: SEATS[3] });
    expect(resolveSeatWord('-', SEATS, null)).toEqual({ kind: 'none', nearest: null });
    expect(resolveSeatWord('-', SEATS, 'gone/x/y')).toEqual({ kind: 'none', nearest: null });
  });

  it('no match names the nearest member when it is close', () => {
    expect(resolveSeatWord('stanly', SEATS, null)).toEqual({ kind: 'none', nearest: 'stanley' });
    expect(resolveSeatWord('xyzzy-nonsense', SEATS, null)).toEqual({ kind: 'none', nearest: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/resolve.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/resolve.ts
import type { Seat } from './store.js';

export type Resolution =
  | { kind: 'seat'; seat: Seat }
  | { kind: 'ambiguous'; candidates: Seat[] }
  | { kind: 'none'; nearest: string | null };

/**
 * `musterd <word>` → one seat (ADR 491 Decision 2). The caller has already ruled out commands —
 * a command always wins, so this never sees one. Order: `-` (the last launch), an exact address,
 * then a `project/member` suffix or a bare member name.
 */
export function resolveSeatWord(word: string, seats: readonly Seat[], last: string | null): Resolution {
  if (word === '-') {
    const seat = last ? seats.find((s) => s.address === last) : undefined;
    return seat ? { kind: 'seat', seat } : { kind: 'none', nearest: null };
  }
  const exact = seats.find((s) => s.address === word);
  if (exact) return { kind: 'seat', seat: exact };
  const matches = word.includes('/')
    ? seats.filter((s) => s.address.endsWith(`/${word}`))
    : seats.filter((s) => s.member === word);
  if (matches.length === 1) return { kind: 'seat', seat: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'none', nearest: nearestMember(word, seats) };
}

function nearestMember(word: string, seats: readonly Seat[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const name of new Set(seats.map((s) => s.member))) {
    const d = editDistance(word, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best !== null && bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/resolve.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/resolve.ts packages/cli/src/launcher/resolve.test.ts
git commit -m "feat(cli): resolve a seat word — member, address, project/member, and - (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Interactive entries on the harness adapters, and a `cursor-agent` resolver

**Files:**
- Modify: `packages/cli/src/onboard/reconcile/fragments.ts` (after `HarnessAvailability`, plus the `HarnessAdapter` interface)
- Modify: `packages/cli/src/onboard/harnesses/{claudeCode,codex,cursor,grok,opencode,musterd}.ts` (each adapter literal; `musterd.ts` also has `musterdCoreAdapter`)
- Create: `packages/cli/src/cursorAgentBin.ts`
- Test: `packages/cli/src/onboard/harnesses/interactive.test.ts`, `packages/cli/src/cursorAgentBin.test.ts`

**Interfaces:**
- Produces: `interface InteractiveLaunch { resolveBin(): Promise<string | null>; fresh(): string[]; resume(sessionId: string | undefined): string[] }`, `HarnessAdapter.interactive: InteractiveLaunch | null`, and `resolveCursorAgentBin(runnable?, home?): Promise<string | null>` with `cursorAgentCandidates(home?): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/onboard/harnesses/interactive.test.ts
import { describe, expect, it } from 'vitest';
import { LAUNCHABLE_HARNESSES } from '../../launcher/labels.js';
import { harnessAdapters } from './index.js';
import { musterdCoreAdapter } from './musterd.js';

/** The argv each harness takes, checked against its own `--help` on 2026-10-01 (spec §4.4). */
const EXPECTED: [string, string[], string[], string[]][] = [
  ['claude-code', [], ['--resume', 'S1'], ['--continue']],
  ['cursor', [], ['--resume', 'S1'], ['--continue']],
  ['codex', [], ['resume', 'S1'], ['resume', '--last']],
  ['opencode', [], ['--session', 'S1'], ['--continue']],
  ['grok', [], ['--resume', 'S1'], ['--continue']],
];

describe('interactive launch entries (ADR 491 Decision 5)', () => {
  const byId = new Map(harnessAdapters().map((a) => [a.id, a]));

  it.each(EXPECTED)('%s', (id, fresh, resumeWithId, resumeLatest) => {
    const entry = byId.get(id)?.interactive;
    expect(entry).toBeTruthy();
    expect(entry!.fresh()).toEqual(fresh);
    expect(entry!.resume('S1')).toEqual(resumeWithId);
    expect(entry!.resume(undefined)).toEqual(resumeLatest);
  });

  it('the native host and the musterd-core producer have no terminal entry', () => {
    expect(byId.get('musterd')?.interactive).toBeNull();
    expect(musterdCoreAdapter.interactive).toBeNull();
  });

  it('LAUNCHABLE_HARNESSES is exactly the registry ids that have an entry, in registry order', () => {
    const withEntry = harnessAdapters()
      .filter((a) => a.interactive)
      .map((a) => a.id);
    expect([...LAUNCHABLE_HARNESSES]).toEqual(withEntry);
  });
});
```

```ts
// packages/cli/src/cursorAgentBin.test.ts
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursorAgentCandidates, resolveCursorAgentBin } from './cursorAgentBin.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'musterd-cursor-bin-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('resolveCursorAgentBin', () => {
  it('prefers cursor-agent on PATH', async () => {
    const seen: string[] = [];
    const bin = await resolveCursorAgentBin(async (cmd) => {
      seen.push(cmd);
      return { ok: cmd === 'cursor-agent' };
    }, home);
    expect(bin).toBe('cursor-agent');
    expect(seen).toEqual(['cursor-agent']);
  });

  it('falls back to ~/.local/bin/cursor-agent — never the bare `agent`, which may be Grok', async () => {
    const local = join(home, '.local', 'bin', 'cursor-agent');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(local, '#!/bin/sh\n');
    chmodSync(local, 0o755);
    const seen: string[] = [];
    const bin = await resolveCursorAgentBin(async (cmd) => {
      seen.push(cmd);
      return { ok: cmd === local };
    }, home);
    expect(bin).toBe(local);
    expect(seen).not.toContain('agent');
    expect(cursorAgentCandidates(home)[0]).toBe(local);
  });

  it('answers null when nothing runs', async () => {
    expect(await resolveCursorAgentBin(async () => ({ ok: false }), home)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/harnesses/interactive.test.ts src/cursorAgentBin.test.ts`
Expected: FAIL. `interactive` is undefined on every adapter, and `./cursorAgentBin.js` does not resolve.

- [ ] **Step 3: Add the type to `fragments.ts`**

After `HarnessAvailability`:

```ts
/**
 * How a person starts this harness in a terminal, in a Workspace (ADR 491 Decision 5). Each adapter
 * declares its own, so the launcher holds no per-harness switch and a new harness joins by
 * declaring one.
 */
export interface InteractiveLaunch {
  /** A runnable binary: PATH first, then known install locations; null when absent. */
  resolveBin(): Promise<string | null>;
  /** argv for a fresh session. */
  fresh(): string[];
  /** argv to resume: the recorded session id when there is one, else the harness's continue-latest form. */
  resume(sessionId: string | undefined): string[];
}
```

Inside `HarnessAdapter`, after `adapterVersion`:

```ts
  /** The terminal launch entry (ADR 491); null for a harness with none (the native `musterd host`). */
  interactive: InteractiveLaunch | null;
```

- [ ] **Step 4: Create the `cursor-agent` resolver**

```ts
// packages/cli/src/cursorAgentBin.ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/**
 * Where `cursor-agent` installs. Never the bare `agent` name: with Grok installed, `agent` on PATH is
 * Grok's binary (measured on the dogfood machine 2026-10-01), so probing it would launch the wrong
 * harness.
 */
export function cursorAgentCandidates(home: string = homedir()): string[] {
  return [join(home, '.local', 'bin', 'cursor-agent'), '/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent'];
}

/** Resolve a runnable `cursor-agent` without a shell. A miss is not cached. */
export async function resolveCursorAgentBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
  home: string = homedir(),
): Promise<string | null> {
  if ((await runnable('cursor-agent', ['--version'])).ok) return 'cursor-agent';
  for (const candidate of cursorAgentCandidates(home)) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok) return candidate;
  }
  return null;
}
```

- [ ] **Step 5: Declare an entry on each adapter**

Add the property after `adapterVersion` in each adapter literal, and the import where it is missing.

`claudeCode.ts` already imports `resolveClaudeBin`:

```ts
  interactive: {
    resolveBin: () => resolveClaudeBin(),
    fresh: () => [],
    resume: (id) => (id ? ['--resume', id] : ['--continue']),
  },
```

`codex.ts` (add `import { resolveCodexBin } from '../../codexBin.js';`):

```ts
  interactive: {
    resolveBin: () => resolveCodexBin(),
    fresh: () => [],
    resume: (id) => (id ? ['resume', id] : ['resume', '--last']),
  },
```

`cursor.ts`, on `cursorAdapter` (add `import { resolveCursorAgentBin } from '../../cursorAgentBin.js';`):

```ts
  interactive: {
    resolveBin: () => resolveCursorAgentBin(),
    fresh: () => [],
    resume: (id) => (id ? ['--resume', id] : ['--continue']),
  },
```

`opencode.ts` (add `import { resolveOpencodeBin } from '../../opencodeBin.js';`):

```ts
  interactive: {
    resolveBin: () => resolveOpencodeBin(),
    fresh: () => [],
    resume: (id) => (id ? ['--session', id] : ['--continue']),
  },
```

`grok.ts` (add `import { resolveGrokBin } from '../../grokBin.js';`):

```ts
  interactive: {
    resolveBin: () => resolveGrokBin(),
    fresh: () => [],
    resume: (id) => (id ? ['--resume', id] : ['--continue']),
  },
```

`musterd.ts`, on both `musterdAdapter` and `musterdCoreAdapter`:

```ts
  interactive: null,
```

Keep each new import in the file's `import/order` position (alphabetical by path); `pnpm lint` checks it.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/harnesses/interactive.test.ts src/cursorAgentBin.test.ts && pnpm typecheck`
Expected: PASS. Test fakes typed `HarnessAdapter` are not type-checked (the cli tsconfig excludes tests), so they need no edit.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/onboard/reconcile/fragments.ts packages/cli/src/onboard/harnesses packages/cli/src/cursorAgentBin.ts packages/cli/src/cursorAgentBin.test.ts
git commit -m "feat(cli): each harness adapter declares its terminal entry; cursor-agent resolver (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: The live layer — one time-boxed roster read per team

**Files:**
- Create: `packages/cli/src/launcher/live.ts`
- Test: `packages/cli/src/launcher/live.test.ts`

**Interfaces:**
- Consumes: `MemberSummarySchema` and `type MemberSummary` (`@musterd/protocol`), `canonicalServer` and `isLoopbackServer` (`host/registry.ts`), `Seat` (Task 6).
- Produces: `interface Live { where: 'here' | 'elsewhere'; label: string; surface: string; since: number | null }`, `ROSTER_TIMEOUT_MS = 300`, `fetchRoster(server, team, timeoutMs?, fetchImpl?)`, `fetchRosters(seats, timeoutMs?, fetchImpl?)`, `rosterKey(seat)`, `liveFor(seat, members)` and `teamAgents(members)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/live.test.ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRoster, fetchRosters, liveFor, rosterKey, teamAgents } from './live.js';
import type { Seat } from './store.js';

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'acme/proj/ada',
  team: 'acme',
  project: 'proj',
  member: 'ada',
  server: 'http://127.0.0.1:4849',
  path: '/w/ada',
  kind: 'agent',
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const member = (name: string, kind: 'agent' | 'human', presences: unknown[] = []) => ({
  id: `m-${name}`,
  team: 'acme',
  name,
  kind,
  created_at: 1,
  presence: presences.length ? 'online' : 'offline',
  presences,
});
const roster = {
  members: [
    member('ada', 'agent', [{ surface: 'claude-code', status: 'online', last_seen_at: 9, attached_at: 5_000 }]),
    member('bo', 'agent', [
      { surface: 'codex', status: 'online', last_seen_at: 9, attached_at: 6_000, node: 'n1', node_label: 'mini-2' },
    ]),
    member('nick', 'human'),
    member('cy', 'agent'),
  ],
};
const okFetch = (async () =>
  new Response(JSON.stringify(roster), { status: 200 })) as unknown as typeof fetch;

let server: Server | undefined;
afterEach(() => server?.close());

describe('the roster read (ADR 491)', () => {
  it('parses members through the protocol schema', async () => {
    const members = await fetchRoster('http://127.0.0.1:4849', 'acme', 300, okFetch);
    expect(members?.map((m) => m.name)).toEqual(['ada', 'bo', 'nick', 'cy']);
  });

  it('answers null for a refused, non-JSON or off-schema answer', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const bad = (async () => new Response('{"members":[{"x":1}]}', { status: 200 })) as unknown as typeof fetch;
    const notOk = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    for (const f of [refused, html, bad, notOk]) expect(await fetchRoster('http://x', 'acme', 300, f)).toBeNull();
  });

  it('gives up on a wedged daemon at its time box', async () => {
    server = createServer(() => {
      /* accept the request, never answer */
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const t0 = Date.now();
    expect(await fetchRoster(`http://127.0.0.1:${port}`, 'acme', 80)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('reads each (server, team) once', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(roster), { status: 200 });
    }) as unknown as typeof fetch;
    const seats = [seat(), seat({ address: 'acme/proj/bo', member: 'bo' }), seat({ server: 'http://localhost:4849/' })];
    const rosters = await fetchRosters(seats, 300, counting);
    expect(calls).toBe(1);
    expect(rosters.get(rosterKey(seats[0]!))?.length).toBe(4);
  });
});

describe('liveFor', () => {
  it('a Presence on the loopback daemon with no node is here', () => {
    expect(liveFor(seat(), roster.members as never)).toEqual({
      where: 'here',
      label: 'here',
      surface: 'claude-code',
      since: 5_000,
    });
  });

  it('a Presence on another node names that node', () => {
    expect(liveFor(seat({ member: 'bo' }), roster.members as never)).toEqual({
      where: 'elsewhere',
      label: 'mini-2',
      surface: 'codex',
      since: 6_000,
    });
  });

  it('no Presence, no roster, or no member is not live', () => {
    expect(liveFor(seat({ member: 'cy' }), roster.members as never)).toBeNull();
    expect(liveFor(seat(), null)).toBeNull();
    expect(liveFor(seat({ member: 'zz' }), roster.members as never)).toBeNull();
  });
});

describe('teamAgents', () => {
  it('lists agent members only, sorted', () => {
    expect(teamAgents(roster.members as never)).toEqual(['ada', 'bo', 'cy']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/live.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/live.ts
import { MemberSummarySchema, type MemberSummary } from '@musterd/protocol';
import { z } from 'zod';
import { canonicalServer, isLoopbackServer } from '../host/registry.js';
import { serverHost } from './address.js';
import type { Seat } from './store.js';

/** The time box for one roster read (ADR 491 §5.1). The local daemon answers in ~45 ms. */
export const ROSTER_TIMEOUT_MS = 300;

/** Where a seat is live, from its team's roster (ADR 491 Decision 6). */
export interface Live {
  where: 'here' | 'elsewhere';
  /** `here`, or the other machine's label. */
  label: string;
  surface: string;
  since: number | null;
}

const RosterSchema = z.object({ members: z.array(MemberSummarySchema) }).passthrough();

/**
 * One UNAUTHENTICATED roster read, time-boxed. Unauthenticated on purpose: an authenticated client
 * may claim a seat per request (`claimSeatPerRequest`) and so write Presence, while the roster
 * route answers anonymous reads without touching anyone. Null on any failure — refused, timed out,
 * not JSON, off-schema — so a daemon that is down or wedged costs at most `timeoutMs`.
 */
export async function fetchRoster(
  server: string,
  team: string,
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<MemberSummary[] | null> {
  try {
    const res = await fetchImpl(`${server.replace(/\/+$/, '')}/teams/${encodeURIComponent(team)}/members`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = RosterSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.members : null;
  } catch {
    return null;
  }
}

export function rosterKey(seat: Pick<Seat, 'server' | 'team'>): string {
  return `${canonicalServer(seat.server)}|${seat.team}`;
}

/** One roster read per distinct (server, team), in parallel. */
export async function fetchRosters(
  seats: readonly Seat[],
  timeoutMs: number = ROSTER_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, MemberSummary[] | null>> {
  const wanted = new Map<string, { server: string; team: string }>();
  for (const s of seats) if (s.server) wanted.set(rosterKey(s), { server: s.server, team: s.team });
  const out = new Map<string, MemberSummary[] | null>();
  await Promise.all(
    [...wanted].map(async ([key, { server, team }]) => {
      out.set(key, await fetchRoster(server, team, timeoutMs, fetchImpl));
    }),
  );
  return out;
}

/** The seat's first live Presence, if any. `node` absent means the queried daemon's own machine. */
export function liveFor(seat: Seat, members: readonly MemberSummary[] | null): Live | null {
  const p = members?.find((m) => m.name === seat.member)?.presences[0];
  if (!p) return null;
  const here = !p.node && isLoopbackServer(seat.server);
  return {
    where: here ? 'here' : 'elsewhere',
    label: here ? 'here' : (p.node_label ?? serverHost(seat.server)),
    surface: p.surface,
    since: p.attached_at ?? null,
  };
}

/** The team's agent members, sorted — what "on the team · not here" draws from (increment 4). */
export function teamAgents(members: readonly MemberSummary[]): string[] {
  return members
    .filter((m) => m.kind === 'agent')
    .map((m) => m.name)
    .sort();
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/live.test.ts`
Expected: PASS (8 tests). If the off-schema case parses, check that `MemberSummarySchema` requires `id`, `team`, `name`, `kind`, `created_at` and `presence`; the `{"x":1}` member lacks all of them.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/live.ts packages/cli/src/launcher/live.test.ts
git commit -m "feat(cli): launcher live layer — one unauthenticated, time-boxed roster read per team (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Launch plan, supervisor, and shared rows

**Files:**
- Create: `packages/cli/src/launcher/plan.ts`, `packages/cli/src/launcher/supervise.ts`, `packages/cli/src/launcher/rows.ts`
- Test: `packages/cli/src/launcher/plan.test.ts`, `packages/cli/src/launcher/supervise.test.ts`, `packages/cli/src/launcher/rows.test.ts`

**Interfaces:**
- Consumes: `resolveAdapter` and `type HarnessAdapter` (`onboard/reconcile/fragments.ts`), `CliError`, `harnessLabel` (Task 5), and the `Seat` and `Recent` types (Task 6). `Live` (Task 10) is imported as a type only.
- Produces:
  - `interface LaunchPlan { bin: string; args: string[]; cwd: string; harness: string }`
  - `chooseHarness(seat, requested, recentHarness): string` and `planLaunch(input: PlanInput): Promise<LaunchPlan>`
  - `supervise(plan, deps?): Promise<{ code: number; durationMs: number }>`
  - `ago(ts, now)`, `formatDuration(ms)`, `formatReceipt(member, harness, durationMs, code)`, `describeLive(live, now)`, `describeLiveLong(live, now)`, `seatLine(seat, opts)`, `interface SeatEntry { seat: Seat; live: Live | null; lastUsed: number | null }` and `renderSeatsList(entries, stale, now)`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/launcher/plan.test.ts
import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import type { HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { chooseHarness, planLaunch } from './plan.js';
import type { Seat } from './store.js';

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'revive/agents/stanley',
  team: 'revive',
  project: 'agents',
  member: 'stanley',
  server: 'http://127.0.0.1:4849',
  path: '/w/stanley',
  kind: 'agent',
  harnesses: ['claude-code', 'musterd'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});
const adapter = (id: string, bin: string | null): HarnessAdapter =>
  ({
    id,
    interactive: {
      resolveBin: async () => bin,
      fresh: () => ['--fresh'],
      resume: (sid: string | undefined) => (sid ? ['--resume', sid] : ['--continue']),
    },
  }) as unknown as HarnessAdapter;
const REGISTRY = [
  adapter('claude-code', '/bin/claude'),
  adapter('codex', null),
  { id: 'musterd', interactive: null } as unknown as HarnessAdapter,
];
const base = { mode: 'fresh' as const, harness: null, session: null, recent: null, registry: REGISTRY, env: {} };

describe('chooseHarness', () => {
  it('asked for > recent (if still desired) > first desired > last session > claude-code', () => {
    expect(chooseHarness(seat(), 'codex', null)).toBe('codex');
    expect(chooseHarness(seat({ harnesses: ['codex', 'claude-code'] }), null, 'claude-code')).toBe('claude-code');
    expect(chooseHarness(seat({ harnesses: ['codex'] }), null, 'grok')).toBe('codex');
    expect(chooseHarness(seat({ harnesses: ['musterd'] }), null, null)).toBe('claude-code');
    expect(
      chooseHarness(seat({ harnesses: [], last_session: { harness: 'grok', started_at: 1, ended_at: null } }), null, null),
    ).toBe('grok');
  });
});

describe('planLaunch (ADR 491)', () => {
  it('a fresh agent launch runs the resolved binary in the Workspace', async () => {
    expect(await planLaunch({ ...base, seat: seat() })).toEqual({
      bin: '/bin/claude',
      args: ['--fresh'],
      cwd: '/w/stanley',
      harness: 'claude-code',
    });
  });

  it('resume uses the recorded id only when its harness matches', async () => {
    const session = { harness: 'claude-code', id: 'S9' };
    expect((await planLaunch({ ...base, seat: seat(), mode: 'resume', session })).args).toEqual(['--resume', 'S9']);
    const other = { harness: 'codex', id: 'C1' };
    expect((await planLaunch({ ...base, seat: seat(), mode: 'resume', session: other })).args).toEqual(['--continue']);
  });

  it('a human seat gets a login shell', async () => {
    expect(await planLaunch({ ...base, seat: seat({ kind: 'human' }), env: { SHELL: '/bin/fish' } })).toEqual({
      bin: '/bin/fish',
      args: ['-l'],
      cwd: '/w/stanley',
      harness: 'shell',
    });
  });

  it('refuses a missing binary, the native host, and an unknown id — with the reason', async () => {
    await expect(planLaunch({ ...base, seat: seat(), harness: 'codex' })).rejects.toThrow(/codex is not installed/);
    await expect(planLaunch({ ...base, seat: seat(), harness: 'musterd' })).rejects.toThrow(/musterd host/);
    const unknown = planLaunch({ ...base, seat: seat(), harness: 'nope' });
    await expect(unknown).rejects.toBeInstanceOf(CliError);
    await expect(unknown).rejects.toThrow(/unknown harness "nope"/);
  });
});
```

```ts
// packages/cli/src/launcher/supervise.test.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { supervise } from './supervise.js';

const plan = (args: string[]) => ({ bin: process.execPath, args, cwd: process.cwd(), harness: 'claude-code' });

describe('supervise (ADR 491 Decision 3)', () => {
  it('returns the harness exit code', async () => {
    const r = await supervise(plan(['-e', 'process.exit(3)']), { env: process.env });
    expect(r.code).toBe(3);
  });

  it('a harness killed by a signal exits 128 + n', async () => {
    const r = await supervise(plan(['-e', "process.kill(process.pid, 'SIGTERM')"]));
    expect(r.code).toBe(143);
  });

  it('a binary that cannot start is a CliError', async () => {
    await expect(
      supervise({ bin: '/nonexistent/claude', args: [], cwd: process.cwd(), harness: 'claude-code' }),
    ).rejects.toThrow(/couldn't start \/nonexistent\/claude/);
  });

  it('ignores SIGINT/SIGQUIT, forwards SIGTERM/SIGHUP, and unregisters on exit', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const handlers = new Map<string, () => void>();
    const signals = {
      on: (sig: string, fn: () => void) => void handlers.set(sig, fn),
      off: (sig: string) => void handlers.delete(sig),
    };
    let t = 1_000;
    const done = supervise(plan([]), {
      spawn: (() => child) as never,
      signals: signals as never,
      now: () => (t += 500),
    });
    handlers.get('SIGINT')!();
    handlers.get('SIGQUIT')!();
    expect(child.kill).not.toHaveBeenCalled();
    handlers.get('SIGTERM')!();
    handlers.get('SIGHUP')!();
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGHUP']]);
    child.emit('exit', 0, null);
    expect(await done).toEqual({ code: 0, durationMs: 500 });
    expect(handlers.size).toBe(0);
  });
});
```

```ts
// packages/cli/src/launcher/rows.test.ts
import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../render/theme.js';
import { ago, describeLive, describeLiveLong, formatDuration, formatReceipt, renderSeatsList, seatLine } from './rows.js';
import type { Seat } from './store.js';

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
const H = 3_600_000;
const seat = (member: string, over: Partial<Seat> = {}): Seat => ({
  address: `revive/agents/${member}`,
  team: 'revive',
  project: 'agents',
  member,
  server: 'http://127.0.0.1:4849',
  path: `/w/${member}`,
  kind: 'agent',
  harnesses: ['claude-code'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});

describe('launcher rows (ADR 491)', () => {
  it('ago / duration', () => {
    expect([ago(NOW - 30_000, NOW), ago(NOW - 5 * 60_000, NOW), ago(NOW - 2 * H, NOW), ago(NOW - 26 * H, NOW)]).toEqual([
      'now',
      '5m',
      '2h',
      '1d',
    ]);
    expect([formatDuration(9_000), formatDuration(42 * 60_000), formatDuration(125 * 60_000)]).toEqual([
      '9s',
      '42m',
      '2h 5m',
    ]);
  });

  it('the receipt is one line', () => {
    expect(formatReceipt('stanley', 'claude-code', 42 * 60_000, 0)).toBe(
      '✓ stanley · claude · 42m · exit 0 · musterd - to go back',
    );
    expect(formatReceipt('stanley', 'codex', 9_000, 7)).toBe('✗ stanley · codex · 9s · exit 7 · musterd - to go back');
  });

  it('describes where a seat is live', () => {
    const here = { where: 'here' as const, label: 'here', surface: 'claude-code', since: NOW - H };
    expect(describeLive(here, NOW)).toBe(`here · since ${sinceLabel(NOW - H, NOW)}`);
    expect(describeLiveLong({ ...here, where: 'elsewhere', label: 'mini-2' }, NOW)).toBe(
      `on mini-2 (claude-code) since ${sinceLabel(NOW - H, NOW)}`,
    );
  });

  it('a seat line, with and without the address and harness columns', () => {
    const s = seat('stanley');
    expect(
      seatLine(s, { selected: true, nameWidth: 9, addressWidth: 15, showHarness: true, harness: 'claude-code', state: 'idle', tail: '★ last used · 2h' }),
    ).toBe('› stanley  revive/agents  claude   ○ idle  ★ last used · 2h');
    expect(
      seatLine(s, { selected: false, nameWidth: 9, addressWidth: null, showHarness: false, harness: 'claude-code', state: 'live', tail: 'here' }),
    ).toBe('  stanley  ● live  here');
    expect(
      seatLine(seat('nick', { kind: 'human' }), { selected: false, nameWidth: 9, addressWidth: null, showHarness: true, harness: 'human', state: 'unknown', tail: '' }),
    ).toBe('  nick     human    ?');
  });

  it('`musterd seats` groups by team/project', () => {
    const out = renderSeatsList(
      [
        { seat: seat('stanley'), live: null, lastUsed: NOW - 2 * H },
        { seat: seat('miley'), live: { where: 'here', label: 'here', surface: 'claude-code', since: NOW - H }, lastUsed: null },
        { seat: seat('gptbot', { harnesses: ['codex'], problem: { kind: 'binding-invalid', fix: 'x' } }), live: null, lastUsed: null },
      ],
      2,
      NOW,
    );
    expect(out).toBe(
      [
        'seats on this machine · 3',
        '',
        'revive/agents',
        '  stanley  claude   ○ idle  2h',
        `  miley    claude   ● live  here · since ${sinceLabel(NOW - H, NOW)}`,
        '  gptbot   codex    ○ idle  needs repair',
        '',
        '2 stale · musterd init --prune-bindings --apply',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/plan.test.ts src/launcher/supervise.test.ts src/launcher/rows.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement `plan.ts`**

```ts
// packages/cli/src/launcher/plan.ts
import { CliError } from '../errors.js';
import { resolveAdapter, type HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { harnessLabel } from './labels.js';
import type { Recent, Seat } from './store.js';

/** What to run, where (ADR 491 Decision 5). */
export interface LaunchPlan {
  bin: string;
  args: string[];
  cwd: string;
  /** The harness id, or `shell` for a human seat. */
  harness: string;
}

export interface PlanInput {
  seat: Seat;
  mode: 'fresh' | 'resume';
  /** `--harness` or the picker's tab choice; null → {@link chooseHarness}. */
  harness: string | null;
  /** The session `binding.json` records, read at launch time — never from the snapshot. */
  session: { harness: string; id: string } | null;
  recent: Recent | null;
  registry: HarnessAdapter[];
  env: NodeJS.ProcessEnv;
}

/** Asked for > the harness used last (if still desired) > first desired > last session > claude-code. */
export function chooseHarness(seat: Seat, requested: string | null, recentHarness: string | null): string {
  if (requested) return requested;
  const launchable = seat.harnesses.filter((h) => h !== 'musterd');
  if (recentHarness && (launchable.length === 0 || launchable.includes(recentHarness))) return recentHarness;
  return launchable[0] ?? seat.last_session?.harness ?? 'claude-code';
}

export async function planLaunch(input: PlanInput): Promise<LaunchPlan> {
  const { seat } = input;
  if (seat.kind === 'human') {
    return { bin: input.env['SHELL'] || '/bin/zsh', args: ['-l'], cwd: seat.path, harness: 'shell' };
  }
  const id = chooseHarness(seat, input.harness, input.recent?.harness ?? null);
  const adapter = resolveAdapter(id, input.registry);
  if (!adapter) {
    throw new CliError(`unknown harness "${id}" — one of: ${input.registry.map((a) => a.id).join(', ')}`, 2);
  }
  if (!adapter.interactive) throw new CliError(`${id} has no terminal entry — it runs under \`musterd host\``, 1);
  const bin = await adapter.interactive.resolveBin();
  if (!bin) throw new CliError(`${harnessLabel(id)} is not installed (not on PATH or the usual install locations)`, 1);
  const sessionId = input.session?.harness === id ? input.session.id : undefined;
  const args = input.mode === 'resume' ? adapter.interactive.resume(sessionId) : adapter.interactive.fresh();
  return { bin, args, cwd: seat.path, harness: id };
}
```

- [ ] **Step 4: Implement `supervise.ts`**

```ts
// packages/cli/src/launcher/supervise.ts
import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:os';
import { CliError } from '../errors.js';
import type { LaunchPlan } from './plan.js';

type Sig = 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGHUP';

export interface SuperviseDeps {
  spawn?: typeof nodeSpawn;
  /** Signal registration (tests). Defaults to `process`. */
  signals?: { on(sig: Sig, fn: () => void): unknown; off(sig: Sig, fn: () => void): unknown };
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface SuperviseResult {
  code: number;
  durationMs: number;
}

/**
 * Run a harness with the terminal handed over (ADR 491 Decision 3). musterd stays its parent:
 * SIGINT/SIGQUIT are ignored here (the terminal delivers them to the harness too, which decides),
 * SIGTERM/SIGHUP are forwarded, and the harness's exit code comes back — 128 + n for signal n.
 * The environment passes through untouched: identity reaches the harness through the Workspace's
 * MCP registration (ADR 286), never through the launcher.
 */
export function supervise(plan: LaunchPlan, deps: SuperviseDeps = {}): Promise<SuperviseResult> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const signals = deps.signals ?? process;
  const now = deps.now ?? Date.now;
  const started = now();
  return new Promise((resolve, reject) => {
    const child = spawnFn(plan.bin, plan.args, { cwd: plan.cwd, env: deps.env ?? process.env, stdio: 'inherit' });
    const ignore = (): void => {};
    const term = (): void => void child.kill('SIGTERM');
    const hup = (): void => void child.kill('SIGHUP');
    signals.on('SIGINT', ignore);
    signals.on('SIGQUIT', ignore);
    signals.on('SIGTERM', term);
    signals.on('SIGHUP', hup);
    const release = (): void => {
      signals.off('SIGINT', ignore);
      signals.off('SIGQUIT', ignore);
      signals.off('SIGTERM', term);
      signals.off('SIGHUP', hup);
    };
    child.once('error', (err: Error) => {
      release();
      reject(new CliError(`couldn't start ${plan.bin}: ${err.message}`, 1));
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      release();
      const exit = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
      resolve({ code: exit, durationMs: now() - started });
    });
  });
}
```

- [ ] **Step 5: Implement `rows.ts`**

```ts
// packages/cli/src/launcher/rows.ts
import { sinceLabel, theme } from '../render/theme.js';
import { hint, padEndVisible, sym } from '../render/ui.js';
import { harnessLabel } from './labels.js';
import type { Live } from './live.js';
import type { Seat } from './store.js';

/*
 * Row and receipt rendering shared by the picker and `musterd seats` (ADR 491). On the paint path:
 * it loads only the theme, `ui` and labels; `Live` is a type import.
 */

/** `now`, `5m`, `2h`, `3d`. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** `9s`, `42m`, `2h 5m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The one line printed when the harness exits (spec §3.5). */
export function formatReceipt(member: string, harness: string, durationMs: number, code: number): string {
  const mark = code === 0 ? theme.ok(sym.ok) : theme.err(sym.err);
  return `${mark} ${member} · ${harnessLabel(harness)} · ${formatDuration(durationMs)} · exit ${code} ${theme.meta('· musterd - to go back')}`;
}

/** `here · since 15:37` / `on mini-2 · since 15:37`. */
export function describeLive(live: Live, now: number): string {
  const where = live.where === 'here' ? 'here' : `on ${live.label}`;
  return live.since !== null ? `${where} · since ${sinceLabel(live.since, now)}` : where;
}

/** `here (claude-code) since 15:37` — the live-seat prompt's wording. */
export function describeLiveLong(live: Live, now: number): string {
  const where = live.where === 'here' ? 'here' : `on ${live.label}`;
  return `${where} (${live.surface})${live.since !== null ? ` since ${sinceLabel(live.since, now)}` : ''}`;
}

export interface SeatLineOpts {
  selected: boolean;
  nameWidth: number;
  /** null → no `team/project` column. */
  addressWidth: number | null;
  showHarness: boolean;
  /** Harness id, or `human` for a human seat. */
  harness: string;
  state: 'live' | 'idle' | 'unknown';
  tail: string;
}

/** One seat row: marker · member · [team/project] · [harness] · state · tail. */
export function seatLine(seat: Seat, o: SeatLineOpts): string {
  const marker = o.selected ? `${theme.accent('›')} ` : '  ';
  const name = padEndVisible(theme.memberName(seat.member, seat.kind), o.nameWidth);
  const address =
    o.addressWidth === null ? '' : padEndVisible(theme.meta(`${seat.team}/${seat.project}`), o.addressWidth);
  const harness = o.showHarness ? padEndVisible(theme.meta(harnessLabel(o.harness)), 9) : '';
  const state = padEndVisible(
    o.state === 'live' ? `${theme.ok('●')} live` : o.state === 'idle' ? `${theme.meta('○')} idle` : theme.meta('?'),
    8,
  );
  return `${marker}${name}${address}${harness}${state}${o.tail}`.trimEnd();
}

export interface SeatEntry {
  seat: Seat;
  live: Live | null;
  lastUsed: number | null;
}

/** `musterd seats` (spec §3.6): every seat, grouped by team/project. */
export function renderSeatsList(entries: SeatEntry[], stale: number, now: number): string {
  if (entries.length === 0) {
    return `no seats on this machine yet\n${hint('musterd init in a project checkout, or musterd agent <name>')}`;
  }
  const nameWidth = Math.max(...entries.map((e) => e.seat.member.length)) + 2;
  const out = [theme.bold(`seats on this machine · ${entries.length}`)];
  const groups = new Map<string, SeatEntry[]>();
  for (const e of entries) {
    const key = `${e.seat.team}/${e.seat.project}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, group] of groups) {
    out.push('', theme.accent(key));
    for (const { seat, live, lastUsed } of group) {
      const tail = live
        ? describeLive(live, now)
        : seat.problem
          ? theme.warn('needs repair')
          : lastUsed !== null
            ? ago(lastUsed, now)
            : '';
      out.push(
        seatLine(seat, {
          selected: false,
          nameWidth,
          addressWidth: null,
          showHarness: true,
          harness: seat.kind === 'human' ? 'human' : (seat.harnesses.find((h) => h !== 'musterd') ?? seat.last_session?.harness ?? 'claude-code'),
          state: live ? 'live' : 'idle',
          tail,
        }),
      );
    }
  }
  if (stale > 0) out.push('', theme.meta(`${stale} stale · musterd init --prune-bindings --apply`));
  return out.join('\n');
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/plan.test.ts src/launcher/supervise.test.ts src/launcher/rows.test.ts`
Expected: PASS. If the `musterd seats` frame differs only in spacing, the frame is right and the code is wrong: `padEndVisible` always leaves at least one space, and the widths are name = longest + 2, harness = 9, state = 8.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/launcher/plan.ts packages/cli/src/launcher/supervise.ts packages/cli/src/launcher/rows.ts packages/cli/src/launcher/*.test.ts
git commit -m "feat(cli): launch plan, supervisor (musterd as parent), receipt and seat rows (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: `musterd <seat>`, `musterd -`, `musterd seats`

**Files:**
- Create: `packages/cli/src/launcher/byName.ts`, `packages/cli/src/commands/seats.ts`
- Modify: `packages/cli/src/bin.ts` (route non-commands to the launcher), `packages/cli/src/commandTable.ts` (`seats`), `packages/cli/src/help/catalog.ts` (`seats` entry)
- Test: `packages/cli/src/launcher/byName.test.ts`, `packages/cli/src/commands/seats.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–11, plus `loadBinding` and `loadConfig` (`config.ts`), `harnessAdapters` (`onboard/harnesses/index.ts`), `nearestCommand` (`render/help.ts`) and `flagStr` (`args.ts`).
- Produces: `interface LaunchOptions { mode: 'fresh' | 'resume'; harness: string | null; force: boolean }`, `interface LaunchDeps`, `launchByName(word, parsed, deps?): Promise<number>`, `launchSeat(seat, opts, deps?): Promise<number>` and `seatsCommand(parsed, deps?): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/launcher/byName.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import type { Catalog } from './catalog.js';
import { launchByName, type LaunchDeps } from './byName.js';
import type { Seat } from './store.js';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-byname-'));
  env = { ...process.env, MUSTERD_CONFIG: join(dir, 'config.json') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (address: string, over: Partial<Seat> = {}): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team,
    project,
    member,
    server: 'http://127.0.0.1:9',
    path: dir,
    kind: 'human', // a login shell: planLaunch needs no adapter registry for it
    harnesses: [],
    remote: null,
    last_session: null,
    problem: null,
    ...over,
  };
};
const catalog = (...seats: Seat[]): (() => Catalog) => () => ({ taken_at: 0, seats, teams: [], stale: [] });

function deps(over: Partial<LaunchDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const supervise = vi.fn(async () => ({ code: 0, durationMs: 1_500 }));
  const d: LaunchDeps = {
    catalog: catalog(seat('revive/agents/stanley'), seat('revive/agents/miley'), seat('revive/site/miley')),
    roster: async () => null,
    supervise,
    isTTY: false,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env,
    now: () => 10_000,
    ...over,
  };
  return { d, out, err, supervise };
}

describe('launchByName (ADR 491 Decision 2)', () => {
  it('a flag-shaped word stays an unknown command, as today', async () => {
    const { d } = deps();
    await expect(launchByName('--json', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/^unknown command "--json".*musterd help$/),
    });
  });

  it('no match is an unknown command, suggesting a near command first, then a near seat', async () => {
    const { d } = deps();
    await expect(launchByName('statuss', parseArgs([]), d)).rejects.toThrow(/did you mean "status"\?/);
    await expect(launchByName('stanly', parseArgs([]), d)).rejects.toThrow(/did you mean the seat "stanley"\?/);
  });

  it('an ambiguous name without a TTY exits 2 and lists every address', async () => {
    const { d } = deps();
    await expect(launchByName('miley', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('musterd revive/agents/miley'),
    });
  });

  it('--path prints the Workspace and launches nothing', async () => {
    const { d, out, supervise } = deps();
    expect(await launchByName('stanley', parseArgs(['--path']), d)).toBe(0);
    expect(out).toEqual([`${dir}\n`]);
    expect(supervise).not.toHaveBeenCalled();
  });

  it('launches, records recents, prints the receipt, returns the harness code', async () => {
    const { d, err, supervise } = deps();
    supervise.mockResolvedValueOnce({ code: 7, durationMs: 9_000 });
    expect(await launchByName('stanley', parseArgs([]), d)).toBe(7);
    expect(err).toEqual(['✗ stanley · shell · 9s · exit 7 · musterd - to go back\n']);
    const file = JSON.parse(readFileSync(join(dir, 'launcher.json'), 'utf8'));
    expect(file.last).toBe('revive/agents/stanley');
    expect(file.seats['revive/agents/stanley']).toMatchObject({ harness: 'shell', mode: 'fresh', exit: 7 });
  });

  it('`-` relaunches the last seat; `-r` resumes', async () => {
    const { d, supervise } = deps();
    await launchByName('stanley', parseArgs([]), d);
    await launchByName('-', parseArgs(['-r']), d);
    const file = JSON.parse(readFileSync(join(dir, 'launcher.json'), 'utf8'));
    expect(file.seats['revive/agents/stanley'].mode).toBe('resume');
    expect(supervise).toHaveBeenCalledTimes(2);
  });

  it('`-` with nothing launched yet says so', async () => {
    const { d } = deps();
    await expect(launchByName('-', parseArgs([]), d)).rejects.toThrow(/no seat launched yet/);
  });

  it('refuses a seat that needs repair, with the fix', async () => {
    const broken = seat('revive/agents/old', { problem: { kind: 'binding-legacy', fix: 'cd /w && musterd harness configure' } });
    const { d, supervise } = deps({ catalog: catalog(broken) });
    await expect(launchByName('old', parseArgs([]), d)).rejects.toThrow(/needs repair — cd \/w && musterd harness configure/);
    expect(supervise).not.toHaveBeenCalled();
  });

  it('a live seat is refused without a TTY unless --force', async () => {
    const live = async () =>
      [{ id: 'm', team: 'revive', name: 'stanley', kind: 'human', created_at: 1, presence: 'online', roles: [], role: '', lifecycle: 'forever', presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 1, attached_at: 1 }] }] as never;
    const { d, supervise } = deps({ roster: live, catalog: catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849' })) });
    await expect(launchByName('stanley', parseArgs([]), d)).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/live here.*--force/) });
    expect(await launchByName('stanley', parseArgs(['--force']), d)).toBe(0);
    expect(supervise).toHaveBeenCalledTimes(1);
  });

  it('a live seat on a TTY asks, and N launches nothing', async () => {
    const live = async () =>
      [{ id: 'm', team: 'revive', name: 'stanley', kind: 'human', created_at: 1, presence: 'online', roles: [], role: '', lifecycle: 'forever', presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 1, attached_at: 1 }] }] as never;
    const confirm = vi.fn(async () => false);
    const { d, supervise } = deps({ roster: live, isTTY: true, confirm, catalog: catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849' })) });
    expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/^stanley is live here \(claude-code\).*Open a second session in the same folder\? \(y\/N\) $/);
    expect(supervise).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'launcher.json'))).toBe(false);
  });
});
```

```ts
// packages/cli/src/commands/seats.test.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { seatsCommand } from './seats.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-seats-')));
  const dir = join(home, 'musterd', 'acme', 'proj', 'ada');
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({ version: 2, server: 'http://127.0.0.1:9', team: 'acme', claim: { mode: 'seat', name: 'ada' }, agent_key: 'mskey_SECRET' }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function capture(fn: () => Promise<number>) {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
    chunks.push(String(c));
    return true;
  });
  try {
    return { code: await fn(), out: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

describe('musterd seats (ADR 491)', () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  it('--json lists every seat, secret-free', async () => {
    const { code, out } = await capture(() => seatsCommand(parseArgs(['--json']), { home, fetch: offline }));
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.seats.map((s: { address: string }) => s.address)).toEqual(['acme/proj/ada']);
    expect(json.seats[0]).toMatchObject({ live: null, last_used: null });
    expect(containsMusterdCredential(out)).toBe(false);
  });

  it('prints the grouped list', async () => {
    const { out } = await capture(() => seatsCommand(parseArgs([]), { home, fetch: offline }));
    expect(out).toBe('seats on this machine · 1\n\nacme/proj\n  ada  claude   ○ idle\n');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/byName.test.ts src/commands/seats.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement `byName.ts`**

```ts
// packages/cli/src/launcher/byName.ts
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { flagStr, type Parsed } from '../args.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { nearestCommand } from '../render/help.js';
import { buildCatalog, type Catalog } from './catalog.js';
import { fetchRoster, liveFor } from './live.js';
import { planLaunch, type LaunchPlan } from './plan.js';
import { resolveSeatWord } from './resolve.js';
import { describeLiveLong, formatReceipt } from './rows.js';
import {
  launcherFilePath,
  readLauncherFile,
  withExit,
  withLaunch,
  writeLauncherFile,
  type LauncherFile,
  type Seat,
} from './store.js';
import { supervise, type SuperviseResult } from './supervise.js';

export interface LaunchOptions {
  mode: 'fresh' | 'resume';
  harness: string | null;
  /** Skip the live check — `--force`, or the picker already asked. */
  force: boolean;
}

/** Seams (tests). Every default is the real thing. */
export interface LaunchDeps {
  catalog?: () => Catalog;
  roster?: typeof fetchRoster;
  supervise?: (plan: LaunchPlan) => Promise<SuperviseResult>;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/**
 * `musterd <word>` when the word is not a command (ADR 491 Decision 2). It returns BEFORE bin.ts's
 * postambles, so a launched session never pays for the reachability nudge or retitles the tab
 * under a seat name.
 */
export async function launchByName(word: string, parsed: Parsed, deps: LaunchDeps = {}): Promise<number> {
  if (word.startsWith('-') && word !== '-') throw unknownCommand(word, null);
  const catalog = (deps.catalog ?? defaultCatalog)();
  const file = readLauncherFile(launcherFilePath(deps.env ?? process.env));
  const res = resolveSeatWord(word, catalog.seats, file.last);
  if (res.kind === 'none') {
    if (word === '-') throw new CliError('no seat launched yet — run `musterd` to pick one', 2);
    throw unknownCommand(word, res.nearest);
  }
  if (res.kind === 'ambiguous') {
    throw new CliError(
      `"${word}" matches ${res.candidates.length} seats — name one:\n` +
        res.candidates.map((s) => `  musterd ${s.address}`).join('\n'),
      2,
    );
  }
  if (parsed.flags['path'] !== undefined) {
    (deps.out ?? ((s: string) => void process.stdout.write(s)))(`${res.seat.path}\n`);
    return 0;
  }
  const mode = parsed.positionals.includes('-r') || parsed.flags['resume'] !== undefined ? 'resume' : 'fresh';
  return launchSeat(
    res.seat,
    { mode, harness: flagStr(parsed.flags, 'harness') ?? null, force: parsed.flags['force'] === true },
    deps,
  );
}

/** Live check → plan → record → supervise → record → receipt. Shared by the name path and the picker. */
export async function launchSeat(seat: Seat, opts: LaunchOptions, deps: LaunchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (seat.problem) throw new CliError(`${seat.address} needs repair — ${seat.problem.fix}`, 1);

  if (!opts.force) {
    const live = liveFor(seat, await (deps.roster ?? fetchRoster)(seat.server, seat.team));
    if (live) {
      const where = describeLiveLong(live, now());
      const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!isTTY) throw new CliError(`${seat.member} is live ${where} — pass --force to open a second session`, 1);
      const ok = await (deps.confirm ?? confirmOnTTY)(
        `${seat.member} is live ${where}. Open a second session in the same folder? (y/N) `,
      );
      if (!ok) return 0;
    }
  }

  const binding = loadBinding(seat.path);
  const captured = binding.kind === 'valid' ? binding.value.session : undefined;
  const path = launcherFilePath(env);
  const plan = await planLaunch({
    seat,
    mode: opts.mode,
    harness: opts.harness,
    session: captured ? { harness: captured.harness, id: captured.id } : null,
    recent: readLauncherFile(path).seats[seat.address] ?? null,
    registry: seat.kind === 'human' ? [] : harnessAdapters(),
    env,
  });
  record(path, (f) => withLaunch(f, seat, plan.harness, opts.mode, now()));
  const result = await (deps.supervise ?? supervise)(plan);
  record(path, (f) => withExit(f, seat.address, now(), result.code));
  err(formatReceipt(seat.member, plan.harness, result.durationMs, result.code) + '\n');
  return result.code;
}

/** Read-modify-write, best-effort: recents are advisory and never fail a launch. */
function record(path: string, change: (f: LauncherFile) => LauncherFile): void {
  try {
    writeLauncherFile(path, change(readLauncherFile(path)));
  } catch {
    // advisory
  }
}

function defaultCatalog(): Catalog {
  return buildCatalog({ home: homedir(), config: loadConfig() });
}

function unknownCommand(word: string, nearestSeat: string | null): CliError {
  const near = nearestCommand(word);
  const hint = near
    ? ` — did you mean "${near}"?`
    : nearestSeat
      ? ` — did you mean the seat "${nearestSeat}"?`
      : '';
  return new CliError(`unknown command "${word}"${hint}  ·  musterd help`, 2);
}

async function confirmOnTTY(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Implement `commands/seats.ts`**

```ts
// packages/cli/src/commands/seats.ts
import { homedir } from 'node:os';
import type { Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { buildCatalog } from '../launcher/catalog.js';
import { fetchRosters, liveFor, rosterKey } from '../launcher/live.js';
import { renderSeatsList } from '../launcher/rows.js';
import { lastUsedAt, launcherFilePath, readLauncherFile } from '../launcher/store.js';

/**
 * `musterd seats [--json]` (ADR 491 Decision 7): every seat on this machine, as the launcher sees
 * them — the catalog plus one time-boxed roster read per team. `--json` is the read model a future
 * face (the macOS app) consumes; it carries no secret.
 */
export async function seatsCommand(
  parsed: Parsed,
  deps: { home?: string; fetch?: typeof fetch; now?: number } = {},
): Promise<number> {
  const catalog = buildCatalog({ home: deps.home ?? homedir(), config: loadConfig() });
  const rosters = await fetchRosters(catalog.seats, undefined, deps.fetch);
  const file = readLauncherFile(launcherFilePath());
  const entries = catalog.seats.map((seat) => ({
    seat,
    live: liveFor(seat, rosters.get(rosterKey(seat)) ?? null),
    lastUsed: lastUsedAt(seat, file),
  }));
  if (parsed.flags['json'] === true) {
    process.stdout.write(
      JSON.stringify({
        seats: entries.map(({ seat, live, lastUsed }) => ({ ...seat, live, last_used: lastUsed })),
        teams: catalog.teams,
        stale: catalog.stale,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(renderSeatsList(entries, catalog.stale.length, deps.now ?? Date.now()) + '\n');
  return 0;
}
```

`fetchRosters(seats, undefined, deps.fetch)`: with `exactOptionalPropertyTypes`, passing `undefined` to an optional parameter is allowed. When `deps.fetch` is undefined, the default `fetch` applies.

- [ ] **Step 5: Register `seats` and route non-commands in `bin.ts`**

In `commandTable.ts`, add in alphabetical place:

```ts
  seats: async () => (await import('./commands/seats.js')).seatsCommand,
```

In `help/catalog.ts`, add to `CATALOG` in the `team` group, after `status`:

```ts
  {
    name: 'seats',
    signature: '[--json]',
    summary: 'every seat on this machine — what bare `musterd` picks from; launch one with `musterd <name>`',
    group: 'team',
    primary: true,
    detail:
      'The seat catalog (ADR 491): every Workspace under ~/musterd/<team>/<project>/<member> and in ' +
      'the bindings registry, with its harnesses, where it is live, and when it was last used. ' +
      '`musterd <name>` launches a seat\'s harness in its Workspace (a member name unique on this ' +
      'machine, `project/member`, or the full `team/project/member`); `-r` resumes the last session, ' +
      '`--harness <id>` picks one, `--path` prints the folder, `--force` opens a second session on a ' +
      'live seat. `musterd -` is the last seat again. Commands always win over seat names.',
    examples: [
      'musterd seats',
      'musterd seats --json',
      'musterd stanley',
      'musterd revive/agents/stanley -r',
      'musterd -',
      'cd "$(musterd stanley --path)"',
    ],
  },
```

In `bin.ts`, after the `wantsCommandHelp` block and before `instrumentedDispatch`:

```ts
  // A word that is not a command is a seat address (ADR 491 Decision 2). Commands always win, and
  // the launcher returns before the postambles: a launched session never pays for the nudge.
  if (!isCommand(command)) {
    const { launchByName } = await import('./launcher/byName.js');
    return launchByName(command, rest);
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher src/commands/seats.test.ts src/commandTable.test.ts src/help src/render/help.test.ts src/importClosure.test.ts`
Expected: PASS. The `bin.ts` closure test still passes because `launcher/byName.js` is a dynamic import.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/launcher/byName.ts packages/cli/src/launcher/byName.test.ts packages/cli/src/commands/seats.ts packages/cli/src/commands/seats.test.ts packages/cli/src/commandTable.ts packages/cli/src/help/catalog.ts packages/cli/src/bin.ts
git commit -m "feat(cli): musterd <seat>, musterd -, and musterd seats (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: End to end through `dist/bin.js`, frames, docs, PR

**Files:**
- Create: `packages/cli/src/launcher/byName.e2e.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree + two command sections), `docs/design/figma-brief-terminal.md` (frames 18–19)

- [ ] **Step 1: Write the end-to-end test**

```ts
// packages/cli/src/launcher/byName.e2e.test.ts
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');

let home: string;
let bin: string;
let env: Record<string, string>;

beforeEach(() => {
  if (!existsSync(BIN)) throw new Error(`the launcher e2e needs the built CLI at ${BIN} — run \`pnpm -r build\` first`);
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-launch-e2e-')));
  const ws = join(home, 'musterd', 'acme', 'proj', 'ada');
  mkdirSync(join(ws, '.musterd'), { recursive: true });
  writeFileSync(
    join(ws, '.musterd', 'binding.json'),
    JSON.stringify({ version: 2, server: 'http://127.0.0.1:9', team: 'acme', claim: { mode: 'seat', name: 'ada' }, agent_key: 'mskey_E2E' }),
  );
  // A fake `claude`: answers --version (so the resolver accepts it), then exits 7 with its cwd on stdout.
  bin = join(home, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\npwd\nexit 7\n');
  chmodSync(fake, 0o755);
  env = {
    ...(process.env as Record<string, string>),
    HOME: home,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    MUSTERD_CONFIG: join(home, '.musterd', 'config.json'),
    NO_COLOR: '1',
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function musterd(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('the launcher through the built binary (ADR 491)', () => {
  it('seats --json lists the seat with no credential', async () => {
    const r = await musterd(['seats', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).seats[0].address).toBe('acme/proj/ada');
    expect(containsMusterdCredential(r.stdout)).toBe(false);
  });

  it('launches the harness in the Workspace, returns its code, prints the receipt, and `-` repeats it', async () => {
    const r = await musterd(['ada']);
    expect(r.code).toBe(7);
    expect(r.stdout.trim()).toBe(join(home, 'musterd', 'acme', 'proj', 'ada'));
    expect(r.stderr).toMatch(/^✗ ada · claude · \d+s · exit 7 · musterd - to go back\n$/);
    const again = await musterd(['-']);
    expect(again.code).toBe(7);
    const file = JSON.parse(readFileSync(join(home, '.musterd', 'launcher.json'), 'utf8'));
    expect(file.last).toBe('acme/proj/ada');
  });

  it('--path prints the folder for `cd "$(musterd ada --path)"`', async () => {
    const r = await musterd(['ada', '--path']);
    expect(r).toMatchObject({ code: 0, stdout: `${join(home, 'musterd', 'acme', 'proj', 'ada')}\n` });
  });

  it('a non-seat word keeps today\'s unknown-command contract', async () => {
    for (const word of ['zzz-nope', '--json', '-r']) {
      const r = await musterd([word]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`unknown command "${word.replace(/-/g, '\\-')}"`));
    }
  });

  it('piped bare `musterd` still prints help', async () => {
    const r = await musterd([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('musterd help <command>');
  });
});
```

- [ ] **Step 2: Build and run it**

Run: `pnpm -r build && pnpm --filter @musterd/cli exec vitest run src/launcher/byName.e2e.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Docs — the file tree**

In `docs/architecture/04-cli.md`, add after `opencodeBin.ts`:

```
  cursorAgentBin.ts   // PATH-robust `cursor-agent` resolution for the launcher — that name only, never the bare `agent`, which Grok also installs (ADR 491)
```

Add after the `integrations/` block:

```
  launcher/           // the seat launcher (ADR 491): bare `musterd` picks a seat and starts its harness; `musterd <seat>` does it by name
    labels.ts         // short harness labels (`claude-code` → `claude`) and the registry-ordered launchable set the picker paints with
    address.ts        // seat addresses: team/project/member, host-qualified when two servers on this machine host a same-named team
    store.ts          // ~/.musterd/launcher.json beside config.json: recents + the secret-free catalog snapshot the first screen paints from; zod-validated read and write, a corrupt file is set aside
    catalog.ts        // the seat catalog: config.bindings ∪ a scan of ~/musterd/<team>/<project>/<member>, read through the protocol loaders, named non-secret fields only; `originRepoName` reads git's files without a subprocess
    resolve.ts        // `musterd <word>` → one seat, an ambiguity, or no match (commands are ruled out before it runs)
    live.ts           // the live layer: one unauthenticated, time-boxed roster read per (server, team); Presence → here/elsewhere; the team's agent members
    plan.ts           // (seat, harness, fresh|resume) → { bin, args, cwd } from the adapter's interactive entry; a human seat gets a login shell
    supervise.ts      // runs the harness with the terminal handed over; ignores SIGINT/SIGQUIT, forwards SIGTERM/SIGHUP; the harness's exit code (128+n on a signal)
    rows.ts           // shared row and receipt rendering for the picker and `musterd seats`
    byName.ts         // `musterd <seat>` / `musterd -`: resolve, live check, plan, record, supervise, receipt
```

Add in `commands/` alphabetical place:

```
    seats.ts          // `musterd seats [--json]`: the seat catalog + live state, the launcher's read model (ADR 491)
```

- [ ] **Step 4: Docs — the command sections**

In `04-cli.md`'s `## Commands`, before `### \`musterd init\``:

````md
### `musterd <seat> [-r | --resume] [--harness <id>] [--path] [--force]` · `musterd -`

Launches a seat's harness in its Workspace, with musterd as the harness's parent process
([ADR 491](../decisions/491-seat-launcher.md)). `<seat>` is a member name unique on this machine,
`project/member`, or `team/project/member` (`team@host/project/member` when two servers host a team
with the same name). Commands always win over seat names. `-` is the seat launched last.

- Fresh by default; `-r` resumes the harness's last session.
- `--path` prints the Workspace path and launches nothing: `cd "$(musterd stanley --path)"`.
- A live seat asks `(y/N)` on a TTY and is refused without one unless `--force`.
- When the harness exits: one receipt line on stderr, and the harness's exit code (128 + n on signal n).
- Exit codes: 2 for no match or an ambiguous name (the candidates are listed); 1 for a seat that needs
  repair, a live seat without `--force`, or a harness that is not installed.

### `musterd seats [--json]`

Every seat on this machine and where it is live — the launcher's read model. `--json` carries no
secret and no harness session id.
````

- [ ] **Step 5: Frames**

In `docs/design/figma-brief-terminal.md`, add a subsection after the integration doctor frames:

````md
### Seat launcher frames (ADR 491)

18. `cmd/seats` — `$ musterd seats` (no color, 80 columns):
    ```
    seats on this machine · 3

    revive/agents
      stanley  claude   ○ idle  2h
      miley    claude   ● live  here · since 15:37
      gptbot   codex    ○ idle  needs repair

    2 stale · musterd init --prune-bindings --apply
    ```
    Columns: member (longest + 2), harness (9), state (8), then the tail. The tail is `here · since`
    or `on <node> · since` when live, `needs repair` in yellow when broken, otherwise when it was last
    used.
19. `cmd/launch-receipt` — the line `musterd <seat>` prints to stderr when the harness exits:
    `✓ stanley · claude · 42m · exit 0 · musterd - to go back` (green `✓` on exit 0, red `✗`
    otherwise; the last segment dim).
````

- [ ] **Step 6: Gates, commit, PR**

```bash
pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check
git add packages/cli/src/launcher/byName.e2e.test.ts docs/architecture/04-cli.md docs/design/figma-brief-terminal.md
git commit -m "test(cli): launcher end to end through dist/bin.js; docs + frames (ADR 491)" \
  -m "Lane: 01M3WA7J4YRC21TCGGW9PSDK9E" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/front-door-2-launch-by-name
gh pr create --title "Front door 2/4: musterd <seat>, musterd -, musterd seats (ADR 491)" --body "<lane, what ships, test list; end with the Claude Code attribution footer>"
gh pr merge --squash --auto --delete-branch
```

After the merge: `lane_submit` for lane `01M3WA7J4YRC21TCGGW9PSDK9E`. Dogfood it the same day: `musterd stanley` from a fresh terminal.

---

## Increment 3 — the picker (lane `01M3WA7W55F50XC6TFV33K21PR`)

### Task 14: Fuzzy search

**Files:**
- Create: `packages/cli/src/launcher/fuzzy.ts`
- Test: `packages/cli/src/launcher/fuzzy.test.ts`

**Interfaces:**
- Consumes: `Seat` (Task 6).
- Produces: `fuzzyScore(query, text): number | null` and `rankSeats(query, seats, lastUsed: (s: Seat) => number | null): Seat[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/fuzzy.test.ts
import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankSeats } from './fuzzy.js';
import type { Seat } from './store.js';

const seat = (address: string): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return { address, team, project, member, server: '', path: `/w/${address}`, kind: 'agent', harnesses: [], remote: null, last_session: null, problem: null };
};

describe('fuzzy search (spec §3.2)', () => {
  it('matches a subsequence, and every space-separated term', () => {
    expect(fuzzyScore('sta', 'revive/agents/stanley')).not.toBeNull();
    expect(fuzzyScore('rev sta', 'revive/agents/stanley')).not.toBeNull();
    expect(fuzzyScore('rev zzz', 'revive/agents/stanley')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers word starts and runs', () => {
    expect(fuzzyScore('sta', 'revive/agents/stanley')!).toBeGreaterThan(fuzzyScore('sta', 'revive/estates/x')!);
  });

  it('ranks by score, then last use, then address', () => {
    const seats = [seat('revive/agents/sloane'), seat('revive/agents/stanley'), seat('dawn/agents/stanley')];
    const used = (s: Seat) => (s.address === 'dawn/agents/stanley' ? 5 : null);
    expect(rankSeats('stan', seats, used).map((s) => s.address)).toEqual(['dawn/agents/stanley', 'revive/agents/stanley']);
    expect(rankSeats('s', seats, () => null).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/fuzzy.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/fuzzy.ts
import type { Seat } from './store.js';

/**
 * Subsequence fuzzy score (higher is better), or null when a term does not match. Space-separated
 * terms must all match, in any order: `rev sta` finds `revive/agents/stanley`. A character at a word
 * start (after `/`, `-`, `@`, a space, or the start) scores more, and so does a run; a shorter text
 * wins a tie.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    const s = termScore(term, hay);
    if (s === null) return null;
    total += s;
  }
  return total - hay.length * 0.01;
}

function termScore(term: string, hay: string): number | null {
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of term) {
    const at = hay.indexOf(ch, from);
    if (at === -1) return null;
    const boundary = at === 0 || '/-@ '.includes(hay[at - 1]!);
    score += 1 + (boundary ? 3 : 0) + (at === prev + 1 ? 2 : 0);
    prev = at;
    from = at + 1;
  }
  return score;
}

/** Seats matching `query`, best first; ties break on last use (newest first), then address. */
export function rankSeats(query: string, seats: readonly Seat[], lastUsed: (s: Seat) => number | null): Seat[] {
  return seats
    .map((seat) => ({ seat, score: fuzzyScore(query, seat.address) }))
    .filter((x): x is { seat: Seat; score: number } => x.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (lastUsed(b.seat) ?? 0) - (lastUsed(a.seat) ?? 0) ||
        a.seat.address.localeCompare(b.seat.address),
    )
    .map((x) => x.seat);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/fuzzy.test.ts`
Expected: PASS (3 tests). In the ranking case, `dawn/agents/stanley` and `revive/agents/stanley` both score higher than `sloane`, and the last-use tie-break puts `dawn` first. If the two `stanley` seats do not score equal, the length penalty differs (`dawn/…` is shorter), and `dawn` still sorts first.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/fuzzy.ts packages/cli/src/launcher/fuzzy.test.ts
git commit -m "feat(cli): launcher fuzzy search over seat addresses (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: The picker state machine

**Files:**
- Create: `packages/cli/src/launcher/picker/state.ts`
- Test: `packages/cli/src/launcher/picker/state.test.ts`

**Interfaces:**
- Consumes: `rankSeats` (Task 14); `lastUsedAt` and the `LauncherFile`, `Seat` and `TeamEntry` types (Task 6). `Live` (Task 10) is a type only.
- Produces: the types `Level`, `Row`, `Key`, `PickerState`, `PickerEvent` and `PickerOutcome`; the functions `initialState(file, query, now)`, `rows(state)`, `selectableRows(state)` and `reduce(state, event)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/picker/state.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce, rows, selectableRows, type Key, type PickerState } from './state.js';

const seat = (address: string, over: Partial<Seat> = {}): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return { address, team, project, member, server: 'http://127.0.0.1:4849', path: `/w/${member}`, kind: 'agent', harnesses: ['claude-code', 'codex'], remote: null, last_session: null, problem: null, ...over };
};
const SEATS = [seat('revive/agents/stanley'), seat('revive/agents/miley'), seat('dawn/web/ada')];
const FILE: LauncherFile = {
  ...EMPTY_LAUNCHER_FILE,
  last: 'revive/agents/stanley',
  seats: {
    'revive/agents/stanley': { path: '/w/stanley', harness: 'claude-code', mode: 'fresh', launched_at: 900, ended_at: null, exit: null },
    'revive/agents/miley': { path: '/w/miley', harness: 'claude-code', mode: 'fresh', launched_at: 800, ended_at: null, exit: null },
  },
  snapshot: { taken_at: 1, seats: SEATS, teams: [{ team: 'acme', here: false }, { team: 'dawn', here: true }, { team: 'revive', here: true }] },
};
const k = (name: string, extra: Partial<Key> = {}): Key => ({ name, sequence: name.length === 1 ? name : undefined, ...extra });
function press(s: PickerState, ...keys: Key[]) {
  let state = s;
  for (const key of keys) {
    const r = reduce(state, { type: 'key', key });
    if (r.outcome) return { state: r.state, outcome: r.outcome };
    state = r.state;
  }
  return { state, outcome: null };
}

describe('picker state (spec §3)', () => {
  const s0 = initialState(FILE, '', 1_000);

  it('opens on recent seats, newest first, from the snapshot', () => {
    expect(rows(s0)[0]).toEqual({ kind: 'heading', label: 'recent' });
    expect(selectableRows(s0).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual(['stanley', 'miley']);
  });

  it('⏎ launches the selected seat fresh; ⌃R resumes', () => {
    expect(press(s0, k('return')).outcome).toEqual({ kind: 'launch', seat: SEATS[0], mode: 'fresh', harness: null, force: false });
    expect(press(s0, k('down'), k('r', { ctrl: true })).outcome).toMatchObject({ seat: SEATS[1], mode: 'resume' });
  });

  it('typing searches every seat; esc clears, then quits', () => {
    const { state } = press(s0, k('a'), k('d'));
    expect(state.query).toBe('ad');
    expect(selectableRows(state).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual(['ada']);
    const cleared = press(state, k('escape')).state;
    expect(cleared.query).toBe('');
    expect(press(cleared, k('escape')).outcome).toEqual({ kind: 'quit', code: 0 });
  });

  it('`r` and `q` are letters, not commands — `ryder` must be typeable', () => {
    expect(press(s0, k('r'), k('q')).state.query).toBe('rq');
  });

  it('⌃C quits 130 from anywhere', () => {
    expect(press(s0, k('a'), k('c', { ctrl: true })).outcome).toEqual({ kind: 'quit', code: 130 });
  });

  it('→ browses teams → projects → members; ← goes back; a team with no Workspace is skipped', () => {
    let { state } = press(s0, k('right'));
    expect(state.level).toEqual({ kind: 'teams' });
    expect(selectableRows(state).map((r) => (r.kind === 'team' ? r.team : ''))).toEqual(['dawn', 'revive']);
    state = press(state, k('down'), k('return')).state;
    expect(state.level).toEqual({ kind: 'projects', team: 'revive' });
    state = press(state, k('return')).state;
    expect(state.level).toEqual({ kind: 'members', team: 'revive', project: 'agents' });
    expect(selectableRows(state).map((r) => (r.kind === 'seat' ? r.seat.member : ''))).toEqual(['miley', 'stanley']);
    expect(press(state, k('left')).state.level).toEqual({ kind: 'projects', team: 'revive' });
  });

  it('⇥ cycles the harness on a seat with several, and the launch carries it', () => {
    const { state } = press(s0, k('tab'));
    expect(state.harness['revive/agents/stanley']).toBe('codex');
    expect(press(state, k('return')).outcome).toMatchObject({ harness: 'codex' });
  });

  it('a live seat asks first; y launches with force, anything else cancels', () => {
    const live = reduce(s0, { type: 'live', live: { 'revive/agents/stanley': { where: 'here', label: 'here', surface: 'claude-code', since: 5 } }, status: 'ok', now: 2_000 }).state;
    const asking = press(live, k('return')).state;
    expect(asking.confirm?.seat).toEqual(SEATS[0]);
    expect(press(asking, k('n')).state.confirm).toBeNull();
    expect(press(asking, k('y')).outcome).toEqual({ kind: 'launch', seat: SEATS[0], mode: 'fresh', harness: null, force: true });
  });

  it('when the roster answered, a launch skips the re-check', () => {
    const ok = reduce(s0, { type: 'live', live: {}, status: 'ok', now: 2_000 }).state;
    expect(press(ok, k('return')).outcome).toMatchObject({ force: true });
  });

  it('a fresh catalog keeps the cursor on the same seat', () => {
    const moved = press(s0, k('down')).state;
    const next = reduce(moved, { type: 'catalog', seats: [seat('revive/agents/zed'), ...SEATS], teams: [], stale: 0, now: 3_000 }).state;
    const sel = selectableRows(next)[next.cursor];
    expect(sel?.kind === 'seat' && sel.seat.member).toBe('miley');
    expect(next.scanning).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/state.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/picker/state.ts
import { rankSeats } from '../fuzzy.js';
import type { Live } from '../live.js';
import { lastUsedAt, type LauncherFile, type Seat, type TeamEntry } from '../store.js';

/*
 * The picker as a pure state machine (ADR 491): keys and asynchronous answers in, a new state or an
 * outcome out. No I/O — tty.ts owns the terminal, index.ts owns the scans.
 */

export type Level =
  | { kind: 'recent' }
  | { kind: 'teams' }
  | { kind: 'projects'; team: string }
  | { kind: 'members'; team: string; project: string };

export type Row =
  | { kind: 'heading'; label: string }
  | { kind: 'seat'; seat: Seat; showAddress: boolean }
  | { kind: 'team'; team: string; here: boolean; count: number; star: boolean }
  | { kind: 'project'; team: string; project: string; count: number; remote: string | null; star: boolean };

/** What `readline`'s keypress event carries. */
export interface Key {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

export interface PickerState {
  seats: Seat[];
  teams: TeamEntry[];
  stale: number;
  file: LauncherFile;
  live: Record<string, Live>;
  liveStatus: 'pending' | 'ok' | 'offline';
  scanning: boolean;
  level: Level;
  stack: Level[];
  query: string;
  cursor: number;
  harness: Record<string, string>;
  confirm: { seat: Seat; mode: 'fresh' | 'resume' } | null;
  help: boolean;
  now: number;
}

export type PickerEvent =
  | { type: 'key'; key: Key }
  | { type: 'catalog'; seats: Seat[]; teams: TeamEntry[]; stale: number; now: number }
  | { type: 'live'; live: Record<string, Live>; status: 'ok' | 'offline'; now: number };

export type PickerOutcome =
  | { kind: 'launch'; seat: Seat; mode: 'fresh' | 'resume'; harness: string | null; force: boolean }
  | { kind: 'quit'; code: 0 | 130 };

type Step = { state: PickerState; outcome: PickerOutcome | null };

export function initialState(file: LauncherFile, query: string, now: number): PickerState {
  return {
    seats: file.snapshot?.seats ?? [],
    teams: file.snapshot?.teams ?? [],
    stale: 0,
    file,
    live: {},
    liveStatus: 'pending',
    scanning: true,
    level: { kind: 'recent' },
    stack: [],
    query,
    cursor: 0,
    harness: {},
    confirm: null,
    help: false,
    now,
  };
}

const seatRow = (seat: Seat, showAddress: boolean): Row => ({ kind: 'seat', seat, showAddress });
const byMember = (a: Seat, b: Seat) => a.member.localeCompare(b.member);

/** The rows of the current level (or of the search, when there is a query). */
export function rows(s: PickerState): Row[] {
  if (s.query.trim()) {
    const ranked = rankSeats(s.query, s.seats, (seat) => lastUsedAt(seat, s.file));
    return ranked.length ? [{ kind: 'heading', label: 'on this machine' }, ...ranked.map((x) => seatRow(x, true))] : [];
  }
  const lastTeam = s.seats.find((x) => x.address === s.file.last);
  switch (s.level.kind) {
    case 'recent': {
      const used = s.seats
        .filter((x) => lastUsedAt(x, s.file) !== null)
        .sort((a, b) => (lastUsedAt(b, s.file) ?? 0) - (lastUsedAt(a, s.file) ?? 0));
      const list = used.length ? used : [...s.seats];
      return list.length
        ? [{ kind: 'heading', label: used.length ? 'recent' : 'seats' }, ...list.map((x) => seatRow(x, true))]
        : [];
    }
    case 'teams':
      return [
        { kind: 'heading', label: 'teams' },
        ...s.teams.map((t): Row => ({
          kind: 'team',
          team: t.team,
          here: t.here,
          count: s.seats.filter((x) => x.team === t.team).length,
          star: lastTeam?.team === t.team,
        })),
      ];
    case 'projects': {
      const team = s.level.team;
      const projects = [...new Set(s.seats.filter((x) => x.team === team).map((x) => x.project))].sort();
      return [
        { kind: 'heading', label: `${team} · projects` },
        ...projects.map((project): Row => {
          const inProject = s.seats.filter((x) => x.team === team && x.project === project);
          return {
            kind: 'project',
            team,
            project,
            count: inProject.length,
            remote: inProject.find((x) => x.remote)?.remote ?? null,
            star: lastTeam?.team === team && lastTeam.project === project,
          };
        }),
      ];
    }
    case 'members': {
      const { team, project } = s.level;
      const here = s.seats.filter((x) => x.team === team && x.project === project).sort(byMember);
      return [{ kind: 'heading', label: 'on this machine' }, ...here.map((x) => seatRow(x, false))];
    }
  }
}

export function selectable(row: Row): boolean {
  return row.kind !== 'heading' && !(row.kind === 'team' && !row.here);
}

export function selectableRows(s: PickerState): Row[] {
  return rows(s).filter(selectable);
}

const identity = (row: Row | undefined): string =>
  !row ? '' : row.kind === 'seat' ? row.seat.address : row.kind === 'team' ? `t:${row.team}` : row.kind === 'project' ? `p:${row.team}/${row.project}` : '';

function clamp(s: PickerState, cursor: number): PickerState {
  const n = selectableRows(s).length;
  return { ...s, cursor: Math.min(Math.max(0, cursor), Math.max(0, n - 1)) };
}

function push(s: PickerState, level: Level): Step {
  return { state: { ...s, stack: [...s.stack, s.level], level, cursor: 0, query: '' }, outcome: null };
}

function pop(s: PickerState): PickerState {
  const prev = s.stack[s.stack.length - 1];
  return prev ? { ...s, level: prev, stack: s.stack.slice(0, -1), cursor: 0 } : s;
}

function activate(s: PickerState, mode: 'fresh' | 'resume'): Step {
  const row = selectableRows(s)[s.cursor];
  if (row?.kind === 'seat') {
    if (s.live[row.seat.address]) return { state: { ...s, confirm: { seat: row.seat, mode } }, outcome: null };
    return {
      state: s,
      outcome: { kind: 'launch', seat: row.seat, mode, harness: s.harness[row.seat.address] ?? null, force: s.liveStatus === 'ok' },
    };
  }
  if (mode === 'fresh' && row?.kind === 'team' && row.here) return push(s, { kind: 'projects', team: row.team });
  if (mode === 'fresh' && row?.kind === 'project') return push(s, { kind: 'members', team: row.team, project: row.project });
  return { state: s, outcome: null };
}

function cycleHarness(s: PickerState): PickerState {
  const row = selectableRows(s)[s.cursor];
  if (row?.kind !== 'seat') return s;
  const choices = row.seat.harnesses.filter((h) => h !== 'musterd');
  if (choices.length < 2) return s;
  const current = s.harness[row.seat.address] ?? choices[0]!;
  const next = choices[(choices.indexOf(current) + 1) % choices.length]!;
  return { ...s, harness: { ...s.harness, [row.seat.address]: next } };
}

function onKey(s: PickerState, key: Key): Step {
  const none = (state: PickerState): Step => ({ state, outcome: null });
  if (key.ctrl && key.name === 'c') return { state: s, outcome: { kind: 'quit', code: 130 } };
  if (s.confirm) {
    if (key.name === 'y' || key.sequence === 'Y') {
      const { seat, mode } = s.confirm;
      return { state: { ...s, confirm: null }, outcome: { kind: 'launch', seat, mode, harness: s.harness[seat.address] ?? null, force: true } };
    }
    return none({ ...s, confirm: null });
  }
  if (s.help) return none({ ...s, help: false });
  switch (key.name) {
    case 'escape':
      if (s.query) return none(clamp({ ...s, query: '' }, 0));
      if (s.stack.length) return none(pop(s));
      return { state: s, outcome: { kind: 'quit', code: 0 } };
    case 'up':
      return none(clamp(s, s.cursor - 1));
    case 'down':
      return none(clamp(s, s.cursor + 1));
    case 'return':
      return activate(s, 'fresh');
    case 'tab':
      return none(cycleHarness(s));
    case 'right': {
      // → browses; it never launches.
      if (!s.query && s.level.kind === 'recent') return push(s, { kind: 'teams' });
      const row = selectableRows(s)[s.cursor];
      return row?.kind === 'seat' ? none(s) : activate(s, 'fresh');
    }
    case 'left':
      return none(pop(s));
    case 'backspace':
      return none(clamp({ ...s, query: s.query.slice(0, -1) }, 0));
  }
  if (key.ctrl && key.name === 'p') return none(clamp(s, s.cursor - 1));
  if (key.ctrl && key.name === 'n') return none(clamp(s, s.cursor + 1));
  if (key.ctrl && key.name === 'r') return activate(s, 'resume');
  const ch = key.sequence;
  if (ch === '?' && !s.query) return none({ ...s, help: true });
  if (ch && ch.length === 1 && ch >= ' ' && !key.ctrl && !key.meta) return none(clamp({ ...s, query: s.query + ch }, 0));
  return none(s);
}

export function reduce(s: PickerState, e: PickerEvent): Step {
  if (e.type === 'catalog') {
    const keep = identity(selectableRows(s)[s.cursor]);
    const next: PickerState = { ...s, seats: e.seats, teams: e.teams, stale: e.stale, scanning: false, now: e.now };
    const at = selectableRows(next).findIndex((r) => identity(r) === keep);
    return { state: clamp(next, at === -1 ? s.cursor : at), outcome: null };
  }
  if (e.type === 'live') return { state: { ...s, live: e.live, liveStatus: e.status, now: e.now }, outcome: null };
  return onKey(s, e.key);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/state.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/picker/state.ts packages/cli/src/launcher/picker/state.test.ts
git commit -m "feat(cli): picker state machine — levels, search, keys, live confirm (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: The picker view

**Files:**
- Create: `packages/cli/src/launcher/picker/view.ts`
- Test: `packages/cli/src/launcher/picker/view.test.ts`

**Interfaces:**
- Consumes: `rows`, `selectableRows`, `PickerState` and `Row` (Task 15); `seatLine`, `describeLive`, `describeLiveLong` and `ago` (Task 11); `lastUsedAt` (Task 6); `theme`, `sym` and `visibleLen` (render).
- Produces: `interface PickerSize { cols: number; rows: number }` and `renderPicker(state, size): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/picker/view.test.ts
import { describe, expect, it } from 'vitest';
import { sinceLabel } from '../../render/theme.js';
import { EMPTY_LAUNCHER_FILE, type LauncherFile, type Seat } from '../store.js';
import { initialState, reduce } from './state.js';
import { renderPicker } from './view.js';

const NOW = Date.UTC(2026, 9, 1, 18, 0, 0);
const H = 3_600_000;
const seat = (member: string, over: Partial<Seat> = {}): Seat => ({
  address: `revive/agents/${member}`, team: 'revive', project: 'agents', member, server: 'http://127.0.0.1:4849', path: `/w/${member}`, kind: 'agent', harnesses: ['claude-code'], remote: null, last_session: null, problem: null, ...over,
});
const SEATS = [
  seat('stanley'),
  seat('miley', { last_session: { harness: 'claude-code', started_at: NOW - 3 * H, ended_at: null } }),
  seat('gptbot', { harnesses: ['codex'], last_session: { harness: 'codex', started_at: NOW - 26 * H, ended_at: null } }),
];
const FILE: LauncherFile = {
  ...EMPTY_LAUNCHER_FILE,
  last: 'revive/agents/stanley',
  seats: { 'revive/agents/stanley': { path: '/w/stanley', harness: 'claude-code', mode: 'fresh', launched_at: NOW - 2 * H, ended_at: null, exit: null } },
  snapshot: { taken_at: NOW, seats: SEATS, teams: [{ team: 'revive', here: true }] },
};
const header = (left: string, right: string) => left + ' '.repeat(80 - left.length - right.length) + right;

describe('renderPicker (spec §3.1, no color, 80 columns)', () => {
  it('the recent screen, once the roster answered', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, { type: 'catalog', seats: SEATS, teams: [{ team: 'revive', here: true }], stale: 0, now: NOW }).state;
    s = reduce(s, { type: 'live', live: { 'revive/agents/miley': { where: 'here', label: 'here', surface: 'claude-code', since: NOW - H } }, status: 'ok', now: NOW }).state;
    expect(renderPicker(s, { cols: 80, rows: 24 })).toEqual([
      header('● ● ○ musterd', 'revive · 3 seats here'),
      '',
      '  recent',
      '› stanley  revive/agents  claude   ○ idle  ★ last used · 2h',
      `  miley    revive/agents  claude   ● live  here · since ${sinceLabel(NOW - H, NOW)}`,
      '  gptbot   revive/agents  codex    ○ idle  1d',
      '',
      '  ⏎ launch · ⌃R resume · type to search · → browse · esc quit',
    ]);
  });

  it('says it is still checking before the roster answers, and offline when it cannot', () => {
    const s = initialState(FILE, '', NOW);
    expect(renderPicker(s, { cols: 80, rows: 24 })[0]).toBe(header('● ● ○ musterd', 'revive · 3 seats here · checking…'));
    const off = reduce(s, { type: 'live', live: {}, status: 'offline', now: NOW }).state;
    expect(renderPicker(off, { cols: 80, rows: 24 })[0]).toContain('offline · live state unavailable');
    expect(renderPicker(off, { cols: 80, rows: 24 })[3]).toContain('?');
  });

  it('drops the address column below 70 columns and the harness column below 56', () => {
    const s = reduce(initialState(FILE, '', NOW), { type: 'live', live: {}, status: 'ok', now: NOW }).state;
    expect(renderPicker(s, { cols: 60, rows: 24 })[3]).toBe('› stanley  claude   ○ idle  ★ last used · 2h');
    expect(renderPicker(s, { cols: 50, rows: 24 })[3]).toBe('› stanley  ○ idle  ★ last used · 2h');
  });

  it('the live-seat prompt replaces the footer', () => {
    let s = initialState(FILE, '', NOW);
    s = reduce(s, { type: 'live', live: { 'revive/agents/stanley': { where: 'here', label: 'here', surface: 'claude-code', since: NOW - H } }, status: 'ok', now: NOW }).state;
    s = reduce(s, { type: 'key', key: { name: 'return' } }).state;
    const lines = renderPicker(s, { cols: 80, rows: 24 });
    expect(lines.at(-1)).toBe(`  stanley is live here (claude-code) since ${sinceLabel(NOW - H, NOW)}. Open a second session in the same folder? (y/N)`);
  });

  it('never prints a line wider than the terminal, and fits the height', () => {
    const many = Array.from({ length: 60 }, (_, i) => seat(`member-with-a-long-name-${i}`));
    const s = initialState({ ...FILE, snapshot: { taken_at: NOW, seats: many, teams: [] } }, '', NOW);
    const lines = renderPicker(s, { cols: 40, rows: 12 });
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(40);
  });

  it('first run, before any scan, says it is finding seats', () => {
    const s = initialState(EMPTY_LAUNCHER_FILE, '', NOW);
    expect(renderPicker(s, { cols: 80, rows: 24 })).toContain('  finding seats…');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/view.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/picker/view.ts
import { theme } from '../../render/theme.js';
import { padEndVisible, visibleLen } from '../../render/ui.js';
import { ago, describeLive, describeLiveLong, seatLine } from '../rows.js';
import { lastUsedAt } from '../store.js';
import { rows, selectable, type PickerState, type Row } from './state.js';

export interface PickerSize {
  cols: number;
  rows: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** The picker screen as lines (spec §3): header, list, footer. Pure — tty.ts writes it. */
export function renderPicker(s: PickerState, size: PickerSize): string[] {
  const out: string[] = [header(s, size.cols), ''];
  if (s.query) out.push(`  ${theme.meta('search ›')} ${s.query}▏`);
  const list = s.help ? helpLines().map((line) => ({ line, selected: false })) : body(s, size.cols);
  const room = Math.max(1, size.rows - out.length - 2);
  out.push(...window(list, room), '', footer(s));
  return out.map((l) => clip(l, size.cols));
}

function header(s: PickerState, cols: number): string {
  const crumbs = s.level.kind === 'teams' ? ['teams'] : s.level.kind === 'projects' ? [s.level.team] : s.level.kind === 'members' ? [s.level.team, s.level.project] : [];
  const left = `${theme.presenceDot('online')} ${theme.presenceDot('away')} ${theme.presenceDot('offline')} ${['musterd', ...crumbs].join(' › ')}`;
  const teams = [...new Set(s.seats.map((x) => x.team))].sort().join(', ');
  const status = s.liveStatus === 'pending' ? ' · checking…' : s.liveStatus === 'offline' ? ' · offline · live state unavailable' : '';
  const right = theme.meta(`${teams ? `${teams} · ` : ''}${s.seats.length} seats here${status}`);
  const gap = Math.max(1, cols - visibleLen(left) - visibleLen(right));
  return left + ' '.repeat(gap) + right;
}

function body(s: PickerState, cols: number): { line: string; selected: boolean }[] {
  const all = rows(s);
  if (all.length === 0) {
    return [{ line: s.scanning ? '  finding seats…' : '  no seats on this machine yet — run `musterd init` in a project checkout', selected: false }];
  }
  const seatRows = all.filter((r): r is Extract<Row, { kind: 'seat' }> => r.kind === 'seat');
  const nameWidth = Math.max(8, ...seatRows.map((r) => r.seat.member.length + 2));
  const showAddress = cols >= 70 && seatRows.some((r) => r.showAddress);
  const addressWidth = showAddress ? Math.max(...seatRows.map((r) => `${r.seat.team}/${r.seat.project}`.length)) + 2 : null;
  const sel = all.filter(selectable)[s.cursor];
  return all.map((row) => {
    const selected = row === sel;
    const marker = selected ? `${theme.accent('›')} ` : '  ';
    switch (row.kind) {
      case 'heading':
        return { line: `  ${theme.meta(row.label)}`, selected };
      case 'team':
        return {
          line: `${marker}${padEndVisible(row.team, 9)}${row.here ? `${theme.ok('●')} here  ${row.count} seats` : theme.meta('○ no Workspace here')}${row.star ? '  ★' : ''}`,
          selected,
        };
      case 'project':
        return {
          line: `${marker}${padEndVisible(row.project, 9)}${theme.ok('●')} here  ${row.count} seats${row.star ? '  ★' : ''}${row.remote ? `  ${theme.meta(row.remote)}` : ''}`,
          selected,
        };
      case 'seat': {
        const { seat } = row;
        const live = s.live[seat.address];
        const used = lastUsedAt(seat, s.file);
        const tail = live
          ? describeLive(live, s.now)
          : seat.problem
            ? theme.warn('needs repair')
            : used !== null
              ? `${seat.address === s.file.last ? '★ last used · ' : ''}${ago(used, s.now)}`
              : '';
        const harness =
          seat.kind === 'human'
            ? 'human'
            : (s.harness[seat.address] ?? seat.harnesses.find((h) => h !== 'musterd') ?? seat.last_session?.harness ?? 'claude-code');
        return {
          line: seatLine(seat, {
            selected,
            nameWidth,
            addressWidth: row.showAddress ? addressWidth : null,
            showHarness: cols >= 56,
            harness,
            state: live ? 'live' : s.liveStatus === 'offline' ? 'unknown' : 'idle',
            tail,
          }),
          selected,
        };
      }
    }
  });
}

/** The `room` lines around the selected one, so the cursor never scrolls off screen. */
function window(items: { line: string; selected: boolean }[], room: number): string[] {
  const at = Math.max(0, items.findIndex((x) => x.selected));
  const start = Math.min(Math.max(0, at - room + 1), Math.max(0, items.length - room));
  return items.slice(start, start + room).map((x) => x.line);
}

function footer(s: PickerState): string {
  if (s.confirm) {
    const live = s.live[s.confirm.seat.address];
    const where = live ? describeLiveLong(live, s.now) : 'elsewhere';
    return `  ${s.confirm.seat.member} is live ${where}. Open a second session in the same folder? (y/N)`;
  }
  if (s.help) return theme.meta('  any key to go back');
  if (s.query) return theme.meta('  ⏎ launch · ⌃R resume · esc clear');
  if (s.level.kind === 'recent') return theme.meta('  ⏎ launch · ⌃R resume · type to search · → browse · esc quit');
  if (s.level.kind === 'members') return theme.meta('  ⏎ launch · ⌃R resume · ⇥ harness · ← back · esc back');
  return theme.meta('  ⏎ open · ← back · type to search · esc back');
}

function helpLines(): string[] {
  return [
    '  ↑ ↓ / ⌃P ⌃N   move',
    '  ⏎              launch fresh · open a team or project',
    '  ⌃R             resume the last session',
    '  ⇥              next harness, when the seat has several',
    '  → ←            into a level · back out',
    '  letters        search every seat',
    '  esc            clear · back · quit',
    '  ⌃C             quit',
  ];
}

function clip(line: string, cols: number): string {
  if (visibleLen(line) <= cols) return line;
  const plain = line.replace(ANSI, '');
  return [...plain].slice(0, Math.max(0, cols - 1)).join('') + '…';
}
```

The header right side uses `theme.meta`, which is plain text under `NO_COLOR`, so the test's `header()` helper computes the same padding. `seatLine` trims trailing spaces, which is why the expected rows have none.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/view.test.ts`
Expected: PASS (6 tests). The frame in the first test is the spec §3.1 frame; if they differ, fix the code, not the frame.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/picker/view.ts packages/cli/src/launcher/picker/view.test.ts
git commit -m "feat(cli): picker view — frames for recent, browse, search, confirm, help (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: The terminal layer

**Files:**
- Create: `packages/cli/src/launcher/picker/tty.ts`
- Test: `packages/cli/src/launcher/picker/tty.test.ts`

**Interfaces:**
- Consumes: `reduce`, `PickerState`, `PickerEvent`, `PickerOutcome` and `Key` (Task 15); `renderPicker` (Task 16).
- Produces: `interface PickerIO { input: NodeJS.ReadStream; output: NodeJS.WriteStream }` and `runPicker(initial, io, start, reducer?): Promise<PickerOutcome>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/picker/tty.test.ts
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type Seat } from '../store.js';
import { initialState, reduce } from './state.js';
import { runPicker } from './tty.js';

const seat = (member: string): Seat => ({
  address: `revive/agents/${member}`, team: 'revive', project: 'agents', member, server: '', path: `/w/${member}`, kind: 'agent', harnesses: [], remote: null, last_session: null, problem: null,
});
function io() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString()));
  return { input, output, written: () => written };
}
const STATE = initialState({ ...EMPTY_LAUNCHER_FILE, snapshot: { taken_at: 0, seats: [seat('stanley'), seat('miley')], teams: [] } }, '', 0);

describe('runPicker (ADR 491)', () => {
  it('typing then ⏎ resolves the outcome and restores the terminal', async () => {
    const t = io();
    const done = runPicker(STATE, t as never, () => {});
    t.input.write('sta');
    t.input.write('\r');
    expect(await done).toMatchObject({ kind: 'launch', seat: { member: 'stanley' }, mode: 'fresh' });
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(t.written()).toContain('\u001b[?1049h');
    expect(t.written().endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
  });

  it('async events repaint; ⌃C quits 130', async () => {
    const t = io();
    const done = runPicker(STATE, t as never, (dispatch) => {
      dispatch({ type: 'live', live: {}, status: 'offline', now: 0 });
    });
    t.input.write('\u0003');
    expect(await done).toEqual({ kind: 'quit', code: 130 });
    expect(t.written()).toContain('offline · live state unavailable');
  });

  it('restores the terminal when the reducer throws, and rejects', async () => {
    const t = io();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const done = runPicker(STATE, t as never, () => {}, boom as unknown as typeof reduce);
    t.input.write('x');
    await expect(done).rejects.toThrow('boom');
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.written().endsWith('\u001b[?25h\u001b[?1049l')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/tty.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/picker/tty.ts
import { emitKeypressEvents } from 'node:readline';
import { reduce, type Key, type PickerEvent, type PickerOutcome, type PickerState } from './state.js';
import { renderPicker } from './view.js';

export interface PickerIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const ALT_ON = '\u001b[?1049h';
const ALT_OFF = '\u001b[?1049l';
const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const HOME = '\u001b[H';
const CLEAR_LINE = '\u001b[K';
const CLEAR_DOWN = '\u001b[J';

/**
 * Run the picker until it produces an outcome (ADR 491). The only code that touches the terminal:
 * alternate screen, raw mode, keypresses, repaint, and — on every exit path, a throw and process
 * exit included — restore. `start` receives a dispatcher for asynchronous answers (the catalog
 * scan, the roster). In raw mode ⌃C arrives as a key, not a signal; the reducer maps it to quit 130.
 */
export function runPicker(
  initial: PickerState,
  io: PickerIO,
  start: (dispatch: (e: PickerEvent) => void) => void,
  reducer: typeof reduce = reduce,
): Promise<PickerOutcome> {
  return new Promise((resolve, reject) => {
    let state = initial;
    let finished = false;
    const restore = (): void => {
      try {
        if (io.input.isTTY) io.input.setRawMode(false);
      } catch {
        // the stream is already gone
      }
      io.input.pause();
      io.output.write(SHOW + ALT_OFF);
    };
    const paint = (): void => {
      const lines = renderPicker(state, { cols: io.output.columns || 80, rows: io.output.rows || 24 });
      io.output.write(HOME + lines.map((l) => l + CLEAR_LINE).join('\n') + CLEAR_DOWN);
    };
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      io.input.off('keypress', onKey);
      io.output.off('resize', paint);
      process.off('exit', restore);
      restore();
      settle();
    };
    const dispatch = (event: PickerEvent): void => {
      if (finished) return;
      try {
        const next = reducer(state, event);
        state = next.state;
        const outcome = next.outcome;
        if (outcome) finish(() => resolve(outcome));
        else paint();
      } catch (err) {
        finish(() => reject(err));
      }
    };
    const onKey = (str: string | undefined, key: Key | undefined): void =>
      dispatch({ type: 'key', key: key ?? { sequence: str } });

    process.on('exit', restore);
    emitKeypressEvents(io.input);
    if (io.input.isTTY) io.input.setRawMode(true);
    io.input.on('keypress', onKey);
    io.output.on('resize', paint);
    io.input.resume();
    io.output.write(ALT_ON + HIDE);
    paint();
    start(dispatch);
  });
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/tty.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/picker/tty.ts packages/cli/src/launcher/picker/tty.test.ts
git commit -m "feat(cli): picker terminal layer — alt screen, raw keys, restore on every exit (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 18: `openPicker`, bare `musterd`, the paint-path closure

**Files:**
- Create: `packages/cli/src/launcher/index.ts`
- Modify: `packages/cli/src/bin.ts` (bare `musterd` on a TTY), `packages/cli/src/launcher/byName.ts` (ambiguous name on a TTY), `packages/cli/src/importClosure.test.ts`, `scripts/bench-cli-start.ts`
- Test: `packages/cli/src/launcher/index.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 10, 12, 15, 16 and 17.
- Produces: `openPicker(opts?: { query?: string; io?: PickerIO; env?: NodeJS.ProcessEnv; home?: string }): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Append to `importClosure.test.ts`'s `describe`:

```ts
  it('the launcher paint path loads only zod, picocolors and node builtins (ADR 491 §5.1)', () => {
    const { files, packages } = staticClosure(join(SRC, 'launcher', 'index.ts'));
    const names = rel(files);
    for (const heavy of ['client.ts', 'config.ts', 'launcher/catalog.ts', 'launcher/live.ts', 'launcher/byName.ts'])
      expect(names, heavy).not.toContain(heavy);
    expect(names.filter((f) => f.startsWith('commands/'))).toEqual([]);
    expect([...packages].sort()).toEqual(['picocolors', 'zod']);
  });
```

```ts
// packages/cli/src/launcher/index.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPicker } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-picker-index-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openPicker (ADR 491)', () => {
  it('the paint probe prints the first frame and the time, without a TTY', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await openPicker({ env: { MUSTERD_CONFIG: join(dir, 'config.json'), MUSTERD_PAINT_PROBE: '1' }, home: dir });
      expect(code).toBe(0);
      expect(String(out.mock.calls[0]?.[0])).toContain('musterd');
      expect(String(err.mock.calls[0]?.[0])).toMatch(/^first-paint \d+(\.\d+)?ms\n$/);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/importClosure.test.ts src/launcher/index.test.ts`
Expected: FAIL — `launcher/index.ts` does not exist.

- [ ] **Step 3: Implement `index.ts`**

```ts
// packages/cli/src/launcher/index.ts
import { initialState, type PickerEvent } from './picker/state.js';
import { runPicker, type PickerIO } from './picker/tty.js';
import { renderPicker } from './picker/view.js';
import { launcherFilePath, readLauncherFile, withSnapshot, writeLauncherFile } from './store.js';
import type { Live } from './live.js';

/**
 * Bare `musterd` on a terminal (ADR 491 Decision 1). Paints from the snapshot first — this module's
 * static imports are zod, picocolors and node builtins only (`importClosure.test.ts`) — then loads
 * the catalog scan and the roster reads, which patch rows in place. `MUSTERD_PAINT_PROBE=1` renders
 * the first frame to stdout and reports the time since process start: the bench's first-paint probe.
 */
export async function openPicker(
  opts: { query?: string; io?: PickerIO; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const path = launcherFilePath(env);
  const state = initialState(readLauncherFile(path), opts.query ?? '', Date.now());
  if (env['MUSTERD_PAINT_PROBE'] === '1') {
    process.stdout.write(renderPicker(state, { cols: 80, rows: 24 }).join('\n') + '\n');
    process.stderr.write(`first-paint ${performance.now().toFixed(1)}ms\n`);
    return 0;
  }
  const outcome = await runPicker(state, opts.io ?? { input: process.stdin, output: process.stdout }, (dispatch) => {
    void refresh(dispatch, path, opts.home);
  });
  if (outcome.kind === 'quit') return outcome.code;
  const { launchSeat } = await import('./byName.js');
  return launchSeat(outcome.seat, { mode: outcome.mode, harness: outcome.harness, force: outcome.force });
}

/** The post-paint work: scan, snapshot, roster reads. Every failure degrades to "offline". */
async function refresh(dispatch: (e: PickerEvent) => void, path: string, home?: string): Promise<void> {
  try {
    const [{ buildCatalog }, { loadConfig }, os] = await Promise.all([
      import('./catalog.js'),
      import('../config.js'),
      import('node:os'),
    ]);
    const catalog = buildCatalog({ home: home ?? os.homedir(), config: loadConfig() });
    dispatch({ type: 'catalog', seats: catalog.seats, teams: catalog.teams, stale: catalog.stale.length, now: Date.now() });
    try {
      writeLauncherFile(path, withSnapshot(readLauncherFile(path), { taken_at: catalog.taken_at, seats: catalog.seats, teams: catalog.teams }));
    } catch {
      // the snapshot is a cache
    }
    const { fetchRosters, liveFor, rosterKey } = await import('./live.js');
    const rosters = await fetchRosters(catalog.seats);
    const live: Record<string, Live> = {};
    let answered = catalog.seats.length === 0;
    for (const seat of catalog.seats) {
      const members = rosters.get(rosterKey(seat)) ?? null;
      if (members) answered = true;
      const l = liveFor(seat, members);
      if (l) live[seat.address] = l;
    }
    dispatch({ type: 'live', live, status: answered ? 'ok' : 'offline', now: Date.now() });
  } catch {
    dispatch({ type: 'live', live: {}, status: 'offline', now: Date.now() });
  }
}
```

Put the `type Live` import in `import/order` place (`./live.js` sorts before `./picker/…`). It is type-only, so it stays out of the closure.

- [ ] **Step 4: Wire bare `musterd` and the ambiguous name**

In `bin.ts`, right after the Node gate and before `wantsHelp`:

```ts
  // Bare `musterd` on a terminal opens the seat picker (ADR 491 Decision 1). Piped or redirected,
  // it keeps printing help. MUSTERD_PAINT_PROBE is the bench's first-paint hook.
  if (argv.length === 0 && ((process.stdin.isTTY && process.stdout.isTTY) || process.env['MUSTERD_PAINT_PROBE'] === '1')) {
    const { openPicker } = await import('./launcher/index.js');
    return openPicker();
  }
```

In `byName.ts`, replace the `ambiguous` branch:

```ts
  if (res.kind === 'ambiguous') {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (isTTY) {
      const { openPicker } = await import('./index.js');
      return openPicker({ query: word });
    }
    throw new CliError(
      `"${word}" matches ${res.candidates.length} seats — name one:\n` +
        res.candidates.map((s) => `  musterd ${s.address}`).join('\n'),
      2,
    );
  }
```

- [ ] **Step 5: Add the first-paint probe to the bench**

In `scripts/bench-cli-start.ts`, append to `PROBES`:

```ts
  { name: 'musterd (first paint)', argv: [BIN], env: { MUSTERD_PAINT_PROBE: '1' } },
```

- [ ] **Step 6: Run the tests, build, try it**

Run: `pnpm --filter @musterd/cli exec vitest run src/importClosure.test.ts src/launcher`
Expected: PASS.

```bash
pnpm -r build && pnpm bench:cli-start     # record the first-paint median against the 150 ms target
node packages/cli/dist/bin.js             # in a real terminal: the picker
node packages/cli/dist/bin.js | cat       # piped: help
```

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/launcher/index.ts packages/cli/src/launcher/index.test.ts packages/cli/src/bin.ts packages/cli/src/launcher/byName.ts packages/cli/src/importClosure.test.ts scripts/bench-cli-start.ts
git commit -m "feat(cli): bare musterd opens the seat picker; paint path held to zod + picocolors (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Frames, docs, PR

**Files:**
- Modify: `docs/architecture/04-cli.md` (tree, the bare-`musterd` command section), `docs/design/figma-brief-terminal.md` (frames 20–22), `docs/decisions/491-seat-launcher.md` (dated Consequences note with the first-paint number)

- [ ] **Step 1: Tree lines**

Inside the `launcher/` block of `04-cli.md`:

```
    fuzzy.ts          // subsequence fuzzy scoring over seat addresses; every space-separated term must match; ties break on last use
    index.ts          // openPicker: paint from the snapshot, then the catalog scan and roster reads patch rows; launches what was picked; MUSTERD_PAINT_PROBE is the bench's first-paint hook
    picker/
      state.ts        // the picker as a pure state machine: levels (recent → teams → projects → members), search, keys, the live-seat confirm → state or an outcome
      view.ts         // pure renderer: state → screen lines; drops the address column below 70 columns and the harness column below 56
      tty.ts          // the only terminal code: alternate screen, raw mode, keypresses, repaint, restore on every exit path
```

- [ ] **Step 2: The command section**

In `04-cli.md`, add above the `musterd <seat>` section:

```md
### `musterd` (bare)

On a terminal, opens the seat picker ([ADR 491](../decisions/491-seat-launcher.md)): recent seats
first, letters search every seat, `→` browses teams → projects → members, `⏎` launches fresh, `⌃R`
resumes, `⇥` switches harness, `esc` goes back or quits (exit 0), `⌃C` quits (exit 130). The first
screen paints from `~/.musterd/launcher.json`'s snapshot; the catalog scan and the roster reads patch
it. Piped or redirected, bare `musterd` prints help.
```

- [ ] **Step 3: Frames**

Append to the `### Seat launcher frames (ADR 491)` subsection:

````md
20. `cmd/launcher-recent` — `$ musterd` in an 80-column terminal, after the roster answered. The
    exact no-color text is `view.test.ts`'s first case:
    ```
    ● ● ○ musterd                                              revive · 3 seats here

      recent
    › stanley  revive/agents  claude   ○ idle  ★ last used · 2h
      miley    revive/agents  claude   ● live  here · since 15:37
      gptbot   revive/agents  codex    ○ idle  1d

      ⏎ launch · ⌃R resume · type to search · → browse · esc quit
    ```
    The header shows ` · checking…` until the roster answers and ` · offline · live state
    unavailable` when it cannot (rows then show `?`).
21. `cmd/launcher-browse` — `→` from recent: `musterd › teams` (a team with no Workspace here is dim
    `○ no Workspace here` and is skipped by the cursor), `musterd › revive` (projects, with the remote
    name dim when it differs from the folder), and `musterd › revive › agents` (members).
22. `cmd/launcher-live-confirm` — `⏎` on a live seat replaces the footer:
    `  miley is live here (claude-code) since 15:37. Open a second session in the same folder? (y/N)`.
````

- [ ] **Step 4: ADR note**

Append to ADR 491's `## Consequences`:

```md
- **2026-10-xx — increment 3 measured.** `pnpm bench:cli-start` first-paint median <N> ms (p90 <N> ms)
  at load average <N>, against the 150 ms target (lane `01M3WA7W55F50XC6TFV33K21PR`).
```

Replace each `<N>` with the measured number.

- [ ] **Step 5: Gates, commit, PR**

```bash
pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check
git add docs/architecture/04-cli.md docs/design/figma-brief-terminal.md docs/decisions/491-seat-launcher.md
git commit -m "docs: picker frames, tree and command section; first-paint measurement (ADR 491)" \
  -m "Lane: 01M3WA7W55F50XC6TFV33K21PR" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/front-door-3-picker
gh pr create --title "Front door 3/4: bare musterd opens the seat picker (ADR 491)" --body "<lane, bench table, frames, test list; end with the Claude Code attribution footer>"
gh pr merge --squash --auto --delete-branch
```

After the merge: `lane_submit` for lane `01M3WA7W55F50XC6TFV33K21PR`. Its reply arms ADR 491's adoption experiment: seven days of `musterd` as the only way into a seat.

---

## Increment 4 — create from the picker (lane `01M3WA85HQRSA7V08FEQQ489HM`)

### Task 20: A new Workspace starts from the remote's default branch

**Files:**
- Modify: `packages/cli/src/onboard/workspace.ts:30-55` (`WorkspaceOpts`), `:141-161` (`addClone`, `addWorktree`), `:203` and `:226-227` (call sites)
- Test: `packages/cli/src/onboard/workspace.base.test.ts`

**Interfaces:**
- Produces: `WorkspaceOpts.base?: string` and `resolveBaseRef(top: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/onboard/workspace.base.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionWorkspace, resolveBaseRef } from './workspace.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
let checkout: string;
let mainTip: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-base-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'a'), '1');
  git(seed, 'add', 'a');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'main');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  mainTip = git(seed, 'rev-parse', 'HEAD');
  // The acting checkout: a clone of origin with a feature branch checked out, one commit ahead.
  checkout = join(root, 'musterd', 'acme', 'proj', 'nick');
  git(root, 'clone', '-q', origin, checkout);
  git(checkout, 'switch', '-qc', 'feature');
  writeFileSync(join(checkout, 'b'), '2');
  git(checkout, 'add', 'b');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'feature');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('base ref (ADR 491)', () => {
  it('resolves the remote default branch tip', () => {
    expect(resolveBaseRef(checkout)).toBe(mainTip);
  });

  it('a new Workspace starts at the base, not at whatever branch the checkout has open', () => {
    const ws = provisionWorkspace('ada', { cwd: checkout, team: 'acme', home: root, base: mainTip });
    expect(ws.dir).toBe(join(root, 'musterd', 'acme', 'proj', 'ada'));
    expect(git(ws.dir, 'rev-parse', 'HEAD')).toBe(mainTip);
    // --no-track: the seat's branch is its own, with no upstream.
    expect(() => git(ws.dir, 'config', 'branch.agent/ada.remote')).toThrow();
  });

  it('without a base it keeps today\'s behavior (the checkout HEAD)', () => {
    const ws = provisionWorkspace('bo', { cwd: checkout, team: 'acme', home: root });
    expect(git(ws.dir, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'HEAD'));
  });

  it('answers null when there is no remote', () => {
    const lonely = join(root, 'lonely');
    git(root, 'init', '-q', lonely);
    expect(resolveBaseRef(lonely)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/workspace.base.test.ts`
Expected: FAIL — `resolveBaseRef` is not exported.

- [ ] **Step 3: Implement**

In `WorkspaceOpts`, after `clone`:

```ts
  /**
   * Start a NEW branch from this commit-ish instead of the checkout's HEAD (ADR 491: a seat set up
   * from the launcher starts at the remote's default branch). Ignored when the branch already exists.
   */
  base?: string;
```

Replace `addClone` and `addWorktree`:

```ts
function addClone(top: string, dir: string, branch: string, base?: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', top, dir], { encoding: 'utf8' });
  // A local clone hard-links the whole object store, so a commit resolved in `top` exists here too.
  git(base ? ['switch', '-c', branch, base] : ['switch', '-c', branch], dir);
  const exclude = join(dir, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, '\n.musterd/\n');
}

function addWorktree(top: string, dir: string, branch: string, base?: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    // New branch so the member has its own line to commit on: off `base` when given (no upstream —
    // the seat's branch is its own), else off HEAD as before.
    git(base ? ['worktree', 'add', '--no-track', '-b', branch, dir, base] : ['worktree', 'add', '-b', branch, dir, 'HEAD'], top);
  } catch {
    // Branch already exists (e.g. a prior run): attach a worktree to it.
    git(['worktree', 'add', dir, branch], top);
  }
}

/**
 * The remote's default branch tip as a commit sha (ADR 491), after a best-effort fetch — offline,
 * the last-known tip. `origin/HEAD` first (absent in a repo built with `init` + `remote add`), then
 * `origin/main`. Null when there is no remote to start from.
 */
export function resolveBaseRef(top: string): string | null {
  try {
    execFileSync('git', ['fetch', 'origin', '--quiet'], { cwd: top, timeout: 20_000, stdio: 'ignore' });
  } catch {
    // offline or no origin — fall back to what is already fetched
  }
  for (const ref of ['origin/HEAD', 'origin/main']) {
    try {
      return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], top);
    } catch {
      // next
    }
  }
  return null;
}
```

Thread `opts.base` into both call sites: `addWorktree(top, dir, branch, opts.base)` at the `--path` site (`:203`), and `opts.clone ? addClone(top, dir, branch, opts.base) : addWorktree(top, dir, branch, opts.base)` at the layout site (`:226-227`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/workspace`
Expected: PASS, including the existing workspace tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/workspace.ts packages/cli/src/onboard/workspace.base.test.ts
git commit -m "feat(cli): a new Workspace can start from the remote's default branch (ADR 491)" \
  -m "Lane: 01M3WA85HQRSA7V08FEQQ489HM" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: `provisionSeat` wires through the reconcile engine and revokes on failure

**Files:**
- Modify: `packages/cli/src/onboard/provisionSeat.ts` (whole file), `packages/cli/src/host/provisioner.ts:137-158` (the call)
- Test: `packages/cli/src/onboard/provisionSeat.test.ts` (update), `packages/cli/src/host/provisioner.test.ts` (update expectations that read `harness` from the call)

**Interfaces:**
- Consumes: `saveProvisioning` and `loadProvisioning` (`onboard/manifest.ts`), `defaultHarnessContext` (`reconcile/context.ts`), `reconcileHarnesses` and `type ReconcileReport` (`reconcile/engine.ts`).
- Produces: `ProvisionSeatInput.wiring: { desired: string[]; toolkit: string; reconcile?: typeof reconcileHarnesses }` (replaces `harness` and `profileName`), and `ProvisionSeatResult { workspace; agentKey; granted; wiring: ReconcileReport | null; wiringError: string | null }` (replaces `mcpError`).

- [ ] **Step 1: Rewrite the test file's fakes and add the new cases**

In `provisionSeat.test.ts`, replace `fakeHarness` and `input` with:

```ts
const report = (ok = true) => ({
  ok,
  results: ok ? [] : [{ harness: 'claude-code', resourceKey: 'k', scope: 'folder', action: 'write', result: 'failed', recovery: 'none', detail: 'claude not found' }],
});

function input(over: Partial<ProvisionSeatInput> = {}): ProvisionSeatInput {
  return {
    team: 'acme',
    name: 'dana-scout',
    server: 'http://localhost:4849',
    http: {
      mintBootstrapCredential: vi.fn(async () => ({ credential: { id: 'cred-1' } as never, agent_key: 'msac_x' })),
      issueGrant: vi.fn(async () => ({ grant: {} as never, token: 'msgr_y' })),
      revokeBootstrapCredential: vi.fn(async () => ({ ok: true as const })),
    },
    workspace: () => ws,
    wiring: { desired: ['claude-code', 'musterd'], toolkit: '', reconcile: vi.fn(async () => report() as never) },
    ...over,
  };
}
```

In the first test, build the input once so its `reconcile` spy can be inspected, and replace the harness assertions (the `configure` calls) with:

```ts
    const i = input({ model: 'claude-opus-5-5', driver: 'dana' });
    const r = await provisionSeat(i);
    expect(r).toMatchObject({ agentKey: 'msac_x', granted: true, wiringError: null });
    const reconcile = i.wiring.reconcile as unknown as ReturnType<typeof vi.fn>;
    expect(reconcile).toHaveBeenCalledTimes(1);
    const [ctx, desired, opts] = reconcile.mock.calls[0] as [{ worktreeRoot: string; team?: string }, string[], { legacyRepair: boolean }];
    expect(ctx.worktreeRoot).toBe(realpathSync(dir));
    expect(ctx.team).toBe('acme');
    expect(desired).toEqual(['claude-code', 'musterd']);
    expect(opts.legacyRepair).toBe(false);
    const prov = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(prov).toMatchObject({ version: 3, toolkit: '', desired: ['claude-code', 'musterd'], contributions: {} });
```

Keep that test's binding and spec assertions. Add `realpathSync` to the `node:fs` import. Then add:

```ts
  it('reports incomplete wiring without throwing — the binding is already written', async () => {
    const i = input({ wiring: { desired: ['claude-code'], toolkit: '', reconcile: vi.fn(async () => report(false) as never) } });
    const r = await provisionSeat(i);
    expect(r.wiringError).toBe('claude-code: failed — claude not found');
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'dana-scout' });
  });

  it('keeps the prior contributions when it re-provisions a Workspace', async () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'provisioned.json'),
      JSON.stringify({ version: 3, toolkit: 'old', desired: ['codex'], contributions: { codex: ['k1'] }, provisionedAt: 'x' }),
    );
    await provisionSeat(input());
    const prov = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(prov.contributions).toEqual({ codex: ['k1'] });
    expect(prov.desired).toEqual(['claude-code', 'musterd']);
  });

  it('revokes the minted credential when the Workspace cannot be made, then rethrows', async () => {
    const i = input({
      workspace: () => {
        throw new Error('disk full');
      },
    });
    await expect(provisionSeat(i)).rejects.toThrow('disk full');
    expect(i.http.revokeBootstrapCredential).toHaveBeenCalledWith('acme', 'cred-1');
  });

  it('restores the process cwd after wiring, even when reconcile throws', async () => {
    const before = process.cwd();
    const i = input({ wiring: { desired: ['claude-code'], toolkit: '', reconcile: vi.fn(async () => { throw new Error('x'); }) } });
    const r = await provisionSeat(i);
    expect(r.wiringError).toBe('x');
    expect(process.cwd()).toBe(before);
  });
```

Add `mkdirSync` and `writeFileSync` to the `node:fs` import. Delete every remaining reference to `configure`, `fakeHarness`, `profileName` and `mcpError` in the file, along with the tests that only existed to assert the legacy `harness.configure` entry. The new behavior has no shared-entry write to assert.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/provisionSeat.test.ts`
Expected: FAIL — no `provisioned.json` is written, and `wiringError` is undefined.

- [ ] **Step 3: Rewrite `provisionSeat.ts`**

```ts
import type { Binding } from '@musterd/protocol';
import type { HttpClient } from '../client.js';
import { saveBinding, saveWorkspaceSpec } from '../config.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';
import { defaultHarnessContext } from './reconcile/context.js';
import { reconcileHarnesses, type ReconcileReport } from './reconcile/engine.js';
import type { Workspace } from './workspace.js';

/**
 * The one seat-provisioning sequence (ADR 065 steps 2–5, extracted for ADR 463 §3; wiring per
 * ADR 491): a credential scoped to this one seat, a standing grant, the Workspace's binding, the
 * committed launch spec, the desired harness set (`provisioned.json`), and the reconcile engine's
 * wiring. `musterd agent`, a sponsor's host and the launcher all run it.
 *
 * The caller owns declaring the member, the seat file, and creating the Workspace, which arrives as
 * a factory called AFTER the mint. A factory that throws gets the minted credential revoked: there
 * is no other rollback, and every step is idempotent, so running the same set-up again finishes it.
 */
export interface ProvisionSeatInput {
  team: string;
  name: string;
  server: string;
  http: Pick<HttpClient, 'mintBootstrapCredential' | 'issueGrant'> &
    Partial<Pick<HttpClient, 'revokeBootstrapCredential'>>;
  /** Create (or reuse) the seat's Workspace. Called once, after the credential is minted. */
  workspace: () => Workspace;
  /** The harnesses this Workspace launches (the ADR 281 desired set) and its toolkit. */
  wiring: { desired: string[]; toolkit: string; reconcile?: typeof reconcileHarnesses };
  /** A declared model for the seat's binding (ADR 101). Never a guess. */
  model?: string | undefined;
  /** The human steering this seat, if any (ADR 155). */
  driver?: string | undefined;
}

export interface ProvisionSeatResult {
  workspace: Workspace;
  agentKey: string;
  /** Whether a standing grant was minted (best-effort — the first claim routes through approval if not). */
  granted: boolean;
  /** The reconcile report, or null when wiring threw before producing one. */
  wiring: ReconcileReport | null;
  /** Why wiring is incomplete, or null. The binding and spec are already written when this is set. */
  wiringError: string | null;
}

const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged', 'pending']);

/** Throws only when the credential cannot be minted or the Workspace cannot be made. */
export async function provisionSeat(input: ProvisionSeatInput): Promise<ProvisionSeatResult> {
  const { team, name, server, http } = input;

  // ADR 344: a credential constrained to this one seat. Mint after declaration — the server
  // validates the target against the live roster. Never fall back to a Team-wide key.
  const mint = await http.mintBootstrapCredential(team, {
    use: 'claim_seat',
    target: name,
    label: `${input.wiring.desired[0] ?? 'musterd'}:${name}`,
  });
  const agentKey = mint.agent_key;

  // A standing grant so autojoin occupies on launch instead of opening an approval (ADR 077).
  let grant: string | undefined;
  try {
    grant = (await http.issueGrant(team, { scope: 'seat', target: name, lifetime: 'standing' })).token;
  } catch {
    grant = undefined;
  }

  let ws: Workspace;
  try {
    ws = input.workspace();
  } catch (err) {
    const id = (mint.credential as { id?: string } | undefined)?.id;
    if (id && http.revokeBootstrapCredential) {
      await http.revokeBootstrapCredential(team, id).catch(() => undefined);
    }
    throw err;
  }

  const binding: Binding = {
    version: 2,
    server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    // Per-Workspace, never the shared harness entry (ADR 165 inc 2).
    autojoin: true,
    ...(input.driver ? { driver: input.driver } : {}),
  };
  saveBinding(ws.dir, binding);
  saveWorkspaceSpec(ws.dir, { version: 2, server, team, claim: { mode: 'seat', name } });

  // Desire BEFORE reconciliation (ADR 282): a stop right after this leaves honest intent that the
  // next `musterd wire` resumes. A re-provisioned Workspace keeps its recorded contributions.
  const prior = loadProvisioning(ws.dir);
  saveProvisioning(ws.dir, {
    version: 3,
    toolkit: input.wiring.toolkit,
    desired: input.wiring.desired,
    contributions: prior.kind === 'valid' ? prior.value.contributions : {},
    provisionedAt: new Date().toISOString(),
  });

  let wiring: ReconcileReport | null = null;
  let wiringError: string | null = null;
  const prevCwd = process.cwd();
  try {
    // Claude Code's `claude mcp` local scope is keyed by the process cwd, not ctx.worktreeRoot.
    process.chdir(ws.dir);
    wiring = await (input.wiring.reconcile ?? reconcileHarnesses)(
      defaultHarnessContext(ws.dir, process.env, { team }),
      input.wiring.desired,
      { legacyRepair: false },
    );
    const bad = wiring.results.filter((r) => !WIRED.has(r.result));
    if (bad.length) {
      wiringError = bad.map((r) => `${r.harness}: ${r.result}${r.detail ? ` — ${r.detail}` : ''}`).join('; ');
    }
  } catch (err) {
    wiringError = (err as Error).message;
  } finally {
    process.chdir(prevCwd);
  }

  return { workspace: ws, agentKey, granted: grant !== undefined, wiring, wiringError };
}
```

- [ ] **Step 4: Update the sponsor host's call**

In `host/provisioner.ts`, in the `provisionSeat({…})` call, replace `harness: deps.harness,` with:

```ts
        wiring: { desired: [deps.harness.id], toolkit: '' },
```

In `host/provisioner.test.ts`, update any assertion that reads `harness` from the captured `provisionSeat` input to read `wiring.desired[0]` instead.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/provisionSeat.test.ts src/host/provisioner.test.ts`
Expected: PASS. `commands/agent.ts` does not compile yet; Task 22 fixes it.

- [ ] **Step 6: Commit (with Task 22)**

The build is red until `agent.ts` follows, so commit Tasks 21 and 22 together at the end of Task 22.

### Task 22: `provisionAgentSeat` — the core `musterd agent` and the launcher share

**Files:**
- Create: `packages/cli/src/onboard/agentSeat.ts`
- Modify: `packages/cli/src/commands/agent.ts` (whole file)
- Test: `packages/cli/src/onboard/agentSeat.test.ts`, `packages/cli/src/commands/agent.test.ts` (update mocks)

**Interfaces:**
- Consumes: `provisionSeat` (Task 21), `provisionWorkspace` (Task 20), `writeSeatFile` (`roster.ts`) and `CliError`.
- Produces: `interface AgentSeatInput`, `interface AgentSeatResult { workspace; reused; granted; wiring; wiringError }` and `provisionAgentSeat(input): Promise<AgentSeatResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/onboard/agentSeat.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { provisionAgentSeat, type AgentSeatInput } from './agentSeat.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-agent-seat-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function input(over: Partial<AgentSeatInput> = {}): AgentSeatInput {
  return {
    name: 'ada',
    team: 'acme',
    server: 'http://127.0.0.1:4849',
    http: {
      addMember: vi.fn(async () => ({}) as never),
      roster: vi.fn(async () => ({ members: [] }) as never),
      mintBootstrapCredential: vi.fn(async () => ({ credential: { id: 'c' } as never, agent_key: 'msac_a' })),
      issueGrant: vi.fn(async () => ({ grant: {} as never, token: 'msgr_g' })),
      revokeBootstrapCredential: vi.fn(async () => ({ ok: true as const })),
    },
    harnesses: ['claude-code'],
    toolkit: '',
    sourceDir: dir,
    path: join(dir, 'ws'),
    reconcile: vi.fn(async () => ({ ok: true, results: [] }) as never),
    ...over,
  };
}

describe('provisionAgentSeat (ADR 491)', () => {
  it('adds the member, provisions, and wires the desired set', async () => {
    const i = input();
    const r = await provisionAgentSeat(i);
    expect(i.http.addMember).toHaveBeenCalledWith('acme', { name: 'ada', kind: 'agent' });
    expect(r).toMatchObject({ reused: false, granted: true, wiringError: null });
    expect(r.workspace.dir).toBe(join(dir, 'ws'));
  });

  it('an existing agent is reused, not an error', async () => {
    const conflict = new CliError('exists', 9, 'conflict');
    const i = input();
    (i.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(conflict);
    (i.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ members: [{ name: 'ada', kind: 'agent' }] });
    expect((await provisionAgentSeat(i)).reused).toBe(true);
  });

  it('refuses a name that belongs to a human', async () => {
    const i = input();
    (i.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CliError('exists', 9, 'conflict'));
    (i.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ members: [{ name: 'ada', kind: 'human' }] });
    await expect(provisionAgentSeat(i)).rejects.toThrow(/as a human, not an agent/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/agentSeat.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `agentSeat.ts`**

```ts
// packages/cli/src/onboard/agentSeat.ts
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { writeSeatFile } from '../roster.js';
import { provisionSeat } from './provisionSeat.js';
import type { ReconcileReport, reconcileHarnesses } from './reconcile/engine.js';
import { provisionWorkspace, type Workspace } from './workspace.js';

/**
 * Add (or reuse) an agent member and give it a provisioned, wired Workspace (ADR 065, ADR 491) —
 * the core of `musterd agent`, shared with the launcher's "set up here" and "+ new seat". The caller
 * owns identity: it passes an `http` client already acting as someone allowed to add the member.
 */
export interface AgentSeatInput {
  name: string;
  team: string;
  server: string;
  http: Pick<
    HttpClient,
    'addMember' | 'roster' | 'mintBootstrapCredential' | 'issueGrant' | 'revokeBootstrapCredential'
  >;
  harnesses: string[];
  toolkit: string;
  /** The checkout the new Workspace is made from (its git root and layout group). */
  sourceDir: string;
  /** Start commit for a new branch (`resolveBaseRef`). */
  base?: string | undefined;
  /** A file-backed team's roster home: the seat file is written first (ADR 058 §5). */
  rosterHome?: string | undefined;
  role?: string | undefined;
  hue?: number | undefined;
  model?: string | undefined;
  driver?: string | undefined;
  here?: boolean | undefined;
  path?: string | undefined;
  reconcile?: typeof reconcileHarnesses | undefined;
}

export interface AgentSeatResult {
  workspace: Workspace;
  reused: boolean;
  granted: boolean;
  wiring: ReconcileReport | null;
  wiringError: string | null;
}

export async function provisionAgentSeat(input: AgentSeatInput): Promise<AgentSeatResult> {
  const { name, team, http } = input;
  const declared = {
    ...(input.role ? { role: input.role } : {}),
    ...(input.hue !== undefined ? { hue: input.hue } : {}),
  };
  if (input.rosterHome) writeSeatFile(input.rosterHome, name, { kind: 'agent', ...declared });

  // Idempotent: an already-declared agent is reused and its Workspace (re)built. `forbidden` for a
  // sponsor provisioning the agent they created (ADR 463 §3) is not adding a member either; the
  // daemon decides at the credential mint whether this caller may provision THIS agent.
  let reused = false;
  try {
    await http.addMember(team, { name, kind: 'agent', ...declared });
  } catch (err) {
    if (!(err instanceof CliError) || (err.code !== 'conflict' && err.code !== 'forbidden')) throw err;
    const { members } = await http.roster(team);
    const existing = members.find((m) => m.name === name);
    if (err.code === 'forbidden' && existing?.kind !== 'agent') throw err;
    if (existing && existing.kind !== 'agent') {
      throw new CliError(
        `"${name}" already exists in "${team}" as a ${existing.kind}, not an agent — pick a different name for the agent workspace`,
        err.exitCode,
      );
    }
    reused = true;
  }

  const r = await provisionSeat({
    team,
    name,
    server: input.server,
    http,
    workspace: () =>
      provisionWorkspace(name, {
        here: input.here === true,
        team,
        cwd: input.sourceDir,
        ...(input.path ? { path: input.path } : {}),
        ...(input.base ? { base: input.base } : {}),
      }),
    wiring: {
      desired: input.harnesses,
      toolkit: input.toolkit,
      ...(input.reconcile ? { reconcile: input.reconcile } : {}),
    },
    model: input.model,
    driver: input.driver,
  });
  return { workspace: r.workspace, reused, granted: r.granted, wiring: r.wiring, wiringError: r.wiringError };
}
```

- [ ] **Step 4: Rewrite `commands/agent.ts` on top of it**

```ts
import { resolveAttestedModel } from '@musterd/protocol';
import { flagHue, flagStr, type Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { infraTouchWarning } from '../infra-gate.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd agent <name>` — add an agent AND give it an isolated, wired Workspace (ADR 065). Since
 * ADR 491 it writes the desired harness set (`provisioned.json`) and wires through the reconcile
 * engine, so the repo-shared Claude Code entry keeps its launch marker (ADR 286). `--harness a,b`
 * names the set (default claude-code); `--here` binds this folder; `--path <dir>` targets one.
 */
export async function agentCommand(
  parsed: Parsed,
  deps: { infraGate?: (verb: string) => Promise<string | null> } = {},
): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd agent <name> [--role <label>] [--profile <toolkit>] [--model <id>] [--harness <id,…>] [--driver <you>] [--here | --path <dir>]',
      2,
    );
  }
  const role = flagStr(parsed.flags, 'role');
  const toolkit = flagStr(parsed.flags, 'profile') ?? '';
  const hue = flagHue(parsed.flags);
  const model = flagStr(parsed.flags, 'model') ?? resolveAttestedModel(process.env);

  let driver: string | undefined;
  const driverFlag = parsed.flags['driver'];
  if (typeof driverFlag === 'string' && driverFlag.trim()) {
    driver = driverFlag.trim();
  } else if (driverFlag === true) {
    driver = resolveRead(parsed.flags).identity?.name;
    if (!driver)
      throw new CliError(
        '`--driver` marks the human steering this seat — pass a name (`--driver <you>`), or run it from your own Workspace so bare `--driver` resolves to you',
        2,
      );
  }

  const known = harnessAdapters().map((a) => a.id);
  const harnesses = (flagStr(parsed.flags, 'harness') ?? 'claude-code')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const unknown = harnesses.filter((h) => !known.includes(h));
  if (unknown.length || harnesses.length === 0) {
    throw new CliError(`unknown harness "${unknown.join(', ')}" — choose from: ${known.join(', ')}`, 2);
  }

  const { team, http, config } = resolve(parsed.flags);
  const gateWarn = await (deps.infraGate ?? infraTouchWarning)('agent');
  if (gateWarn) process.stdout.write(`${theme.warn(sym.warn)} ${theme.warn(gateWarn)}\n`);

  const r = await provisionAgentSeat({
    name,
    team,
    server: config.server,
    http,
    harnesses,
    toolkit,
    sourceDir: process.cwd(),
    rosterHome: loadConfig().rosterHome[team],
    role,
    hue,
    model,
    driver,
    here: parsed.flags['here'] === true,
    path: flagStr(parsed.flags, 'path'),
  });
  const ws = r.workspace;

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        dir: ws.dir,
        kind: ws.kind,
        branch: ws.branch ?? null,
        harness: harnesses[0],
        harnesses,
        mcpRegistered: r.wiringError === null,
        granted: r.granted,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${r.reused ? 'reused' : 'added'} ${theme.memberName(name, 'agent')} ${theme.meta(`(agent${role ? `, ${role}` : ''})`)} ${r.reused ? 'on' : 'to'} ${team}\n`,
  );
  const where = ws.kind === 'worktree' ? `branch ${theme.accent(ws.branch ?? '')}` : ws.kind === 'folder' ? 'folder' : 'this folder';
  process.stdout.write(`${theme.ok(sym.ok)} workspace ${ws.dir} ${theme.meta(`(${where})`)}\n`);
  if (r.wiringError === null) {
    process.stdout.write(
      success(`wired ${harnesses.join(', ')} there (autojoin)`, { next: `musterd ${name} — launches it` }) + '\n',
    );
  } else {
    process.stdout.write(
      `${theme.warn(sym.warn)} wiring is incomplete (${r.wiringError}).\n` +
        theme.meta(`  finish it with \`musterd wire\` in ${ws.dir} — the binding and provisioned.json are already written.`) +
        '\n',
    );
  }
  return 0;
}
```

`exactOptionalPropertyTypes`: `role`, `hue`, `model`, `driver` and `path` may be `undefined`; `AgentSeatInput` declares each `| undefined`, so passing them through is fine.

- [ ] **Step 5: Update `agent.test.ts`'s mocks**

`agent.test.ts` mocks `../onboard/harnesses/index.js` with `HARNESSES` only. Replace that mock with:

```ts
vi.mock('../onboard/harnesses/index.js', () => ({
  harnessAdapters: () => ['claude-code', 'cursor', 'codex', 'opencode', 'grok', 'musterd'].map((id) => ({ id })),
}));
vi.mock('../onboard/reconcile/engine.js', () => ({
  reconcileHarnesses: vi.fn(async () => ({ ok: true, results: [] })),
}));
```

Update its assertions:
- `mcpRegistered` stays in `--json`.
- Output lines that named `harness.label` now name the ids (`wired claude-code there (autojoin)`).
- A test for `--harness bogus` expects `unknown harness "bogus" — choose from: claude-code, cursor, codex, opencode, grok, musterd`.

Read the file first and keep every other assertion as it is.

- [ ] **Step 6: Run the tests and the whole CLI suite**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/agentSeat.test.ts src/commands/agent.test.ts src/onboard/provisionSeat.test.ts src/host/provisioner.test.ts && pnpm typecheck`
Expected: PASS.

Run: `pnpm --filter @musterd/cli test`
Expected: PASS.

- [ ] **Step 7: Commit Tasks 21–22**

```bash
git add packages/cli/src/onboard/provisionSeat.ts packages/cli/src/onboard/provisionSeat.test.ts packages/cli/src/onboard/agentSeat.ts packages/cli/src/onboard/agentSeat.test.ts packages/cli/src/commands/agent.ts packages/cli/src/commands/agent.test.ts packages/cli/src/host/provisioner.ts packages/cli/src/host/provisioner.test.ts
git commit -m "fix(cli): seats wire through the reconcile engine, write provisioned.json, revoke on failure (ADR 491)" \
  -m "musterd agent's legacy harness.configure wrote the repo-shared Claude Code entry with an empty env, dropping MUSTERD_LAUNCH_SURFACE for every sibling Workspace (ADR 286). provisionSeat now saves the desired set first and reconciles; a Workspace failure after the mint revokes the credential." \
  -m "Lane: 01M3WA85HQRSA7V08FEQQ489HM" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 23: `create.ts` — set up a seat from the launcher, acting as you

**Files:**
- Create: `packages/cli/src/launcher/create.ts`
- Test: `packages/cli/src/launcher/create.test.ts`

**Interfaces:**
- Consumes: `provisionAgentSeat` (Task 22), `resolveBaseRef` (Task 20), `buildCatalog` (Task 7), `loadBinding` and `loadConfig` (`config.ts`), and `HttpClient`.
- Produces: `actingSeat(team, project, seats): Seat | null`, `interface CreateInput`, `interface CreateDeps` and `createSeat(input, deps?): Promise<Seat>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/create.test.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actingSeat, createSeat } from './create.js';
import type { Seat } from './store.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-create-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(member: string, b: Record<string, unknown>): string {
  const dir = join(home, 'musterd', 'acme', 'proj', member);
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(join(dir, '.musterd', 'binding.json'), JSON.stringify({ version: 2, server: 'http://127.0.0.1:4849', team: 'acme', claim: { mode: 'seat', name: member }, ...b }));
  return dir;
}
const seat = (member: string, kind: 'agent' | 'human', path: string): Seat => ({
  address: `acme/proj/${member}`, team: 'acme', project: 'proj', member, server: 'http://127.0.0.1:4849', path, kind, harnesses: [], remote: null, last_session: null, problem: null,
});

describe('createSeat (ADR 491 §4.7)', () => {
  it('acts from your human Workspace in the same team and project', () => {
    const nick = seat('nick', 'human', '/w/nick');
    expect(actingSeat('acme', 'proj', [seat('ada', 'agent', '/w/ada'), nick])).toBe(nick);
    expect(actingSeat('acme', 'other', [nick])).toBeNull();
  });

  it('without a human Workspace here, says how to make one', async () => {
    await expect(createSeat({ team: 'acme', project: 'proj', member: 'slate', harnesses: ['codex'], seats: [], home })).rejects.toThrow(
      /set up your own seat in acme\/proj first: musterd human <you>/,
    );
  });

  it('provisions with your credential and the remote base, then returns the new seat from the catalog', async () => {
    const nickDir = write('nick', { agent_key: 'mscr_nick' });
    const client = vi.fn(() => ({}) as never);
    const provision = vi.fn(async () => {
      const dir = write('slate', { agent_key: 'msac_new' });
      return { workspace: { dir, kind: 'worktree' as const, created: true }, reused: false, granted: true, wiring: null, wiringError: null };
    });
    const created = await createSeat(
      { team: 'acme', project: 'proj', member: 'slate', harnesses: ['codex'], seats: [seat('nick', 'human', nickDir)], home },
      { client, provision, baseRef: () => 'abc123' },
    );
    expect(client).toHaveBeenCalledWith('http://127.0.0.1:4849', 'mscr_nick');
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ name: 'slate', team: 'acme', harnesses: ['codex'], sourceDir: nickDir, base: 'abc123' }));
    expect(created.address).toBe('acme/proj/slate');
  });

  it('incomplete wiring is an error that names the fix', async () => {
    const nickDir = write('nick', { agent_key: 'mscr_nick' });
    const provision = vi.fn(async () => ({ workspace: { dir: write('slate', {}), kind: 'worktree' as const, created: true }, reused: false, granted: true, wiring: null, wiringError: 'codex: failed' }));
    await expect(
      createSeat({ team: 'acme', project: 'proj', member: 'slate', harnesses: ['codex'], seats: [seat('nick', 'human', nickDir)], home }, { client: () => ({}) as never, provision, baseRef: () => null }),
    ).rejects.toThrow(/wiring is incomplete: codex: failed — run `musterd wire` there/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/create.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/launcher/create.ts
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { HttpClient } from '../client.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { resolveBaseRef } from '../onboard/workspace.js';
import { buildCatalog } from './catalog.js';
import type { Seat } from './store.js';

/**
 * Your own human seat's Workspace in a team and project — the identity a launcher-made seat acts
 * as, and the checkout it is made from (ADR 491 §4.7). The CLI writes only as a folder-bound
 * identity (ADR 036, ADR 442), never as one it finds in the machine config.
 */
export function actingSeat(team: string, project: string, seats: readonly Seat[]): Seat | null {
  return seats.find((s) => s.kind === 'human' && s.team === team && s.project === project && s.problem === null) ?? null;
}

export interface CreateInput {
  team: string;
  project: string;
  member: string;
  harnesses: string[];
  /** The current catalog, to find the acting seat. */
  seats: readonly Seat[];
  home?: string;
}

export interface CreateDeps {
  provision?: typeof provisionAgentSeat;
  client?: (server: string, key: string) => HttpClient;
  baseRef?: (dir: string) => string | null;
}

/** Set up an agent seat in `team/project` on this machine and return it, ready to launch. */
export async function createSeat(input: CreateInput, deps: CreateDeps = {}): Promise<Seat> {
  const acting = actingSeat(input.team, input.project, input.seats);
  if (!acting) {
    throw new CliError(`set up your own seat in ${input.team}/${input.project} first: musterd human <you>`, 2);
  }
  const b = loadBinding(acting.path);
  if (b.kind !== 'valid' || !b.value.agent_key) {
    throw new CliError(`${acting.path} has no usable identity — run \`musterd init --check\` there`, 4);
  }
  const config = loadConfig();
  const http = (deps.client ?? ((server: string, key: string) => new HttpClient({ server, key })))(
    b.value.server,
    b.value.agent_key,
  );
  const base = (deps.baseRef ?? resolveBaseRef)(acting.path);
  const result = await (deps.provision ?? provisionAgentSeat)({
    name: input.member,
    team: input.team,
    server: b.value.server,
    http,
    harnesses: input.harnesses,
    toolkit: '',
    sourceDir: acting.path,
    ...(base ? { base } : {}),
    rosterHome: config.rosterHome[input.team],
  });
  if (result.wiringError) {
    throw new CliError(
      `set up ${input.member} at ${result.workspace.dir}, but wiring is incomplete: ${result.wiringError} — run \`musterd wire\` there`,
      1,
    );
  }
  const real = realpathSync(result.workspace.dir);
  const seat = buildCatalog({ home: input.home ?? homedir(), config }).seats.find((s) => s.path === real);
  if (!seat) {
    throw new CliError(`set up ${input.member} at ${result.workspace.dir}, but it is not in the seat catalog — run \`musterd seats\``, 1);
  }
  return seat;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/create.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launcher/create.ts packages/cli/src/launcher/create.test.ts
git commit -m "feat(cli): launcher create — set up a seat acting from your own human Workspace (ADR 491)" \
  -m "Lane: 01M3WA85HQRSA7V08FEQQ489HM" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 24: Create flows in the picker

**Files:**
- Modify: `packages/cli/src/launcher/picker/state.ts`, `picker/view.ts`, `launcher/index.ts`
- Test: `packages/cli/src/launcher/picker/state.create.test.ts`, plus a case in `picker/view.test.ts`

**Interfaces:**
- Consumes: `teamAgents` (Task 10), `LAUNCHABLE_HARNESSES` and `harnessLabel` (Task 5), `createSeat` (Task 23).
- Produces:
  - New `Row` kinds: `{ kind: 'team-only'; team; project; member }`, `{ kind: 'new-seat'; team; project }` and `{ kind: 'hint'; text }`.
  - New state: `PickerState.agents: Record<string, string[]>` and `PickerState.create: CreateDraft | null`.
  - New outcome: `{ kind: 'create'; team; project; member; harnesses: string[] }`.
  - The `live` event gains `agents: Record<string, string[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/launcher/picker/state.create.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type Seat } from '../store.js';
import { initialState, reduce, rows, type Key, type PickerState } from './state.js';

const seat = (member: string, kind: 'agent' | 'human' = 'agent'): Seat => ({
  address: `acme/proj/${member}`, team: 'acme', project: 'proj', member, server: '', path: `/w/${member}`, kind, harnesses: [], remote: null, last_session: null, problem: null,
});
const k = (name: string, extra: Partial<Key> = {}): Key => ({ name, sequence: name.length === 1 ? name : undefined, ...extra });
function press(s: PickerState, ...keys: Key[]) {
  let state = s;
  for (const key of keys) {
    const r = reduce(state, { type: 'key', key });
    if (r.outcome) return { state: r.state, outcome: r.outcome };
    state = r.state;
  }
  return { state, outcome: null };
}
function membersOf(seats: Seat[], agents: string[]): PickerState {
  let s = initialState({ ...EMPTY_LAUNCHER_FILE, snapshot: { taken_at: 0, seats, teams: [{ team: 'acme', here: true }] } }, '', 0);
  s = reduce(s, { type: 'live', live: {}, status: 'ok', now: 0, agents: { acme: agents } }).state;
  return { ...s, level: { kind: 'members', team: 'acme', project: 'proj' }, stack: [{ kind: 'recent' }] };
}

describe('picker create flows (ADR 491 §3.4)', () => {
  it('lists team agents with no Workspace here, then + new seat, when you have a seat here', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], ['ada', 'slate']);
    expect(rows(s).map((r) => r.kind + (r.kind === 'team-only' ? `:${r.member}` : ''))).toEqual([
      'heading', 'seat', 'seat', 'heading', 'team-only:slate', 'new-seat',
    ]);
  });

  it('without your own seat here, shows how to make one instead', () => {
    const s = membersOf([seat('ada')], ['ada', 'slate']);
    expect(rows(s).at(-1)).toEqual({ kind: 'hint', text: 'set up your own seat here first: musterd human <you>' });
  });

  it('⏎ on a team member → confirm → ⇥ harness → ⏎ creates', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], ['ada', 'slate']);
    const at = press(s, k('down'), k('down')).state;
    const confirm = press(at, k('return')).state;
    expect(confirm.create).toMatchObject({ member: 'slate', naming: false, harness: 0 });
    const out = press(confirm, k('tab'), k('return')).outcome;
    expect(out).toEqual({ kind: 'create', team: 'acme', project: 'proj', member: 'slate', harnesses: ['cursor'] });
  });

  it('+ new seat asks for a name, validates it, then creates', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], []);
    const naming = press(s, k('down'), k('down'), k('return')).state;
    expect(naming.create).toMatchObject({ naming: true, member: '' });
    const bad = press(naming, k('9'), k('return')).state;
    expect(bad.create?.error).toMatch(/lowercase/);
    const named = press(bad, k('backspace'), k('z'), k('e'), k('d'), k('return')).state;
    expect(named.create).toMatchObject({ naming: false, member: 'zed', error: null });
    expect(press(named, k('return')).outcome).toEqual({ kind: 'create', team: 'acme', project: 'proj', member: 'zed', harnesses: ['claude-code'] });
  });

  it('esc cancels a draft', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], []);
    const naming = press(s, k('down'), k('down'), k('return')).state;
    expect(press(naming, k('escape')).state.create).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher/picker/state.create.test.ts`
Expected: FAIL — the `team-only` rows and `create` state do not exist.

- [ ] **Step 3: Extend `state.ts`**

Add the import and types:

```ts
import { LAUNCHABLE_HARNESSES } from '../labels.js';

export interface CreateDraft {
  team: string;
  project: string;
  member: string;
  /** Typing a name (`+ new seat`) vs. confirming a harness. */
  naming: boolean;
  /** Index into LAUNCHABLE_HARNESSES. */
  harness: number;
  error: string | null;
}
```

Extend `Row`:

```ts
  | { kind: 'team-only'; team: string; project: string; member: string }
  | { kind: 'new-seat'; team: string; project: string }
  | { kind: 'hint'; text: string };
```

Add `agents: Record<string, string[]>` and `create: CreateDraft | null` to `PickerState`, initialised as `agents: {}` and `create: null`.

Extend the `live` event: `{ type: 'live'; live: Record<string, Live>; status: 'ok' | 'offline'; now: number; agents?: Record<string, string[]> }`. In `reduce`, use `agents: e.agents ?? s.agents`.

Extend `PickerOutcome`: `| { kind: 'create'; team: string; project: string; member: string; harnesses: string[] }`.

Replace the `members` case in `rows()`:

```ts
    case 'members': {
      const { team, project } = s.level;
      const here = s.seats.filter((x) => x.team === team && x.project === project).sort(byMember);
      const mine = here.some((x) => x.kind === 'human' && x.problem === null);
      const teamOnly = (s.agents[team] ?? []).filter((name) => !here.some((x) => x.member === name));
      const out: Row[] = [{ kind: 'heading', label: 'on this machine' }, ...here.map((x) => seatRow(x, false))];
      if (!mine) return [...out, { kind: 'hint', text: 'set up your own seat here first: musterd human <you>' }];
      return [
        ...out,
        { kind: 'heading', label: 'on the team · not here' },
        ...teamOnly.map((member): Row => ({ kind: 'team-only', team, project, member })),
        { kind: 'new-seat', team, project },
      ];
    }
```

`selectable` excludes `heading` and `hint`:

```ts
export function selectable(row: Row): boolean {
  return row.kind !== 'heading' && row.kind !== 'hint' && !(row.kind === 'team' && !row.here);
}
```

In `activate`, before the team and project branches:

```ts
  if (mode === 'fresh' && row?.kind === 'team-only') {
    return { state: { ...s, create: { team: row.team, project: row.project, member: row.member, naming: false, harness: 0, error: null } }, outcome: null };
  }
  if (mode === 'fresh' && row?.kind === 'new-seat') {
    return { state: { ...s, create: { team: row.team, project: row.project, member: '', naming: true, harness: 0, error: null } }, outcome: null };
  }
```

In `onKey`, after the `⌃C` check:

```ts
  if (s.create) return onCreateKey(s, s.create, key);
```

and add:

```ts
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

function onCreateKey(s: PickerState, d: CreateDraft, key: Key): Step {
  const set = (create: CreateDraft | null): Step => ({ state: { ...s, create }, outcome: null });
  if (key.name === 'escape') return set(null);
  if (d.naming) {
    if (key.name === 'return') {
      if (!NAME.test(d.member)) return set({ ...d, error: 'a seat name is lowercase letters, digits and dashes, starting with a letter' });
      if (s.seats.some((x) => x.team === d.team && x.member === d.member)) return set({ ...d, error: `${d.member} already has a Workspace here` });
      return set({ ...d, naming: false, error: null });
    }
    if (key.name === 'backspace') return set({ ...d, member: d.member.slice(0, -1), error: null });
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch >= ' ' && !key.ctrl && !key.meta) return set({ ...d, member: d.member + ch.toLowerCase(), error: null });
    return set(d);
  }
  if (key.name === 'tab') return set({ ...d, harness: (d.harness + 1) % LAUNCHABLE_HARNESSES.length });
  if (key.name === 'return') {
    return {
      state: { ...s, create: null },
      outcome: { kind: 'create', team: d.team, project: d.project, member: d.member, harnesses: [LAUNCHABLE_HARNESSES[d.harness]!] },
    };
  }
  return set(d);
}
```

`identity()` (used to keep the cursor across a catalog refresh) gains `team-only` → `o:${row.member}` and `new-seat` → `new`.

- [ ] **Step 4: Render the new rows and the draft**

In `view.ts`'s `body()` switch, add:

```ts
      case 'hint':
        return { line: `  ${theme.meta(row.text)}`, selected };
      case 'team-only':
        return { line: `${marker}${padEndVisible(row.member, nameWidth)}${theme.meta('⏎ set up here')}`, selected };
      case 'new-seat':
        return { line: `${marker}${theme.accent('+ new seat')}`, selected };
```

In `footer()`, first:

```ts
  if (s.create) {
    const d = s.create;
    if (d.naming) {
      const prompt = `  new seat in ${d.team}/${d.project} › ${d.member}▏   ⏎ next · esc cancel`;
      return d.error ? `${prompt}\n  ${theme.warn(d.error)}` : prompt;
    }
    return `  set up ${d.member} here → ~/musterd/${d.team}/${d.project}/${d.member} · ${harnessLabel(LAUNCHABLE_HARNESSES[d.harness]!)} (⇥ to change) · ⏎ set up and launch · esc cancel`;
  }
```

Import `harnessLabel` and `LAUNCHABLE_HARNESSES` from `../labels.js`. Because `footer` can now return two lines, change `renderPicker` to push `...footer(s).split('\n')`, and count those lines in `room`.

Add a view test case:

```ts
  it('the set-up prompt names the path and the harness', () => {
    let s = initialState({ ...FILE, snapshot: { taken_at: NOW, seats: [...SEATS, seat('nick', { kind: 'human' })], teams: [{ team: 'revive', here: true }] } }, '', NOW);
    s = reduce(s, { type: 'live', live: {}, status: 'ok', now: NOW, agents: { revive: ['slate'] } }).state;
    s = { ...s, level: { kind: 'members', team: 'revive', project: 'agents' }, create: { team: 'revive', project: 'agents', member: 'slate', naming: false, harness: 2, error: null } };
    expect(renderPicker(s, { cols: 120, rows: 24 }).at(-1)).toBe(
      '  set up slate here → ~/musterd/revive/agents/slate · codex (⇥ to change) · ⏎ set up and launch · esc cancel',
    );
  });
```

- [ ] **Step 5: Handle the outcome and feed `agents` in `index.ts`**

In `refresh()`, build the team agents next to `live`:

```ts
    const { fetchRosters, liveFor, rosterKey, teamAgents } = await import('./live.js');
    // …existing loop…
    const agents: Record<string, string[]> = {};
    for (const seat of catalog.seats) {
      const members = rosters.get(rosterKey(seat));
      if (members && !agents[seat.team]) agents[seat.team] = teamAgents(members);
    }
    dispatch({ type: 'live', live, status: answered ? 'ok' : 'offline', now: Date.now(), agents });
```

In `openPicker`, after the `quit` check:

```ts
  if (outcome.kind === 'create') {
    process.stderr.write(`setting up ${outcome.member} in ${outcome.team}/${outcome.project}…\n`);
    const [{ createSeat }, { buildCatalog }, { loadConfig }, os] = await Promise.all([
      import('./create.js'),
      import('./catalog.js'),
      import('../config.js'),
      import('node:os'),
    ]);
    const home = opts.home ?? os.homedir();
    const seats = buildCatalog({ home, config: loadConfig() }).seats;
    const seat = await createSeat({ team: outcome.team, project: outcome.project, member: outcome.member, harnesses: outcome.harnesses, seats, home });
    const { launchSeat } = await import('./byName.js');
    return launchSeat(seat, { mode: 'fresh', harness: outcome.harnesses[0] ?? null, force: true });
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/launcher src/importClosure.test.ts`
Expected: PASS. The paint closure stays `['picocolors', 'zod']`, because `create.ts` is imported dynamically.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/launcher
git commit -m "feat(cli): picker create flows — set up a team member here, + new seat (ADR 491)" \
  -m "Lane: 01M3WA85HQRSA7V08FEQQ489HM" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 25: Docs, frames, PR, and the dogfood week

**Files:**
- Modify: `docs/architecture/04-cli.md` (tree: `onboard/agentSeat.ts`, `launcher/create.ts`; the `musterd agent` description if the doc has one), `docs/design/figma-brief-terminal.md` (frame 23)

- [ ] **Step 1: Tree lines**

Under `onboard/`:

```
    agentSeat.ts      // provisionAgentSeat: add-or-reuse an agent member + a provisioned, reconcile-wired Workspace — the core `musterd agent` and the launcher share (ADR 065/491)
```

Inside `launcher/`:

```
    create.ts         // "set up here" / "+ new seat": acts from your own human Workspace in that team and project (ADR 036/442), starts the branch at the remote's default tip
```

Update the `provisionSeat.ts` and `workspace.ts` lines: `provisionSeat.ts` now says it "writes provisioned.json, wires through the reconcile engine, revokes the credential if the Workspace cannot be made"; `workspace.ts` gains "`base` + `resolveBaseRef`".

- [ ] **Step 2: Frame**

````md
23. `cmd/launcher-create` — in `musterd › revive › agents`, below the seats: `on the team · not here`,
    each agent member with `⏎ set up here` (dim), then `+ new seat` (accent). `⏎` on a member replaces
    the footer with
    `  set up slate here → ~/musterd/revive/agents/slate · claude (⇥ to change) · ⏎ set up and launch · esc cancel`;
    `+ new seat` first asks `  new seat in revive/agents › ▏   ⏎ next · esc cancel`. With no human
    Workspace of yours in the project, the section is one dim line:
    `set up your own seat here first: musterd human <you>`.
````

- [ ] **Step 3: Gates, commit, PR**

```bash
pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check
git add docs/architecture/04-cli.md docs/design/figma-brief-terminal.md
git commit -m "docs: launcher create frames + tree (ADR 491)" \
  -m "Lane: 01M3WA85HQRSA7V08FEQQ489HM" \
  -m "Co-authored-by: stanley <stanley@revive.musterd>
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/front-door-4-create
gh pr create --title "Front door 4/4: create seats from the picker; musterd agent wires through reconcile (ADR 491)" --body "<lane, the shared-entry fix, test list; end with the Claude Code attribution footer>"
gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 4: Close the goal's last lane, then dogfood**

After the merge: `lane_submit` for lane `01M3WA85HQRSA7V08FEQQ489HM`. Then run ADR 491's adoption experiment: seven days of `musterd` as nick's only way into a seat. Record every typed path or `cd` as a finding against goal `front-door`. When it ends, write the outcome with `team_goal_outcome`.

---

## Self-review (done while writing)

- **Spec coverage.**
  - §3.1 bare `musterd` → Task 18.
  - §3.2 levels, search, here and last-used marks → Tasks 15 and 16.
  - §3.3 keys → Task 15.
  - §3.4 launch kinds:
    - agent → Tasks 11–12
    - human → Task 11
    - live → Tasks 12 and 15
    - set up here and `+ new seat` → Tasks 23–24
    - not installed → Task 11
  - §3.5 receipt → Task 11.
  - §3.6 the non-interactive table → Tasks 12–13.
  - §4.2 sources → Tasks 7 and 10.
  - §4.3 three names (remote shown dim) → Tasks 7 and 16.
  - §4.4 entries → Task 9.
  - §4.5 the file → Task 6.
  - §4.6 the supervisor → Task 11.
  - §4.7 creation, including who acts, the revoke and the base ref → Tasks 20–23.
  - §4.8 invariants → the tests in Tasks 7, 12 and 13.
  - §5.1 speed (closure, snapshot, no sync scans) → Tasks 3, 18 and 4/18 (bench).
  - §5.2 failures:
    - daemon down → Tasks 10 and 16
    - not installed → Task 11
    - broken seat → Tasks 7 and 12
    - stale → Tasks 7 and 11
    - ambiguous → Tasks 12 and 18
    - live with no TTY → Task 12
    - creation fails → Tasks 21 and 23
    - ⌃C and crash → Task 17
    - narrow and `NO_COLOR` → Task 16
  - §5.3 tests → every task; the dogfood → Task 25.
  - §6 groundwork: `musterd seats --json` is the one read model → Task 12.
- **Placeholders.**
  - The bench and ADR notes carry `<N>` markers for numbers that can only be measured; each step says to replace them with Step 3's output.
  - The PR bodies are described rather than written out, because they cite the merge-time test list.
- **Type consistency.** `Seat` (snake_case fields) is defined once by `SeatSchema` and imported as a type everywhere. `Live` lives in `live.ts`, and the paint path only ever imports it as a type. `LaunchPlan.harness` is `'shell'` for a human seat, and `formatReceipt` labels it through `harnessLabel`. `PickerOutcome` gains `create` only in Task 24, and `index.ts` handles it in the same task.
- **Review Focus coverage.** (1) Tasks 7 and 12. (2) Task 17's throwing reducer. (3) Task 11's signal seam and Task 13's real spawn. (4) Tasks 12 and 13. (5) Task 10's server that never answers.

## After this plan

The what's-next brainstorm (spec §8) starts from a working launcher:
- the metaharness proper (owning the harness's terminal);
- the macOS app (lane `01M03AEZ1BVFB7T3FQPVWHNWF9`), reading `musterd seats --json`;
- the project as a team fact;
- seat links;
- co-tenancy (lane `01M3TB3EY9502QJBHJ154XTM01`).
