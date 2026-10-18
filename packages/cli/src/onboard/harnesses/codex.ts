import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BINDING_DIR, WorktreeProvisioningSchema } from '@musterd/protocol';
import { resolveCodexBin } from '../../codexBin.js';
import { readModelFromTranscript } from '../../session/transcript-model.js';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';
import { launchEntryEnv, markerGenerationOfEnv, resolveMcpLaunch } from '../mcpEntry.js';
import { storeFiles } from '../permissions.js';
import { nodeFs, type FsSeam, type HarnessContext } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentIntent,
  type HarnessAdapter,
} from '../reconcile/fragments.js';
import { BUILTIN_TOOLKITS, parseToolkit } from '../toolkit.js';
import {
  CODEX_HOOK_MARKER,
  codexCommonDirRoot,
  codexHookCommands,
  codexHooksPath,
  hasNewerCodexHookEpoch,
  inspectCodexHookDrift,
  codexCommonHooksPath,
  installCodexHooks,
  removeCodexHooks,
} from './codexHooks.js';
import {
  hasServer,
  readPermissionProfile,
  readPlugin,
  readServer,
  readServerEnv,
  readTopLevel,
  hasTable,
  removePermissionProfile,
  removePlugins,
  removeServers,
  upsertPermissionProfile,
  upsertPlugin,
  upsertServer,
  type CodexDenyProfile,
  type CodexPlugin,
  type CodexServer,
} from './codexToml.js';

/**
 * Codex (OpenAI Codex CLI). Codex reads MCP servers from `[mcp_servers.<name>]` tables in a TOML
 * config that can be **global** (`~/.codex/config.toml`) or **project-local** (`.codex/config.toml`,
 * trusted projects). musterd writes the **project-local** file — the same non-invasive posture as
 * Cursor's `.cursor/mcp.json` (ADR 027): one folder, in-tree, gitignorable, cleanly removable, and
 * never touching the user's global Codex setup or polluting their other projects (ADR 031).
 *
 * It edits TOML directly via a minimal `[mcp_servers.*]`-scoped helper rather than the `codex mcp
 * add` CLI: that CLI's write target (global vs. project) isn't a documented, stable flag, and writing
 * the project-local file ourselves is the deterministic, correct-scope choice — and needs no TOML
 * dependency (hard rule #6). See ADR 031.
 */
function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.codex', 'config.toml');
}

/**
 * Codex's machine-global config. musterd never WRITES it (see above), but Codex merges it with the
 * project file, so a musterd server defined here is live in every folder on the machine — and
 * reading it back is the only way `init --check` can stop reporting "no musterd server" while one is
 * plainly there. Read-only by construction: nothing in this adapter passes this path to `writeToml`.
 */
function globalConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function readToml(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function writeToml(path: string, toml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toml.endsWith('\n') ? toml : toml + '\n', 'utf8');
}

function toCodexServer(entry: McpServerEntry): CodexServer {
  return { command: entry.command, args: entry.args, env: entry.env };
}

/** ADR 442: Codex has no PreToolUse hook. The wall here is identity. */
export const SESSION_REACH_WALL = 'Codex: session-reach: not gateable (identity-only) (ADR 442)';

