import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bindingSeat,
  type HarnessId,
  parseRoleFile,
  parseSeatFile,
  type RoleFile,
  roleSkillName,
  roleToolkitName,
  seatRoles,
  SKILL_NAME_RE,
} from '@musterd/protocol';
import { loadConfig, readBindingAt } from '../config.js';
import {
  BUILTIN_ROLE_SKILLS,
  bundledSkillsRoot,
  installSkill,
  shippedSkillFiles,
} from '../roster-roles/skills.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';
import { defaultHarnessContext } from './reconcile/context.js';
import { reconcileHarnesses } from './reconcile/engine.js';
import {
  applyRoleSkill,
  type BridgeShape,
  BRIDGE_BY_HARNESS,
  missingSkillLine,
  observeRoleSkill,
  type RoleSkillBridge,
  roleSkillFragments,
  skillDescription,
  withRoleSkills,
} from './roleSkills.js';
import { GENERALIST, loadToolkit, type Toolkit } from './toolkit.js';
import { provisionToolkitIntoHarnesses, type ToolkitProvisionOutcome } from './toolkitProvision.js';

/**
 * Equip a seat's roles into the harnesses that seat is wired for (ADR 713).
 *
 * Toolkits go through {@link provisionToolkitIntoHarnesses} — the same writer `init` uses —
 * for every harness in the saved desired set. Skill bridges are the reconciler's
 * `role-skill.*` files. Codex and Muse read `.agents/skills/` and get no bridge. OpenCode's
 * project surface is the AGENTS.md primer, which stays free of a seat's role, so it gets no
 * skill file either. A missing skill is installed only when it is a bundled built-in, and
 * never overwritten.
 */

const BUILTINS: readonly string[] = BUILTIN_ROLE_SKILLS;

export interface RoleEquipTarget {
  workspace: string;
  /** Roster home that holds `seats/` and `roles/`. Omit when this folder has no seat file. */
  rosterHome?: string | undefined;
  seat?: string | undefined;
  team?: string | undefined;
  /** Desired harnesses. When omitted, read from `provisioned.json`. */
  harnessIds?: readonly string[] | undefined;
  /** Toolkit name already recorded. When omitted, read from `provisioned.json`. */
  recorded?: string | undefined;
}

interface ResolvedEquip {
  workspace: string;
  team: string | undefined;
  rosterHome: string | undefined;
  seat: string | undefined;
  harnessIds: string[];
  recorded: string;
}

function resolved(target: RoleEquipTarget): ResolvedEquip {
  // Supplied fields win. The binding and the manifest fill only what the caller left out.
  const binding =
    target.team === undefined || target.seat === undefined
      ? readBindingAt(target.workspace)
      : undefined;
  const team = target.team ?? binding?.team;
  const seat = target.seat ?? (binding ? bindingSeat(binding) : undefined);
  let rosterHome = target.rosterHome;
  if (rosterHome === undefined && team) {
    try {
      rosterHome = loadConfig().rosterHome[team];
    } catch {
      rosterHome = undefined;
    }
  }
  const stored =
    target.harnessIds === undefined || target.recorded === undefined
      ? loadProvisioning(target.workspace)
      : undefined;
  const valid = stored?.kind === 'valid' ? stored.value : undefined;
  return {
    workspace: target.workspace,
    team,
    rosterHome,
    seat,
    harnessIds: [...(target.harnessIds ?? valid?.desired ?? [])],
    recorded: target.recorded ?? valid?.toolkit ?? '',
  };
}

/** Roles on the seat file. Empty when the file is missing or unreadable. */
export function seatRoleNames(rosterHome: string, seat: string): string[] {
  const path = join(rosterHome, '.musterd', 'seats', `${seat}.toml`);
  if (!existsSync(path)) return [];
  try {
    return seatRoles(parseSeatFile(readFileSync(path, 'utf8'), seat));
  } catch {
    return [];
  }
}

