import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { resolveMuseBin } from '../../museBin.js';
import { registeredFromEnv, type Harness } from '../harness.js';
import {
  launchEntryEnv,
  markerGenerationOfEnv,
  resolveMcpLaunch,
  type McpServerEntry,
} from '../mcpEntry.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  machineResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';

/**
 * Meta's Muse Code CLI (ADR 619). Machine-global `~/.config/muse/settings.json` for the MCP
 * server entry (`mcp_servers.musterd`, stdio) and project-local `.muse/hooks.json` for the
 * lifecycle hooks (SessionStart orient nudge, Stop interrupt check). Shapes verified against the
 * installed binary (1.4.9, 2026-10-15) — the hooks nesting is Claude-style
 * `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "..."}]}]}}`, which the docs
 * never state and startup validation enforces (a wrong guess fails with a named warning, which
 * is how the shape was found).
 *
 * Muse reads `.agents/skills` natively, which is where musterd's canonical skill already lives —
 * so unlike Grok/Codex there is no per-harness skill bridge to write; guidance.skillPath names
 * the shared path. The env channel does NOT reach Muse's MCP stdio children (measured: only
 * `MUSE_SESSION_ID` arrives), so the ADR 354 lease file is the attestation (as for Codex).
 */

export const MUSE_SURFACE = 'muse';
export const MUSE_START_MARKER = 'musterd-muse-start';
export const MUSE_STOP_MARKER = 'musterd-muse-stop';
export const MUSE_SETTINGS_VERSION = 1;

/** `~/.config/muse/settings.json` — honour XDG like Muse itself does. */
export function museSettingsPath(home: string = homedir()): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  return join(base, 'muse', 'settings.json');
}

/** The settings path for a reconcile context — test-hermetic via ctx.env. */
export function museSettingsPathFor(env: NodeJS.ProcessEnv): string {
  const base = env['XDG_CONFIG_HOME'] ?? join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'muse', 'settings.json');
}

/** `<worktree>/.muse/hooks.json`. */
export function museHooksPath(dir: string = process.cwd()): string {
  return join(dir, '.muse', 'hooks.json');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

/** The `eN` generation tag written into a musterd hook's marker comment (ADR 168). */
function epochTag(epoch: number): string {
  return `e${String(epoch)}`;
}

export interface MuseMcpServer {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  mode: 'required' | 'optional';
}

export interface MuseSettings {
  schema_version?: number;
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Parse settings.json, or null when absent/unparseable — a malformed file is never clobbered. */
export function readMuseSettings(path: string = museSettingsPath()): MuseSettings | null {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as MuseSettings;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function museServerEntry(entry: McpServerEntry): MuseMcpServer {
  return {
    transport: 'stdio',
    command: entry.command,
    args: entry.args,
    env: { ...entry.env, ...launchEntryEnv(MUSE_SURFACE) },
    enabled: true,
    mode: 'required',
  };
}

/** The settings.json text with our server upserted — every other key untouched. */
export function upsertMuseServer(
  raw: string | null,
  entry: McpServerEntry,
): { text: string; created: boolean } {
  let settings: MuseSettings = {};
  const created = raw === null;
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as MuseSettings;
    } catch {
      // Malformed: refuse to clobber — the caller reports, the file stays as it was.
      throw new Error('muse settings.json does not parse — refusing to rewrite it');
    }
  }
  settings = { ...settings, schema_version: MUSE_SETTINGS_VERSION };
  settings.mcp_servers = { ...(settings.mcp_servers ?? {}), musterd: museServerEntry(entry) };
  return { text: `${JSON.stringify(settings, null, 2)}\n`, created };
}

export interface MuseHookGroup {
  hooks: Array<{ type: 'command'; command: string }>;
}

function musterdHookCommand(inner: string, marker: string): string {
  return `command -v musterd >/dev/null 2>&1 && musterd ${inner} 2>/dev/null || true # ${marker} ${epochTag(FEATURE_EPOCH)}`;
}

/** SessionStart: the orient nudge (session-orientation §B), guarded and never failing. */
export function museStartCommand(): string {
  return musterdHookCommand(
    'init --check-build 2>/dev/null; musterd session orient-nudge',
    MUSE_START_MARKER,
  );
}

/** Stop: the mid-loop interrupt line (ADR 088) — silent unless an interrupt-class act waits. */
export function museStopCommand(): string {
  return musterdHookCommand('inbox --interrupt-check --hook muse', MUSE_STOP_MARKER);
}

function hookGroup(command: string): MuseHookGroup {
  return { hooks: [{ type: 'command', command }] };
}

/**
 * The .muse/hooks.json text with our two groups upserted under their events — every other event
 * and every foreign group untouched. A malformed file is refused, never rewritten.
 */
export function upsertMuseHooks(raw: string | null): string {
  let doc: { hooks?: Record<string, MuseHookGroup[]>; [key: string]: unknown } = {};
  if (raw !== null) {
    try {
      doc = JSON.parse(raw) as typeof doc;
    } catch {
      throw new Error('.muse/hooks.json does not parse — refusing to rewrite it');
    }
  }
  const hooks = { ...(doc.hooks ?? {}) };
  for (const [event, command] of [
    ['SessionStart', museStartCommand()],
    ['Stop', museStopCommand()],
  ] as const) {
    const groups = [...(hooks[event] ?? [])];
    const idx = groups.findIndex((g) => g.hooks?.some((h) => h.command.includes('musterd-muse-')));
    const fresh = hookGroup(command);
    if (idx === -1) groups.push(fresh);
    else groups[idx] = fresh;
    hooks[event] = groups;
  }
  return `${JSON.stringify({ ...doc, hooks }, null, 2)}\n`;
}

/** True when the hooks.json text carries both musterd groups at the current epoch. */
export function hasMuseHooks(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const doc = JSON.parse(raw) as { hooks?: Record<string, MuseHookGroup[]> };
    const tag = epochTag(FEATURE_EPOCH);
    return ['SessionStart', 'Stop'].every((event) =>
      (doc.hooks?.[event] ?? []).some((g) =>
        g.hooks?.some((h) => h.command.includes('# musterd-muse-') && h.command.includes(tag)),
      ),
    );
  } catch {
    return false;
  }
}

