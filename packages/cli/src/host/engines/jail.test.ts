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

  it('compares the protected names case-insensitively: on APFS .MUSTERD is .musterd', () => {
    for (const p of ['.MUSTERD/binding.json', '.Musterd/Binding.JSON'])
      expect(jailPath('/real/ws', p, {}, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '.MUSTERD/skill/x.md', { write: true }, fs).ok).toBe(false);
    expect(jailPath('/real/ws', '.GIT/hooks/pre-commit', { write: true }, fs).ok).toBe(false);
    expect(jailPath('/real/ws', 'src/.MusterD/x', {}, fs).ok).toBe(true); // only the top-level names
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
  it.each(['cat s?c/a.txt', 'cat s[c]c/a.txt', 'cat src/*', 'cat s{rc,pec}/a.txt', 'echo "safe"*'])(
    'refuses unquoted expansion in %s',
    (command) => {
      expect(deny(command)).toMatch(/expansion/);
    },
  );

  it.each([
    String.raw`find src -name '*.ts'`,
    String.raw`echo "*?[{"`,
    String.raw`echo \*\?\[\{`,
    String.raw`echo 'a"*'`,
    String.raw`echo "a\"*"`,
  ])('preserves literal patterns in %s', (command) => {
    expect(bashAllowed(command, policy)).toEqual({ ok: true });
  });

  it('ADR 605: the seat cannot read its own key from the Keychain', () => {
    expect(bashAllowed('security find-generic-password -s musterd:SEAT_KEY -w', policy).ok).toBe(
      false,
    );
  });

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
      'rg -n "foo" src ; wc -l src/a.ts',
      'cd packages/cli && pnpm test',
      'sed -n 1,20p src/a.ts',
      'musterd inbox',
      'find src -name "*.ts"',
      'printenv PATH',
      'gh pr create --title "x" --body "see https://github.com/x/y"',
    ]) {
      expect(bashAllowed(cmd, policy)).toEqual({ ok: true });
    }
  });

  it('refuses every smuggler: substitution, redirection, backgrounding, newlines', () => {
    expect(deny('echo $(cat /etc/passwd)')).toMatch(/expansion/);
    expect(deny('echo `id`')).toMatch(/backticks/);
    expect(deny('cat a > b')).toMatch(/redirection/);
    expect(deny('cat < a')).toMatch(/redirection/);
    expect(deny('sleep 10 &')).toMatch(/backgrounding/);
    expect(deny('ls\nrm -rf /')).toMatch(/newlines/);
    expect(deny('echo ${HOME}')).toMatch(/expansion/);
    expect(deny('cat $HOME/.musterd/binding.json')).toMatch(/expansion/);
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
    expect(deny('git push origin HEAD:refs/heads/main')).toMatch(/main/);
  });

  it('refuses the git options that execute, reconfigure or retarget — anywhere on the line (miley)', () => {
    expect(deny('git -c core.pager=cat log')).toMatch(/not on the allowlist/);
    expect(deny('git log -c')).toMatch(/executes, reconfigures/);
    expect(deny('git fetch --upload-pack=evil origin')).toMatch(/executes/);
    expect(deny('git push --receive-pack=evil origin x')).toMatch(/executes/);
    // ADR 675 review: an allowlist — abbreviated long options (`--mir`) are what a deny-list misses.
    for (const c of [
      'git push --all origin',
      'git push --mirror origin',
      'git push --mir origin',
      'git push --tags',
      'git push --ta',
      'git push origin --delete agent/x',
      'git push origin -d agent/x',
      'git push -o ci.skip origin agent/x',
      'git push --prune origin',
    ])
      expect(deny(c), c).toMatch(/is not allowed — only -u/);
    for (const c of [
      'git push origin +HEAD:agent/x',
      'git push origin HEAD:refs/heads/other',
      'git push origin :agent/x',
      'git push origin refs/heads/agent/x',
    ])
      expect(deny(c), c).toMatch(/no refspecs/);
    expect(deny('git push upstream agent/x')).toMatch(/origin only/);
    expect(deny('git push origin agent/x extra')).toMatch(/at most a remote/);
    expect(bashAllowed('git push -u origin agent/pilot-2', policy).ok).toBe(true);
    expect(bashAllowed('git push --force-with-lease origin agent/pilot-2', policy).ok).toBe(true);
    expect(bashAllowed('git push --force-with-lease=agent/x:abc', policy).ok).toBe(true);
    // Bound to the seat's branch when the policy names it.
    const own = { ...policy, branch: 'agent/pilot-2' };
    expect(bashAllowed('git push -u origin agent/pilot-2', own).ok).toBe(true);
    expect(bashAllowed('git push origin HEAD', own).ok).toBe(true);
    expect(bashAllowed('git push', own).ok).toBe(true);
    expect((bashAllowed('git push origin agent/other', own) as { reason: string }).reason).toMatch(
      /only this seat’s branch agent\/pilot-2/,
    );
    expect(deny('git rebase -x "rm -rf ." origin/main')).toMatch(/executes/);
    expect(deny('git rebase --exec evil origin/main')).toMatch(/executes/);
    expect(deny('git diff --ext-diff')).toMatch(/executes/);
    expect(deny('git --git-dir=/tmp/x status')).toMatch(/leaves the workspace/);
    expect(deny('git --git-dir=x status')).toMatch(/not on the allowlist/);
    expect(deny('git log --output=/tmp/x')).toMatch(/leaves the workspace|executes/);
  });

  it('confines every argument: absolute, ~, .., .musterd/, .git/ (wallow, fifty)', () => {
    expect(deny('cat ~/.musterd/binding.json')).toMatch(/leaves the workspace/);
    expect(deny('cat /etc/passwd')).toMatch(/leaves the workspace/);
    expect(deny('cat ../../other/.env')).toMatch(/leaves the workspace/);
    expect(deny('cat .musterd/binding.json')).toMatch(/\.musterd/);
    expect(deny('cat .git/config')).toMatch(/\.git/);
    expect(deny('ls --color=auto /tmp')).toMatch(/leaves the workspace/);
    expect(deny('gh pr create --body-file /tmp/body.md')).toMatch(/leaves the workspace/);
  });

  it('keeps the gh credential out of reach (ADR 675): no gh auth, no git credential, no HOME reads', () => {
    // The entrypoint signs gh in under $HOME/.config/gh and sets git's credential helper; the
    // seat's git and gh use it, the shell cannot read or print it through any allowed head.
    expect(deny('gh auth token')).toMatch(/not on the allowlist/);
    expect(deny('gh auth status')).toMatch(/not on the allowlist/);
    expect(deny('git credential fill')).toMatch(/not on the allowlist/);
    expect(deny('git config --global credential.helper')).toMatch(/not on the allowlist/);
    expect(deny('cat ~/.config/gh/hosts.yml')).toMatch(/leaves the workspace|~/);
    expect(deny('cat ../../../.config/gh/hosts.yml')).toMatch(/leaves the workspace/);
    expect(deny('pnpm exec vitest run --config /tmp/v.ts')).toMatch(/leaves the workspace/);
    expect(bashAllowed('cat README.md .gitignore packages/cli/src/a.ts', policy)).toEqual({
      ok: true,
    });
  });

  it('asks the filesystem about existing paths and refuses one that resolves outside', () => {
    const fsPolicy = {
      ...policy,
      pathOk: (t: string) => (t === 'escape' ? false : t === 'src' ? true : undefined),
    };
    expect(bashAllowed('cat escape/secret', fsPolicy).ok).toBe(true); // only the exact token is asked
    expect(bashAllowed('ls escape', fsPolicy)).toEqual({
      ok: false,
      reason: 'escape resolves outside the workspace',
    });
    expect(bashAllowed('ls src', fsPolicy)).toEqual({ ok: true });
  });

  it('denies the flags that turn a reader into an executor or a writer (fifty, miley)', () => {
    expect(deny('rg --pre evil pattern src')).toMatch(/executes or writes/);
    expect(deny('rg "--pre-glob=*" pattern')).toMatch(/executes or writes/);
    expect(deny('sort -o out.txt a.txt')).toMatch(/executes or writes/);
    expect(deny('find . -fprint out.txt')).toMatch(/executes or writes/);
    expect(deny('find . -fls out.txt')).toMatch(/executes or writes/);
    expect(deny('diff --output=o a b')).toMatch(/executes or writes/);
    expect(deny("sed 'e id' a.txt")).toMatch(/line range/);
    expect(deny("sed 'w out.txt' a.txt")).toMatch(/line range/);
    expect(deny("sed -n '1,5p;w out' a.txt")).toMatch(/line range/);
    expect(deny('sed -E s/a/b/ a.txt')).toMatch(/line range/);
    expect(deny('sed -n 1,20p')).toMatch(/line range/);
    expect(bashAllowed('sed -n 1,20p a.txt', policy)).toEqual({ ok: true });
    expect(bashAllowed('sed -n 3p a.txt', policy)).toEqual({ ok: true });
  });

  it('refuses .MUSTERD/ and .GIT/ in an argument too (APFS is case-insensitive)', () => {
    expect(deny('cat .MUSTERD/binding.json')).toMatch(/\.musterd/);
    expect(deny('cat src/.Musterd/binding.json')).toMatch(/\.musterd/);
    expect(deny('cat .GIT/config')).toMatch(/\.git/);
  });

  it('refuses the recursive readers that walk into .musterd and .git', () => {
    for (const c of [
      'grep -r x .',
      'grep -R x .',
      'grep -rn x .',
      'grep -nr x .',
      'grep --recursive x .',
      'grep --directories=recurse x .',
      'grep -d recurse x .',
      'rg --hidden x .',
      'rg -. x .',
      'rg -u x .',
      'rg -uu x .',
      'rg --no-ignore x .',
      'rg --no-ignore-vcs x .',
      'diff -r . copy',
      'diff -ru a b',
      'diff --recursive a b',
    ])
      expect(deny(c), c).toMatch(/executes or writes/);
    expect(bashAllowed('grep -n needle src/a.ts', policy)).toEqual({ ok: true });
    expect(bashAllowed('rg -n needle src', policy)).toEqual({ ok: true });
    expect(bashAllowed('diff a.txt b.txt', policy)).toEqual({ ok: true });
  });

  it('judges the value joined onto a short flag as a path', () => {
    for (const c of [
      'gh pr create -F.musterd/binding.json',
      'git commit -F.musterd/binding.json',
      'git commit -aF.musterd/binding.json',
      'gh pr create -F/etc/passwd',
      'git commit -F~/x',
      'git commit -F../x',
      'git commit -F=.musterd/binding.json',
      'git commit -F.git/config',
    ])
      expect(deny(c), c).toMatch(/\.musterd|\.git|leaves the workspace/);
    expect(bashAllowed('git log -n5 --oneline', policy)).toEqual({ ok: true });
    expect(bashAllowed('head -n10 README.md', policy)).toEqual({ ok: true });
    expect(bashAllowed('git commit -m x', policy)).toEqual({ ok: true });
  });

  it('cd takes exactly one path: `cd --`, `-P`, `-L` and `-` land in HOME or OLDPWD', () => {
    for (const c of ['cd --', 'cd -P', 'cd -L', 'cd -', 'cd -- -P', 'cd a b'])
      expect(deny(c), c).toMatch(/exactly one path/);
    expect(bashAllowed('cd src', policy)).toEqual({ ok: true });
    expect(bashAllowed('cd -P src', policy)).toEqual({ ok: true });
    expect(bashAllowed('cd -- src', policy)).toEqual({ ok: true });
  });

  it('keeps gh to the repository it was started in: -R and --repo are refused', () => {
    expect(deny('gh pr view 1 -R other/repo')).toMatch(/executes or writes/);
    expect(deny('gh pr view 1 -Rother/repo')).toMatch(/leaves the workspace/);
    expect(deny('gh pr view 1 --repo other/repo')).toMatch(/executes or writes/);
    expect(deny('gh pr view 1 --repo=other/repo')).toMatch(/executes or writes/);
    expect(bashAllowed('gh pr view 1', policy)).toEqual({ ok: true });
  });

  it('keeps musterd to the seat half of the CLI', () => {
    expect(deny('musterd residency on --harness musterd')).toMatch(/not a seat command/);
    expect(deny('musterd team grant list')).toMatch(/not a seat command/);
    expect(deny('musterd service refresh')).toMatch(/not a seat command/);
    expect(deny('musterd')).toMatch(/not a seat command/);
    expect(
      bashAllowed('musterd lane submit --pr 12 && musterd send --act status_update x', policy),
    ).toEqual({ ok: true });
  });

  it('allows pnpm only for declared scripts and the toolchain binaries', () => {
    expect(deny('pnpm add left-pad')).toMatch(/ADR/);
    expect(deny('pnpm install')).toMatch(/ADR/);
    expect(deny('pnpm dlx x')).toMatch(/ADR/);
    expect(deny('pnpm run deploy')).toMatch(/not a declared script/);
    expect(deny('pnpm deploy')).toMatch(/not a declared script/);
    expect(deny('pnpm exec node -e 1')).toMatch(/not on the allowlist/);
    expect(deny('pnpm -C /tmp test')).toMatch(/leaves the workspace/);
    expect(deny('pnpm -C packages/cli test')).toMatch(/executes or writes/);
    expect(deny('pnpm')).toMatch(/needs a script/);
  });

  it('keeps gh to pull requests and never the admin bypass', () => {
    expect(deny('gh api repos/x/y')).toMatch(/not on the allowlist/);
    expect(deny('gh pr merge 1 --admin')).toMatch(/admin/);
    expect(deny('gh repo delete')).toMatch(/not on the allowlist/);
  });

  it('refuses in-place sed, destructive find, cd out of the tree, and unknown heads', () => {
    expect(deny('sed -i s/a/b/ src/a.ts')).toMatch(/line range/);
    expect(deny('find . -name "*.log" -delete')).toMatch(/executes or writes/);
    expect(deny('cd ../other')).toMatch(/leaves the workspace/);
    expect(deny('cd /tmp')).toMatch(/leaves the workspace/);
    expect(deny('cd')).toMatch(/exactly one path/);
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
