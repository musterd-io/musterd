/*
 * skills:check — every committed skill in .agents/skills is well formed, and every role skill has
 * the shape ADR 586 decision 1 sets: a lean core, routed references, evals with a recorded run.
 *
 *   pnpm skills:check
 *
 * Every skill: SKILL.md opens with frontmatter whose `name` is the directory name (lowercase,
 * digits, hyphens, at most 64 characters) and whose `description` is present and at most 1,024
 * characters (the Agent Skills limits); relative links and routed `references/…` paths resolve;
 * LICENSES/ never appears without PROVENANCE.md.
 *
 * Role skills (ROLE_SKILLS below): SKILL.md at most 250 lines; at least one reference;
 * evals/evals.json parses, names the skill and holds at least two cases; evals/results.md exists.
 * A role still waiting for its rebuild is listed in PENDING with the lane that owes it, and is held
 * to the every-skill rules only. PENDING only shrinks.
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(root, '.agents', 'skills');

/** Role skills: the built-in roles (packages/cli/src/roster-roles) and this team's custom roles. */
const ROLE_SKILLS = [
  'product-communications',
  'platform',
  'designer',
  'security',
  'courier',
  'planner',
  'steward',
  'observer',
];

/** Roles whose rebuild by the ADR 586 method is still owed, with the lane that owes it. */
const PENDING: Record<string, string> = {
  platform: '01M4VPY15AT1YNJRT8CHGGWYZW',
  designer: '01M4VPY2D5WSJ6063YRMWXR7C4',
  security: '01M4VPY3M7YY7WE44ZN5DZ2WTB',
  courier: '01M4VPY4VCFHE0X231JT40HY36',
  planner: '01M4VPY6NTXKPAZM6TEVWXYHW1',
  steward: '01M4VPY6NTXKPAZM6TEVWXYHW1',
  observer: '01M4VPY6NTXKPAZM6TEVWXYHW1',
};

const MAX_CORE_LINES = 250;

export function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m?.[1]) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined)
      out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'skeleton' && entry !== 'files') out.push(...markdownFiles(path));
    } else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

export function checkSkill(name: string): string[] {
  const dir = join(SKILLS, name);
  const errs: string[] = [];
  const core = join(dir, 'SKILL.md');
  if (!existsSync(core)) return [`${name}: no SKILL.md`];
  const text = readFileSync(core, 'utf8');
  const fm = frontmatter(text);
  if (!fm) errs.push(`${name}: SKILL.md does not open with --- frontmatter ---`);
  else {
    if (fm.name !== name)
      errs.push(`${name}: frontmatter name "${fm.name ?? ''}" is not the directory name`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
      errs.push(`${name}: name must be lowercase, digits and hyphens, at most 64`);
    if (!fm.description) errs.push(`${name}: frontmatter has no description`);
    else if (fm.description.length > 1024)
      errs.push(`${name}: description is ${fm.description.length} characters (limit 1,024)`);
  }

  for (const file of markdownFiles(dir)) {
    const body = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of body.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (target === undefined || /^[a-z]+:/.test(target) || target.includes('<')) continue;
      if (!existsSync(resolve(dirname(file), target)))
        errs.push(
          `${name}: ${file.slice(dir.length + 1)} links to ${target}, which does not exist`,
        );
    }
  }
  for (const m of text.matchAll(/`(references\/[\w.-]+\.md)`/g)) {
    if (m[1] !== undefined && !existsSync(join(dir, m[1])))
      errs.push(`${name}: SKILL.md routes to ${m[1]}, which does not exist`);
  }
  if (existsSync(join(dir, 'LICENSES')) && !existsSync(join(dir, 'PROVENANCE.md')))
    errs.push(`${name}: has LICENSES/ but no PROVENANCE.md`);
  return errs;
}

export function checkRoleSkill(name: string): string[] {
  const dir = join(SKILLS, name);
  const errs: string[] = [];
  const lines = readFileSync(join(dir, 'SKILL.md'), 'utf8').split('\n').length;
  if (lines > MAX_CORE_LINES)
    errs.push(`${name}: SKILL.md is ${lines} lines (role skills: at most ${MAX_CORE_LINES})`);
  const refs = existsSync(join(dir, 'references'))
    ? readdirSync(join(dir, 'references')).filter((f) => f.endsWith('.md'))
    : [];
  if (refs.length === 0) errs.push(`${name}: no references/*.md`);
  const evalsPath = join(dir, 'evals', 'evals.json');
  if (!existsSync(evalsPath)) errs.push(`${name}: no evals/evals.json`);
  else {
    try {
      const ev = JSON.parse(readFileSync(evalsPath, 'utf8')) as {
        skill_name?: string;
        evals?: unknown[];
      };
      if (ev.skill_name !== name)
        errs.push(`${name}: evals.json skill_name is "${ev.skill_name ?? ''}"`);
      if (!Array.isArray(ev.evals) || ev.evals.length < 2)
        errs.push(`${name}: evals.json needs at least two cases`);
    } catch (e) {
      errs.push(`${name}: evals.json does not parse (${(e as Error).message})`);
    }
  }
  if (!existsSync(join(dir, 'evals', 'results.md')))
    errs.push(`${name}: no evals/results.md (no recorded run)`);
  return errs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const skills = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());
  const errs: string[] = [];
  for (const name of skills) errs.push(...checkSkill(name));
  for (const name of ROLE_SKILLS) {
    if (PENDING[name]) {
      if (existsSync(join(SKILLS, name)) && checkRoleSkill(name).length === 0)
        errs.push(
          `${name}: meets the role-skill shape; remove it from PENDING in scripts/check-skills.ts`,
        );
      continue;
    }
    if (!existsSync(join(SKILLS, name)))
      errs.push(`${name}: role skill missing and not in PENDING`);
    else errs.push(...checkRoleSkill(name));
  }
  if (errs.length) {
    for (const e of errs) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const pending = Object.keys(PENDING).length;
  console.log(
    `✓ skills:check — ${skills.length} skills well formed; ${ROLE_SKILLS.length - pending} of ${ROLE_SKILLS.length} role skills in the ADR 586 shape (${pending} pending, each with its lane)`,
  );
}
