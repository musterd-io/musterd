import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * The resident seat's jail (ADR 588 §4): deterministic, at the tool, no unjailed mode. Two pure
 * verdicts the working tools and the engine's preflight both consult:
 *
 * - {@link jailPath}: a path the model named must `realpath` inside the seat's workspace. The
 *   deepest EXISTING ancestor is resolved, so a symlink anywhere on the way out is caught, and a
 *   file that does not exist yet (a write) is judged by where it would land.
 * - {@link bashAllowed}: a bash line is split at its operators and every segment's parsed command
 *   head must be on the allowlist — the repo's declared scripts under `pnpm`, `pnpm exec` of the
 *   toolchain binaries, a git subset bounded to the current non-main branch, `gh pr`, the seat
 *   half of `musterd`, and read-only coreutils. Every ARGUMENT is confined too (nothing absolute,
 *   `~`, `..`, `.musterd/`, `.git/`, or resolving outside through a symlink), and the flags that
 *   turn a reader into a writer or an executor (`rg --pre`, `sort -o`, `find -fprint*`, `git -c`,
 *   `sed` scripts beyond a line-range print, …) are denied per binary — the findings wallow, fifty
 *   and miley filed on #2554. Shell features that smuggle a second command (substitution, any `$`,
 *   redirects, backgrounding) are refused outright rather than parsed.
 *
 *   This is a filesystem and process boundary for the SHELL. Code the seat writes into its
 *   workspace and then runs under `pnpm test` executes as the host user by design — that is the
 *   job of a worker seat — and the durable answer to that is an OS sandbox around the bash child,
 *   which is a follow-up lane under the security goal, not this allowlist.
 *
 * Denials are reasons, never throws — the caller turns a reason into a blocked tool call the
 * model sees and the `wake_turns` row records.
 */

export type JailVerdict = { ok: true; path: string } | { ok: false; reason: string };

