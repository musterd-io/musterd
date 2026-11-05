import { describe, expect, it } from 'vitest';
import { bashWriteTargets } from './bashWrites.js';

const t = (command: string, isDirectory?: (p: string) => boolean) =>
  bashWriteTargets(command, isDirectory ? { isDirectory } : {});

describe('bashWriteTargets (ADR 803 §1)', () => {
  it.each([
    ['echo x > a.ts', ['a.ts']],
    ['echo x >> a.ts', ['a.ts']],
    ['cmd &> log.txt', ['log.txt']],
    ['cmd 2> err.txt', ['err.txt']],
    ['cmd >"spaced name.ts"', ['spaced name.ts']],
    ['echo x | tee a.ts b.ts', ['a.ts', 'b.ts']],
    ['tee -a a.ts < in', ['a.ts']],
    ["sed -i '' 's/a/b/' a.ts", ['a.ts']],
    ["sed -i 's/a/b/' a.ts b.ts", ['a.ts', 'b.ts']],
    ["sed -i.bak -e 's/a/b/' a.ts", ['a.ts']],
    ["perl -pi -e 's/a/b/' a.ts", ['a.ts']],
    ['truncate -s 0 a.ts', ['a.ts']],
    ['touch a.ts', ['a.ts']],
    ['rm -rf build a.ts', ['build', 'a.ts']],
    ['cp x.ts a.ts', ['a.ts']],
    ['cp -r x y dest/', ['dest/x', 'dest/y']],
    ['mv x.ts a.ts', ['x.ts', 'a.ts']],
    ['install -m 644 x a.ts', ['a.ts']],
    ['ln -sf x a.ts', ['a.ts']],
    ['git checkout -- a.ts b.ts', ['a.ts', 'b.ts']],
    ['git checkout main -- a.ts', ['a.ts']],
    ['git restore --staged a.ts', ['a.ts']],
    ['git restore -s HEAD~1 a.ts', ['a.ts']],
    ['git rm -q a.ts', ['a.ts']],
    ['git mv x.ts a.ts', ['x.ts', 'a.ts']],
    ['echo x>a.ts', ['a.ts']],
    ['echo "x">a.ts', ['a.ts']],
    ['echo x>>a.ts', ['a.ts']],
    ['echo x 2>err.txt>a.ts', ['err.txt', 'a.ts']],
    ['cat <<<word > a.ts\necho y > b.ts', ['a.ts', 'b.ts']],
  ])('%s → %j', (command, paths) => {
    expect(t(command)).toEqual({ paths, opaque: false });
  });

  // Any heredoc makes the command opaque (fail closed, 2026-11-04 reviews); its named targets are
  // still read, with bodies dropped, so a deny on one of them still stands.
  it.each([
    ['cat <<EOF > out.ts\nline > not-a-file\nEOF', ['out.ts']],
    ['echo "<<EOF" > a.ts\necho y > b.ts', ['a.ts', 'b.ts']],
    ['echo x # <<EOF\necho y > b.ts', ['b.ts']],
    ['echo "a\n<<EOF" > a.ts\necho y > b.ts', ['a.ts', 'b.ts']],
    ["echo $'it\\'s <<EOF' > a.ts\necho y > b.ts", ['a.ts', 'b.ts']],
    ["cat <<'EOF' > a.ts\nrm -rf x\nEOF\necho y > b.ts", ['a.ts', 'b.ts']],
    ['cat <<-EOF > a.ts\n\tbody\n\tEOF\ntouch b.ts', ['a.ts', 'b.ts']],
    ['cat <<EOF \\\n&& touch a.ts\nEOF', ['a.ts']],
    ['cat <<EOF > a.ts\n${x}\nEOF\ntouch b.ts', ['a.ts', 'b.ts']],
    ['(( n << y )) && touch a.ts\ny\ntouch b.ts', ['a.ts', 'b.ts']],
    ['arr[1<<2]=x; cat <<EOF\nEOF\ntouch a.ts', ['a.ts']],
  ])('heredoc: %s → opaque, %j still named', (command, paths) => {
    const read = t(command);
    expect(read.opaque).toBe(true);
    for (const p of paths) expect(read.paths).toContain(p);
  });

  it('a descriptor redirect and /dev/null write no file', () => {
    expect(t('cmd 2>&1 >/dev/null | grep x >&2')).toEqual({ paths: [], opaque: false });
  });

  it('reads are not writes', () => {
    for (const c of [
      'ls -la',
      'grep -n "> x" a.ts',
      'cat a.ts',
      'git status',
      'sed -n 1,5p a.ts',
    ]) {
      expect(t(c)).toEqual({ paths: [], opaque: false });
    }
  });

  it('follows a literal cd and git -C', () => {
    expect(t('cd packages/protocol && sed -i "s/a/b/" src/x.ts').paths).toEqual([
      'packages/protocol/src/x.ts',
    ]);
    expect(t('git -C sub checkout -- a.ts').paths).toEqual(['sub/a.ts']);
  });

  it('reads every simple command of a chain, and the line inside sh -c', () => {
    expect(t('touch a; echo b > b && rm c || cp d e').paths).toEqual(['a', 'b', 'c', 'e']);
    expect(t(`bash -lc "echo x > a.ts"`)).toEqual({ paths: ['a.ts'], opaque: false });
  });

  it('skips env assignments and wrappers', () => {
    expect(t('FOO=1 sudo -u me env -i touch a.ts').paths).toEqual(['a.ts']);
  });

  it('asks isDirectory whether a single destination is a directory', () => {
    expect(t('cp x.ts out', (p) => p === 'out').paths).toEqual(['out/x.ts']);
  });

  it.each([
    "python3 -c \"open('a.ts','w')\"",
    'node -e "fs.writeFileSync(1)"',
    "python3 - <<'EOF'\nopen('a.ts','w')\nEOF",
    './scripts/gen.sh',
    'bash gen.sh',
    'eval "$CMD"',
    'find . -name x -delete',
    'ls | xargs rm',
    'prettier --write a.ts',
    'pnpm format',
    'pnpm exec eslint --fix .',
    'npm install',
    'npx codemod',
    'patch -p1 < x.diff',
    'git apply x.diff',
    'git stash pop',
    'git checkout a.ts',
    'echo x > $OUT',
    'rm packages/*.ts',
    'echo x > "$(pwd)/a.ts"',
    'cd $DIR && touch a.ts',
    'cat <<EOF > a.ts\nnever closed',
    'cat <<E"OF" > a.ts\nEOF\ntouch b.ts',
    "cat <<'EOF'x > a.ts\nEOF\ntouch b.ts",
    'cat <<$X > a.ts\nbody',
    "echo 'unclosed > a.ts",
    'echo $(touch a.ts > b.ts',
    'x=$((1 << 2)) && touch a.ts',
    '(( n << y )) && touch a.ts\ny',
    '(( n\n<< y )) && touch a.ts\ny',
    'cat <<EOF > a.ts\n${x}\nEOF',
    'cat <<EOF "open\nEOF\ntouch a.ts',
  ])('opaque: %s', (command) => {
    expect(t(command).opaque).toBe(true);
  });

  it('an opaque part does not lose the plainly named ones', () => {
    expect(t('python3 gen.py && echo x > a.ts')).toEqual({ paths: ['a.ts'], opaque: true });
  });
});
