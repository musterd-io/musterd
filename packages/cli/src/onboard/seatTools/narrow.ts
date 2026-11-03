import { join } from 'node:path';
import { SeatToolSetSchema } from '@musterd/protocol';
import { FLOOR_DENIED_SKILLS } from '../permissions.js';
import type { FsSeam } from '../reconcile/context.js';
import { SEAT_TOOLS_CACHE_REL } from './cache.js';
import { claudeComplement } from './claudeComplement.js';
import { readClaudeHumanLayer } from './claudeHumanLayer.js';
import { emptyDeclaredSet } from './resolve.js';

/**
 * The SessionStart half of ADR 794 §2: close off, in a seat folder, any tool the human added to
 * their Claude Code layer since the last reconcile. **Narrow only** — it adds `false` and deny
 * entries and never enables or un-denies anything, because a SessionStart hook never widens what
 * a seat may do (the ADR 408 self-heal line). Widening is the reconcile's, from a fresh read.
 *
 * Reads the declared set from the folder's cache, never the daemon, so a session start waits on
 * nothing. A folder with no cache has never been reconciled under ADR 794 and is left alone.
 * Returns what it closed (plugin ids and deny entries), empty when nothing changed.
 */
export function narrowNewHumanTools(
  worktreeRoot: string,
  fs: FsSeam,
  env: NodeJS.ProcessEnv,
): string[] {
  const raw = fs.readFile(join(worktreeRoot, SEAT_TOOLS_CACHE_REL));
  if (raw === null) return [];
  let declared;
  try {
    const parsed = SeatToolSetSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    declared = { ...emptyDeclaredSet(), ...parsed.data, deniedSkills: [...FLOOR_DENIED_SKILLS] };
  } catch {
    return [];
  }
  const want = claudeComplement(declared, readClaudeHumanLayer(fs, env));

  const path = join(worktreeRoot, '.claude', 'settings.local.json');
  const text = fs.readFile(path);
  let settings: {
    enabledPlugins?: Record<string, boolean>;
    permissions?: { deny?: string[] };
  } & Record<string, unknown>;
  try {
    settings = text === null ? {} : (JSON.parse(text) as typeof settings);
  } catch {
    return []; // a broken settings file is a human's edit, not ours to overwrite
  }
  const enabled = { ...(settings.enabledPlugins ?? {}) };
  const deny = [...(settings.permissions?.deny ?? [])];
  const closed: string[] = [];
  for (const [id, on] of Object.entries(want.enabledPlugins)) {
    if (on || enabled[id] === false) continue;
    enabled[id] = false;
    closed.push(id);
  }
  for (const entry of want.deny) {
    if (deny.includes(entry)) continue;
    deny.push(entry);
    closed.push(entry);
  }
  if (closed.length === 0) return [];
  const next = {
    ...settings,
    enabledPlugins: enabled,
    permissions: { ...(settings.permissions ?? {}), deny },
  };
  const stage = `${path}.tmp-${String(process.pid)}`;
  fs.mkdirp(join(worktreeRoot, '.claude'));
  fs.writeFile(stage, `${JSON.stringify(next, null, 2)}\n`, 0o644);
  fs.rename(stage, path);
  return closed;
}
