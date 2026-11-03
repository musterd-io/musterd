import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FsSeam } from '../reconcile/context.js';

/**
 * What the human's Claude Code layer would load into a session started bare in a seat folder
 * (ADR 794 §2). The sources are on `docs/wiki/claude-code-seat-isolation.md`. Read from files,
 * never by shelling out to `claude`.
 */
export interface HumanLayer {
  /** Enabled plugins (`PLUGIN@MARKETPLACE`), plus claude.ai-synced ones as `<name>@synced`. */
  plugins: string[];
  /** Skill names: directory names under `~/.claude/skills/`, and synced ones as
   *  `anthropic-skills:<name>`. */
  skills: string[];
  /** MCP tool prefixes: user-config servers by key, claude.ai connectors as `claude_ai_<Name>`. */
  mcpServers: string[];
  /** False when any source exists but could not be read. A complement built from an incomplete
   *  layer may add entries but never removes one. */
  complete: boolean;
}

/** The namespace a claude.ai-synced skill is listed and invoked under. */
export const SYNCED_SKILL_NAMESPACE = 'anthropic-skills';

/** A claude.ai connector's display name as its tool prefix: `claude.ai Gmail` → `claude_ai_Gmail`. */
export function connectorPrefix(displayName: string): string {
  return displayName.replace(/[\s.]/g, '_');
}

export function readClaudeHumanLayer(fs: FsSeam, env: NodeJS.ProcessEnv): HumanLayer {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  const base = configDir || join(env['HOME'] ?? homedir(), '.claude');
  const claudeJson = configDir
    ? join(configDir, '.claude.json')
    : join(env['HOME'] ?? homedir(), '.claude.json');
  let complete = true;
  const readJson = (path: string): Record<string, unknown> | null => {
    const raw = fs.readFile(path);
    if (raw === null) return null;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === 'object' && v !== null && !Array.isArray(v))
        return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    complete = false;
    return null;
  };

  const plugins = new Set<string>();
  const enabled = readJson(join(base, 'settings.json'))?.['enabledPlugins'];
  if (enabled && typeof enabled === 'object') {
    for (const [id, on] of Object.entries(enabled)) if (on === true) plugins.add(id);
  }
  const syncedRoot = join(base, 'plugins', 'synced');
  for (const bucket of fs.listDirs?.(syncedRoot) ?? []) {
    for (const dir of fs.listDirs?.(join(syncedRoot, bucket)) ?? []) {
      plugins.add(`${dir.replace(/~g\d+$/, '')}@synced`);
    }
  }

  const skills = new Set<string>();
  const skillsRoot = join(base, 'skills');
  for (const dir of fs.listDirs?.(skillsRoot) ?? []) {
    if (dir !== 'synced') {
      skills.add(dir);
      continue;
    }
    for (const bucket of fs.listDirs?.(join(skillsRoot, 'synced')) ?? []) {
      // A claude.ai-synced skill is invoked as `anthropic-skills:<name>` (the 2026-11-03 listing).
      for (const name of fs.listDirs?.(join(skillsRoot, 'synced', bucket)) ?? [])
        skills.add(`${SYNCED_SKILL_NAMESPACE}:${name}`);
    }
  }

  const mcpServers = new Set<string>();
  const state = readJson(claudeJson);
  const user = state?.['mcpServers'];
  if (user && typeof user === 'object') for (const name of Object.keys(user)) mcpServers.add(name);
  const connectors = state?.['claudeAiMcpEverConnected'];
  if (Array.isArray(connectors)) {
    for (const name of connectors)
      if (typeof name === 'string') mcpServers.add(connectorPrefix(name));
  }

  return {
    plugins: [...plugins].sort(),
    skills: [...skills].sort(),
    mcpServers: [...mcpServers].sort(),
    complete,
  };
}
