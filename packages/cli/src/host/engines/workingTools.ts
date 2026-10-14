import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineTool } from '../engine.js';
import { bashAllowed, jailPath, scrubEnv, type BashPolicy, type JailFsDeps } from './jail.js';

/**
 * The resident seat's four working tools (ADR 588 §3–§4): `read`, `write`, `edit`, `bash` — our
 * own, since pi's `CodingTools` ride pi-durable, which the amendment does not take. Expressed as
 * {@link EngineTool}s so any engine behind the seam can carry them and the scripted suite sees
 * them without pi. Every call is jailed twice: {@link preflightWorkingTool} is what the engine's
 * before-tool hook consults (the block the model sees), and each tool re-checks before it
 * touches the disk, so a tool handed a path by any other route is still inside the workspace.
 */

export interface WorkingToolOptions {
  workspace: string;
  policy: BashPolicy;
  /** The host's environment, scrubbed of credentials before a bash child sees it. */
  env: Record<string, string | undefined>;
  /** Variable names that must never reach a child — the ADR 588 `--key-env` name above all. */
  secretEnvNames?: readonly string[];
  bashTimeoutMs?: number;
  fs?: JailFsDeps;
}

/** Output bound per tool result — enough to read a test run, never a dump. */
export const WORKING_TOOL_OUTPUT_MAX_BYTES = 65_536;
const DEFAULT_BASH_TIMEOUT_MS = 10 * 60_000;

export const WORKING_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const;
export type WorkingToolName = (typeof WORKING_TOOL_NAMES)[number];

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : undefined;
}

