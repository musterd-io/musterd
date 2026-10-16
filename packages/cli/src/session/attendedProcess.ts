import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, sep } from 'node:path';
import { parseCodexAttendedMeta } from '@musterd/protocol';

/**
 * The host guard's backstop for an attended session (ADR 444). The transcript guard (ADR 131 §5)
 * reads a session as live only while its transcript is being written, so an open session whose
 * person has stepped away reads as idle — and once the daemon stops seeing its presence, a wake is
 * leased and spawned beside it (dolly, 2026-09-22: 25 minutes). An attended session is a harness
 * process that is running in the workspace and is not a headless run. A wake child is always
 * headless (`claude -p …`), so it never counts.
 *
 * Read-only and best-effort. `undefined` is "cannot tell" and must never be read as "no session".
 */

/** One harness process, as the process table reports it. */
export interface HarnessProcess {
  pid: number;
  /** The executable name (`ps -o comm`). */
  comm: string;
  /** The full command line (`ps -o args`). */
  args: string;
  /** The process's working directory, when it could be read. */
  cwd?: string;
  /** ADR 632: interactive rollout headers held open by this Codex app server. */
  attendedWorkspaces?: string[];
  /** True only when ps reports a controlling terminal for this process. */
  terminal?: boolean;
}

/** Lists harness processes, or `undefined` when the process table cannot be read. */
export type ProcessLister = () => HarnessProcess[] | undefined;

/** How to recognise a harness's interactive session: its executable, and its headless flags. */
interface ProcessSignature {
  comm: string;
  headless: readonly string[];
}

/** Only harnesses with a known signature are judged; the rest return "cannot tell". */
const SIGNATURES: Readonly<Record<string, ProcessSignature>> = {
  'claude-code': { comm: 'claude', headless: ['-p', '--print'] },
  codex: { comm: 'codex', headless: [] },
};

const EXEC_TIMEOUT_MS = 2_000;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readCwd(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

/** ADR 632: metadata is attributed by its recorded cwd, never by a rollout filename. */
export function readCodexAttendedWorkspace(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(64 * 1024);
    const count = readSync(fd, buf, 0, buf.length, 0);
    const prefix = buf.subarray(0, count).toString('utf8');
    const end = prefix.indexOf('\n');
    if (end < 0) return undefined;
    return parseCodexAttendedMeta(prefix.slice(0, end))?.cwd;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* process/file may have disappeared */
      }
    }
  }
}

/** A process-held file is evidence while idle; a transcript merely left on disk is not. */
export function codexOpenWorkspaces(pid: number): string[] | undefined {
  try {
    const files =
      process.platform === 'linux'
        ? readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
            try {
              return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
            } catch {
              return [];
            }
          })
        : process.platform === 'darwin'
          ? execFileSync('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], {
              encoding: 'utf8',
              timeout: EXEC_TIMEOUT_MS,
              maxBuffer: 1024 * 1024,
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .split('\n')
              .filter((line) => line.startsWith('n'))
              .map((line) => line.slice(1))
          : undefined;
    if (!files) return undefined;
    return [...new Set(files)].flatMap((path) => {
      if (!basename(path).startsWith('rollout-') || !path.endsWith('.jsonl')) return [];
      const workspace = readCodexAttendedWorkspace(path);
      return workspace ? [workspace] : [];
    });
  } catch {
    return undefined;
  }
}

/** The real process table: every process whose executable is a known harness binary. */
export function listHarnessProcesses(): HarnessProcess[] | undefined {
  const comms = new Set(Object.values(SIGNATURES).map((s) => s.comm));
  let table: string;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  const found: HarnessProcess[] = [];
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const comm = basename(m[2]!.trim());
    if (!comms.has(comm)) continue;
    const pid = Number(m[1]);
    let args = comm;
    try {
      args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      continue; // exited between the two reads
    }
    const cwd = readCwd(pid);
    const attendedWorkspaces = comm === 'codex' ? codexOpenWorkspaces(pid) : undefined;
    let terminal = false;
    if (comm === 'codex') {
      try {
        const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        terminal = tty !== '' && tty !== '?' && tty !== '??' && tty !== '-';
      } catch {
        /* no terminal evidence */
      }
    }
    found.push({
      ...(terminal ? { terminal } : {}),
      pid,
      comm,
      args,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(attendedWorkspaces !== undefined ? { attendedWorkspaces } : {}),
    });
  }
  return found;
}

/**
 * An attended `harness` session open in `workspace` (or a directory under it): its pid, `null` when
 * there is none, or `undefined` when this cannot be told — an unknown harness, or an unreadable
 * process table.
 */
export function attendedHarnessProcess(
  workspace: string,
  harness: string | undefined,
  list: ProcessLister = listHarnessProcesses,
): { pid: number } | null | undefined {
  const signature = SIGNATURES[harness ?? 'claude-code'];
  if (!signature) return undefined;
  const procs = list();
  if (procs === undefined) return undefined;
  const root = canonical(workspace);
  let unknown = false;
  const owns = (cwd: string): boolean => {
    const path = canonical(cwd);
    return path === root || path.startsWith(root + sep);
  };
  const hit = procs.find((p) => {
    if (basename(p.comm) !== signature.comm) return false;
    const tokens = p.args.split(/\s+/);
    if (harness === 'codex') {
      if (p.attendedWorkspaces?.some(owns)) return true;
      // A native TUI can delegate its rollout to the shared app server. A controlling terminal
      // plus cwd is the independent evidence; command names are exclusions, never proof alone.
      const headless = ['exec', 'e', 'app-server', 'mcp-server', 'exec-server', 'review'];
      if (p.terminal && p.cwd !== undefined && !headless.some((cmd) => tokens.includes(cmd)))
        return owns(p.cwd);
      if (p.attendedWorkspaces === undefined) unknown = true;
      return false;
    }
    if (p.cwd === undefined) return false;
    if (signature.headless.some((flag) => tokens.includes(flag))) return false;
    const cwd = canonical(p.cwd);
    return cwd === root || cwd.startsWith(root + sep);
  });
  return hit ? { pid: hit.pid } : unknown ? undefined : null;
}
