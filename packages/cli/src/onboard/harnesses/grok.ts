import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { resolveGrokBin } from '../../grokBin.js';
import { isDeclined } from '../declined.js';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import {
  launchEntryEnv,
  markerGenerationOfEnv,
  resolveMcpLaunch,
  type McpServerEntry,
} from '../mcpEntry.js';
import { STANDARD_FLOOR } from '../permissions.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';
import {
  applyRoleSkill,
  GROK_BRIDGE,
  isRoleSkillFragment,
  observeRoleSkill,
  roleSkillFragments,
} from '../roleSkills.js';
import {
  hasServer,
  readServer,
  readServerEnv,
  removeServers,
  upsertServer,
  type CodexServer,
} from './codexToml.js';

/**
 * Grok CLI (ADR 352). Project-local `.grok/config.toml` for MCP + statusline + permission floor;
 * `.grok/hooks/musterd.json` for notification, the gate, capture, and session end.
 * The interrupt (PreToolUse additionalContext + Stop) lives in `~/.grok/hooks/musterd-interrupt.json`
 * so it is already on disk when Grok snapshots hooks — the project file is often created during
 * that session's own SessionStart (ADR 718). Never writes `~/.grok/config.toml`.
 * Cursor MCP compat stays on (other servers). Cursor and Claude *hook* compat are turned off
 * so inherited hooks do not double-fire or attest the wrong harness (ADR 352, ADR 597).
 */

export const GROK_SURFACE = 'grok';
export const NOTIFY_MARKER = 'musterd-grok-notify';
export const INTERRUPT_MARKER = 'musterd-grok-interrupt';
export const STOP_MARKER = 'musterd-grok-stop';
export const GATE_MARKER = 'musterd-grok-gate';
export const CAPTURE_MARKER = 'musterd-grok-capture';
export const END_MARKER = 'musterd-grok-end';
export const STATUSLINE_MARKER = 'musterd-grok-statusline';
export const GLOBAL_START_MARKER = 'musterd-grok-global-start';

const GROK_PREFIX = 'grok';
export const SURFACE_STATUSLINE = `${GROK_PREFIX}:statusLine`;

function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.grok', 'config.toml');
}
function projectHooksPath(dir: string = process.cwd()): string {
  return join(dir, '.grok', 'hooks', 'musterd.json');
}
function globalConfigPath(): string {
  return join(homedir(), '.grok', 'config.toml');
}

/**
 * Grok loads user hooks from `~/.grok/hooks`. Tests set `MUSTERD_GROK_HOOKS_HOME` so a run does
 * not rewrite the machine's real hook files. The override is ignored outside Vitest.
 */
function grokUserHooksDir(): string {
  const fromTest = process.env['MUSTERD_GROK_HOOKS_HOME'];
  if (fromTest && process.env['VITEST'] === 'true') return fromTest;
  return join(homedir(), '.grok', 'hooks');
}

function globalStartHookPath(): string {
  return join(grokUserHooksDir(), 'musterd-sessionstart.json');
}

