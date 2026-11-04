/**
 * ADR 803 — the paths a shell command writes, read out of the command when it says them plainly.
 *
 * ADR 150's Gate A matches the path a file tool names. A `Bash` call named no path, so a shell write
 * to a `block`-class file went past the gate unweighed. {@link bashWriteTargets} gives the gate the
 * paths: the file of a redirect, the file operands of `tee`, `sed -i`, `perl -i`, `truncate`, `touch`
 * and `rm`, the last operand of `cp`, `mv`, `install` and `ln` (and the sources of `mv`, which it
 * removes), and the path operands of `git checkout -- …`, `git restore`, `git rm` and `git mv`.
 *
 * A command whose writes it cannot read is **opaque**: an inline interpreter (`python -c`, `node -e`),
 * a heredoc or a script file fed to an interpreter, `eval`, `xargs`, `find -exec`/`-delete`, a
 * formatter or codemod, a substitution, a variable or a glob in a target, and the writing commands
 * whose targets are not on the command line (`patch`, `git apply`, `npm install`, …). The gate never
 * denies on a guess: an opaque call gets an advisory before it and a work-tree check after it.
 *
 * Like `isWriteShaped`, this is a heuristic on a command string. It induces a cooperating seat; it is
 * not a boundary against one that sets out to evade it (ADR 658).
 */

/** What {@link bashWriteTargets} read: the plainly named paths, and whether some write was unreadable. */
export interface BashWriteTargets {
  /** Paths the command writes, as written (joined onto a literal `cd` / `git -C` before them). */
  paths: string[];
  /** True when the command may write somewhere these paths do not say. */
  opaque: boolean;
}

export interface BashWriteTargetOptions {
  /** Is this path an existing directory? Lets `cp a.ts dir` name `dir/a.ts`. Absent → only a trailing
   *  `/` or several sources say the destination is a directory. */
  isDirectory?: (path: string) => boolean;
}

/** One word of a simple command, after quote removal. */
interface Word {
  text: string;
  /** Holds an unquoted `$`, a substitution, or an unquoted glob character: not a literal path. */
  dynamic: boolean;
}

type Piece = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

const SEPARATORS = new Set([';', '|', '&', '\n', '(', ')']);

/** Where a word ends, unquoted. */
const METACHAR = /[\s;&|()<>]/;

/**
 * The heredoc tags a line opens: an unquoted `<<` or `<<-`, never `<<<` (a here-string) and never
 * inside a comment. The delimiter is read as bash reads it — the whole word up to an unquoted
 * metacharacter, quotes removed. `ambiguous` when it is not a plain name, quoted wholly or not at
 * all (`<<E"OF"`, `<<'EOF'x`, `<<$X`): then where the body ends is a guess, and the caller treats
 * the command as unread (security review, 2026-11-04).
 */
function heredocTags(line: string): { tags: { tag: string; dash: boolean }[]; ambiguous: boolean } {
  const tags: { tag: string; dash: boolean }[] = [];
  let ambiguous = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      // `"…"` and `$'…'` take backslash escapes; `'…'` does not.
      if (c === '\\' && quote !== "'") i++;
      else if (c === quote || (quote === "$'" && c === "'")) quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
    } else if (c === '$' && line[i + 1] === "'") {
      quote = "$'";
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s|[;&|()]/.test(line[i - 1]!))) {
      break; // a comment: nothing after it opens a heredoc
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] === '<') {
      i += 2; // `<<<`: a here-string, no body follows
    } else if (c === '<' && line[i + 1] === '<') {
      let j = i + 2;
      const dash = line[j] === '-';
      if (dash) j++;
      while (line[j] === ' ' || line[j] === '\t') j++;
      let word = '';
      let quotedParts = 0;
      let plainParts = 0;
      while (j < line.length && !METACHAR.test(line[j]!)) {
        const q = line[j]!;
        if (q === "'" || q === '"') {
          const close = line.indexOf(q, j + 1);
          if (close < 0) {
            ambiguous = true;
            j = line.length;
            break;
          }
          word += line.slice(j + 1, close);
          quotedParts++;
          j = close + 1;
        } else {
          if (q === '\\' || q === '$' || q === '`') ambiguous = true;
          word += q;
          plainParts++;
          j++;
        }
      }
      const clean = quotedParts + (plainParts > 0 ? 1 : 0) === 1;
      if (/^[A-Za-z_][\w-]*$/.test(word) && clean) tags.push({ tag: word, dash });
      else ambiguous = true;
      i = j - 1;
    }
  }
  return { tags, ambiguous };
}