function readRole(rosterHome: string, role: string): Pick<RoleFile, 'skill' | 'toolkit'> {
  const path = join(rosterHome, '.musterd', 'roles', `${role}.toml`);
  try {
    return existsSync(path) ? parseRoleFile(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

interface ToolkitLoad {
  names: string[];
  /** A role file named a toolkit and it did not load. A same-name miss is a label, not an error. */
  errors: string[];
}

/** Toolkits the roles name that actually load. Searches the roster home, then the Workspace. */
export function loadableRoleToolkits(
  rosterHome: string,
  roles: readonly string[],
  workspace: string,
): ToolkitLoad {
  const names: string[] = [];
  const errors: string[] = [];
  for (const role of roles) {
    const file = readRole(rosterHome, role);
    const explicit = file.toolkit !== undefined;
    const name = roleToolkitName(role, file);
    if (!name || name === GENERALIST) continue;
    const toolkit = tryLoadToolkit(name, rosterHome, workspace);
    if (toolkit) {
      if (!names.includes(name)) names.push(name);
      continue;
    }
    if (explicit) {
      errors.push(
        `role ${role} names toolkit "${name}", which did not load (no built-in and no toolkit file)`,
      );
    }
  }
  return { names, errors };
}

function tryLoadToolkit(name: string, ...dirs: string[]): Toolkit | undefined {
  for (const dir of dirs) {
    try {
      return loadToolkit(dir, name);
    } catch {
      // The next directory, then a reported miss.
    }
  }
  return undefined;
}

/**
 * The toolkit name seat creation records when `--profile` was omitted and nothing is recorded
 * yet: the first held role's toolkit that loads. Empty when no role names one.
 */
export function defaultRecordedToolkit(
  rosterHome: string,
  seat: string,
  workspace: string,
): string {
  return (
    loadableRoleToolkits(rosterHome, seatRoleNames(rosterHome, seat), workspace).names[0] ?? ''
  );
}

function mergeRoleTools(workspace: string, outcomes: readonly ToolkitProvisionOutcome[]): void {
  const added = outcomes.flatMap((o) => o.servers.map((s) => `role-server ${o.harness} ${s}`));
  if (added.length === 0) return;
  const current = loadProvisioning(workspace);
  if (current.kind !== 'valid') return;
  const existing = current.value.contributions['role-tools'] ?? [];
  saveProvisioning(workspace, {
    ...current.value,
    contributions: {
      ...current.value.contributions,
      'role-tools': [...new Set([...existing, ...added])],
    },
  });
}

/**
 * Provision the recorded toolkit and every toolkit a held role names into `harnessIds`.
 * Additive and best-effort: a harness that throws is one outcome, and the rest still run.
 * An unloadable recorded name is reported. A role with no toolkit file is not.
 */
export async function equipRoleToolkits(
  target: RoleEquipTarget,
): Promise<ToolkitProvisionOutcome[]> {
  const ctx = resolved(target);
  if (ctx.harnessIds.length === 0) return [];
  const outcomes: ToolkitProvisionOutcome[] = [];
  const names: string[] = [];
  const recorded = ctx.recorded.trim();
  if (recorded && recorded !== GENERALIST) names.push(recorded);
  if (ctx.rosterHome && ctx.seat) {
    const loaded = loadableRoleToolkits(
      ctx.rosterHome,
      seatRoleNames(ctx.rosterHome, ctx.seat),
      ctx.workspace,
    );
    for (const name of loaded.names) if (!names.includes(name)) names.push(name);
    for (const error of loaded.errors) {
      outcomes.push({
        harness: 'role-tools',
        servers: [],
        skipped: [],
        permissionsAdded: 0,
        error,
      });
    }
  }
  const dirs = [ctx.rosterHome, ctx.workspace].filter((d): d is string => d !== undefined);
  for (const name of names) {
    const toolkit = tryLoadToolkit(name, ...dirs);
    if (!toolkit) {
      outcomes.push({
        harness: name,
        servers: [],
        skipped: [],
        permissionsAdded: 0,
        error: `unknown toolkit "${name}" (no built-in and no .musterd/toolkits/${name}.json)`,
      });
      continue;
    }
    outcomes.push(...(await provisionToolkitIntoHarnesses(toolkit, ctx.harnessIds, ctx.workspace)));
  }
  mergeRoleTools(ctx.workspace, outcomes);
  return outcomes;
}

function skillRows(
  workspace: string,
  rosterHome: string,
  roles: readonly string[],
): { bridges: RoleSkillBridge[]; missing: { role: string; skill: string }[] } {
  const bridges: RoleSkillBridge[] = [];
  const missing: { role: string; skill: string }[] = [];
  for (const role of roles) {
    const skill = roleSkillName(role, readRole(rosterHome, role));
    if (!SKILL_NAME_RE.test(skill)) {
      missing.push({ role, skill });
      continue;
    }
    const core = join(workspace, '.agents', 'skills', skill, 'SKILL.md');
    const description = existsSync(core) ? skillDescription(readFileSync(core, 'utf8')) : null;
    if (description === null) missing.push({ role, skill });
    else if (!bridges.some((b) => b.skill === skill)) bridges.push({ skill, description });
  }
  return { bridges, missing };
}

/**
 * Install a bundled built-in skill the Workspace does not have yet. A skill already there
 * is kept, differing bytes included (ADR 586). A role skill with no recorded eval is not a
 * built-in and is not copied.
 */
export function installMissingBuiltinRoleSkills(target: RoleEquipTarget): string[] {
  const ctx = resolved(target);
  if (!ctx.rosterHome || !ctx.seat) return [];
  const written: string[] = [];
  const skillsDir = join(ctx.workspace, '.agents', 'skills');
  for (const role of seatRoleNames(ctx.rosterHome, ctx.seat)) {
    const skill = roleSkillName(role, readRole(ctx.rosterHome, role));
    if (!SKILL_NAME_RE.test(skill) || !BUILTINS.includes(skill)) continue;
    if (existsSync(join(skillsDir, skill, 'SKILL.md'))) continue;
    try {
      const result = installSkill(skillsDir, skill, shippedSkillFiles(bundledSkillsRoot(), skill));
      if (result.status === 'written') written.push(skill);
    } catch {
      // A skill that will not stay inside the Workspace is reported by the missing-skill line.
    }
  }
  return written;
}

export interface RoleSkillEquip {
  written: string[];
  notes: string[];
}

/**
 * Write a role-skill bridge for each desired harness that catalogs one, when reconcile left
 * the file absent (the harness binary is not installed, so the engine plans nothing). A file
 * already there is left alone — a hand edit is not ours to overwrite (ADR 282).
 */
export function writeMissingRoleSkillBridges(target: RoleEquipTarget): RoleSkillEquip {
  const ctx = resolved(target);
  if (!ctx.rosterHome || !ctx.seat || ctx.harnessIds.length === 0)
    return { written: [], notes: [] };
  const { bridges, missing } = skillRows(
    ctx.workspace,
    ctx.rosterHome,
    seatRoleNames(ctx.rosterHome, ctx.seat),
  );
  const notes = missing.map(missingSkillLine);
  const written: string[] = [];
  if (bridges.length === 0) return { written, notes };
  const harnessCtx = {
    ...defaultHarnessContext(ctx.workspace, process.env, ctx.team ? { team: ctx.team } : {}),
    roleSkills: bridges,
  };
  for (const id of ctx.harnessIds) {
    const shape: BridgeShape | undefined = BRIDGE_BY_HARNESS[id as HarnessId];
    if (!shape) continue;
    for (const intent of roleSkillFragments(
      harnessCtx,
      id as HarnessId,
      shape,
      'role-skill-equip',
    )) {
      if (
        observeRoleSkill(harnessCtx.fs, harnessCtx.worktreeRoot, intent, shape).state !== 'absent'
      ) {
        continue;
      }
      applyRoleSkill(harnessCtx.fs, harnessCtx.worktreeRoot, intent, shape, 'write');
      written.push(`${id} ${intent.fragmentKey}`);
    }
  }
  if (written.length > 0 && ctx.harnessIds.includes('opencode')) {
    const skills = bridges.map((b) => b.skill).join(', ');
    notes.push(
      `opencode has no project skill catalog — its guidance is the AGENTS.md primer, which stays free of a seat's role. The skill is at .agents/skills/${skills}/SKILL.md`,
    );
  }
  return { written, notes };
}

/** Lines a command prints for toolkit outcomes and skill notes. Empty when nothing happened. */
export function equipmentReportLines(
  outcomes: readonly ToolkitProvisionOutcome[],
  notes: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`toolkit tools not provisioned for ${o.harness}: ${o.error}`);
    } else if (o.servers.length > 0) {
      const skipped = o.skipped.length > 0 ? ` (skipped: ${o.skipped.join(', ')})` : '';
      lines.push(`provisioned toolkit tools for ${o.harness}: ${o.servers.join(', ')}${skipped}`);
    }
  }
  return [...lines, ...notes];
}