export interface JailFsDeps {
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/** Files no working tool may write: the seat's credentials and git's own state. */
const WRITE_DENIED = ['.musterd', '.git'];

export function jailPath(
  workspace: string,
  requested: string,
  opts: { write?: boolean } = {},
  deps: JailFsDeps = {},
): JailVerdict {
  // `.native` canonicalises case on APFS/NTFS (`.HIDDEN/x` is `.hidden/x`); the JS realpath keeps the
  // caller's spelling. A path that does not exist yet keeps its spelling either way, so the
  // protected names below are also compared case-insensitively.
  const realpath = deps.realpath ?? realpathSync.native;
  const exists = deps.exists ?? existsSync;
  let root: string;
  try {
    root = realpath(workspace);
  } catch {
    return { ok: false, reason: `workspace ${workspace} does not resolve` };
  }
  if (typeof requested !== 'string' || requested.length === 0) {
    return { ok: false, reason: 'path must be a non-empty string' };
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  // Walk up to the deepest existing ancestor, resolve it for real, then re-append the tail.
  const tail: string[] = [];
  let probe = candidate;
  while (!exists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  let real: string;
  try {
    real = realpath(probe);
  } catch {
    return { ok: false, reason: `${requested} does not resolve` };
  }
  const resolved = tail.length > 0 ? join(real, ...tail) : real;
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, reason: `${requested} resolves outside the workspace` };
  }
  const relative = resolved === root ? '' : resolved.slice(root.length + 1);
  const head = (relative.split(sep)[0] ?? '').toLowerCase();
  if (opts.write && WRITE_DENIED.includes(head)) {
    return { ok: false, reason: `${head}/ is not writable by a working tool` };
  }
  if (relative.toLowerCase() === join('.musterd', 'binding.json')) {
    return { ok: false, reason: '.musterd/binding.json holds the seat’s credentials' };
  }
  return { ok: true, path: resolved };
}

export interface BashPolicy {
  /** The repo's declared `package.json` scripts — the one source of what `pnpm <x>` may run. */
  scripts: ReadonlySet<string>;
  /** The filesystem half of the argument check: for a token that names an EXISTING path relative
   *  to the workspace, whether it resolves (through symlinks) inside the workspace. `undefined`
   *  means "not a path here" and the token is judged on its text alone. Absent ⇒ text only. */
  pathOk?: (token: string) => boolean | undefined;
}

export type BashVerdict = { ok: true } | { ok: false; reason: string };

const READERS = new Set([
  'cat',
  'printenv',
  'cut',
  'date',
  'diff',
  'echo',
  'file',
  'grep',
  'head',
  'ls',
  'printf',
  'pwd',
  'rg',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'true',
  'uniq',
  'wc',
  'which',
]);
const PNPM_EXEC = new Set(['prettier', 'tsc', 'vitest', 'eslint']);
const PNPM_DENIED = new Set([
  'add',
  'dlx',
  'install',
  'link',
  'publish',
  'remove',
  'setup',
  'unlink',
  'update',
  'i',
]);
const GIT = new Set([
  'add',
  'blame',
  'branch',
  'checkout',
  'commit',
  'diff',
  'fetch',
  'log',
  'ls-files',
  'push',
  'rebase',
  'remote',
  'restore',
  'rev-parse',
  'show',
  'status',
  'switch',
]);
/** The seat-shaped half of the musterd CLI — never service, residency, team, host or human admin. */
const MUSTERD = new Set([
  'board',
  'claim',
  'goal',
  'help',
  'inbox',
  'insight',
  'lane',
  'memory',
  'next',
  'report',
  'send',
  'session',
  'standup',
  'status',
  'whoami',
]);
/** Flags that make a reader execute or write (wallow, fifty, miley on #2554). */
const FLAG_DENIED: Record<string, RegExp> = {
  // rg skips hidden directories unless told not to: `--hidden`, `-.`, `-u`/`-uu` and `--no-ignore*`
  // walk into .musterd and .git.
  rg: /^--pre|^--hostname-bin|^-f$|^--file(=|$)|^--hidden$|^--unrestricted$|^--no-ignore|^-[a-zA-Z]*[.u]/,
  // grep -r/-R/-d recurse into whatever directory it is given, .musterd included.
  grep: /^-f$|^--file(=|$)|^--recursive$|^--dereference-recursive$|^--directories(=|$)|^-[a-zA-Z]*[rRd]/,
  sort: /^-o$|^--output(=|$)|^-o./,
  find: /^-f(print|print0|printf|ls)$|^-(exec|execdir|ok|okdir|delete)$|^-D$/,
  diff: /^--output(=|$)|^--to-file(=|$)|^--from-file(=|$)|^--recursive$|^-[a-zA-Z]*r/,
  tail: /^--pid(=|$)/,
  stat: /^--printf(=|$)|^-c$/,
  // -R/--repo retargets a pull request command at any repository the token can reach.
  gh: /^--admin$|^--hostname(=|$)|^-R|^--repo(=|$)/,
  pnpm: /^-C$|^--dir(=|$)|^--config(=|$)|^--store-dir(=|$)|^--workspace-root$/,
};
/** git options that execute, reconfigure, or retarget the repository — anywhere on the line. */
const GIT_DENIED =
  /^-c$|^-c=|^-C$|^-x$|^--exec(=|$)|^--exec-path|^--upload-pack|^--receive-pack|^--ext-diff|^--textconv|^--config-env|^--git-dir|^--work-tree|^--output(=|$)|^--namespace|^--super-prefix|^-p$|^--paginate/;
/** The sed scripts a reader may run: line-address prints only (`sed -n 1,20p`). */
const SED_SCRIPT = /^[0-9]+(,([0-9]+|\$))?p$|^\$p$/;
const GH_PR = new Set([
  'checks',
  'comment',
  'create',
  'edit',
  'list',
  'merge',
  'ready',
  'status',
  'view',
]);
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/** Shell features that carry a second command or a write the allowlist cannot see. */
const SMUGGLERS: [RegExp, string][] = [
  [/`/, 'backticks'],
  [/\$/, 'variable expansion'],
  [/[<>]/, 'redirection'],
  [/[\r\n]/, 'newlines'],
  [/(^|[^&])&([^&]|$)/, 'backgrounding'],
];

/** Only unquoted, unescaped text can expand into different arguments in the shell. */
function hasArgumentExpansion(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === quote) quote = null;
    } else if (c === '\\') {
      // In double quotes a backslash only escapes the shell's special characters.
      if (quote === null || /[\\"$`\n]/.test(command[i + 1] ?? '')) i++;
    } else if (quote === '"') {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if ('*?[{'.includes(c)) {
      return true;
    }
  }
  return false;
}

