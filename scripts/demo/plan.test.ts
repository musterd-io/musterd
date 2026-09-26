import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defaultRepoName,
  joinUrl,
  pagesProjectBody,
  pagesProjectName,
  parseAgentDir,
  parseInvite,
  seedFiles,
  skillFrontmatter,
  steps,
  surfaceUrls,
  type StageOptions,
} from './plan.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const plannerSkill = readFileSync(join(repoRoot, '.agents/skills/planner/SKILL.md'), 'utf8');

describe('demo stage plan', () => {
  it('names the repo by date and derives a valid Pages project name', () => {
    expect(defaultRepoName(new Date('2026-09-26T21:00:00Z'))).toBe('musterd-demo-2026-09-26');
    expect(pagesProjectName('musterd-demo-2026-09-26')).toBe('musterd-demo-2026-09-26');
    expect(pagesProjectName('My_Demo..Repo-')).toBe('my-demo-repo');
    expect(pagesProjectName('x'.repeat(80) + '-y')).toHaveLength(58);
    expect(() => pagesProjectName('___')).toThrow();
  });

  it('connects Pages to the repo with main in production and previews for every PR', () => {
    const body = pagesProjectBody('p', 'Nas4146', 'musterd-demo-x') as {
      production_branch: string;
      source: { type: string; config: Record<string, unknown> };
    };
    expect(body.production_branch).toBe('main');
    expect(body.source.type).toBe('github');
    expect(body.source.config).toMatchObject({
      owner: 'Nas4146',
      repo_name: 'musterd-demo-x',
      production_branch: 'main',
      preview_deployment_setting: 'all',
      deployments_enabled: true,
    });
  });

  it('builds the join URL with the invite secret in the fragment, and local surface URLs', () => {
    expect(joinUrl('https://demo.example.com/', 'demo', 'ABC.s3cr3t')).toBe(
      'https://demo.example.com/join/demo#i=ABC.s3cr3t',
    );
    expect(surfaceUrls('http://127.0.0.1:4851/', 'demo')).toEqual({
      live: 'http://127.0.0.1:4851/live?team=demo',
      board: 'http://127.0.0.1:4851/board?team=demo',
    });
  });

  it('parses the CLI --json it depends on, and fails loudly on a shape change', () => {
    expect(
      parseInvite(
        JSON.stringify({
          invite: { id: 'inv_1', selector: 'ABC' },
          link_secret: 'ABC.xyz',
          room_code: 'ABC-DEFG-HJKM',
        }),
      ),
    ).toEqual({ id: 'inv_1', roomCode: 'ABC-DEFG-HJKM', linkSecret: 'ABC.xyz' });
    expect(() => parseInvite('{"invite":{}}')).toThrow(/room_code/);
    expect(parseAgentDir('{"member":"planner","dir":"/w/planner"}')).toBe('/w/planner');
    expect(() => parseAgentDir('{}')).toThrow();
  });

  it('seeds the real planner skill verbatim plus a pointer bridge per harness', () => {
    const { name, description } = skillFrontmatter(plannerSkill);
    expect(name).toBe('planner');
    const files = seedFiles({ repo: 'musterd-demo-x', team: 'demo', skillMd: plannerSkill });
    expect(files['.agents/skills/planner/SKILL.md']).toBe(plannerSkill);
    for (const bridge of [
      '.claude/skills/planner/SKILL.md',
      '.cursor/rules/planner.mdc',
      '.grok/skills/planner/SKILL.md',
    ]) {
      const body = files[bridge]!;
      expect(body).toContain('.agents/skills/planner/SKILL.md');
      expect(body).toContain(JSON.stringify(description));
      // A committed bridge is a pointer, never a copy of the body.
      expect(body.length).toBeLessThan(plannerSkill.length);
    }
    expect(files['AGENTS.md']).toContain('.agents/skills/planner/SKILL.md');
    expect(files['.gitignore']).toContain('.musterd/');
    expect(files['index.html']).toMatch(/^<!doctype html>/);
  });

  it('lists every step in order', () => {
    const o: StageOptions = {
      team: 'demo',
      owner: 'o',
      repo: 'r',
      presenter: 'nick',
      planner: 'planner',
      server: 'http://127.0.0.1:4851',
      publicOrigin: 'https://d.example.com',
      harness: 'claude-code',
      invite: { expires: '3h', memberUntil: '12h' },
      apply: false,
    };
    expect(steps(o).map((s) => s.id)).toEqual([
      'repo',
      'seed',
      'pages',
      'team',
      'policy',
      'invite',
      'planner',
      'residency',
    ]);
  });
});
