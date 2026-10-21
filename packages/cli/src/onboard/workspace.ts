import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { gitToplevel } from '@musterd/protocol/project';
import { CliError } from '../errors.js';

/**
 * Provision an *isolated workspace* for a new agent (ADR 065). The thrash this avoids: in Claude Code
 * one folder = one `-s local` MCP registration = one identity, so two live agents cannot share a
 * folder — they fight over the single `.musterd/binding.json`. Each agent therefore gets its own
 * working directory. In a git repo that's a **worktree** (own branch + own checked-out tree, so two
 * agents can edit in parallel without colliding); outside git it's a sibling folder.
 */
export type WorkspaceKind = 'here' | 'worktree' | 'folder';

export interface Workspace {
  /** Absolute path the agent's binding + MCP registration will live in. */
  dir: string;
  kind: WorkspaceKind;
  /** The branch checked out in the worktree (worktree kind only). */
  branch?: string;
  /** True when this call created the directory (false when an existing one was reused). */
  created: boolean;
}

function git(args: string[], cwd: string): string {
  // stderr is piped, not inherited: a probe that is expected to fail (no `origin` yet) must not print
  // git's own "error: No such remote" over the onboarding screen. A real failure still carries it,
  // in the thrown error's message.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface WorkspaceOpts {
  /** Bind the current folder instead of making a new one (the legacy single-folder behavior). */
  here?: boolean;
  /** An explicit target directory (created if missing). */
  path?: string;
  /** Base directory to resolve from; defaults to process.cwd(). */
  cwd?: string;
  /** Team slug — used for the seat's synthetic git-identity email domain (ADR 109). */
  team?: string;
  /** The `~` the `~/musterd/<team>/<repo>/<member>` layout hangs off; defaults to `os.homedir()` (tests). */
  home?: string;
  /** The worktree's branch; defaults to `agent/<name>`. */
  branch?: string;
  /**
   * Write the seat's synthetic git identity (ADR 109). Default true; a human's Workspace keeps the
   * person's own git identity — {@link setSeatGitIdentity} is for agent seats only.
   */
  gitIdentity?: boolean;
  /**
   * A full clone of the checkout instead of a `git worktree` (ADR 463 §3, `musterd host --clone`):
   * isolation from the sponsor's own checkout — a worktree shares its object store, refs and
   * hooks config; a clone shares nothing. Only the layout-driven case (a new Workspace named from
   * inside a repo) honours it; `--here` / `--path` are unaffected.
   */
  clone?: boolean;
  /**
   * Start a NEW branch from this commit-ish instead of the checkout's HEAD (ADR 491: a seat set up
   * from the launcher starts at the remote's default branch). Ignored when the branch already exists.
   */
  base?: string;
  /**
   * ADR 675: the URL the clone's `origin` is set to after cloning — the checkout's own remote, so a
   * seat provisioned from a machine's local mirror pushes to GitHub, not into the mirror. Clone
   * only (a worktree shares its checkout's remotes). Absent ⇒ git's default: the clone source.
   */
  origin?: string;
}

/**
 * Where a member's Workspace lives (ADR 447, superseding the ADR 442 layout note):
 * `~/musterd/<team>/<repo>/<member>`. Team outermost, because a member name means one thing only on
 * its team — two teams can share a repo and a name (`revive/agents/dolly`, `other/agents/dolly`)
 * without colliding — and because a team spans repos more often than a repo spans teams. Grouped by
 * repo beneath that, not by member kind (humans and agents alike), and never a sibling of the
 * checkout it was provisioned from, because that checkout may be the unbound runtime
 * (`~/.musterd/runtime`) whose parent must hold no Workspace.
 *
 * `<repo>` is, in order: the group this checkout already sits in when it is itself a member
 * Workspace of the same team (`~/musterd/revive/agents/nick` → `agents`, so a repo keeps one group
 * however its remote is spelled); else the remote's repo name; else the checkout's basename.
 */
export function memberWorkspaceDir(
  top: string,
  name: string,
  team: string,
  home: string = homedir(),
  remote: string | null = null,
): string {
  const roof = join(home, 'musterd');
  const rel = resolvePath(top).startsWith(roof + '/')
    ? resolvePath(top).slice(roof.length + 1)
    : '';
  const segments = rel.split('/');
  const repo =
    segments.length >= 3 && segments[0] === team && segments[1]
      ? segments[1]
      : (remoteRepoName(remote) ?? basename(resolvePath(top)));
  return join(roof, team, repo, name);
}

/** `git@github.com:Org/musterd.git` / `https://…/Org/musterd` → `musterd`; null when unparseable. */
function remoteRepoName(remote: string | null): string | null {
  if (!remote) return null;
  const tail = remote.trim().replace(/\/+$/, '').split(/[/:]/).pop();
  const name = tail?.replace(/\.git$/, '');
  return name ? name : null;
}