/** Heredoc bodies are data, not commands: drop them (the line with the `<<` stays). `open` when a
 *  body never reaches its tag, or a delimiter is not a plain name — then where the body ends is a
 *  guess, and the caller treats the command as unread. */
function stripHeredocs(command: string): { text: string; open: boolean } {
  const out: string[] = [];
  const pending: { tag: string; dash: boolean }[] = [];
  let ambiguous = false;
  for (const line of command.split('\n')) {
    const head = pending[0];
    if (head) {
      if ((head.dash ? line.replace(/^\t+/, '') : line) === head.tag) pending.shift();
      continue;
    }
    out.push(line);
    const opened = heredocTags(line);
    if (opened.ambiguous) ambiguous = true;
    pending.push(...opened.tags);
  }
  return { text: out.join('\n'), open: ambiguous || pending.length > 0 };
}

/** A redirect operator, read from its first `<`, `>` or `&>` (an fd's digits are the word before it). */
const REDIRECT = /^(?:&>>?|>>?\|?&?|<<<|<<-?|<&?)/;

/**
 * A small POSIX-ish tokenizer: words (quotes removed) and operators (separators and redirects).
 * What it does not model — an unclosed quote, `$(…)`, backticks — marks the word dynamic, so a target
 * holding it is opaque rather than wrong.
 */
function tokenize(command: string): { pieces: Piece[]; unclosed: boolean } {
  const pieces: Piece[] = [];
  // An unclosed quote, substitution or backtick: the rest of the line is not read as written.
  let unclosed = false;
  const n = command.length;
  let i = 0;
  let text = '';
  let dynamic = false;
  let inWord = false;
  const flush = (): void => {
    if (inWord) pieces.push({ kind: 'word', word: { text, dynamic } });
    text = '';
    dynamic = false;
    inWord = false;
  };
  while (i < n) {
    const c = command[i]!;
    if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if (c === '\\' && command[i + 1] === '\n') {
      i += 2;
    } else if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i++;
    } else if (c === '$' && command[i + 1] === "'") {
      // ANSI-C quoting `$'…'`: backslash escapes, closed by an unescaped `'`.
      inWord = true;
      let j = i + 2;
      while (j < n && command[j] !== "'") {
        if (command[j] === '\\' && j + 1 < n) j++;
        text += command[j];
        j++;
      }
      if (j >= n) unclosed = true;
      i = j + 1;
    } else if (c === "'") {
      inWord = true;
      const end = command.indexOf("'", i + 1);
      if (end < 0) unclosed = true;
      text += command.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n) {
          text += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === '$' || command[j] === '`') dynamic = true;
        text += command[j];
        j++;
      }
      if (j >= n) unclosed = true;
      i = j + 1;
    } else if (c === '\\') {
      inWord = true;
      text += command[i + 1] ?? '';
      i += 2;
    } else if (c === '$' && command[i + 1] === '(') {
      // A substitution runs a command of its own: keep the word, mark it unreadable.
      inWord = true;
      dynamic = true;
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      if (j >= n) unclosed = true;
      text += command.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`') {
      inWord = true;
      dynamic = true;
      const end = command.indexOf('`', i + 1);
      if (end < 0) unclosed = true;
      text += command.slice(i, end < 0 ? n : end + 1);
      i = end < 0 ? n : end + 1;
    } else {
      // An unquoted `<` or `>` (or `&>`) is always an operator, even inside a word: `echo x>f`
      // writes `f`. A word made only of digits right before it is the fd (`2>f`), not an argument.
      const m =
        c === '<' || c === '>' || (c === '&' && command[i + 1] === '>')
          ? REDIRECT.exec(command.slice(i))
          : null;
      if (m) {
        if (inWord && !dynamic && /^\d+$/.test(text)) {
          text = '';
          inWord = false;
        }
        flush();
        pieces.push({ kind: 'op', op: m[0] });
        i += m[0].length;
      } else if (/^(?:&&|\|\||\|&)/.test(command.slice(i, i + 2))) {
        flush();
        pieces.push({ kind: 'op', op: command.slice(i, i + 2) });
        i += 2;
      } else if (SEPARATORS.has(c)) {
        flush();
        pieces.push({ kind: 'op', op: c });
        i++;
      } else {
        if ('$*?[{~'.includes(c)) dynamic = true;
        inWord = true;
        text += c;
        i++;
      }
    }
  }
  flush();
  return { pieces, unclosed };
}