function globalInterruptHookPath(): string {
  return join(grokUserHooksDir(), 'musterd-interrupt.json');
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

/**
 * The generation stamped on an installed hook command, or `0` for an unstamped one. Unstamped is
 * legal and means "written before this inspector compared text" — the oldest possible generation.
 */
function hookEpochOf(command: string): number {
  const m = /#\s*musterd-[a-z-]+\s+e(\d+)\b/.exec(command);
  return m?.[1] ? Number(m[1]) : 0;
}

function cmd(inner: string, marker: string, discardStdout: boolean): string {
  const redir = discardStdout ? ' >/dev/null 2>&1' : ' 2>/dev/null';
  return `command -v musterd >/dev/null 2>&1 && musterd ${inner}${redir} || true # ${marker} ${epochTag(FEATURE_EPOCH)}`;
}

/**
 * Grok 1.0.13: PostToolUse stdout and additionalContext JSON are ignored. PreToolUse
 * additionalContext reaches the model after the tool, wrapped in a system-reminder (ADR 370).
 * Empty interrupt-check (the common path) prints nothing, so no context is added. `--hook grok`
 * names the harness, so the probe reads the PreToolUse payload Grok pipes it and taps it (ADR 445 R1)
 * — the one Grok hook with no matcher, so the one that sees every tool call.
 */
export const GROK_INTERRUPT_PRE_WRAP =
  'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const t=s.trim();if(t)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:t}}))})';

export function grokInterruptPreCommand(): string {
  return (
    'command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ' +
    `musterd inbox --interrupt-check --hook grok 2>/dev/null | node -e '${GROK_INTERRUPT_PRE_WRAP}' || true # ${INTERRUPT_MARKER} ${epochTag(FEATURE_EPOCH)}`
  );
}

/**
 * Idle-at-turn-end doorbell (ADR 370). Blocks a genuine end_turn once with the daemon-composed
 * interrupt line; `stopHookActive` and non-end_turn reasons (session shutdown) exit 0. The script
 * reads the Stop payload itself, so it hands the probe that payload on stdin with `--hook grok`, or
 * the probe has nothing to tap (ADR 445 R1).
 *
 * `spawnSync`, not `execFileSync`, and the verdict is read off `status`/`stdout` rather than the
 * throw: a probe that exits before draining stdin (an early gate, an unreachable daemon) leaves the
 * parent's write of `input` with EPIPE, which `execFileSync` raises as an error even though the
 * child exited 0 with the interrupt line on stdout — so a genuine end_turn silently went unblocked
 * (~3% of runs with a non-reading probe; the `grok.hooks` CI flake). The line is the child's
 * verdict; the pipe's fate is not.
 */
export const GROK_INTERRUPT_STOP_SCRIPT = [
  'const fs=require("fs");',
  'const {spawnSync}=require("child_process");',
  'let raw="";',
  'try{raw=fs.readFileSync(0,"utf8")}catch{}',
  'let ev={};',
  'try{ev=JSON.parse(raw)}catch{}',
  'if(ev.reason!=="end_turn"||ev.stopHookActive)process.exit(0);',
  'let line="";',
  'try{const r=spawnSync("musterd",["inbox","--interrupt-check","--hook","grok"],{encoding:"utf8",input:raw,stdio:["pipe","pipe","ignore"]});if(r.status===0&&r.stdout)line=r.stdout.trim()}catch{}',
  'if(line)console.log(JSON.stringify({decision:"block",reason:line}))',
].join('');

export function grokInterruptStopCommand(): string {
  return (
    'command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ' +
    `node -e '${GROK_INTERRUPT_STOP_SCRIPT}' || true # ${STOP_MARKER} ${epochTag(FEATURE_EPOCH)}`
  );
}

/** Same self-gate as the global SessionStart: silent outside a musterd folder. */
function musterdFolderGate(): string {
  return 'grep -q musterd:start AGENTS.md 2>/dev/null || grep -q musterd:start Agents.md 2>/dev/null || exit 0; ';
}

/**
 * A decline is per workspace (ADR 332). The interrupt file is one copy for the machine, so the
 * command exits 0 where this workspace's tombstone names the surface. Other workspaces keep it.
 */
function declinedSurfaceGate(surface: string): string {
  return `grep -q '${surface}' .musterd/declined.json 2>/dev/null && exit 0; `;
}

interface GrokHookFile {
  hooks?: Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]
  >;
}

function readHooks(path: string): GrokHookFile | null {
  const raw = readText(path);
  if (raw === null) return { hooks: {} };
  try {
    return JSON.parse(raw) as GrokHookFile;
  } catch {
    return null;
  }
}

function upsertJsonHook(
  path: string,
  event: string,
  marker: string,
  command: string,
  matcher?: string,
  timeout?: number,
): string | undefined {
  const file = readHooks(path);
  if (!file) return `could not parse ${path} — left untouched`;
  file.hooks ??= {};
  const list = file.hooks[event] ?? [];
  const present = list.filter((g) => g.hooks.some((h) => h.command.includes(marker)));
  const installedEpoch = Math.max(
    0,
    ...present.flatMap((g) => g.hooks.map((h) => hookEpochOf(h.command))),
  );
  const ours = hookEpochOf(command);
  if (installedEpoch > ours) {
    return (
      `refused to rewrite the Grok ${event} hook \`${marker}\` in ${path}: it was written by a NEWER musterd ` +
      `(epoch ${String(installedEpoch)}), and this build is epoch ${String(ours)} — installing it here ` +
      'would downgrade the hook (ADR 168). The hook was left untouched. Update ' +
      'this checkout (`git pull` + `pnpm build`) and re-run.'
    );
  }
  const kept = list.filter((g) => !g.hooks.some((h) => h.command.includes(marker)));
  kept.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, ...(timeout !== undefined ? { timeout } : {}) }],
  });
  file.hooks[event] = kept;
  writeText(path, `${JSON.stringify(file, null, 2)}\n`);
  return undefined;
}

