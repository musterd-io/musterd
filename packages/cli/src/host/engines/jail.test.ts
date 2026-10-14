import { describe, expect, it } from 'vitest';
import { bashAllowed, jailPath, scrubEnv, splitWords } from './jail.js';

/**
 * ADR 588 §4: the jail is deterministic and has no unjailed mode. These pin the two verdicts
 * against the cases that matter — escapes through symlinks and `..`, writes into the seat's
 * secrets, and every shell feature that smuggles a second command past an allowlist.
 */

const tree = new Map<string, string>([
  ['/real/ws', '/real/ws'],
  ['/real/ws/src', '/real/ws/src'],
  ['/real/ws/src/a.ts', '/real/ws/src/a.ts'],
  ['/real/ws/.musterd', '/real/ws/.musterd'],
  ['/real/ws/.musterd/binding.json', '/real/ws/.musterd/binding.json'],
  ['/real/ws/.git', '/real/ws/.git'],
  ['/real/ws/escape', '/elsewhere'],
  ['/elsewhere', '/elsewhere'],
  ['/link/ws', '/real/ws'],
]);
const fs = {
  realpath: (p: string) => {
    const r = tree.get(p);
    if (!r) throw new Error('ENOENT');
    return r;
  },
  exists: (p: string) => tree.has(p),
};

describe('jailPath', () => {
  it('resolves a relative path inside the workspace, through a symlinked workspace root', () => {
    expect(jailPath('/link/ws', 'src/a.ts', {}, fs)).toEqual({
      ok: true,
      path: '/real/ws/src/a.ts',
    });
  });

  it('judges a file that does not exist yet by where it would land', () => {
    expect(jailPath('/real/ws', 'src/new/b.ts', { write: true }, fs)).toEqual({
      ok: true,
      path: '/real/ws/src/new/b.ts',
    });
    expect(jailPath('/real/ws', '../out/b.ts', { write: true }, fs).ok).toBe(false);
  });

  it('refuses an escape through a symlink inside the workspace', () => {
    const v = jailPath('/real/ws', 'escape/secret', {}, fs);
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toMatch(/outside the workspace/);
  });

  it('refuses absolute paths outside and accepts absolute paths inside', () => {
    expect(jailPath('/real/ws', '/etc/passwd', {}, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '/real/ws/src/a.ts', {}, fs).ok).toBe(true);
  });

  it('never exposes the binding and never lets a write into .musterd or .git', () => {
    expect(jailPath('/real/ws', '.musterd/binding.json', {}, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '.git/hooks/pre-commit', { write: true }, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '.musterd/skill/orient.md', { write: true }, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '.git/HEAD', {}, fs).ok).toBe(true);
  });

  it('refuses an empty path and an unresolvable workspace', () => {
    expect(jailPath('/real/ws', '', {}, fs).ok).toBe(false);
    expect(jailPath('/nowhere', 'a', {}, fs).ok).toBe(false);
  });
});

describe('splitWords', () => {
  it('groups quotes and honours escapes without expanding anything', () => {
    expect(splitWords(`git commit -m "fix: a b" -m 'c d' e\\ f`)).toEqual([
      'git',
      'commit',
      '-m',
      'fix: a b',
      '-m',
      'c d',
      'e f',
    ]);
  });
});

const policy = { scripts: new Set(['typecheck', 'lint', 'format:check', 'test', 'build']) };
const deny = (cmd: string): string => {
  const v = bashAllowed(cmd, policy);
  expect(v.ok).toBe(false);
  return (v as { reason: string }).reason;
};

