import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Built-in role skills (ADR 586 §4–6). The repo's `.agents/skills/` is the one place a role skill is
 * edited; the CLI build copies these into `dist/role-skills/` and `musterd role create` copies them
 * out again into a team's repo.
 *
 * Only a role whose skill has a recorded blind-graded eval run ships one (decision 6). The
 * product-communications skill has one, but names this team's brand sources throughout, so it is
 * team-specific until it is split the way `references/team.md` splits the others (ADR 586,
 * Consequences 2026-10-13); its role file ships without it.
 */
export const BUILTIN_ROLE_SKILLS: readonly string[] = [
  'designer',
  'observer',
  'planner',
  'platform',
  'steward',
];

/** The method skill: a custom role's skeleton lives in it, and it ships beside the built-ins. */
export const METHOD_SKILL = 'building-a-role-skill';

/** A role skill's team-specific layer (ADR 586, amended §1); shipped blank, from the skeleton. */
const TEAM_FILE = join('references', 'team.md');
const SKELETON = 'skeleton';

/**
 * Where the shipped skills are: `dist/role-skills/` in a built CLI, else the repo's own
 * `.agents/skills/` when running from source (tests, `pnpm dev`).
 */
export function bundledSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, '..', 'role-skills');
  if (existsSync(built)) return built;
  return join(here, '..', '..', '..', '..', '.agents', 'skills');
}

/** Every file under `dir`, as paths relative to it, sorted. `.DS_Store` is not content. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path));
  }
  return out.sort();
}

/**
 * The files a built-in skill ships as, keyed by relative path. A role skill's `references/team.md`
 * is replaced by the skeleton's blank one: the rest of the skill is written for any team, and our
 * own team file stays in this repository.
 */
export function shippedSkillFiles(root: string, skill: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const dir = join(root, skill);
  for (const rel of walk(dir)) files.set(rel, readFileSync(join(dir, rel)));
  if (skill !== METHOD_SKILL && files.has(TEAM_FILE))
    files.set(TEAM_FILE, readFileSync(join(root, METHOD_SKILL, SKELETON, TEAM_FILE)));
  return files;
}

/** A custom role's starting skill: the method's skeleton with the role's name filled in. */
export function skeletonFiles(root: string, role: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const dir = join(root, METHOD_SKILL, SKELETON);
  for (const rel of walk(dir)) {
    const text = readFileSync(join(dir, rel), 'utf8');
    files.set(rel, Buffer.from(text.replaceAll('<role>', role)));
  }
  return files;
}

function writeFiles(dir: string, files: Map<string, Buffer>): void {
  for (const [rel, body] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

function sameFiles(dir: string, files: Map<string, Buffer>): boolean {
  const have = walk(dir);
  if (have.length !== files.size) return false;
  return have.every((rel) => files.get(rel)?.equals(readFileSync(join(dir, rel))) ?? false);
}

/** What happened to one skill directory: written, already identical, or kept as the user has it. */
export type SkillInstall = { skill: string; path: string; status: 'written' | 'same' | 'kept' };

/**
 * Put `files` at `<skillsDir>/<skill>/` unless something is there. A copy that differs is the
 * user's and is never overwritten (ADR 586 §4); the caller says how to compare it.
 */
export function installSkill(
  skillsDir: string,
  skill: string,
  files: Map<string, Buffer>,
): SkillInstall {
  const path = join(skillsDir, skill);
  if (existsSync(path) && statSync(path).isDirectory())
    return { skill, path, status: sameFiles(path, files) ? 'same' : 'kept' };
  writeFiles(path, files);
  return { skill, path, status: 'written' };
}

/** Copy every built-in skill, with its team file blanked, into `dest` (the CLI build step). */
export function bundleRoleSkills(sourceRoot: string, dest: string): string[] {
  const names = [...BUILTIN_ROLE_SKILLS, METHOD_SKILL];
  for (const skill of names) writeFiles(join(dest, skill), shippedSkillFiles(sourceRoot, skill));
  return names;
}

/** The repo a roster home sits in, where `.agents/skills/` belongs; the folder itself outside git. */
export function skillsDirFor(rosterHome: string): string {
  let top = rosterHome;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rosterHome,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    // not a git checkout — the roster home is the only folder we know
  }
  return join(top, '.agents', 'skills');
}
