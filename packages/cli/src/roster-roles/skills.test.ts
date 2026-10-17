import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_SKILLS,
  bundledSkillsRoot,
  bundleRoleSkills,
  installSkill,
  METHOD_SKILL,
  shippedSkillFiles,
  staysInside,
} from './skills.js';
import { BUILTIN_ROLE_TEMPLATES } from './templates.js';

const root = bundledSkillsRoot();

describe('built-in role skills (ADR 586 §4–6)', () => {
  it('each shipped skill belongs to a built-in role and has its recorded eval run (decision 6)', () => {
    for (const skill of BUILTIN_ROLE_SKILLS) {
      expect(BUILTIN_ROLE_TEMPLATES[skill], skill).toBeDefined();
      expect(existsSync(join(root, skill, 'evals', 'results.md')), skill).toBe(true);
    }
  });

  it('a charter promises a skill only when its role ships one', () => {
    for (const [name, role] of Object.entries(BUILTIN_ROLE_TEMPLATES)) {
      if (/\bskill\b/i.test(role.charter ?? '')) expect(BUILTIN_ROLE_SKILLS, name).toContain(name);
    }
  });

  it('ships a role skill with the blank team file, and the method skill whole', () => {
    const blank = readFileSync(join(root, METHOD_SKILL, 'skeleton', 'references', 'team.md'));
    for (const skill of BUILTIN_ROLE_SKILLS) {
      const files = shippedSkillFiles(root, skill);
      expect(files.get('SKILL.md'), skill).toBeDefined();
      if (files.has(join('references', 'team.md')))
        expect(files.get(join('references', 'team.md'))!.equals(blank), skill).toBe(true);
    }
    expect(shippedSkillFiles(root, METHOD_SKILL).has(join('skeleton', 'SKILL.md'))).toBe(true);
  });

  it('installs the portable security source under the security role name', () => {
    const files = shippedSkillFiles(root, 'security');
    const core = files.get('SKILL.md')?.toString('utf8') ?? '';
    const evals = JSON.parse(files.get(join('evals', 'evals.json'))!.toString('utf8')) as {
      skill_name: string;
    };
    const blank = readFileSync(join(root, METHOD_SKILL, 'skeleton', 'references', 'team.md'));

    expect(core).toMatch(/^name: security$/m);
    expect(core).not.toBe(readFileSync(join(root, 'security', 'SKILL.md'), 'utf8'));
    expect(evals.skill_name).toBe('security');
    expect(files.get(join('references', 'team.md'))?.equals(blank)).toBe(true);
  });

  it('the build bundle is the shipped files, skill by skill', () => {
    const dest = mkdtempSync(join(tmpdir(), 'musterd-role-skills-'));
    const names = bundleRoleSkills(root, dest);
    expect(names).toEqual([...BUILTIN_ROLE_SKILLS, METHOD_SKILL]);
    for (const skill of names) {
      for (const [rel, body] of shippedSkillFiles(root, skill))
        expect(readFileSync(join(dest, skill, rel)).equals(body), `${skill}/${rel}`).toBe(true);
    }
  });
});

describe('installing a skill stays inside the repo', () => {
  it("keeps a team's existing security skill when the built-in is created", () => {
    const repo = mkdtempSync(join(tmpdir(), 'musterd-skill-repo-'));
    const skills = join(repo, '.agents', 'skills');
    const existing = join(skills, 'security');
    mkdirSync(existing, { recursive: true });
    const original = Buffer.from('team-owned skill\n');
    writeFileSync(join(existing, 'SKILL.md'), original);

    const result = installSkill(skills, 'security', shippedSkillFiles(root, 'security'));

    expect(result.status).toBe('kept');
    expect(readFileSync(join(existing, 'SKILL.md'))).toEqual(original);
  });

  it('refuses a skill directory reached through a symlink out of the repo', () => {
    const repo = mkdtempSync(join(tmpdir(), 'musterd-skill-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'musterd-skill-out-'));
    mkdirSync(join(repo, '.agents'));
    symlinkSync(outside, join(repo, '.agents', 'skills'));
    const files = shippedSkillFiles(root, 'observer');
    expect(() => installSkill(join(repo, '.agents', 'skills'), 'observer', files)).toThrow(
      /outside/,
    );
    expect(existsSync(join(outside, 'observer'))).toBe(false);
  });

  it('refuses a name that is not a skill directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'musterd-skill-repo-'));
    expect(() => installSkill(join(repo, '.agents', 'skills'), '../x', new Map())).toThrow();
  });

  it('a plain path under the root stays inside; a dangling symlink does not', () => {
    const repo = mkdtempSync(join(tmpdir(), 'musterd-skill-repo-'));
    expect(staysInside(repo, join(repo, '.agents', 'skills', 'x', 'SKILL.md'))).toBe(true);
    symlinkSync(join(repo, 'nowhere'), join(repo, '.agents-link'));
    expect(staysInside(repo, join(repo, '.agents-link', 'x'))).toBe(false);
  });
});