function hooksFingerprint(): string {
  return canonicalFingerprint({ start: museStartCommand(), stop: museStopCommand() });
}

export const muse: Harness = {
  id: 'muse',
  label: 'Muse Code',
  surface: MUSE_SURFACE,
  // Machine-global, which is wider than 'repo-shared' — every folder on this machine reads one
  // entry. The enum has no machine value; repo-shared is the closer story (shared across
  // siblings, and in fact across everything here). The doctor's machine-global wording
  // (registeredElsewhere) does not apply: musterd writes this file itself.
  entryScope: 'repo-shared',
  guidance: {
    skillPath: '.agents/skills/musterd/SKILL.md',
    frontmatter: 'claude-code',
    orientSkillPath: '.agents/skills/musterd-orient/SKILL.md',
    importSkillPath: '.agents/skills/musterd-import/SKILL.md',
  },

  observeModel: (payload) => {
    // ADR 619: the hook payload shape is Muse's own — until a session-log lookup lands (lane 3),
    // the slot reads a declared model id when the payload carries one, else degrades honestly.
    const id = payload.model_id?.trim() || payload.model?.trim();
    return id || undefined;
  },

  async detect() {
    const home = homedir();
    const installed =
      existsSync(join(home, '.config', 'muse')) || (await resolveMuseBin()) !== null;
    const settings = readMuseSettings() ?? {};
    const servers = settings.mcp_servers;
    const inSettings = typeof servers === 'object' && servers !== null && 'musterd' in servers;
    const env =
      inSettings && typeof servers['musterd'] === 'object' && servers['musterd'] !== null
        ? ((servers['musterd'] as Record<string, unknown>)['env'] as
            | Record<string, string>
            | undefined)
        : undefined;
    return {
      installed,
      configured: inSettings,
      detail: installed ? '~/.config/muse present' : 'muse install not found',
      ...registeredFromEnv(env),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = museSettingsPath();
    const { text } = upsertMuseServer(readText(path), entry);
    writeText(path, text);
    const hooksPath = museHooksPath();
    writeText(hooksPath, upsertMuseHooks(readText(hooksPath)));
    return {
      target: path,
      activation:
        'restart the muse session — settings and hooks load at startup (a malformed file fails startup validation with a named warning)',
      scope: `MCP entry is machine-global (${path}); hooks are wired into this folder only (${hooksPath})`,
      secretPath: path,
    };
  },
};

export const museAdapter: HarnessAdapter = {
  id: 'muse',
  surface: MUSE_SURFACE,
  adapterVersion: 1,
  interactive: {
    resolveBin: () => resolveMuseBin(),
    installHint: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    fresh: () => [],
    resume: (id) => (id ? ['resume', id] : ['resume', '--last']),
  },

  async availability(ctx) {
    void ctx;
    const bin = await resolveMuseBin();
    return bin
      ? { available: true, detail: `muse on PATH (${bin})` }
      : { available: false, detail: 'muse install not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `machine muse-settings`,
          scope: 'machine',
          handle: museSettingsPath(),
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} .muse/hooks.json`,
          scope: 'folder',
          handle: museHooksPath(ctx.worktreeRoot),
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const mcp = museServerEntry({
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(MUSE_SURFACE),
    });
    return [
      {
        harness: 'muse',
        resourceKey: machineResourceKey('muse', 'mcp.musterd'),
        containerKey: `machine muse-settings`,
        fragmentKey: 'mcp.musterd',
        scope: 'machine',
        fingerprint: canonicalFingerprint(mcp),
        payload: mcp,
      },
      {
        harness: 'muse',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'muse', 'hooks.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .muse/hooks.json`,
        fragmentKey: 'hooks.musterd',
        scope: 'folder',
        fingerprint: hooksFingerprint(),
        payload: { start: museStartCommand(), stop: museStopCommand() },
      },
    ];
  },

  async observe(ctx, intent) {
    if (intent.fragmentKey === 'mcp.musterd') {
      const raw = ctx.fs.readFile(museSettingsPathFor(ctx.env));
      let parsed: MuseSettings | null = null;
      try {
        parsed = raw === null ? null : (JSON.parse(raw) as MuseSettings);
      } catch {
        return {
          state: 'invalid-container',
          issues: [{ path: museSettingsPathFor(ctx.env), message: 'settings.json does not parse' }],
        };
      }
      const entry = parsed?.mcp_servers?.['musterd'] as MuseMcpServer | undefined;
      if (!entry) return { state: 'absent' };
      // Same shape as desiredFragments — command + args + env + enabled + mode — so a write
      // observes as itself. Entries predating the launch marker read as legacy (as on Grok).
      const fingerprint = canonicalFingerprint(entry);
      return markerGenerationOfEnv(entry.env) !== 'launch'
        ? { state: 'legacy-launch-marker', fingerprint }
        : { state: 'present', fingerprint };
    }
    if (intent.fragmentKey === 'hooks.musterd') {
      if (!hasMuseHooks(ctx.fs.readFile(museHooksPath(ctx.worktreeRoot))))
        return { state: 'absent' };
      return { state: 'present', fingerprint: hooksFingerprint() };
    }
    return { state: 'absent' };
  },

  async apply(ctx, mutation) {
    if (mutation.intent.fragmentKey === 'mcp.musterd') {
      const path = museSettingsPathFor(ctx.env);
      if (mutation.kind === 'remove') {
        const raw = ctx.fs.readFile(path);
        if (raw === null) return;
        try {
          const settings = JSON.parse(raw) as MuseSettings;
          if (settings.mcp_servers && 'musterd' in settings.mcp_servers) {
            delete settings.mcp_servers['musterd'];
            ctx.fs.mkdirp(dirname(path));
            ctx.fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
          }
        } catch {
          // Malformed: leave it — never rewrite what we cannot parse.
        }
        return;
      }
      const payload = mutation.intent.payload as McpServerEntry;
      const { text } = upsertMuseServer(ctx.fs.readFile(path), payload);
      ctx.fs.mkdirp(dirname(path));
      // 0o600: the entry env can carry the seat's agent key (as on every harness).
      ctx.fs.writeFile(path, text, 0o600);
      return;
    }
    if (mutation.intent.fragmentKey === 'hooks.musterd') {
      const path = museHooksPath(ctx.worktreeRoot);
      if (mutation.kind === 'remove') {
        const raw = ctx.fs.readFile(path);
        if (raw === null) return;
        try {
          const doc = JSON.parse(raw) as { hooks?: Record<string, MuseHookGroup[]> };
          for (const event of ['SessionStart', 'Stop']) {
            const groups = (doc.hooks?.[event] ?? []).filter(
              (g) => !g.hooks?.some((h) => h.command.includes('musterd-muse-')),
            );
            if (doc.hooks) doc.hooks[event] = groups;
          }
          ctx.fs.mkdirp(dirname(path));
          ctx.fs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
        } catch {
          // Malformed: leave it — never rewrite what we cannot parse.
        }
        return;
      }
      ctx.fs.mkdirp(dirname(path));
      ctx.fs.writeFile(path, upsertMuseHooks(ctx.fs.readFile(path)), 0o644);
      return;
    }
    throw new Error(`unknown muse fragment ${mutation.intent.fragmentKey}`);
  },
};
