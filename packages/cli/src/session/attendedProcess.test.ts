import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attendedHarnessProcess,
  codexOpenWorkspaces,
  readCodexAttendedWorkspace,
  type HarnessProcess,
} from './attendedProcess.js';

const proc = (over: Partial<HarnessProcess>): HarnessProcess => ({
  pid: 100,
  comm: 'claude',
  args: 'claude',
  cwd: '/ws/dolly',
  ...over,
});

describe('attendedHarnessProcess (ADR 444 host backstop)', () => {
  it('finds an interactive claude session whose cwd is the workspace', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', () => [proc({})])).toEqual({
      pid: 100,
    });
  });

  it('counts a session started in a subdirectory of the workspace', () => {
    const list = () => [proc({ cwd: '/ws/dolly/packages/cli' })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toEqual({ pid: 100 });
  });

  it('ignores headless runs — a wake child is spawned with -p', () => {
    const list = () => [
      proc({ pid: 1, args: 'claude -p musterd wake --session-id abc' }),
      proc({ pid: 2, args: 'claude --resume abc --print hi' }),
    ];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('ignores sessions in other workspaces, including a sibling sharing a prefix', () => {
    const list = () => [proc({ cwd: '/ws/izzo' }), proc({ cwd: '/ws/dolly-old' })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('ignores a process whose cwd could not be read', () => {
    const list = () => [proc({ cwd: undefined })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('cannot tell (undefined) when the process table is unreadable', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', () => undefined)).toBeUndefined();
  });

  it('cannot tell (undefined) for a harness it has no process signature for', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'other', () => [proc({})])).toBeUndefined();
  });
});

describe('Codex attended process backstop (ADR 632)', () => {
  it('protects an interactive CLI, including resume, but not exec or app-server cwd alone', () => {
    const codex = (args: string): HarnessProcess => ({
      pid: 20,
      comm: 'codex',
      args,
      cwd: '/ws/body',
      terminal: true,
      attendedWorkspaces: [],
    });
    expect(attendedHarnessProcess('/ws/body', 'codex', () => [codex('codex resume s1')])).toEqual({
      pid: 20,
    });
    expect(
      attendedHarnessProcess('/ws/body', 'codex', () => [codex('codex exec resume s1')]),
    ).toBeNull();
    expect(
      attendedHarnessProcess('/ws/body', 'codex', () => [codex('codex app-server')]),
    ).not.toEqual({ pid: 20 });
  });

  it('requires a terminal for the native fallback and excludes service/review commands', () => {
    const p = {
      pid: 22,
      comm: 'codex',
      args: 'codex resume s1',
      cwd: '/ws/body',
      attendedWorkspaces: [],
    };
    expect(attendedHarnessProcess('/ws/body', 'codex', () => [p])).toBeNull();
    expect(
      attendedHarnessProcess('/ws/other', 'codex', () => [{ ...p, terminal: true }]),
    ).toBeNull();
    for (const cmd of ['exec', 'e', 'app-server', 'exec-server', 'mcp-server', 'review']) {
      expect(
        attendedHarnessProcess('/ws/body', 'codex', () => [
          { ...p, terminal: true, args: `codex ${cmd}` },
        ]),
      ).toBeNull();
    }
  });

  it('protects only the desktop workspace whose transcript remains open', () => {
    const p = {
      pid: 21,
      comm: 'codex',
      args: 'codex app-server --listen unix://',
      cwd: '/',
      attendedWorkspaces: ['/ws/body'],
    };
    expect(attendedHarnessProcess('/ws/body', 'codex', () => [p])).toEqual({ pid: 21 });
    expect(attendedHarnessProcess('/ws/other', 'codex', () => [p])).toBeNull();
    expect(
      attendedHarnessProcess('/ws/body', 'codex', () => [{ ...p, attendedWorkspaces: [] }]),
    ).toBeNull();
  });
});

describe('process-held Codex rollout header', () => {
  it('attributes an old open desktop transcript by metadata and excludes a headless or incomplete header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-attended-'));
    const path = join(dir, 'rollout-unrelated-name.jsonl');
    try {
      const write = (source: unknown) =>
        writeFileSync(
          path,
          JSON.stringify({
            type: 'session_meta',
            payload: { session_id: 'real-id', cwd: '/ws/body', source },
          }) +
            '\n' +
            'unparsed conversation body',
        );
      write('vscode');
      utimesSync(path, new Date(0), new Date(0));
      expect(readCodexAttendedWorkspace(path)).toBe('/ws/body');
      write('exec');
      expect(readCodexAttendedWorkspace(path)).toBeUndefined();
      write({ subagent: { thread_spawn: {} } });
      expect(readCodexAttendedWorkspace(path)).toBeUndefined();
      writeFileSync(path, '{"type":"session_meta"');
      expect(readCodexAttendedWorkspace(path)).toBeUndefined();
      writeFileSync(path, 'x'.repeat(70_000) + '\n');
      expect(readCodexAttendedWorkspace(path)).toBeUndefined();
      expect(readCodexAttendedWorkspace(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'releasing the real held file removes desktop attendance evidence',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-open-rollout-'));
    const path = join(dir, 'rollout-fixture.jsonl');
    let fd: number | undefined;
    try {
      writeFileSync(
        path,
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'fixture', cwd: dir, source: 'vscode' },
        }) + '\n',
      );
      fd = openSync(path, 'r');
      expect(codexOpenWorkspaces(process.pid)).toContain(dir);
      closeSync(fd);
      fd = undefined;
      expect(codexOpenWorkspaces(process.pid)).not.toContain(dir);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