/**
 * Bring the recorded toolkit name in line with the roles the seat holds after an assign.
 * An empty recorded name takes the first loadable role toolkit. Removing the role that was
 * the recorded name clears it, so a later wire does not put those servers back. The servers
 * already on disk stay until `musterd uninstall --role-tools` (ADR 713). No valid manifest
 * means there is nothing to equip.
 */
export function syncRecordedToolkit(args: {
  workspace: string;
  rosterHome: string;
  seat: string;
  role: string;
  remove: boolean;
  stillHeld: readonly string[];
}): { desired: string[]; lines: string[] } | undefined {
  const current = loadProvisioning(args.workspace);
  if (current.kind !== 'valid') return undefined;
  let toolkit = current.value.toolkit;
  const lines: string[] = [];
  if (args.remove) {
    const named = roleToolkitName(args.role, readRole(args.rosterHome, args.role));
    const remaining = loadableRoleToolkits(args.rosterHome, args.stillHeld, args.workspace).names;
    if (toolkit && toolkit !== GENERALIST && toolkit === named && !remaining.includes(toolkit)) {
      toolkit = '';
      lines.push(`toolkit "${named}" stays installed until \`musterd uninstall --role-tools\``);
    }
  } else if (!toolkit) {
    const next = defaultRecordedToolkit(args.rosterHome, args.seat, args.workspace);
    if (next) toolkit = next;
  }
  if (toolkit !== current.value.toolkit) {
    saveProvisioning(args.workspace, { ...current.value, toolkit });
  }
  return { desired: [...current.value.desired], lines };
}

