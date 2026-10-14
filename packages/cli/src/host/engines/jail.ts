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
 *   three toolchain binaries, a git subset bounded to the current non-main branch, `gh pr`, and
 *   read-only coreutils. Shell features that smuggle a second command (substitution, redirects,
 *   backgrounding) are refused outright rather than parsed.
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
  const realpath = deps.realpath ?? realpathSync;
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
  const head = relative.split(sep)[0] ?? '';
  if (opts.write && WRITE_DENIED.includes(head)) {
    return { ok: false, reason: `${head}/ is not writable by a working tool` };
  }
  if (relative === join('.musterd', 'binding.json')) {
    return { ok: false, reason: '.musterd/binding.json holds the seat’s credentials' };
  }
  return { ok: true, path: resolved };
}

export interface BashPolicy {
  /** The repo's declared `package.json` scripts — the one source of what `pnpm <x>` may run. */
  scripts: ReadonlySet<string>;
}

export type BashVerdict = { ok: true } | { ok: false; reason: string };

const READERS = new Set([
  'cat',
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
  [/\$\(/, 'command substitution'],
  [/\$\{/, 'parameter expansion'],
  [/[<>]/, 'redirection'],
  [/[\r\n]/, 'newlines'],
  [/(^|[^&])&([^&]|$)/, 'backgrounding'],
];

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

function denyGit(words: string[]): string | undefined {
  const sub = words[1];
  if (sub === undefined || !GIT.has(sub)) return `git ${sub ?? ''} is not on the allowlist`.trim();
  const rest = words.slice(2);
  if (sub === 'push') {
    if (rest.some((w) => w === '--force' || w === '-f' || /^-[a-zA-Z]*f/.test(w)))
      return 'git push --force is never allowed (use --force-with-lease)';
    if (rest.some((w) => PROTECTED_BRANCHES.has(w) || /:(main|master)$/.test(w)))
      return 'git push to main is never allowed';
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

function denySegment(words: string[], policy: BashPolicy): string | undefined {
  const head = words[0];
  if (head === undefined) return 'empty command';
  if (head === 'cd') {
    const target = words[1];
    if (target === undefined || isAbsolute(target) || target.split(/[\\/]/).includes('..'))
      return 'cd may only descend inside the workspace';
    return undefined;
  }
  if (head === 'sed') {
    if (words.some((w) => w === '-i' || w.startsWith('-i') || w === '--in-place'))
      return 'sed -i writes in place; use the edit tool';
    return undefined;
  }
  if (head === 'find') {
    if (words.some((w) => w === '-delete' || w === '-exec' || w === '-execdir' || w === '-ok'))
      return 'find may not delete or exec';
    return undefined;
  }
  if (READERS.has(head)) return undefined;
  if (head === 'musterd') return undefined;
  if (head === 'pnpm') return denyPnpm(words, policy);
  if (head === 'git') return denyGit(words);
  if (head === 'gh') {
    if (words[1] !== 'pr' || words[2] === undefined || !GH_PR.has(words[2]))
      return `gh ${words.slice(1, 3).join(' ')} is not on the allowlist`.trim();
    if (words.includes('--admin')) return 'gh pr merge --admin bypasses the gates';
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
