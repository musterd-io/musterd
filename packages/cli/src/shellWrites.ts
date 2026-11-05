import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  bashWriteTargets,
  type EnforcementClass,
  type EnforcementMatch,
  type EnforcementPolicy,
  matchEnforcement,
  textFingerprint,
} from '@musterd/protocol';

/**
 * ADR 803 at the hook — the paths a `Bash` call writes, and the work-tree check after an opaque one.
 *
 * Before the call, {@link shellWritePaths} reads the plainly named targets out of the command and
 * makes them repo-relative, the way the gate already treats a file tool's path. When the command is
 * opaque and the team declares a `block` contended surface, {@link takeShellSnapshot} records which
 * paths `git status` already shows as changed. After the call, {@link freshlyWritten} compares again:
 * a path newly changed — or already changed and touched again — is one the command wrote.
 *
 * Everything here is local to the seat's Workspace: the snapshot is a file in `.musterd/`, and only a
 * matched path ever reaches the daemon, as a Gate A request.
 */

/** Repo-relative paths a shell call writes, resolved against the shell's directory, plus opacity. */
export function shellWritePaths(
  command: string,
  shellCwd: string,
  root: string,
): { paths: string[]; opaque: boolean } {
  const isDirectory = (p: string): boolean => {
    try {
      return statSync(isAbsolute(p) ? p : resolve(shellCwd, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const read = bashWriteTargets(command, { isDirectory });
  const paths: string[] = [];
  for (const p of read.paths) {
    const rel = relative(root, isAbsolute(p) ? p : resolve(shellCwd, p));
    // Outside the repo → no repo glob can match; keep it as written, as the file-tool path does.
    const out = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
    if (!paths.includes(out)) paths.push(out);
  }
  return { paths, opaque: read.opaque };
}

/** The contended-surface classes only: ADR 803 is Gate A, so a shell write's paths never meet Gate B. */
export function contendedOnly(policy: EnforcementPolicy): EnforcementPolicy {
  return { classes: policy.classes.filter((c) => c.kind === 'contended-surface') };
}

/** The `block` contended-surface classes — the ones an opaque write is checked against. */
export function blockSurfaces(policy: EnforcementPolicy): EnforcementClass[] {
  return policy.classes.filter((c) => c.kind === 'contended-surface' && c.posture === 'block');
}

/** Each path's contended-surface match, `block` first, one per path. */
export function shellPathMatches(
  policy: EnforcementPolicy,
  paths: readonly string[],
): EnforcementMatch[] {
  const table = contendedOnly(policy);
  const out: EnforcementMatch[] = [];
  for (const path of paths) {
    const m = matchEnforcement(table, { tool: 'Bash', path });
    if (m && !out.some((o) => o.fingerprint === m.fingerprint)) out.push(m);
  }
  return out.sort((a, b) => Number(b.cls.posture === 'block') - Number(a.cls.posture === 'block'));
}

/** Changed paths per `git status` (tracked and untracked, repo-relative), or null outside a repo. */
export function changedPaths(root: string): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  const paths: string[] = [];
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    paths.push(e.slice(3));
    // A rename or copy carries its source as the next entry; the source changed too.
    if (xy.includes('R') || xy.includes('C')) {
      const from = entries[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

function mtime(root: string, path: string): number | null {
  try {
    return statSync(join(root, path)).mtimeMs;
  } catch {
    return null;
  }
}

/** What the PreToolUse hook saw before an opaque call. */
interface ShellSnapshot {
  at: number;
  /** Paths `git status` already showed as changed, with their mtime (null: gone). */
  changed: Record<string, number | null>;
  /** The `block` contended-surface classes at the time — the after-call check matches these. */
  classes: EnforcementClass[];
}

const SNAPSHOT_DIR = 'shell-writes';
/** A snapshot older than this belongs to a call whose PostToolUse never came; swept on the next write. */
const SNAPSHOT_TTL_MS = 60 * 60_000;

/** The key one tool call's PreToolUse and PostToolUse share: the harness's tool-use id, else the
 *  session id with the command. Fingerprinted, so a file name never carries the command. */
export function shellSnapshotKey(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const input = (o['tool_input'] ?? o['toolInput']) as Record<string, unknown> | undefined;
    const id = o['tool_use_id'] ?? o['toolUseId'];
    if (typeof id === 'string' && id) return textFingerprint(`id\u0000${id}`);
    const session = o['session_id'] ?? o['sessionId'];
    const command = input?.['command'];
    if (typeof session === 'string' && typeof command === 'string') {
      return textFingerprint(`cmd\u0000${session}\u0000${command}`);
    }
  } catch {
    // no key → no snapshot
  }
  return null;
}

/** The directory the shell call runs in: the payload's `cwd`, else the hook's own. */
export function payloadCwd(raw: string, fallback: string): string {
  try {
    const cwd = (JSON.parse(raw) as Record<string, unknown>)['cwd'];
    return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : fallback;
  } catch {
    return fallback;
  }
}

/** Record the work tree before an opaque call (ADR 803 §3). Best-effort: a failure means no check. */
export function takeShellSnapshot(
  state: string,
  key: string,
  root: string,
  classes: EnforcementClass[],
  now: number = Date.now(),
): boolean {
  const before = changedPaths(root);
  if (!before) return false;
  const changed: Record<string, number | null> = {};
  for (const p of before) changed[p] = mtime(root, p);
  const dir = join(state, SNAPSHOT_DIR);
  try {
    mkdirSync(dir, { recursive: true });
    // The directory ignores itself, so no repo needs a rule for it: a snapshot never shows in
    // `git status` (nor in the after-call comparison) and `git add -A` never commits one.
    writeFileSync(join(dir, '.gitignore'), '*\n');
    for (const f of readdirSync(dir)) {
      if (f === '.gitignore') continue;
      const at = statSync(join(dir, f)).mtimeMs;
      if (now - at > SNAPSHOT_TTL_MS) unlinkSync(join(dir, f));
    }
    const snap: ShellSnapshot = { at: now, changed, classes };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(snap));
    return true;
  } catch {
    return false;
  }
}

/** Read and remove the snapshot for this call, or null when the PreToolUse hook took none. */
function popSnapshot(state: string, key: string): ShellSnapshot | null {
  const file = join(state, SNAPSHOT_DIR, `${key}.json`);
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as ShellSnapshot;
    unlinkSync(file);
    return snap;
  } catch {
    return null;
  }
}

/** The bound on paths one after-call check sends the daemon; the hook names how many more it left. */
export const WRITTEN_CHECK_MAX = 16;

/**
 * After an opaque call: the paths it changed that fall in a `block` contended surface, each with its
 * match (all of them; the caller bounds what it sends). A path is changed by the call when `git status` shows it now but did not before, or showed
 * it before and its mtime moved. Null when no snapshot was taken.
 */
export function freshlyWritten(
  state: string,
  key: string,
  root: string,
): EnforcementMatch[] | null {
  const snap = popSnapshot(state, key);
  if (!snap) return null;
  const now = changedPaths(root);
  if (!now) return [];
  const fresh = now.filter((p) => !(p in snap.changed) || snap.changed[p] !== mtime(root, p));
  return shellPathMatches({ classes: snap.classes }, fresh);
}
