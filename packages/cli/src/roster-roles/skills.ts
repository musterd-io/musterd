import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_NAME_RE } from '@musterd/protocol';

/**
 * Built-in role skills (ADR 586 §4–6). The repo's `.agents/skills/` is the one place a role skill is
 * edited; the CLI build copies these into `dist/role-skills/` and `musterd role create` copies them
 * out again into a team's repo.
 *
 * Only a role whose skill has a recorded blind-graded eval run ships one (decision 6). The
 * security source lives at `security-portable/` so the built-in never bundles this team's
 * `.agents/skills/security/`; it is installed with the role's name and a blank team file.
 */
export const BUILTIN_ROLE_SKILLS: readonly string[] = [
  'designer',
  'observer',
  'planner',
  'platform',
  'product-communications',
  'security',
  'steward',
];

/** The method skill: a custom role's skeleton lives in it, and it ships beside the built-ins. */
export const METHOD_SKILL = 'building-a-role-skill';

/** A role skill's team-specific layer (ADR 586, amended §1); shipped blank, from the skeleton. */
const TEAM_FILE = join('references', 'team.md');
const SKELETON = 'skeleton';

/** A portable source tree may have its own directory name while installing as a built-in role. */
const BUILTIN_ROLE_SKILL_SOURCES: Record<string, string> = {
  security: 'security-portable',
};

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
  const source = BUILTIN_ROLE_SKILL_SOURCES[skill] ?? skill;
  const dir = join(root, source);
  for (const rel of walk(dir)) files.set(rel, readFileSync(join(dir, rel)));
  if (skill !== METHOD_SKILL && files.has(TEAM_FILE))
    files.set(TEAM_FILE, readFileSync(join(root, METHOD_SKILL, SKELETON, TEAM_FILE)));
  if (source !== skill) {
    const core = files.get('SKILL.md');
    if (core)
      files.set(
        'SKILL.md',
        Buffer.from(core.toString('utf8').replace(/^name: [^\n]+$/m, `name: ${skill}`)),
      );
    const evalsPath = join('evals', 'evals.json');
    const evals = files.get(evalsPath);
    if (evals) {
      const document = JSON.parse(evals.toString('utf8')) as { skill_name?: string };
      document.skill_name = skill;
      files.set(evalsPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
    }
  }
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

/**
 * Whether writing `path` stays inside `root`: the nearest ancestor that exists (a symlink counts as
 * existing, dangling or not) must resolve inside `root`'s real path. A symlinked `.agents` or skill
 * directory — say, one committed in a cloned repo — would otherwise carry a write anywhere.
 */
export function staysInside(root: string, path: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  let p = path;
  for (;;) {
    try {
      lstatSync(p);
      break;
    } catch {
      const up = dirname(p);
      if (up === p) return false;
      p = up;
    }
  }
  try {
    const real = realpathSync(p);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false; // a dangling symlink: where it points is not ours to create
  }
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
  if (!SKILL_NAME_RE.test(skill)) throw new Error(`"${skill}" is not a skill directory name`);
  const path = join(skillsDir, skill);
  const repo = dirname(dirname(skillsDir));
  if (!staysInside(repo, path))
    throw new Error(`${path} resolves outside ${repo} (a symlink?) — not writing a skill there`);
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