function clip(text: string, max = WORKING_TOOL_OUTPUT_MAX_BYTES): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [clipped ${String(text.length - max)} more chars]`;
}

/**
 * The jail's verdict for one working-tool call, or undefined when the call may run. Musterd's own
 * tools are never judged here — they are the seat's coordination surface and carry no path.
 */
export function preflightWorkingTool(
  opts: Pick<WorkingToolOptions, 'workspace' | 'policy' | 'fs'>,
  name: string,
  args: unknown,
): string | undefined {
  switch (name) {
    case 'read': {
      const v = jailPath(opts.workspace, str(args, 'path') ?? '', {}, opts.fs);
      return v.ok ? undefined : v.reason;
    }
    case 'write':
    case 'edit': {
      const v = jailPath(opts.workspace, str(args, 'path') ?? '', { write: true }, opts.fs);
      return v.ok ? undefined : v.reason;
    }
    case 'bash': {
      const v = bashAllowed(str(args, 'command') ?? '', opts.policy);
      return v.ok ? undefined : v.reason;
    }
    default:
      return undefined;
  }
}

function jailed(opts: WorkingToolOptions, p: string | undefined, write: boolean): string {
  const v = jailPath(opts.workspace, p ?? '', { write }, opts.fs);
  if (!v.ok) throw new Error(`denied: ${v.reason}`);
  return v.path;
}

export function workingTools(opts: WorkingToolOptions): EngineTool[] {
  const read: EngineTool = {
    name: 'read',
    description:
      'Read a file inside the workspace. Returns its text (clipped at 64 KiB); use offset/limit (1-based line window) for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based)' },
        limit: { type: 'integer', minimum: 1, description: 'Number of lines to return' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (input) => {
      const path = jailed(opts, str(input, 'path'), false);
      const text = readFileSync(path, 'utf8');
      const o = (input as { offset?: number; limit?: number }) ?? {};
      if (o.offset === undefined && o.limit === undefined) return clip(text);
      const lines = text.split('\n');
      const start = Math.max(1, o.offset ?? 1) - 1;
      const end = o.limit !== undefined ? start + o.limit : lines.length;
      return clip(lines.slice(start, end).join('\n'));
    },
  };

  const write: EngineTool = {
    name: 'write',
    description:
      'Create or overwrite a file inside the workspace with the given content. Parent directories are created.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    run: async (input) => {
      const path = jailed(opts, str(input, 'path'), true);
      const content = str(input, 'content');
      if (content === undefined) throw new Error('content must be a string');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
      return `wrote ${String(Buffer.byteLength(content))} bytes to ${str(input, 'path')!}`;
    },
  };

  const edit: EngineTool = {
    name: 'edit',
    description:
      'Replace an exact string in a file inside the workspace. `old` must occur exactly once unless `all` is true.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        old: { type: 'string', description: 'The exact text to replace' },
        new: { type: 'string', description: 'The replacement text' },
        all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old', 'new'],
      additionalProperties: false,
    },
    run: async (input) => {
      const path = jailed(opts, str(input, 'path'), true);
      const oldText = str(input, 'old');
      const newText = str(input, 'new');
      if (oldText === undefined || newText === undefined || oldText.length === 0)
        throw new Error('old and new must be strings, and old must be non-empty');
      const all = (input as { all?: boolean }).all === true;
      const text = readFileSync(path, 'utf8');
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new Error('old text not found in file');
      if (count > 1 && !all)
        throw new Error(`old text occurs ${String(count)} times; pass all: true or make it unique`);
      const next = all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
      writeFileSync(path, next, 'utf8');
      return `replaced ${String(all ? count : 1)} occurrence(s) in ${str(input, 'path')!}`;
    },
  };

  const bash: EngineTool = {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Allowed: the repo’s declared pnpm scripts, `pnpm exec prettier|tsc|vitest|eslint`, a git subset on the current non-main branch, `gh pr …`, `musterd …`, and read-only coreutils. No substitution, redirection, backgrounding, installs, or force-pushes.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, description: 'Kill after this long' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    run: async (input) => {
      const command = str(input, 'command') ?? '';
      const verdict = bashAllowed(command, opts.policy);
      if (!verdict.ok) throw new Error(`denied: ${verdict.reason}`);
      const requested = (input as { timeout_ms?: number }).timeout_ms;
      const ceiling = opts.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
      const timeoutMs = Math.min(requested ?? ceiling, ceiling);
      const env = scrubEnv(opts.env, opts.secretEnvNames ?? []);
      return await new Promise<string>((resolveRun) => {
        // Its own process group, so the kill below reaches what the shell forked (a `tail -f`
        // under dash keeps the pipe open after the shell dies, and `close` never fires).
        const child = spawn('/bin/sh', ['-c', command], {
          cwd: opts.workspace,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let out = '';
        let err = '';
        let killed = false;
        let settled = false;
        const finish = (status: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const body = [clip(out), err ? `stderr:\n${clip(err)}` : ''].filter(Boolean).join('\n');
          resolveRun(`${status}\n${body}`);
        };
        const timer = setTimeout(() => {
          killed = true;
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => {
          if (out.length < WORKING_TOOL_OUTPUT_MAX_BYTES) out += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
          if (err.length < WORKING_TOOL_OUTPUT_MAX_BYTES) err += d.toString('utf8');
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolveRun(`spawn failed: ${e.message}`);
          }
        });
        // A killed group settles on `exit`: an orphan holding the pipe must not hold the wake.
        child.on('exit', () => {
          if (killed) finish(`killed after ${String(timeoutMs)}ms`);
        });
        child.on('close', (code, signal) => {
          finish(
            killed
              ? `killed after ${String(timeoutMs)}ms`
              : `exit ${String(code ?? signal ?? '?')}`,
          );
        });
      });
    },
  };

  return [read, write, edit, bash];
}

/** The repo's declared scripts — what `pnpm <x>` may run. Unreadable ⇒ empty (deny-safe). */
export function declaredScripts(
  workspace: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): Set<string> {
  try {
    const pkg = JSON.parse(readFile(`${workspace}/package.json`)) as { scripts?: unknown };
    const scripts = pkg.scripts;
    if (!scripts || typeof scripts !== 'object') return new Set();
    return new Set(Object.keys(scripts as Record<string, unknown>));
  } catch {
    return new Set();
  }
}
