import type { HumanLayer } from './claudeHumanLayer.js';
import type { DeclaredSet } from './resolve.js';

/**
 * The `seatTools` fragment of a Claude Code seat's `settings.local.json` (ADR 794 §2): for a bare
 * `claude` in the folder, an explicit "off" for everything the human's layer would load that the
 * seat does not declare. `enabledPlugins` entries are owned outright (declared → true, undeclared
 * human plugin → false). `deny` is added; `undeny` names entries this fragment takes back out,
 * because the seat now declares them.
 */
export interface ClaudeSeatToolsPayload {
  enabledPlugins: Record<string, boolean>;
  deny: string[];
  undeny: string[];
}

export function claudeComplement(declared: DeclaredSet, human: HumanLayer): ClaudeSeatToolsPayload {
  const floor = new Set(declared.deniedSkills);
  const plugins = new Set(declared.claude_plugins);
  const skills = new Set(declared.skills.filter((s) => !floor.has(s)));
  const servers = new Set(declared.mcp_servers.filter((name) => /^[A-Za-z0-9_-]+$/.test(name)));
  const ambiguous = new Set(human.ambiguousMcpServers ?? []);

  const enabledPlugins: Record<string, boolean> = {};
  for (const id of [...new Set([...plugins, ...human.plugins])].sort()) {
    enabledPlugins[id] = plugins.has(id);
  }
  const deny = [
    ...human.skills.filter((s) => !skills.has(s)).map((s) => `Skill(${s})`),
    ...human.mcpServers.filter((m) => !servers.has(m) || ambiguous.has(m)).map((m) => `mcp__${m}`),
  ].sort();
  const undeny = [
    ...[...skills].map((s) => `Skill(${s})`),
    ...[...servers].filter((m) => !ambiguous.has(m)).map((m) => `mcp__${m}`),
  ].sort();
  return { enabledPlugins, deny, undeny };
}