/** The production reconcile `role assign` runs. Tests pass their own. */
export type RoleReconcile = typeof reconcileHarnesses;

/**
 * Install a missing bundled skill, reconcile so an installed harness owns the bridge,
 * then write any bridge reconcile left absent and provision the toolkits (ADR 713).
 * A reconcile throw is a line. The toolkit write still runs.
 */
export async function equipWiredRole(
  target: RoleEquipTarget,
  reconcile: RoleReconcile | undefined,
): Promise<{ outcomes: ToolkitProvisionOutcome[]; skills: RoleSkillEquip; lines: string[] }> {
  installMissingBuiltinRoleSkills(target);
  const lines: string[] = [];
  try {
    await (reconcile ?? reconcileHarnesses)(
      withRoleSkills(
        defaultHarnessContext(
          target.workspace,
          process.env,
          target.team ? { team: target.team } : {},
        ),
      ),
      [...(target.harnessIds ?? [])],
      { legacyRepair: false },
    );
  } catch (err) {
    lines.push(`harness reconcile: ${(err as Error).message}`);
  }
  const equipped = await finishRoleEquipment(target);
  return {
    outcomes: equipped.outcomes,
    skills: equipped.skills,
    lines: [...lines, ...equipped.lines],
  };
}

/** Write bridges reconcile left absent, then provision toolkits. One order for every caller. */
export async function finishRoleEquipment(target: RoleEquipTarget): Promise<{
  outcomes: ToolkitProvisionOutcome[];
  skills: RoleSkillEquip;
  lines: string[];
}> {
  const skills = writeMissingRoleSkillBridges(target);
  const outcomes = await equipRoleToolkits(target);
  return {
    outcomes,
    skills,
    lines: equipmentReportLines(outcomes, [
      ...skills.written.map((w) => `wrote role skill bridge ${w}`),
      ...skills.notes,
    ]),
  };
}