/** Interpreters whose program text the gate cannot read. */
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'php',
  'osascript',
  'awk',
  'gawk',
]);
/** Shells: `sh -c '…'` is read as a command line of its own; `sh script.sh` is opaque. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/** Formatters and codemods that rewrite the files they find themselves. */
const REWRITERS = new Set([
  'prettier',
  'eslint',
  'biome',
  'dprint',
  'jscodeshift',
  'ast-grep',
  'sg',
]);
/** Commands that write, with targets not plainly on the command line. */
const UNREAD_WRITERS = new Set(['patch', 'dd', 'unzip', 'tar', 'rsync', 'chmod', 'chown', 'mkdir']);
/** Words that run the rest of the line as the command. */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'timeout']);
/** Package-manager verbs that write files or run a script that may (`pnpm format`, `npm i`). */
const PM_WRITE_VERB =
  /^(?:install|i|add|remove|rm|uninstall|update|up|upgrade|link|unlink|exec|dlx|x)$|(?:^|:)(?:format|fmt|fix|write|codegen|gen|generate)$/;

function basename(word: string): string {
  const k = word.lastIndexOf('/');
  return k < 0 ? word : word.slice(k + 1);
}

function joinPath(dir: string | undefined, p: string): string {
  if (!dir || p.startsWith('/')) return p;
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return base === '.' ? p : `${base}/${p}`;
}

/** Options of a command that take the next word as their value. */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sed: new Set(['-e', '-f', '-l']),
  perl: new Set(['-e', '-E', '-M', '-I', '-m', '-x']),
  truncate: new Set(['-s', '-r']),
  touch: new Set(['-t', '-d', '-r']),
  cp: new Set(['-t', '-S']),
  mv: new Set(['-t', '-S']),
  ln: new Set(['-t', '-S']),
  install: new Set(['-t', '-m', '-o', '-g', '-S']),
};

interface Args {
  flags: string[];
  operands: Word[];
  values: Map<string, Word>;
}

function parseArgs(cmd: string, args: readonly Word[]): Args {
  const valueFlags = VALUE_FLAGS[cmd] ?? new Set<string>();
  const flags: string[] = [];
  const operands: Word[] = [];
  const values = new Map<string, Word>();
  let ended = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (ended || !a.text.startsWith('-') || a.text === '-') {
      operands.push(a);
    } else if (a.text === '--') {
      ended = true;
    } else if (a.text.startsWith('--') && a.text.includes('=')) {
      const eq = a.text.indexOf('=');
      flags.push(a.text.slice(0, eq));
      values.set(a.text.slice(0, eq), { text: a.text.slice(eq + 1), dynamic: a.dynamic });
    } else {
      flags.push(a.text);
      if ((valueFlags.has(a.text) || a.text === '--target-directory') && k + 1 < args.length) {
        values.set(a.text, args[++k]!);
      }
    }
  }
  return { flags, operands, values };
}

/** Collects one command line's targets; `opaque` latches. */
class Reader {
  paths: string[] = [];
  opaque = false;
  constructor(private readonly opts: BashWriteTargetOptions) {}

  target(dir: string | undefined, w: Word | undefined): void {
    if (!w) return;
    if (w.dynamic || w.text.length === 0) {
      this.opaque = true;
      return;
    }
    if (w.text.startsWith('/dev/')) return;
    const p = joinPath(dir, w.text);
    if (!this.paths.includes(p)) this.paths.push(p);
  }

  /** The last operand of cp/mv/install/ln — or each source's name inside it, when it is a directory. */
  copyLike(cmd: string, dir: string | undefined, a: Args): void {
    if (cmd === 'install' && a.flags.includes('-d')) {
      for (const o of a.operands) this.target(dir, o);
      return;
    }
    const tdir = a.values.get('-t') ?? a.values.get('--target-directory');
    const dest = tdir ?? a.operands[a.operands.length - 1];
    const sources = tdir ? a.operands : a.operands.slice(0, -1);
    if (!dest) return;
    // `mv` removes its sources: that is a write to them too.
    if (cmd === 'mv') for (const s of sources) this.target(dir, s);
    if (dest.dynamic) {
      this.opaque = true;
      return;
    }
    const intoDir =
      tdir !== undefined ||
      sources.length > 1 ||
      dest.text.endsWith('/') ||
      (this.opts.isDirectory?.(joinPath(dir, dest.text)) ?? false);
    if (!intoDir) {
      this.target(dir, dest);
      return;
    }
    for (const s of sources) {
      if (s.dynamic) {
        this.opaque = true;
        continue;
      }
      const name = basename(s.text.replace(/\/+$/, ''));
      this.target(dir, { text: joinPath(dest.text, name), dynamic: false });
    }
  }
}