export const codex: Harness = {
  id: 'codex',
  label: 'Codex',
  surface: 'codex',
  // `.codex/config.toml` is per-folder — and in-tree, so a secret here is committable (ADR 031).
  entryScope: 'folder',
  // No native `guidance` (ADR 085): Codex has no project-level skill/rule shell. The primer points
  // at `.musterd/skill/SKILL.md`; ADR 333 adds canonical `.musterd/skill/orient.md` the same way.

  // Codex rollout logs are JSONL carrying the same `message.model` shape, so the shared reader
  // handles both. A `musterd host`-spawned Codex seat is authoritative from its spawn arguments and
  // never needs this path; a hand-launched one gets whatever its rollout log reports, or `undefined`.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,

  async detect() {
    // ADR 643: installed means the binary resolves (the launcher's own resolver). A config dir
    // left behind by an uninstall is not an install.
    const bin = await resolveCodexBin();
    const installed = bin !== null;
    const projectToml = readToml(projectConfigPath());
    // The project file is what musterd writes, so it is what an entry here MEANS — the global file
    // is the fallback, and only when the folder has none of its own. Getting this order wrong would
    // attribute another seat's baked credential to this folder.
    const inProject = hasServer(projectToml, 'musterd');
    const globalToml = inProject ? '' : readToml(globalConfigPath());
    const inGlobal = !inProject && hasServer(globalToml, 'musterd');
    const configured = inProject || inGlobal;
    // Scoped to folders Codex is actually wired into. Hook drift is a claim about provisioning
    // musterd DID, and `installCodexHooks` runs only from `configure`, so an unconfigured folder has
    // no drift to have — it has an absence that is correct. Ungated, this reported a hard ✗ naming
    // `.codex/hooks.json` in every Claude-Code-only folder, contradicting the "no musterd server"
    // line printed directly above it, and with no safe repair to offer (ADR 168).
    const hookDrift = configured ? inspectCodexHookDrift(process.cwd()) : [];
    return {
      installed,
      configured,
      detail: inGlobal
        ? 'registered in ~/.codex/config.toml (machine-global — musterd writes the project file)'
        : bin
          ? `codex on PATH (${bin})`
          : 'codex install not found',
      // Read the entry's env back so the doctor can flag a baked legacy value here too. Before this,
      // only Claude Code's entry was ever inspected, so a per-seat secret or a stale MUSTERD_SURFACE
      // in `.codex/config.toml` was invisible by construction.
      ...(inProject ? registeredFromEnv(readServerEnv(projectToml, 'musterd')) : {}),
      // A global entry's values are just as live — they outrank binding.json in the adapter's ladder
      // exactly the same way — but no repair run in this folder rewrites that file, so it is reported
      // WITH its location rather than with a prescription (ADR 168).
      ...(inGlobal
        ? {
            ...registeredFromEnv(readServerEnv(globalToml, 'musterd')),
            registeredElsewhere: globalConfigPath(),
          }
        : {}),
      ...(hookDrift.length > 0 ? { hookDrift } : {}),
    };
  },

  /**
   * The ADR 168 safe repair for this harness's hooks — the sibling Codex never declared, which is
   * why `musterd init --refresh-hooks` skipped it and the doctor was left pointing at `musterd
   * wire` (which only registers the MCP server and never installs a hook). Without this the only
   * path that reached `installCodexHooks` was the full `musterd init`, barred from a live seat's
   * workspace by ADR 161 — a detected drift with no runnable repair.
   *
   * `applies` follows the contract's line between refresh and first install: the project config is
   * the file `configure` writes, so its presence is what "musterd provisioned Codex here" means.
   */
  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(codexHooksPath(dir)),
    run: (dir, opts) => {
      const files = installCodexHooks(dir, opts);
      const common = opts?.withinWorktreeOnly ? codexCommonHooksPath(dir) : undefined;
      const skipped = common !== undefined ? [common] : [];
      // A malformed file is left untouched by design (it may be hand-authored), and returns no
      // files — so without this the driver would print "✓ Codex hooks refreshed" over a repair that
      // never happened. Reuse the inspector's own wording rather than inventing a second phrasing.
      const warnings =
        files.length === 0 ? inspectCodexHookDrift(dir).filter((d) => d.includes('malformed')) : [];
      return { files, warnings, skipped };
    },
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    writeToml(path, upsertServer(readToml(path), 'musterd', toCodexServer(entry)));
    installCodexHooks(process.cwd());
    return {
      target: path,
      activation:
        'open this folder in Codex (it must be a trusted project) so Codex starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },

  // Provision a role's MCP servers into the project-local `.codex/config.toml`, additively
  // (ADR 027 — never clobber the user's other `[mcp_servers.*]` tables or their other settings).
  // `${ENV}` secrets are written as references, never resolved/baked here; whether Codex expands them
  // is Codex's concern — musterd writes the template's reference string, never a real secret.
  // Role servers get no tool approvals here, so permissions degrade to declared intent (none added);
  // only the musterd entry approves its own tools (ADR 495).
  async provision(plan: ProvisionPlan, _scope?: 'local' | 'shared', cwd?: string) {
    const path = projectConfigPath(cwd);
    let toml = readToml(path);
    const servers: string[] = [];
    for (const s of plan.servers) {
      toml = upsertServer(toml, s.name, { command: s.command, args: s.args, env: s.env });
      servers.push(s.name);
    }
    if (servers.length > 0) writeToml(path, toml);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'reload Codex (or reopen this folder) to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named `[mcp_servers.*]` tables.
  async unprovision(plan: UnprovisionPlan, _scope?: 'local' | 'shared', cwd?: string) {
    const path = projectConfigPath(cwd);
    const toml = readToml(path);
    if (toml.length === 0) return;
    const next = removeServers(toml, plan.servers);
    if (next !== toml) writeToml(path, next);
    if (!hasServer(next, 'musterd')) removeCodexHooks(cwd ?? process.cwd());
  },
};

// ── The fragment adapter (ADR 281/282/286, Task 5) ───────────────────────────────────────────────
// Codex as MANAGED FRAGMENTS: the `[mcp_servers.musterd]` table in `.codex/config.toml` (all other
// TOML sections pass through byte-for-byte — the minimal scoped writer, ADR 031) and the musterd
// hook handlers in `.codex/hooks.json`. Every intended table shape is validated through the strict
// adapter-owned representation BEFORE the write path opens (ADR 286 §3). Codex has no project
// skill/rule mechanism, so guidance stays the canonical musterd-core fragment.

const CODEX_SURFACE = 'codex';

interface CodexHooksJson {
  hooks?: Record<string, { hooks: { type?: string; command?: string }[] }[]>;
  [key: string]: unknown;
}

function readHooksJson(fs: FsSeam, path: string): CodexHooksJson | null | undefined {
  const raw = fs.readFile(path);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as CodexHooksJson;
  } catch {
    return null;
  }
}

function musterdCodexHandlers(file: CodexHooksJson): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (typeof handler.command === 'string' && handler.command.includes(CODEX_HOOK_MARKER)) {
          out.push({ event, command: handler.command });
        }
      }
    }
  }
  return out.sort((a, b) => (a.event < b.event ? -1 : 1));
}