/** A minimal POSIX-ish word splitter: quotes group, backslash escapes, nothing expands. */
export function splitWords(segment: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      has = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** `git push` shapes that reach past the seat's own branch (ADR 675 review). */
const PUSH_DENIED_FLAGS = new Set([
  '--all',
  '--mirror',
  '--tags',
  '--follow-tags',
  '--delete',
  '--prune',
  '--push-option',
  '-o',
  '--branches',
]);

function denyGit(words: string[]): string | undefined {
  const sub = words[1];
  if (sub === undefined || !GIT.has(sub)) return `git ${sub ?? ''} is not on the allowlist`.trim();
  const rest = words.slice(2);
  const bad = words.slice(1).find((w) => GIT_DENIED.test(w));
  if (bad) return `git ${bad} executes, reconfigures or retargets the repository`;
  if (sub === 'push') {
    if (rest.some((w) => w === '--force' || w === '-f' || /^-[a-zA-Z]*f/.test(w)))
      return 'git push --force is never allowed (use --force-with-lease)';
    if (rest.some((w) => /(^|[/:])(main|master)$/.test(w)))
      return 'git push to main is never allowed';
    // ADR 675 (review): with origin on GitHub the push surface is the seat's own branch, by
    // name or as the current branch — never every ref, tags, a deletion, a forced refspec, or
    // a refspec that lands somewhere else.
    const wide = rest.find(
      (w) =>
        PUSH_DENIED_FLAGS.has(w) ||
        /^-[a-zA-Z]*d[a-zA-Z]*$/.test(w) ||
        w.startsWith('+') ||
        w.includes(':'),
    );
    if (wide)
      return `git push ${wide} is not allowed — push the current branch by name only (no --all, --mirror, --tags, --delete, --prune, or src:dst refspecs)`;
  }
  if (sub === 'checkout' || sub === 'switch' || sub === 'branch') {
    if (rest.some((w) => PROTECTED_BRANCHES.has(w)))
      return `git ${sub} ${rest.find((w) => PROTECTED_BRANCHES.has(w))!} is never allowed`;
  }
  return undefined;
}

function denyPnpm(words: string[], policy: BashPolicy): string | undefined {
  const rest = words.slice(1);
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith('-')) {
    const flag = rest[i]!;
    if (flag === '-C' || flag.startsWith('--dir')) return 'pnpm -C changes directory';
    if (flag === '--filter' || flag === '-F') i += 2;
    else i += 1;
  }
  const sub = rest[i];
  if (sub === undefined) return 'pnpm needs a script';
  if (PNPM_DENIED.has(sub)) return `pnpm ${sub} is not allowed (dependencies need an ADR)`;
  if (sub === 'exec') {
    const bin = rest[i + 1];
    if (bin === undefined || !PNPM_EXEC.has(bin))
      return `pnpm exec ${bin ?? ''} is not on the allowlist`.trim();
    return undefined;
  }
  if (sub === 'run') {
    const script = rest[i + 1];
    if (script === undefined || !policy.scripts.has(script))
      return `pnpm run ${script ?? ''} is not a declared script`.trim();
    return undefined;
  }
  if (PNPM_EXEC.has(sub) || policy.scripts.has(sub)) return undefined;
  return `pnpm ${sub} is not a declared script`;
}

/**
 * Every argument is confined, whatever the command: nothing absolute, nothing under `~`, no `..`
 * segment, nothing under `.musterd/` or `.git/` (the seat's credentials and git's own state are
 * the tools' business, not the shell's), and — when the policy can look — nothing that exists and
 * resolves outside the workspace through a symlink. Flags are text; `--flag=value` values are
 * judged too.
 */