function dropJsonHook(path: string, event: string, marker: string): void {
  const file = readHooks(path);
  if (!file?.hooks?.[event]) return;
  const kept = file.hooks[event]!.filter((g) => !g.hooks.some((h) => h.command.includes(marker)));
  if (kept.length === file.hooks[event]!.length) return;
  if (kept.length > 0) file.hooks[event] = kept;
  else delete file.hooks[event];
  if (file.hooks && Object.keys(file.hooks).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      writeText(path, '{}\n');
    }
    return;
  }
  writeText(path, `${JSON.stringify(file, null, 2)}\n`);
}

const GLOBAL_INTERRUPT_HOOKS: readonly {
  event: string;
  marker: string;
  command: string;
  timeout: number;
  missing: string;
}[] = [
  {
    event: 'PreToolUse',
    marker: INTERRUPT_MARKER,
    command:
      musterdFolderGate() + declinedSurfaceGate('grok:PreToolUse') + grokInterruptPreCommand(),
    timeout: 10,
    missing:
      'the Grok PreToolUse interrupt hook is missing from ~/.grok/hooks/musterd-interrupt.json — a busy agent will not see urgent steering mid-loop, including the session that first writes the project hook file (ADR 370, ADR 718). Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'Stop',
    marker: STOP_MARKER,
    command: musterdFolderGate() + declinedSurfaceGate('grok:Stop') + grokInterruptStopCommand(),
    timeout: 10,
    missing:
      'the Grok Stop interrupt hook is missing from ~/.grok/hooks/musterd-interrupt.json — an idle-at-turn-end agent will not see urgent steering (ADR 370, ADR 718). Run `musterd init --refresh-hooks`.',
  },
];

const LOCAL_HOOKS: readonly {
  event: string;
  marker: string;
  command: string;
  matcher?: string;
  missing?: string;
  timeout?: number;
}[] = [
  {
    event: 'Notification',
    marker: NOTIFY_MARKER,
    command: cmd('inbox --waiting', NOTIFY_MARKER, true),
  },
  {
    event: 'PreToolUse',
    marker: GATE_MARKER,
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|run_terminal_command|search_replace',
    command: cmd('gate check --stdin', GATE_MARKER, true),
    timeout: 10,
    missing:
      'the Grok PreToolUse enforcement-gate hook is missing from .grok/hooks/musterd.json — declared ADR 150 classes fail open here. Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'SessionStart',
    marker: CAPTURE_MARKER,
    // stdout kept: if Grok injects SessionStart stdout, orientation rides (Claude parity).
    command: cmd('session start --stdin', CAPTURE_MARKER, false),
    missing:
      'the Grok SessionStart capture hook is missing from .grok/hooks/musterd.json — wakes will run fresh-only (ADR 131 §5). Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'SessionEnd',
    marker: END_MARKER,
    command: cmd('session end --stdin', END_MARKER, true),
    missing:
      'the Grok SessionEnd hook is missing from .grok/hooks/musterd.json — captured sessions will never be marked ended. Run `musterd init --refresh-hooks`.',
  },
];

function installGlobalInterrupt(): string[] {
  const path = globalInterruptHookPath();
  const warnings: string[] = [];
  for (const spec of GLOBAL_INTERRUPT_HOOKS) {
    const w = upsertJsonHook(path, spec.event, spec.marker, spec.command, undefined, spec.timeout);
    if (w) warnings.push(w);
  }
  return warnings;
}