/**
 * ADR 675 (review): the origin URL a seat's clone may be handed — never one carrying credentials.
 * A `https://user:token@host/…` origin would put the token in the clone's `.git/config`, inside
 * the workspace; userinfo is stripped and authentication is left to the credential helper. A URL
 * that does not parse (scp-like `git@host:path`) passes through; it carries no secret.
 */
export function publicOriginUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return url;
  }
}

/** The checkout's `origin` URL, or null when it has none (ADR 675: what a cloud clone points at). */
export function originUrl(top: string): string | null {
  try {
    return git(['remote', 'get-url', 'origin'], top);
  } catch {
    return null;
  }
}

/**
 * Seat-attributed commits (ADR 109 / ADR 197): give the worktree its own git identity so `git log`
 * answers "which seat wrote this" natively. `--worktree` (not `--local`) is load-bearing — repo-local
 * config is shared across all worktrees, so without `extensions.worktreeConfig` the last-provisioned
 * seat would silently rename every other seat's commits. Best-effort: identity is attribution, never
 * a gate on provisioning or re-bind.
 *
 * Call on every agent re-bind (`claim` / `join`), not only at provision — otherwise a folder that
 * moves to another team keeps `seat@oldTeam.musterd` and splits one seat across two emails on `main`
 * (ADR 197). Agent seats only; never call for a human credential (`mscr_`).
 *
 * `top` is resolved from `dir` rather than passed in, because the callers that most need this are the
 * ones that never computed a toplevel: `--here` and `--path` (§ {@link provisionWorkspace}). Outside a
 * repo there is no toplevel and nothing to write, which is fine — a plain folder has no git identity
 * to carry.
 */
export function setSeatGitIdentity(name: string, dir: string, team?: string): void {
  try {
    const top = gitToplevel(dir);
    if (!top) return; // a plain folder: nothing to attribute
    git(['config', 'extensions.worktreeConfig', 'true'], top);
    git(['config', '--worktree', 'user.name', `${name} (musterd seat)`], dir);
    git(['config', '--worktree', 'user.email', `${name}@${team ?? 'seats'}.musterd`], dir);
  } catch {
    /* attribution only — never fail the workspace for it */
  }
}

/** Real path of `p`, resolved through its nearest existing ancestor (`p` itself may not exist yet). */
function realpathNearest(p: string): string {
  const abs = resolvePath(p);
  const parent = dirname(abs);
  if (existsSync(abs)) return realpathSync(abs);
  return parent === abs ? abs : join(realpathNearest(parent), basename(abs));
}

/** ADR 463 §3: a self-contained clone of `top` on its own `branch`, with `.musterd/` kept out of git. */
function addClone(top: string, dir: string, branch: string, base?: string, origin?: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', top, dir], { encoding: 'utf8' });
  // ADR 675: a local clone's origin is the local path it came from; the seat's pushes and PRs go
  // to the real remote, so point origin there. The objects are already here (hard-linked).
  if (origin) git(['remote', 'set-url', 'origin', origin], dir);
  // A local clone hard-links the whole object store, so a commit resolved in `top` exists here too.
  git(base ? ['switch', '-c', branch, base] : ['switch', '-c', branch], dir);
  // A clone has its own `.git/info/exclude`: the binding must never be committable from it.
  const exclude = join(dir, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, '\n.musterd/\n');
}

/** True once `top`'s HEAD names a commit — false in a repo that was `git init`-ed and never committed. */
function hasCommit(top: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top);
    return true;
  } catch {
    return false;
  }
}

function addWorktree(top: string, dir: string, branch: string, base?: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  if (!base && !hasCommit(top)) {
    // A brand-new repo has no HEAD commit to branch from, and it is the folder a first-time user is
    // most likely in (`git init && musterd init`). An orphan worktree is the same thing one step
    // earlier: its own unborn branch, nothing checked out, committable as soon as there is work.
    try {
      git(['worktree', 'add', '--orphan', '-b', branch, dir], top);
    } catch (err) {
      throw new CliError(
        `this repo has no commits yet, and this git cannot make a workspace from an empty repo ` +
          `(needs git 2.42 or newer). Make a first commit and run it again: ` +
          `git commit --allow-empty -m "first commit"\n${(err as Error).message}`,
        1,
      );
    }
    return;
  }
  try {
    // New branch so the member has its own line to commit on: off `base` when given (no upstream —
    // the seat's branch is its own), else off HEAD as before.
    git(
      base
        ? ['worktree', 'add', '--no-track', '-b', branch, dir, base]
        : ['worktree', 'add', '-b', branch, dir, 'HEAD'],
      top,
    );
  } catch (err) {
    // Branch already exists (e.g. a prior run): attach a worktree to it. Any other failure is
    // reported as itself, not as the attach that could never have worked.
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top);
    } catch {
      throw err;
    }
    git(['worktree', 'add', dir, branch], top);
  }
}

