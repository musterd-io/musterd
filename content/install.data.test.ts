import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderReadme } from '../scripts/gen-install.ts';
import { INSTALL, RETIRED_INSTALL_COMMANDS, installShellBlock } from './install.data.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ADR 669 §3.3: one install, every surface. Before this, four surfaces gave four commands — and a
// stranger reading two of them met a contradiction in their first minute.
describe('install block', () => {
  it('names two routes only, npm and the Homebrew formula (ADR 568), and no npx', () => {
    expect(INSTALL.primary).toBe('npm install -g @musterd/cli');
    expect(INSTALL.alternatives.map((a) => a.command)).toEqual([
      'brew install SandRiseStudio/musterd/musterd',
    ]);
    expect(installShellBlock()).not.toMatch(/npx/);
  });

  it('the shell block carries every step title, so no step is skipped', () => {
    for (const [i, step] of INSTALL.steps.entries()) {
      expect(installShellBlock()).toContain(`# ${i + 1}. ${step.title}`);
    }
  });

  it('ends at `musterd tour`, which needs `musterd` on PATH — the reason npx is out', () => {
    expect(INSTALL.steps.at(-1)?.commands).toContain('musterd tour');
    expect(INSTALL.steps[0]?.commands).toEqual([INSTALL.primary]);
  });

  it('the README block is the current render (pnpm install:gen)', () => {
    const readme = read('README.md');
    expect(renderReadme(readme)).toBe(readme);
  });

  it.each([
    ['README.md'],
    ['docs/launch-post.md'],
    ['packages/web/src/components/site/GettingStarted.tsx'],
    ['packages/web/scripts/site-files.ts'],
  ])('%s carries no retired install command', (path) => {
    const text = read(path);
    for (const cmd of RETIRED_INSTALL_COMMANDS)
      expect(text, `${path} still says "${cmd}"`).not.toContain(cmd);
  });
});