export function installMusterdGrokHooks(dir: string = process.cwd()): string[] {
  const path = projectHooksPath(dir);
  const warnings: string[] = [...installGlobalInterrupt()];
  // ADR 370: interrupt moved off PostToolUse. ADR 718: it also leaves the project file,
  // or the next session loads both copies and the line arrives twice.
  dropJsonHook(path, 'PostToolUse', INTERRUPT_MARKER);
  dropJsonHook(path, 'PreToolUse', INTERRUPT_MARKER);
  dropJsonHook(path, 'Stop', STOP_MARKER);
  for (const spec of LOCAL_HOOKS) {
    if (isDeclined(dir, `${GROK_PREFIX}:${spec.event}`)) continue;
    const w = upsertJsonHook(
      path,
      spec.event,
      spec.marker,
      spec.command,
      spec.matcher,
      spec.timeout,
    );
    if (w) warnings.push(w);
  }
  const global = installGlobalSessionStart();
  if (global) warnings.push(global);
  return warnings;
}

function installGlobalSessionStart(): string | undefined {
  // Self-gating like Claude's ~/.claude/settings.json SessionStart: silent outside musterd folders.
  const command =
    'grep -q musterd:start AGENTS.md 2>/dev/null || grep -q musterd:start Agents.md 2>/dev/null || exit 0; ' +
    cmd('session start --stdin', GLOBAL_START_MARKER, false);
  return upsertJsonHook(globalStartHookPath(), 'SessionStart', GLOBAL_START_MARKER, command);
}

export function removeMusterdGrokHooks(dir: string = process.cwd()): void {
  const path = projectHooksPath(dir);
  if (!existsSync(path)) return;
  dropJsonHook(path, 'PostToolUse', INTERRUPT_MARKER);
  dropJsonHook(path, 'PreToolUse', INTERRUPT_MARKER);
  dropJsonHook(path, 'Stop', STOP_MARKER);
  for (const spec of LOCAL_HOOKS) dropJsonHook(path, spec.event, spec.marker);
}

function commandDrift(
  cwd: string,
  file: GrokHookFile,
  specs: readonly { event: string; marker: string; command: string; missing?: string }[],
  fileLabel: string,
  missingRespectsDecline: boolean,
): string[] {
  const drift: string[] = [];
  for (const spec of specs) {
    const groups = file.hooks?.[spec.event] ?? [];
    const installed = groups
      .flatMap((g) => g.hooks.map((h) => h.command))
      .find((c) => c.includes(spec.marker));
    if (installed === undefined) {
      // ADR 332: only the MISSING branch consults the tombstone, and only for a project file.
      // A machine-wide hook missing is still drift when this workspace declined it: other
      // workspaces read the same file. A STALE hook is never silenced by a tombstone.
      if (
        spec.missing &&
        (!missingRespectsDecline || !isDeclined(cwd, `${GROK_PREFIX}:${spec.event}`))
      ) {
        drift.push(spec.missing);
      }
      continue;
    }
    if (installed !== spec.command) {
      const theirs = hookEpochOf(installed);
      if (theirs > FEATURE_EPOCH) {
        drift.push(
          `the Grok ${spec.event} hook \`${spec.marker}\` in ${fileLabel} was written ` +
            `by a NEWER musterd (epoch ${String(theirs)}) than this checkout (epoch ${String(FEATURE_EPOCH)}). ` +
            'The hook is fine — this checkout is behind. Update it (`git pull` + `pnpm build`); do NOT run ' +
            '`musterd init` here, which would downgrade the hook (ADR 168).',
        );
      } else {
        drift.push(
          `the Grok ${spec.event} hook \`${spec.marker}\` in ${fileLabel} was ` +
            'written by a different musterd build and no longer matches this one — it is present but ' +
            'STALE, which no presence check can see (ADR 168). Run `musterd init --refresh-hooks` ' +
            'here to rewrite it.',
        );
      }
    }
  }
  return drift;
}

