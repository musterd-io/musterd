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
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultHarnessContext, type HarnessContext } from './reconcile/context.js';
import {
  applyRoleSkill,
  CLAUDE_BRIDGE,
  CURSOR_BRIDGE,
  GROK_BRIDGE,
  missingSkillLine,
  observeRoleSkill,
  resolveSeatRoleSkills,
  roleSkillFragments,
  skillDescription,
} from './roleSkills.js';

let worktree: string;
let home: string;

function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function seat(roles: string) {
  write(
    join(home, '.musterd', 'seats', 'fifty.toml'),
    `kind = "agent"\nrole = "platform"\n${roles}`,
  );
}

function skill(name: string, description = `The ${name} role.`) {
  write(
    join(worktree, '.agents', 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'musterd-roleskill-wt-'));
  home = mkdtempSync(join(tmpdir(), 'musterd-roleskill-home-'));
  write(
    join(worktree, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://localhost:4849',
      team: 'alpha',
      claim: { mode: 'seat', name: 'fifty' },
    }),
  );
});

describe("resolving the seat's role skills (ADR 586 §3)", () => {
  it('bridges each skill the roles name, and reports a role whose skill the repo lacks', () => {
    seat('roles = ["platform", "designer", "courier"]\n');
    write(join(home, '.musterd', 'roles', 'designer.toml'), 'skill = "brand-design"\n');
    skill('platform');
    skill('brand-design', '"Owns the UI: copy, layout and tokens"');
    const r = resolveSeatRoleSkills(worktree, 'alpha', { alpha: home })!;
    expect(r.seat).toBe('fifty');
    expect(r.bridges).toEqual([
      { skill: 'platform', description: 'The platform role.' },
      { skill: 'brand-design', description: '"Owns the UI: copy, layout and tokens"' },
    ]);
    expect(r.missing).toEqual([{ role: 'courier', skill: 'courier' }]);
    expect(missingSkillLine(r.missing[0]!)).toMatch(
      /courier.*\.agents\/skills\/courier\/SKILL\.md/,
    );
  });

  it('a role name that is not a skill directory name becomes no path', () => {
    seat('roles = ["../../escape"]\n');
    const r = resolveSeatRoleSkills(worktree, 'alpha', { alpha: home })!;
    expect(r.bridges).toEqual([]);
    expect(r.missing).toEqual([{ role: '../../escape', skill: '../../escape' }]);
  });

  it('says nothing without a seat binding, a roster home, or a seat file', () => {
    seat('');
    expect(resolveSeatRoleSkills(worktree, 'alpha', {})).toBeUndefined();
    expect(resolveSeatRoleSkills(worktree, undefined, { alpha: home })).toBeUndefined();
    expect(resolveSeatRoleSkills(home, 'alpha', { alpha: home })).toBeUndefined();
  });

  it('reads a description verbatim, and none from a file without frontmatter', () => {
    expect(skillDescription('---\nname: x\ndescription: Does x: well\n---\nbody')).toBe(
      'Does x: well',
    );
    expect(skillDescription('# no frontmatter\n')).toBeNull();
  });
});

describe('role-skill bridges as reconciler fragments (ADR 586 §4)', () => {
  function ctx(): HarnessContext {
    return {
      ...defaultHarnessContext(worktree),
      roleSkills: [{ skill: 'platform', description: 'The platform role.' }],
    };
  }

  it('one fragment per skill; the Claude bridge names the skill and points at the canonical file', () => {
    const [intent, ...rest] = roleSkillFragments(ctx(), 'claude-code', CLAUDE_BRIDGE, 'c');
    expect(rest).toHaveLength(0);
    expect(intent!.fragmentKey).toBe('role-skill.platform');
    applyRoleSkill(ctx().fs, worktree, intent!, CLAUDE_BRIDGE, 'write');
    const text = readFileSync(join(worktree, '.claude', 'skills', 'platform', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: platform\ndescription: The platform role\.\n---\n/);
    expect(text).toContain('`.agents/skills/platform/SKILL.md`');
    expect(text).toMatch(/<!-- musterd:content v\d+ sha256:/);
  });

  it('the Grok bridge sits where Grok catalogs skills, with the Claude frontmatter', () => {
    const [intent] = roleSkillFragments(ctx(), 'grok', GROK_BRIDGE, 'g');
    applyRoleSkill(ctx().fs, worktree, intent!, GROK_BRIDGE, 'write');
    const text = readFileSync(join(worktree, '.grok', 'skills', 'platform', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: platform\ndescription: The platform role\.\n---\n/);
    expect(text).toContain('`.agents/skills/platform/SKILL.md`');
  });

  it('a written bridge observes as its intent, and a payload-less release observes the same', () => {
    const c = ctx();
    const [intent] = roleSkillFragments(c, 'cursor', CURSOR_BRIDGE, 'c');
    expect(observeRoleSkill(c.fs, worktree, intent!, CURSOR_BRIDGE)).toEqual({ state: 'absent' });
    applyRoleSkill(c.fs, worktree, intent!, CURSOR_BRIDGE, 'write');
    const observed = observeRoleSkill(c.fs, worktree, intent!, CURSOR_BRIDGE);
    expect(observed).toEqual({ state: 'present', fingerprint: intent!.fingerprint });
    const release = { ...intent!, payload: undefined };
    expect(observeRoleSkill(c.fs, worktree, release, CURSOR_BRIDGE)).toEqual(observed);
    applyRoleSkill(c.fs, worktree, release, CURSOR_BRIDGE, 'remove');
    expect(existsSync(join(worktree, '.cursor', 'rules', 'platform.mdc'))).toBe(false);
  });

  it('never writes a bridge through a symlink out of the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'musterd-roleskill-out-'));
    mkdirSync(join(worktree, '.claude'));
    symlinkSync(outside, join(worktree, '.claude', 'skills'));
    const [intent] = roleSkillFragments(ctx(), 'claude-code', CLAUDE_BRIDGE, 'c');
    expect(() => applyRoleSkill(ctx().fs, worktree, intent!, CLAUDE_BRIDGE, 'write')).toThrow(
      /outside/,
    );
    expect(existsSync(join(outside, 'platform'))).toBe(false);
  });

  it('a context with no resolved roles desires no bridge', () => {
    expect(
      roleSkillFragments(defaultHarnessContext(worktree), 'claude-code', CLAUDE_BRIDGE, 'c'),
    ).toEqual([]);
  });
});