function pluginFragmentKey(id: string): string {
  return `plugin.${id}`;
}

function pluginIdFromFragmentKey(fragmentKey: string): string | null {
  return fragmentKey.startsWith('plugin.') ? fragmentKey.slice('plugin.'.length) : null;
}

/** Toolkit-declared Codex plugins for this worktree (ADR 323). Missing/invalid state is none. */
function declaredCodexPlugins(ctx: HarnessContext): string[] {
  const raw = ctx.fs.readFile(join(ctx.worktreeRoot, BINDING_DIR, 'provisioned.json'));
  if (raw === null) return [];
  let name: string;
  try {
    const parsed = WorktreeProvisioningSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return [];
    name = parsed.data.toolkit;
  } catch {
    return [];
  }
  if (!name) return [];
  const file = ctx.fs.readFile(join(ctx.worktreeRoot, BINDING_DIR, 'toolkits', `${name}.json`));
  if (file !== null) {
    try {
      return parseToolkit(JSON.parse(file) as unknown).tools.codex_plugins;
    } catch {
      return [];
    }
  }
  return BUILTIN_TOOLKITS[name]?.tools.codex_plugins ?? [];
}

function pluginIntent(ctx: HarnessContext, id: string): FragmentIntent {
  const payload: CodexPlugin & { plugin: string } = { plugin: id, enabled: true };
  const fragmentKey = pluginFragmentKey(id);
  return {
    harness: 'codex',
    resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', fragmentKey),
    containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
    fragmentKey,
    scope: 'folder',
    fingerprint: canonicalFingerprint(payload),
    payload,
  };
}

/** The Codex permission profile musterd owns (ADR 658). */
const PROFILE = 'musterd';

/**
 * ADR 658: the store wall as a Codex permission profile — `:workspace` plus `deny` on each store
 * file, exact paths (a glob deny is captured per process start on Linux, so a `-wal` that appears
 * later would stay readable). Codex loads a project file only for a trusted project, where its
 * implicit default is already `:workspace` (codex-rs `default_builtin_permission_profile_name`),
 * so selecting this narrows and never widens. It is selected only when nobody else chose the
 * seat's sandbox: a top-level `sandbox_mode` overrides profiles anyway; a human's own
 * `default_permissions` is theirs (taking it over could widen a `:read-only` choice); and an
 * explicit `:workspace` drops `[sandbox_workspace_write]`, so a file that tunes that table keeps
 * it. Unselected, the profile is written but inert, and the matrix in 04-cli.md says so.
 */