export function inspectGrokHookDrift(cwd: string): string[] {
  const file = readHooks(projectHooksPath(cwd));
  const drift: string[] = [];
  if (file) {
    drift.push(...commandDrift(cwd, file, LOCAL_HOOKS, '.grok/hooks/musterd.json', true));
    const leftover = (event: string, marker: string, sentence: string) => {
      const present = (file.hooks?.[event] ?? []).some((g) =>
        g.hooks.some((h) => h.command.includes(marker)),
      );
      if (present) drift.push(sentence);
    };
    leftover(
      'PostToolUse',
      INTERRUPT_MARKER,
      'a leftover Grok PostToolUse interrupt hook is still installed — current Grok delivers that seam, so it doubles the PreToolUse line (ADR 370, ADR 597). Run `musterd init --refresh-hooks`.',
    );
    leftover(
      'PreToolUse',
      INTERRUPT_MARKER,
      'a leftover Grok PreToolUse interrupt hook is still in .grok/hooks/musterd.json — the global hook already carries it, so the line would arrive twice (ADR 718). Run `musterd init --refresh-hooks`.',
    );
    leftover(
      'Stop',
      STOP_MARKER,
      'a leftover Grok Stop interrupt hook is still in .grok/hooks/musterd.json — the global hook already carries it, so the line would arrive twice (ADR 718). Run `musterd init --refresh-hooks`.',
    );
  }
  const globalFile = readHooks(globalInterruptHookPath());
  if (globalFile) {
    drift.push(
      ...commandDrift(
        cwd,
        globalFile,
        GLOBAL_INTERRUPT_HOOKS,
        '~/.grok/hooks/musterd-interrupt.json',
        false,
      ),
    );
  }
  return drift;
}

/**
 * Turn off one vendor's hook scan without touching its other compat cells.
 * An existing table gets `hooks = false` inside it. A second table of the same
 * name is a TOML error, so this never appends one.
 */
function ensureCompatHooksOff(toml: string, vendor: 'cursor' | 'claude'): string {
  const header = `[compat.${vendor}]`;
  const tableRe = new RegExp(`\\[compat\\.${vendor}\\][^\\[]*`);
  const match = tableRe.exec(toml);
  if (!match || match.index === undefined) {
    return toml.replace(/\s*$/, '') + `\n${header}\nhooks = false\n`;
  }
  const body = match[0];
  if (/hooks\s*=\s*false/.test(body)) return toml;
  const replaced = /hooks\s*=\s*true/.test(body)
    ? body.replace(/hooks\s*=\s*true/, 'hooks = false')
    : body.replace(header, `${header}\nhooks = false`);
  return toml.slice(0, match.index) + replaced + toml.slice(match.index + body.length);
}

function ensureInheritedHooksOff(toml: string): string {
  // ADR 352: Cursor hooks would attest capture as cursor.
  // ADR 597: Claude hooks reach the model on Grok 1.0.52 and inject the interrupt line again.
  return ensureCompatHooksOff(ensureCompatHooksOff(toml, 'cursor'), 'claude');
}

function statuslineCommand(): string {
  return `command -v musterd >/dev/null 2>&1 && musterd session statusline --stdin 2>/dev/null || true # ${STATUSLINE_MARKER}`;
}

