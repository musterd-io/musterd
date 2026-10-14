import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_SKILLS,
  bundledSkillsRoot,
  bundleRoleSkills,
  METHOD_SKILL,
  shippedSkillFiles,
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
