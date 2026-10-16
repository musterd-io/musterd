import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeInbox } from './claudeInbox.js';
import { injectAdapterFor } from './inject.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A real unix socket in a temp dir; resolves with the lines a client sent once it hangs up. */
function listen(): { path: string; lines: Promise<string[]> } {
  const path = join(mkdtempSync(join(tmpdir(), 'cc-')), 's.sock');
  let deliver: (l: string[]) => void = () => {};
  const lines = new Promise<string[]>((r) => (deliver = r));
  server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => (buf += d.toString()));
    sock.on('end', () => deliver(buf.split('\n').filter(Boolean)));
  });
  server.listen(path);
  return { path, lines };
}

describe('claude-code inbox inject (ADR 558 §6)', () => {
  it('probe is deaf without the socket variable', () => {
    expect(claudeInbox({}).probe()).toEqual({ ready: false, reason: 'no-messaging-socket' });
  });

  it('sends the auth line then one user message, newline-delimited', async () => {
    const { path, lines } = listen();
    const a = claudeInbox({
      CLAUDE_CODE_MESSAGING_SOCKET: path,
      CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
    });
    expect(a.probe()).toEqual({ ready: true });
    expect(await a.inject('⚡ musterd [revive]: steer from ryder')).toEqual({ ok: true });
    expect((await lines).map((l) => JSON.parse(l) as unknown)).toEqual([
      { type: 'auth', token: 'tok' },
      {
        type: 'user',
        message: { role: 'user', content: '⚡ musterd [revive]: steer from ryder' },
      },
    ]);
  });

  it('omits the auth line when no token is set', async () => {
    const { path, lines } = listen();
    expect(await claudeInbox({ CLAUDE_CODE_MESSAGING_SOCKET: path }).inject('x')).toEqual({
      ok: true,
    });
    const got = await lines;
    expect(got).toHaveLength(1);
    expect((JSON.parse(got[0]!) as { type: string }).type).toBe('user');
  });

  it('a refused connection is not-ok with a reason and never throws', async () => {
    const r = await claudeInbox({ CLAUDE_CODE_MESSAGING_SOCKET: '/nonexistent/s.sock' }).inject(
      'x',
    );
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/^connect:/);
  });

  it('the token never appears in a reason', async () => {
    const r = await claudeInbox({
      CLAUDE_CODE_MESSAGING_SOCKET: '/nonexistent/s.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'SECRET',
    }).inject('x');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('every other harness is deaf, by name', async () => {
    expect(injectAdapterFor('cursor', {}).probe()).toEqual({
      ready: false,
      reason: 'no-inject:cursor',
    });
    expect(injectAdapterFor('muse', {}).probe()).toEqual({
      ready: false,
      reason: 'no-inject:muse',
    });
    expect(injectAdapterFor(null, {}).probe()).toEqual({
      ready: false,
      reason: 'no-inject:unknown',
    });
    const dir = mkdtempSync(join(tmpdir(), 'codex-deaf-'));
    expect(injectAdapterFor('codex', {}, dir).probe()).toEqual({
      ready: false,
      reason: 'no-thread',
    });
    expect(await injectAdapterFor('codex', {}, dir).inject('x')).toEqual({
      ok: false,
      reason: 'no-thread',
    });
  });
});