describe('bashAllowed', () => {
  it('allows the ADR 106 loop: fast gates, git on a feature branch, gh pr create/merge', () => {
    for (const cmd of [
      'pnpm typecheck && pnpm lint && pnpm format:check',
      'pnpm exec vitest run packages/cli/src/host/engines',
      'pnpm --filter @musterd/cli test',
      'pnpm run build',
      'git fetch origin main && git checkout -b feat/x origin/main',
      'git status --short',
      'git add -A && git commit -m "feat: x"',
      'git push -u origin feat/x',
      'git rebase origin/main && git push --force-with-lease',
      'gh pr create --fill',
      'gh pr merge 12 --squash --auto --delete-branch',
      'musterd lane submit --pr 12',
      'ls -la src | head -20',
      'grep -rn "foo" src ; wc -l src/a.ts',
      'cd packages/cli && pnpm test',
      'sed -n 1,20p src/a.ts',
    ]) {
      expect(bashAllowed(cmd, policy)).toEqual({ ok: true });
    }
  });

  it('refuses every smuggler: substitution, redirection, backgrounding, newlines', () => {
    expect(deny('echo $(cat /etc/passwd)')).toMatch(/substitution/);
    expect(deny('echo `id`')).toMatch(/backticks/);
    expect(deny('cat a > b')).toMatch(/redirection/);
    expect(deny('cat < a')).toMatch(/redirection/);
    expect(deny('sleep 10 &')).toMatch(/backgrounding/);
    expect(deny('ls\nrm -rf /')).toMatch(/newlines/);
    expect(deny('echo ${HOME}')).toMatch(/expansion/);
  });

  it('judges every segment of a pipeline, not just the first', () => {
    expect(deny('ls | rm -rf src')).toMatch(/rm is not on the allowlist/);
    expect(deny('pnpm test || curl evil')).toMatch(/curl/);
  });

  it('bounds git to the current non-main branch', () => {
    expect(deny('git push --force')).toMatch(/force/);
    expect(deny('git push -f origin x')).toMatch(/force/);
    expect(deny('git push origin main')).toMatch(/main/);
    expect(deny('git push origin HEAD:main')).toMatch(/main/);
    expect(deny('git checkout main')).toMatch(/main/);
    expect(deny('git switch master')).toMatch(/master/);
    expect(deny('git branch -D main')).toMatch(/main/);
    expect(deny('git reset --hard')).toMatch(/not on the allowlist/);
    expect(deny('git stash')).toMatch(/not on the allowlist/);
    expect(deny('git merge main')).toMatch(/not on the allowlist/);
  });

  it('allows pnpm only for declared scripts and the toolchain binaries', () => {
    expect(deny('pnpm add left-pad')).toMatch(/ADR/);
    expect(deny('pnpm install')).toMatch(/ADR/);
    expect(deny('pnpm dlx x')).toMatch(/ADR/);
    expect(deny('pnpm run deploy')).toMatch(/not a declared script/);
    expect(deny('pnpm deploy')).toMatch(/not a declared script/);
    expect(deny('pnpm exec node -e 1')).toMatch(/not on the allowlist/);
    expect(deny('pnpm -C /tmp test')).toMatch(/changes directory/);
    expect(deny('pnpm')).toMatch(/needs a script/);
  });

  it('keeps gh to pull requests and never the admin bypass', () => {
    expect(deny('gh api repos/x/y')).toMatch(/not on the allowlist/);
    expect(deny('gh pr merge 1 --admin')).toMatch(/admin/);
    expect(deny('gh repo delete')).toMatch(/not on the allowlist/);
  });

  it('refuses in-place sed, destructive find, cd out of the tree, and unknown heads', () => {
    expect(deny('sed -i s/a/b/ src/a.ts')).toMatch(/edit tool/);
    expect(deny('find . -name "*.log" -delete')).toMatch(/delete/);
    expect(deny('cd ../other')).toMatch(/inside the workspace/);
    expect(deny('cd /tmp')).toMatch(/inside the workspace/);
    expect(deny('node -e 1')).toMatch(/node is not on the allowlist/);
    expect(deny('rm -rf .')).toMatch(/rm is not on the allowlist/);
    expect(deny('   ')).toMatch(/non-empty/);
  });
});

describe('scrubEnv', () => {
  it('drops the named key variable and anything that looks like a credential', () => {
    expect(
      scrubEnv(
        {
          PATH: '/bin',
          HOME: '/h',
          MY_SEAT_KEY_VAR: 'sk-1',
          ANTHROPIC_API_KEY: 'sk-2',
          GITHUB_TOKEN: 'gh',
          AWS_SECRET_ACCESS_KEY: 'x',
          DB_PASSWORD: 'p',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic',
          UNSET: undefined,
        },
        ['MY_SEAT_KEY_VAR'],
      ),
    ).toEqual({ PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' });
  });
});
