import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessId, RoleFile } from '@musterd/protocol';
import {
  bindingSeat,
  parseRoleFile,
  parseSeatFile,
  roleSkillName,
  seatRoles,
  SKILL_NAME_RE,
} from '@musterd/protocol';
import { loadConfig, readBindingAt } from '../config.js';
import { staysInside } from '../roster-roles/skills.js';
import { applyFileMap, observeFileMap, stamped } from './guidance.js';
import type { FsSeam, HarnessContext } from './reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentIntent,
  type ObservedFragment,
} from './reconcile/fragments.js';

/**
 * Role-skill bridges (ADR 586 §4, ADR 299): for each role the seat holds, a thin per-harness file
 * that points the harness at the canonical `.agents/skills/<skill>/SKILL.md`. The skill is the only
 * body; a bridge carries its name and description so the harness can catalog it, and nothing else.
 *
 * Each skill is its own reconciler fragment (`role-skill.<skill>`), so a role added later is a new
 * fragment created on the next wire, and a bridge the user wrote by hand at the same path is an
 * unmanaged conflict the engine leaves alone (ADR 282 §6). A role dropped while the harness stays
 * wired keeps its bridge: it points at a skill that still exists, and the engine releases fragments
 * only when the harness itself goes.
 */

/** One skill the seat's roles name, as found in this worktree. */
export interface RoleSkillBridge {
  skill: string;
  /** The canonical skill's frontmatter `description`, verbatim. */
  description: string;
}

/** What the seat's roles resolve to here: skills to bridge, and roles whose skill the repo lacks. */
export interface SeatRoleSkills {
  seat: string;
  bridges: RoleSkillBridge[];
  missing: { role: string; skill: string }[];
}

const FRAGMENT_PREFIX = 'role-skill.';

/** The `description:` line of a SKILL.md's frontmatter, verbatim; null when there is none. */
export function skillDescription(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const line = m?.[1]?.split('\n').find((l) => l.startsWith('description:'));
  return line ? line.slice('description:'.length).trim() : null;
}

/**
 * Resolve the seat bound to `worktreeRoot` to the skills its roles name (ADR 586 §3). Reads the
 * worktree's binding for the seat, the team's roster home for the seat and role files, and the
 * worktree's `.agents/skills/` for the skills. Undefined when any link is missing — no seat, no
 * roster home on this machine, no seat file — because then there is nothing to say either way.
 */
export function resolveSeatRoleSkills(
  worktreeRoot: string,
  team: string | undefined,
  rosterHomes: Record<string, string> = safeRosterHomes(),
): SeatRoleSkills | undefined {
  if (!team) return undefined;
  const binding = readBindingAt(worktreeRoot);
  const seat = binding ? bindingSeat(binding) : undefined;
  const home = rosterHomes[team];
  if (!seat || !home) return undefined;
  const seatPath = join(home, '.musterd', 'seats', `${seat}.toml`);
  if (!existsSync(seatPath)) return undefined;
  let roles: string[];
  try {
    roles = seatRoles(parseSeatFile(readFileSync(seatPath, 'utf8'), seat));
  } catch {
    return undefined;
  }
  const out: SeatRoleSkills = { seat, bridges: [], missing: [] };
  for (const role of roles) {
    const skill = roleSkillName(role, readRole(home, role));
    // A role name is any string in a seat file; only a skill directory name becomes a path.
    if (!SKILL_NAME_RE.test(skill)) {
      out.missing.push({ role, skill });
      continue;
    }
    const core = join(worktreeRoot, '.agents', 'skills', skill, 'SKILL.md');
    const description = existsSync(core) ? skillDescription(readFileSync(core, 'utf8')) : null;
    if (description === null) out.missing.push({ role, skill });
    else if (!out.bridges.some((b) => b.skill === skill)) out.bridges.push({ skill, description });
  }
  return out;
}