function ensureStatusline(toml: string, dir: string): { toml: string; warning?: string } {
  if (isDeclined(dir, SURFACE_STATUSLINE)) return { toml };
  if (/\[ui\.status_line\]/.test(toml)) {
    if (toml.includes(STATUSLINE_MARKER)) return { toml };
    return {
      toml,
      warning:
        '.grok/config.toml already has [ui.status_line] that musterd did not write, so the seat chip was NOT installed.',
    };
  }
  const block = `\n[ui.status_line]\ntype = "command"\ncommand = "${statuslineCommand().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
  return { toml: toml.replace(/\s*$/, '') + block };
}

function mergePermissionFloor(toml: string): string {
  if (/\[permission\]/.test(toml)) return toml; // existing table is the user's; do not clobber
  const allow = STANDARD_FLOOR.allow.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return toml.replace(/\s*$/, '') + `\n[permission]\nallow = [\n${allow}\n]\n`;
}

function toTomlServer(entry: McpServerEntry): CodexServer {
  return { command: entry.command, args: entry.args, env: entry.env };
}

/** A provisioned role server in Grok's TOML shape — remote servers carry `url` (ADR 708). */
function provisionedToTomlServer(s: {
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
}): CodexServer {
  return s.url !== undefined
    ? { url: s.url, args: [], env: s.env }
    : { command: s.command!, args: s.args, env: s.env };
}

/** ADR 442: Grok's PreToolUse gate matches write tools only; Grok has no session-reach tool names. */
export const SESSION_REACH_WALL = 'Grok CLI: session-reach: not gateable (identity-only) (ADR 442)';

export const grok: Harness = {
  id: 'grok',
  label: 'Grok CLI',
  surface: GROK_SURFACE,
  entryScope: 'folder',
  guidance: {
    skillPath: '.grok/skills/musterd/SKILL.md',
    frontmatter: 'claude-code',
    commandsDir: '.grok/commands',
    orientSkillPath: '.grok/skills/musterd-orient/SKILL.md',
    importSkillPath: '.grok/skills/musterd-import/SKILL.md',
  },

  observeModel: (payload) => {
    const id = payload.model_id?.trim() || payload.model?.trim();
    if (id) return id;
    if (!payload.session_id) return undefined;
    try {
      const home = process.env['GROK_HOME'] ?? join(homedir(), '.grok');
      const cwd = payload.cwd ?? process.cwd();
      const encoded = encodeURIComponent(cwd);
      const summary = join(home, 'sessions', encoded, payload.session_id, 'summary.json');
      const raw = readFileSync(summary, 'utf8');
      const parsed = JSON.parse(raw) as { current_model_id?: string };
      const model = parsed.current_model_id?.trim();
      return model || undefined;
    } catch {
      return undefined;
    }
  },

  async detect() {
    // ADR 643: installed means the binary resolves (the launcher's own resolver). A config dir
    // left behind by an uninstall is not an install.
    const bin = await resolveGrokBin();
    const installed = bin !== null;
    const projectToml = readText(projectConfigPath()) ?? '';
    const inProject = hasServer(projectToml, 'musterd');
    const globalToml = inProject ? '' : (readText(globalConfigPath()) ?? '');
    const inGlobal = !inProject && hasServer(globalToml, 'musterd');
    const env = inProject
      ? readServerEnv(projectToml, 'musterd')
      : inGlobal
        ? readServerEnv(globalToml, 'musterd')
        : undefined;
    return {
      installed,
      configured: inProject || inGlobal,
      detail: inGlobal
        ? 'registered in ~/.grok/config.toml (machine-global — musterd writes the project file)'
        : bin
          ? `grok on PATH (${bin})`
          : 'grok install not found',
      ...registeredFromEnv(env),
      hookDrift: inspectGrokHookDrift(process.cwd()),
      ...(inGlobal ? { registeredElsewhere: globalConfigPath() } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    let toml = readText(path) ?? '';
    toml = upsertServer(toml, 'musterd', toTomlServer(entry));
    toml = ensureInheritedHooksOff(toml);
    const sl = ensureStatusline(toml, process.cwd());
    toml = mergePermissionFloor(sl.toml);
    writeText(path, toml);
    const hookWarnings = installMusterdGrokHooks();
    const warnings = [...hookWarnings, ...(sl.warning ? [sl.warning] : [])];
    return {
      target: path,
      activation:
        'reload MCP in this Grok session (/mcps, disable then enable musterd) — a list refresh does not respawn stdio',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(projectHooksPath(dir)),
    // Lane 01M3NMZ94D: without this the self-heal's inspection read Claude Code hooks only, so a
    // Grok folder with no .grok/hooks/musterd.json at all read `hooks: 0` and was never repaired.
    drift: (dir) => inspectGrokHookDrift(dir),
    run: (dir) => {
      const warnings = installMusterdGrokHooks(dir);
      let toml = readText(projectConfigPath(dir)) ?? '';
      if (toml.length > 0) {
        toml = ensureInheritedHooksOff(toml);
        const sl = ensureStatusline(toml, dir);
        toml = mergePermissionFloor(sl.toml);
        writeText(projectConfigPath(dir), toml);
        if (sl.warning) warnings.push(sl.warning);
      }
      return {
        files: [
          projectHooksPath(dir),
          projectConfigPath(dir),
          globalInterruptHookPath(),
          globalStartHookPath(),
        ],
        warnings,
        skipped: [],
      };
    },
    surfaces: () => [
      SURFACE_STATUSLINE,
      ...new Set([...LOCAL_HOOKS.map((s) => `${GROK_PREFIX}:${s.event}`), `${GROK_PREFIX}:Stop`]),
    ],
  },

  async provision(plan: ProvisionPlan, _scope?: 'local' | 'shared', cwd?: string) {
    const path = projectConfigPath(cwd);
    let toml = readText(path) ?? '';
    const servers: string[] = [];
    for (const s of plan.servers) {
      toml = upsertServer(toml, s.name, provisionedToTomlServer(s));
      servers.push(s.name);
    }
    toml = mergePermissionFloor(toml);
    writeText(path, toml);
    return {
      servers,
      permissions: { allow: STANDARD_FLOOR.allow, ask: [], deny: [] },
      target: path,
      activation: 'reload MCP in this Grok session to pick up new servers',
    };
  },

  async unprovision(plan: UnprovisionPlan, _scope?: 'local' | 'shared', cwd?: string) {
    const path = projectConfigPath(cwd);
    const toml = readText(path);
    if (toml === null) return;
    const next = removeServers(toml, plan.servers);
    writeText(path, next);
  },
};

interface MusterdGrokPayload {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok',
  surface: GROK_SURFACE,
  adapterVersion: 1,
  interactive: {
    resolveBin: () => resolveGrokBin(),
    fresh: () => [],
    resume: (id) => (id ? ['--resume', id] : ['--continue']),
  },

  async availability(ctx) {
    // ADR 643: installed means the binary resolves (the launcher's own resolver). A config dir
    // left behind by an uninstall is not an install.
    const exec = ctx.exec;
    const bin = await resolveGrokBin(exec ? (c, a) => exec.run(c, a) : undefined);
    return bin
      ? { available: true, detail: `grok on PATH (${bin})` }
      : { available: false, detail: 'grok install not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .grok/config.toml`,
          scope: 'folder',
          handle: 'mcp',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const payload: MusterdGrokPayload = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(GROK_SURFACE),
    };
    return [
      {
        harness: 'grok',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'grok', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .grok/config.toml`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(payload),
        payload,
      },
      ...roleSkillFragments(
        ctx,
        'grok',
        GROK_BRIDGE,
        `folder ${ctx.worktreeRoot} grok-role-skills`,
      ),
    ];
  },

  async observe(ctx, intent) {
    if (isRoleSkillFragment(intent.fragmentKey))
      return observeRoleSkill(ctx.fs, ctx.worktreeRoot, intent, GROK_BRIDGE);
    if (intent.fragmentKey !== 'mcp.musterd') return { state: 'absent' };
    const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.grok', 'config.toml'));
    if (toml === null) return { state: 'absent' };
    const entry = readServer(toml, 'musterd');
    if (!entry) return { state: 'absent' };
    // Same payload as desiredFragments — command + args + env — so a write observes as itself
    // (Cursor/Codex/OpenCode). Hashing env alone made every applied entry look drifted.
    const fingerprint = canonicalFingerprint(entry);
    return markerGenerationOfEnv(entry.env) !== 'launch'
      ? { state: 'legacy-launch-marker', fingerprint }
      : { state: 'present', fingerprint };
  },

  async apply(ctx, mutation) {
    if (isRoleSkillFragment(mutation.intent.fragmentKey)) {
      applyRoleSkill(
        ctx.fs,
        ctx.worktreeRoot,
        mutation.intent,
        GROK_BRIDGE,
        mutation.kind === 'remove' ? 'remove' : 'write',
      );
      return;
    }
    if (mutation.intent.fragmentKey !== 'mcp.musterd') {
      throw new Error(`unknown grok fragment ${mutation.intent.fragmentKey}`);
    }
    const path = join(ctx.worktreeRoot, '.grok', 'config.toml');
    const existing = ctx.fs.readFile(path) ?? '';
    let toml = existing;
    if (mutation.kind === 'remove') {
      toml = removeServers(toml, ['musterd']);
    } else if (mutation.kind === 'repair-launch-marker') {
      const observed = readServer(toml, 'musterd');
      if (!observed) return;
      const { ['MUSTERD_SURFACE']: _retired, ...rest } = observed.env;
      toml = upsertServer(toml, 'musterd', {
        command: observed.command!,
        args: observed.args,
        env: { ...rest, ...launchEntryEnv(GROK_SURFACE) },
      });
    } else {
      const payload = mutation.intent.payload as MusterdGrokPayload;
      toml = upsertServer(toml, 'musterd', {
        command: payload.command,
        args: payload.args,
        env: payload.env,
      });
    }
    if (mutation.kind !== 'remove') toml = ensureInheritedHooksOff(toml);
    ctx.fs.mkdirp(dirname(path));
    ctx.fs.writeFile(path, toml.endsWith('\n') ? toml : `${toml}\n`, 0o644);
  },
};