function denyArgument(token: string, policy: BashPolicy): string | undefined {
  let value =
    token.startsWith('--') && token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
  if (value.startsWith('-') && value === token) {
    // A single-dash token can carry its value joined on (`-F.musterd/binding.json`, `-rf../x`): the
    // letters are the flags, whatever follows them is a path to judge. `--long` flags and bare
    // `-x` / `-n10` / `-5` have no remainder and stay text.
    if (token.startsWith('--')) return undefined;
    const rest = token.replace(/^-[a-zA-Z0-9]*/, '').replace(/^=/, '');
    if (rest === '' || !(/[/~]|\.\./.test(rest) || rest.startsWith('.'))) return undefined;
    value = rest;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined; // a URL, not a path
  if (value.startsWith('/') || value.startsWith('~')) return `${token} leaves the workspace`;
  // Case-insensitive: on APFS `.MUSTERD/binding.json` is the same file as `.musterd/binding.json`.
  const segments = value.toLowerCase().split(/[\\/]/);
  if (segments.includes('..')) return `${token} leaves the workspace`;
  if (segments.includes('.musterd')) return `${token} is under .musterd/ (the seat's own state)`;
  if (segments.includes('.git') && segments.length > 1) return `${token} is under .git/`;
  if (policy.pathOk && policy.pathOk(value) === false)
    return `${token} resolves outside the workspace`;
  return undefined;
}

function denySegment(words: string[], policy: BashPolicy): string | undefined {
  const head = words[0];
  if (head === undefined) return 'empty command';
  for (const w of words.slice(1)) {
    const reason = denyArgument(w, policy);
    if (reason) return reason;
  }
  const flagRule = FLAG_DENIED[head];
  if (flagRule) {
    const bad = words.slice(1).find((w) => flagRule.test(w));
    if (bad) return `${head} ${bad} executes or writes; not allowed`;
  }
  if (head === 'cd') {
    // `cd --`, `cd -P`, `cd -L` and `cd -` take no path and land in HOME or OLDPWD.
    const targets = words.slice(1).filter((w) => !w.startsWith('-'));
    if (targets.length !== 1) return 'cd needs exactly one path inside the workspace';
    return undefined;
  }
  if (head === 'sed') {
    const args = words.slice(1);
    const scripts = args.filter((w) => !w.startsWith('-') && SED_SCRIPT.test(w));
    const flags = args.filter((w) => w.startsWith('-'));
    const files = args.filter((w) => !w.startsWith('-') && !SED_SCRIPT.test(w));
    if (scripts.length !== 1 || flags.some((f) => f !== '-n') || files.length === 0)
      return 'sed may only print a line range (`sed -n 1,20p <file>`); use the read/edit tools otherwise';
    return undefined;
  }
  if (READERS.has(head) || head === 'find') return undefined;
  if (head === 'musterd') {
    const sub = words[1];
    if (sub === undefined || !MUSTERD.has(sub))
      return `musterd ${sub ?? ''} is not a seat command`.trim();
    return undefined;
  }
  if (head === 'pnpm') return denyPnpm(words, policy);
  if (head === 'git') return denyGit(words);
  if (head === 'gh') {
    if (words[1] !== 'pr' || words[2] === undefined || !GH_PR.has(words[2]))
      return `gh ${words.slice(1, 3).join(' ')} is not on the allowlist`.trim();
    return undefined;
  }
  return `${head} is not on the allowlist`;
}

/**
 * The bash verdict. Splits at `&&`, `||`, `;` and `|`; every segment's head must be allowed. A
 * quoted operator is split too — the policy is deny-safe: a legitimate `grep "a|b"` fails closed
 * and the model is told why, which beats a parser that could be argued with.
 */
export function bashAllowed(command: string, policy: BashPolicy): BashVerdict {
  if (typeof command !== 'string' || command.trim().length === 0)
    return { ok: false, reason: 'command must be a non-empty string' };
  for (const [re, what] of SMUGGLERS) {
    if (re.test(command)) return { ok: false, reason: `${what} are not allowed in bash` };
  }
  if (hasArgumentExpansion(command))
    return { ok: false, reason: 'unquoted argument expansion is not allowed in bash' };
  const segments = command.split(/\|\||&&|;|\|/);
  for (const segment of segments) {
    const words = splitWords(segment.trim());
    const reason = denySegment(words, policy);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

/** Names that must never reach a bash child: the operator's key variable and anything that looks
 *  like a credential. The gateway forwards the key; a shell has no business seeing it. */
export function scrubEnv(
  env: Record<string, string | undefined>,
  secretNames: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const deny = new Set(secretNames);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (deny.has(k)) continue;
    if (/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|_AUTH\b|AUTH_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
