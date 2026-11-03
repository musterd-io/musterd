import type { SeatToolSet, SeatToolsPolicy } from '@musterd/protocol';
import { FLOOR_DENIED_SKILLS } from '../permissions.js';

/**
 * A seat's declared set (ADR 794 §1): the team's shared grants plus the grants of every role the
 * seat holds, minus the product floor. The repo's committed tools are declared too, but they are
 * already in the folder, so they never appear here. `source` says where the grants came from:
 * the daemon, the folder's cache of the last good read, or neither (repo tools and floor only).
 */
export interface DeclaredSet extends SeatToolSet {
  /** The product floor's skills, always: no grant lifts them. */
  deniedSkills: string[];
  source: 'server' | 'cache' | 'none';
  /** When the grants were read from the daemon, in ms; null when `source` is `none`. */
  readAt: number | null;
}

const KINDS = ['claude_plugins', 'codex_plugins', 'skills', 'mcp_servers'] as const;

/** Union the shared set and each held role's set, sorted and de-duplicated; a role with no entry
 *  adds nothing. A floor-denied skill a grant names is dropped from `skills`. */
export function declaredSetFor(
  policy: SeatToolsPolicy,
  roles: readonly string[],
): Omit<DeclaredSet, 'source' | 'readAt'> {
  const sets = [policy.shared, ...roles.flatMap((r) => policy.roles[r] ?? [])];
  const out = Object.fromEntries(
    KINDS.map((kind) => [kind, [...new Set(sets.flatMap((s) => s[kind]))].sort()]),
  ) as SeatToolSet;
  const floor = new Set(FLOOR_DENIED_SKILLS);
  out.skills = out.skills.filter((name) => !floor.has(name));
  return { ...out, deniedSkills: [...FLOOR_DENIED_SKILLS] };
}

/** The declared set when no grants could be read and none are cached: repo tools and floor only. */
export function emptyDeclaredSet(): DeclaredSet {
  return {
    claude_plugins: [],
    codex_plugins: [],
    skills: [],
    mcp_servers: [],
    deniedSkills: [...FLOOR_DENIED_SKILLS],
    source: 'none',
    readAt: null,
  };
}