function permissionProfile(ctx: HarnessContext): CodexDenyProfile {
  const deny = storeFiles(ctx.env).flatMap(({ path, sqlite }) =>
    sqlite ? [path, `${path}-wal`, `${path}-shm`] : [path],
  );
  const layers = [
    ctx.fs.readFile(join(ctx.worktreeRoot, '.codex', 'config.toml')) ?? '',
    ctx.fs.readFile(globalConfigPath()) ?? '',
  ];
  const selected = layers.every((toml) => {
    const chosen = readTopLevel(toml, 'default_permissions');
    return (
      readTopLevel(toml, 'sandbox_mode') === null &&
      !hasTable(toml, 'sandbox_workspace_write') &&
      (chosen === null || chosen === PROFILE)
    );
  });
  return { deny, selected };
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  surface: 'codex',
  adapterVersion: 2,
  interactive: {
    resolveBin: () => resolveCodexBin(),
    installHint: 'npm install -g @openai/codex',
    fresh: () => [],
    resume: (id) => (id ? ['resume', id] : ['resume', '--last']),
  },

  async availability(ctx) {
    // ADR 643: installed means the binary resolves (the launcher's own resolver). A config dir
    // left behind by an uninstall is not an install.
    const exec = ctx.exec;
    const bin = await resolveCodexBin(exec ? (c, a) => exec.run(c, a) : undefined);
    return bin
      ? { available: true, detail: `codex on PATH (${bin})` }
      : { available: false, detail: 'codex install not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
          scope: 'folder',
          handle: 'toml',
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} .codex/hooks.json`,
          scope: 'folder',
          handle: 'hooks',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    // ADR 495: `approve` — a headless `codex exec` wake refuses any tool call that would prompt, and
    // the musterd tools are the seat's own coordination surface, so the entry approves them itself.
    const mcpPayload: CodexServer = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(CODEX_SURFACE),
      default_tools_approval_mode: 'approve',
    };
    const hooks = [...codexHookCommands()].sort((a, b) => (a.event < b.event ? -1 : 1));
    const plugins = declaredCodexPlugins(ctx).map((id) => pluginIntent(ctx, id));
    const profile = permissionProfile(ctx);
    return [
      {
        harness: 'codex',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(mcpPayload),
        payload: mcpPayload,
      },
      {
        harness: 'codex',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', 'hooks'),
        containerKey: `folder ${ctx.worktreeRoot} .codex/hooks.json`,
        fragmentKey: 'hooks',
        scope: 'folder',
        fingerprint: canonicalFingerprint(hooks),
        payload: hooks,
      },
      {
        harness: 'codex',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', 'permissions'),
        containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
        fragmentKey: 'permissions',
        scope: 'folder',
        fingerprint: canonicalFingerprint(profile),
        payload: profile,
      },
      ...plugins,
    ];
  },

  async observe(ctx, intent) {
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.codex', 'config.toml'));
        if (toml === null) return { state: 'absent' };
        const entry = readServer(toml, 'musterd');
        if (!entry) return { state: 'absent' };
        const fingerprint = canonicalFingerprint(entry);
        // 'legacy' (the retired MUSTERD_SURFACE) and 'none' (the ADR 165 marker-less shape — the
        // COMMON pre-286 fleet registration) are both the pre-ADR-286 class: neither can attach,
        // and confirmed configure's marker-only repair converts both while preserving the entry.
        return markerGenerationOfEnv(entry.env) !== 'launch'
          ? { state: 'legacy-launch-marker', fingerprint }
          : { state: 'present', fingerprint };
      }
      case 'hooks': {
        const file = readHooksJson(ctx.fs, join(ctx.worktreeRoot, '.codex', 'hooks.json'));
        if (file === undefined) return { state: 'absent' };
        if (file === null) {
          return {
            state: 'invalid-container',
            issues: [{ path: '<.codex/hooks.json>', message: 'not valid JSON' }],
          };
        }
        // Fingerprint the canonical PHYSICAL form — payload-independent, so a release intent
        // rebuilt from ledger evidence observes the fingerprint the write recorded.
        const observed = musterdCodexHandlers(file);
        if (observed.length === 0) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(observed) };
      }
      case 'permissions': {
        const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.codex', 'config.toml'));
        const profile = toml === null ? null : readPermissionProfile(toml, PROFILE);
        if (!profile) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(profile) };
      }
      default: {
        const id = pluginIdFromFragmentKey(intent.fragmentKey);
        if (!id) return { state: 'absent' };
        const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.codex', 'config.toml'));
        if (toml === null) return { state: 'absent' };
        const plugin = readPlugin(toml, id);
        if (!plugin) return { state: 'absent' };
        const payload = { plugin: id, ...plugin };
        return { state: 'present', fingerprint: canonicalFingerprint(payload) };
      }
    }
  },

  async apply(ctx, mutation) {
    const { intent } = mutation;
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const path = join(ctx.worktreeRoot, '.codex', 'config.toml');
        const toml = ctx.fs.readFile(path) ?? '';
        let next: string;
        if (mutation.kind === 'remove') {
          next = removeServers(toml, ['musterd']);
        } else if (mutation.kind === 'repair-launch-marker') {
          const observed = readServer(toml, 'musterd');
          if (!observed) return;
          const { ['MUSTERD_SURFACE']: _retired, ...rest } = observed.env;
          next = upsertServer(toml, 'musterd', {
            ...observed,
            env: { ...rest, ...launchEntryEnv(CODEX_SURFACE) },
          });
        } else {
          // The strict representation gate: an invalid intended shape throws inside upsertServer,
          // before this write path opens — the prior TOML bytes stay untouched.
          next = upsertServer(toml, 'musterd', intent.payload as CodexServer);
        }
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 0o644);
        return;
      }
      case 'hooks': {
        const path = join(ctx.worktreeRoot, '.codex', 'hooks.json');
        const read = readHooksJson(ctx.fs, path);
        if (read === null) throw new Error('.codex/hooks.json invalid at apply time');
        const file = read ?? {};
        const commonPath =
          ctx.fs === nodeFs
            ? (() => {
                const commonRoot = codexCommonDirRoot(ctx.worktreeRoot);
                return commonRoot ? codexHooksPath(commonRoot) : undefined;
              })()
            : undefined;
        const common = commonPath ? readHooksJson(ctx.fs, commonPath) : undefined;
        if (
          mutation.kind !== 'remove' &&
          (hasNewerCodexHookEpoch(musterdCodexHandlers(file).map(({ command }) => command)) ||
            (common !== null &&
              common !== undefined &&
              hasNewerCodexHookEpoch(musterdCodexHandlers(common).map(({ command }) => command))))
        ) {
          return;
        }
        const hooks: NonNullable<CodexHooksJson['hooks']> = {};
        // Keep every non-musterd handler/group; drop every marker-owned one.
        for (const [event, groups] of Object.entries(file.hooks ?? {})) {
          const retained = groups
            .map((group) => ({
              ...group,
              hooks: group.hooks.filter(
                (h) => !(typeof h.command === 'string' && h.command.includes(CODEX_HOOK_MARKER)),
              ),
            }))
            .filter((group) => group.hooks.length > 0);
          if (retained.length > 0) hooks[event] = retained;
        }
        if (mutation.kind !== 'remove') {
          const payload =
            (intent.payload as { event: string; command: string }[] | undefined) ??
            codexHookCommands();
          for (const { event, command } of payload) {
            hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command }] }];
          }
        }
        const next: CodexHooksJson = { ...file };
        if (Object.keys(hooks).length > 0) next.hooks = hooks;
        else delete next.hooks;
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o644);
        // The fragment ledger owns the workspace copy. In a real worktree, Codex reads the shared
        // git-common-dir copy instead, so refresh that runtime copy through the same epoch guard.
        if (mutation.kind !== 'remove' && ctx.fs === nodeFs) installCodexHooks(ctx.worktreeRoot);
        return;
      }
      case 'permissions': {
        const path = join(ctx.worktreeRoot, '.codex', 'config.toml');
        const toml = ctx.fs.readFile(path) ?? '';
        const next =
          mutation.kind === 'remove'
            ? removePermissionProfile(toml, PROFILE)
            : upsertPermissionProfile(
                toml,
                PROFILE,
                (intent.payload as CodexDenyProfile | undefined) ?? permissionProfile(ctx),
              );
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 0o644);
        return;
      }
      default: {
        const id = pluginIdFromFragmentKey(intent.fragmentKey);
        if (!id) throw new Error(`unknown codex fragment ${intent.fragmentKey}`);
        const path = join(ctx.worktreeRoot, '.codex', 'config.toml');
        const toml = ctx.fs.readFile(path) ?? '';
        const next =
          mutation.kind === 'remove'
            ? removePlugins(toml, [id])
            : upsertPlugin(toml, id, { enabled: true });
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 0o644);
        return;
      }
    }
  },
};