/** One simple command: its words, the files its redirects write, and the directory it runs in. */
function readSimple(
  reader: Reader,
  words: readonly Word[],
  redirects: readonly Word[],
  dir: string | undefined,
  depth: number,
): void {
  for (const r of redirects) reader.target(dir, r);
  let k = 0;
  const assignment = (w: Word | undefined): boolean => !!w && /^[A-Za-z_]\w*=/.test(w.text);
  while (assignment(words[k])) k++;
  // Wrappers run the rest of the line; skip their own options (`timeout 5`, `sudo -u x`, `env -i`).
  while (k < words.length && WRAPPERS.has(basename(words[k]!.text))) {
    const w = basename(words[k]!.text);
    k++;
    while (k < words.length && words[k]!.text.startsWith('-')) {
      k += w === 'sudo' && /^-[ugCh]$/.test(words[k]!.text) ? 2 : 1;
    }
    if (w === 'timeout' && /^\d/.test(words[k]?.text ?? '')) k++;
    while (assignment(words[k])) k++;
  }
  const head = words[k];
  if (!head) return;
  if (head.dynamic) {
    reader.opaque = true;
    return;
  }
  const cmd = basename(head.text);
  const args = words.slice(k + 1);
  const system = /^\/(?:usr\/(?:local\/)?)?s?bin\//.test(head.text);

  if (head.text.includes('/') && !system) {
    // `./gen.sh`, `scripts/codemod.mjs`: a program the gate cannot read.
    reader.opaque = true;
  } else if (cmd === 'eval' || cmd === 'xargs' || cmd === 'source' || cmd === '.') {
    reader.opaque = true;
  } else if (SHELLS.has(cmd)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
    const inner = c >= 0 ? args[c + 1] : undefined;
    if (inner && depth < 3) {
      if (inner.dynamic) reader.opaque = true;
      readLine(reader, inner.text, dir, depth + 1);
    } else {
      // `bash gen.sh`, or a shell reading its program from a heredoc or stdin.
      reader.opaque = true;
    }
  } else if (cmd === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a.text))) {
    const a = parseArgs('perl', args);
    // `perl -pi -e 's/a/b/' f`: the files are the operands. `perl -pie '…' f` or `perl -i x.pl f`:
    // the first operand is the program.
    const files = a.values.has('-e') || a.values.has('-E') ? a.operands : a.operands.slice(1);
    for (const f of files) reader.target(dir, f);
    if (files.length === 0) reader.opaque = true;
  } else if (INTERPRETERS.has(cmd) || REWRITERS.has(cmd) || UNREAD_WRITERS.has(cmd)) {
    reader.opaque = true;
  } else if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') {
    reader.opaque = true;
  } else if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    const verbs = args.filter((a) => !a.text.startsWith('-')).map((a) => a.text);
    const verb = verbs[0] === 'run' ? verbs[1] : verbs[0];
    if (verb !== undefined && PM_WRITE_VERB.test(verb)) reader.opaque = true;
  } else if (cmd === 'find') {
    if (args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*)$/.test(a.text))) {
      reader.opaque = true;
    }
  } else if (cmd === 'tee' || cmd === 'touch' || cmd === 'rm' || cmd === 'truncate') {
    for (const o of parseArgs(cmd, args).operands) reader.target(dir, o);
  } else if (cmd === 'sed') {
    // BSD `sed -i '' …`: the empty word is the backup suffix, not the script.
    const bsd = args.findIndex((w, j) => w.text === '-i' && args[j + 1]?.text === '');
    const a = parseArgs(
      'sed',
      bsd < 0 ? args : [...args.slice(0, bsd + 1), ...args.slice(bsd + 2)],
    );
    if (!a.flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f === '--in-place')) return;
    const files = a.values.has('-e') || a.values.has('-f') ? a.operands : a.operands.slice(1);
    for (const f of files) reader.target(dir, f);
    if (files.length === 0) reader.opaque = true;
  } else if (cmd === 'cp' || cmd === 'mv' || cmd === 'install' || cmd === 'ln') {
    reader.copyLike(cmd, dir, parseArgs(cmd, args));
  } else if (cmd === 'git') {
    readGit(reader, args, dir);
  }
}