/**
 * The remote's default branch tip as a commit sha (ADR 491), after a best-effort fetch — offline,
 * the last-known tip. `origin/HEAD` first (absent in a repo built with `init` + `remote add`), then
 * `origin/main`. Null when there is no remote to start from.
 */
export function resolveBaseRef(top: string): string | null {
  try {
    // Never prompt: git's HTTPS credential prompt and ssh's passphrase / host-key prompts open
    // /dev/tty directly, which `stdio: 'ignore'` does not stop — they would hang the launcher.
    execFileSync('git', ['fetch', 'origin', '--quiet'], {
      cwd: top,
      timeout: 20_000,
      stdio: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    });
  } catch {
    // offline or no origin — fall back to what is already fetched
  }
  for (const ref of ['origin/HEAD', 'origin/main']) {
    try {
      return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], top);
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Decide + create the workspace directory for an agent named `name`. Pure-ish: the only side effects
 * are `git worktree add` / `mkdir`. Never throws for "already there" — an existing target is reused so
 * re-running is idempotent.
 */
export function provisionWorkspace(name: string, opts: WorkspaceOpts = {}): Workspace {
  const cwd = opts.cwd ?? process.cwd();
  const identity = (dir: string): void => {
    if (opts.gitIdentity !== false) setSeatGitIdentity(name, dir, opts.team);
  };

  /*
   * `--here` and `--path` used to return before writing any identity, and those are exactly the paths
   * a REPAIR takes: `musterd agent <seat> --path <ws>` is the documented fix for an expired grant, so
   * it runs against worktrees already in use. The result was that fixing a broken credential silently
   * stripped the seat's attribution, and every later commit from that seat was authored as the human —
   * which is how two live seats ended up with zero Co-authored-by trailers across dozens of merges.
   */
  if (opts.here) {
    identity(cwd);
    return { dir: cwd, kind: 'here', created: false };
  }

  const top = gitToplevel(cwd);

  if (opts.path) {
    const dir = isAbsolute(opts.path) ? opts.path : resolvePath(cwd, opts.path);
    const created = !existsSync(dir);
    /*
     * A NEW folder named from inside a repo is a member of that repo: a worktree, and so its own git
     * root (ADR 447 §1). A plain folder there is a Workspace with no git root of its own — it borrows
     * whichever repo it later sits under, and Claude Code keys the musterd entry by that root. fifty
     * (2026-09-25) was a plain `--path` folder until the layout move put it inside the team-home repo,
     * and from then on its seat had no musterd tools. A target inside the checkout's own tree stays a
     * plain folder; an existing target is the repair path above and is never rebuilt.
     */
    const outside =
      top !== null && !(realpathNearest(dir) + '/').startsWith(realpathNearest(top) + '/');
    if (created && outside) {
      const branch = opts.branch ?? `agent/${name}`;
      addWorktree(top, dir, branch, opts.base);
      identity(dir);
      return { dir, kind: 'worktree', branch, created };
    }
    if (created) mkdirSync(dir, { recursive: true });
    identity(dir);
    return { dir, kind: 'folder', created };
  }

  if (top) {
    // Pre-layout seats (ADR 065) were siblings of the checkout: `<repo>-<name>`. One that already
    // exists is that seat's Workspace — reuse it (the identity repair below) rather than provision a
    // second; moving it onto the layout is `scripts/layout/migrate.ts`, not this command.
    const legacy = join(dirname(top), `${basename(top)}-${name}`);
    const dir = existsSync(legacy)
      ? legacy
      : memberWorkspaceDir(top, name, opts.team ?? 'seats', opts.home, originUrl(top));
    const branch = opts.branch ?? `agent/${name}`;
    if (existsSync(dir)) {
      // Reuse path repairs identity too, so pre-109 worktrees pick it up on re-run.
      identity(dir);
      return { dir, kind: 'worktree', branch, created: false };
    }
    if (opts.clone) addClone(top, dir, branch, opts.base, opts.origin);
    else addWorktree(top, dir, branch, opts.base);
    identity(dir);
    return { dir, kind: opts.clone ? 'folder' : 'worktree', branch, created: true };
  }

  // Not a git repo — a plain sibling folder.
  const base = resolvePath(cwd);
  const dir = join(dirname(base), `${basename(base)}-${name}`);
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true });
  return { dir, kind: 'folder', created };
}
