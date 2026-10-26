import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokSeatLeaderSocket, grokSeatSocketFile } from './grokSeatSocket.js';

describe('grok seat leader socket (ADR 742)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('locks the filename of /seats/dreamy', () => {
    expect(grokSeatSocketFile('/seats/dreamy')).toBe('65972905c9dfa3cdb961dfa2727d5422.sock');
  });

  it('lives under the machine grok-sockets dir, outside ~/.grok', () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-sock-'));
    dirs.push(root);
    const seat = mkdtempSync(join(root, 'seat-'));
    const socket = grokSeatLeaderSocket(seat, { MUSTERD_CONFIG: join(root, 'config.json') });
    expect(socket.startsWith(join(root, 'grok-sockets'))).toBe(true);
    expect(socket.endsWith('.sock')).toBe(true);
    expect(socket.includes(`${join('.grok', 'leader')}`)).toBe(false);
    expect(socket.includes('leader-')).toBe(false);
  });
});