/** Git global options that take a value; `-C <dir>` moves where paths resolve. */
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** Git subcommands that change work-tree files without naming them. */
const GIT_UNREAD = new Set([
  'apply',
  'am',
  'stash',
  'cherry-pick',
  'revert',
  'pull',
  'reset',
  'clean',
  'merge',
  'rebase',
  'switch',
]);

function readGit(reader: Reader, args: readonly Word[], dir: string | undefined): void {
  let k = 0;
  let where = dir;
  while (k < args.length && args[k]!.text.startsWith('-')) {
    const g = args[k]!.text;
    if (g.startsWith('--work-tree')) {
      reader.opaque = true;
      return;
    }
    if (GIT_VALUE_GLOBALS.has(g)) {
      if (g === '-C') {
        const d = args[k + 1];
        if (!d || d.dynamic) {
          reader.opaque = true;
          return;
        }
        where = joinPath(where, d.text);
      }
      k += 2;
    } else {
      k++;
    }
  }
  const sub = args[k]?.text;
  const rest = args.slice(k + 1);
  if (sub === 'checkout') {
    const dd = rest.findIndex((a) => a.text === '--');
    if (dd >= 0) for (const p of rest.slice(dd + 1)) reader.target(where, p);
    // `git checkout x`: a branch or a file — the command does not say which.
    else if (rest.some((a) => !a.text.startsWith('-'))) reader.opaque = true;
  } else if (sub === 'restore' || sub === 'rm' || sub === 'mv') {
    const ops: Word[] = [];
    let ended = false;
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j]!;
      if (!ended && a.text === '--') ended = true;
      else if (!ended && a.text.startsWith('-')) {
        if (a.text.startsWith('--pathspec-from-file')) reader.opaque = true;
        if (a.text === '-s' || a.text === '--source') j++;
      } else ops.push(a);
    }
    if (sub === 'mv') reader.copyLike('mv', where, { flags: [], operands: ops, values: new Map() });
    else for (const p of ops) reader.target(where, p);
  } else if (sub !== undefined && GIT_UNREAD.has(sub)) {
    reader.opaque = true;
  }
}

/** Read one command line: split it into simple commands, follow a literal `cd`, read each. */
function readLine(reader: Reader, command: string, dir: string | undefined, depth: number): void {
  const stripped = stripHeredocs(command);
  if (stripped.open) reader.opaque = true;
  const { pieces, unclosed } = tokenize(stripped.text);
  if (unclosed) reader.opaque = true;
  let cwd = dir;
  let words: Word[] = [];
  let redirects: Word[] = [];
  const end = (): void => {
    const head = words[0];
    if (head && head.text === 'cd' && !head.dynamic) {
      const to = words[1];
      if (!to || to.dynamic || to.text === '-') {
        // `cd`, `cd -`, `cd $X`: from here on, where relative paths land is unknown.
        reader.opaque = true;
        cwd = '\u0000unknown';
      } else {
        cwd = to.text.startsWith('/') ? to.text : joinPath(cwd, to.text);
      }
    } else if (words.length > 0 || redirects.length > 0) {
      if (cwd === '\u0000unknown') reader.opaque = true;
      else readSimple(reader, words, redirects, cwd, depth);
    }
    words = [];
    redirects = [];
  };
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]!;
    const next = pieces[k + 1];
    if (p.kind === 'word') {
      words.push(p.word);
    } else if (p.op.includes('>')) {
      if (next?.kind !== 'word') continue;
      k++;
      // `>&2`, `2>&1`, `>&-`: a descriptor, not a file.
      if (p.op.endsWith('&') && /^(?:\d+|-)$/.test(next.word.text)) continue;
      redirects.push(next.word);
    } else if (p.op.includes('<')) {
      // An input redirect or heredoc reads: skip the word it names.
      if (next?.kind === 'word') k++;
    } else {
      end();
    }
  }
  end();
}

/**
 * The paths a shell command writes (ADR 803 §1), as the command names them, and whether it may write
 * more than it names. Relative paths are joined onto a literal `cd` or `git -C` before them; the
 * caller resolves them against the shell's directory and makes them repo-relative, as it does a file
 * tool's path.
 */
export function bashWriteTargets(
  command: string,
  opts: BashWriteTargetOptions = {},
): BashWriteTargets {
  const reader = new Reader(opts);
  readLine(reader, command, undefined, 0);
  return { paths: reader.paths, opaque: reader.opaque };
}
