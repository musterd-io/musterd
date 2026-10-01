import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursorAgentCandidates, resolveCursorAgentBin } from './cursorAgentBin.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'musterd-cursor-bin-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('resolveCursorAgentBin', () => {
  it('prefers cursor-agent on PATH', async () => {
    const seen: string[] = [];
    const bin = await resolveCursorAgentBin(async (cmd) => {
      seen.push(cmd);
      return { ok: cmd === 'cursor-agent' };
    }, home);
    expect(bin).toBe('cursor-agent');
    expect(seen).toEqual(['cursor-agent']);
  });

  it('falls back to ~/.local/bin/cursor-agent — never the bare `agent`, which may be Grok', async () => {
    const local = join(home, '.local', 'bin', 'cursor-agent');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(local, '#!/bin/sh\n');
    chmodSync(local, 0o755);
    const seen: string[] = [];
    const bin = await resolveCursorAgentBin(async (cmd) => {
      seen.push(cmd);
      return { ok: cmd === local };
    }, home);
    expect(bin).toBe(local);
    expect(seen).not.toContain('agent');
    expect(cursorAgentCandidates(home)[0]).toBe(local);
  });

  it('answers null when nothing runs', async () => {
    expect(await resolveCursorAgentBin(async () => ({ ok: false }), home)).toBeNull();
  });
});