function readRole(home: string, role: string): Pick<RoleFile, 'skill'> {
  const path = join(home, '.musterd', 'roles', `${role}.toml`);
  try {
    return existsSync(path) ? parseRoleFile(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

function safeRosterHomes(): Record<string, string> {
  try {
    return loadConfig().rosterHome;
  } catch {
    return {};
  }
}

/** The context, with the seat's role-skill bridges resolved for the adapters that write them. */
export function withRoleSkills(ctx: HarnessContext): HarnessContext {
  const resolved = safeResolve(ctx.worktreeRoot, ctx.team);
  return resolved ? { ...ctx, roleSkills: resolved.bridges } : ctx;
}

/** Bridges are a convenience: a failure to resolve them never fails the wiring around them. */
function safeResolve(worktreeRoot: string, team: string | undefined): SeatRoleSkills | undefined {
  try {
    return resolveSeatRoleSkills(worktreeRoot, team);
  } catch {
    return undefined;
  }
}

/** The missing-skill lines for the seat bound to `worktreeRoot` (ADR 586 §3, amended: the CLI
 *  warns, where the repo is known, rather than reconcile). */
export function roleSkillNotes(worktreeRoot: string, team: string | undefined): string[] {
  return (safeResolve(worktreeRoot, team)?.missing ?? []).map(missingSkillLine);
}

/** The line `wire`, `init` and `doctor` print for each role whose skill this repo does not have. */
export function missingSkillLine(m: { role: string; skill: string }): string {
  return (
    `role ${m.role} names skill "${m.skill}", which this repo does not have at ` +
    `.agents/skills/${m.skill}/SKILL.md — no bridge written (musterd role create --from ${m.role} adds a built-in one)`
  );
}

// ── Per-harness bridges ─────────────────────────────────────────────────────────────────────────

/** Where a harness catalogs a skill, and the frontmatter shell it wants. */
export interface BridgeShape {
  path: (skill: string) => string;
  frontmatter: (b: RoleSkillBridge) => string;
}

export const CLAUDE_BRIDGE: BridgeShape = {
  path: (skill) => join('.claude', 'skills', skill, 'SKILL.md'),
  frontmatter: (b) => `---\nname: ${b.skill}\ndescription: ${b.description}\n---`,
};

/** Grok catalogs `.grok/skills/<name>/SKILL.md` with Claude's frontmatter — the same home its
 *  musterd guidance skills use (`grok.guidance`). */
export const GROK_BRIDGE: BridgeShape = {
  path: (skill) => join('.grok', 'skills', skill, 'SKILL.md'),
  frontmatter: CLAUDE_BRIDGE.frontmatter,
};

export const CURSOR_BRIDGE: BridgeShape = {
  path: (skill) => join('.cursor', 'rules', `${skill}.mdc`),
  frontmatter: (b) => `---\ndescription: ${b.description}\nalwaysApply: false\n---`,
};

function bridgeBody(skill: string): string {
  return (
    `This is a bridge, not the skill. Read the canonical skill at\n` +
    `\`.agents/skills/${skill}/SKILL.md\` (repo-relative) and follow it. If that file is\n` +
    `missing, this worktree's branch predates it — rebase onto \`main\` first. Do not edit\n` +
    `this bridge; musterd rewrites it, and the canonical file is the only body (ADR 299).\n`
  );
}

/** The bridge file map for one skill, rendered and stamped. */
export function bridgeFileMap(shape: BridgeShape, b: RoleSkillBridge): Record<string, string> {
  return { [shape.path(b.skill)]: stamped(`${shape.frontmatter(b)}\n\n${bridgeBody(b.skill)}`) };
}

/** One fragment per skill the seat's roles name. */
export function roleSkillFragments(
  ctx: HarnessContext,
  harness: HarnessId,
  shape: BridgeShape,
  containerKey: string,
): FragmentIntent[] {
  return (ctx.roleSkills ?? []).map((b) => {
    const payload = bridgeFileMap(shape, b);
    const fragmentKey = `${FRAGMENT_PREFIX}${b.skill}`;
    return {
      harness,
      resourceKey: folderResourceKey(ctx.worktreeRoot, harness, fragmentKey),
      containerKey,
      fragmentKey,
      scope: 'folder',
      fingerprint: canonicalFingerprint(payload),
      payload,
    };
  });
}

export function isRoleSkillFragment(fragmentKey: string): boolean {
  return fragmentKey.startsWith(FRAGMENT_PREFIX);
}

/** The intent's file map, or — for a release rebuilt from the ledger, which has no payload — its
 *  paths alone, which is all observing what is on disk and removing it need. */
function filesOf(intent: FragmentIntent, shape: BridgeShape): Record<string, string> {
  const payload = intent.payload as Record<string, string> | undefined;
  if (payload) return payload;
  const skill = intent.fragmentKey.slice(FRAGMENT_PREFIX.length);
  if (!SKILL_NAME_RE.test(skill)) throw new Error(`"${skill}" is not a skill directory name`);
  return { [shape.path(skill)]: '' };
}

export function observeRoleSkill(
  fs: FsSeam,
  root: string,
  intent: FragmentIntent,
  shape: BridgeShape,
): ObservedFragment {
  return observeFileMap(fs, root, filesOf(intent, shape));
}

export function applyRoleSkill(
  fs: FsSeam,
  root: string,
  intent: FragmentIntent,
  shape: BridgeShape,
  kind: 'write' | 'remove',
): void {
  const files = filesOf(intent, shape);
  for (const rel of Object.keys(files)) {
    if (!staysInside(root, join(root, rel)))
      throw new Error(`${rel} resolves outside ${root} (a symlink?) — not touching it`);
  }
  applyFileMap(fs, root, files, kind);
}
