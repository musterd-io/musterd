import { describe, expect, it } from 'vitest';
import { browserOrigin, ceremonyLaunch, openCeremony } from './authority.js';

describe('browserOrigin', () => {
  it('rewrites IP literals to localhost (WebAuthn RP ID rule)', () => {
    expect(browserOrigin('http://127.0.0.1:4849')).toBe('http://localhost:4849');
    expect(browserOrigin('http://[::1]:4849')).toBe('http://localhost:4849');
  });
  it('leaves real hostnames alone', () => {
    expect(browserOrigin('https://musterd.io')).toBe('https://musterd.io');
    expect(browserOrigin('http://mac.lan:4849/')).toBe('http://mac.lan:4849');
  });
  it('is safe on garbage input', () => {
    expect(browserOrigin('not a url')).toBe('not a url');
  });
});

describe('ceremonyLaunch', () => {
  it('returns null on a non-TTY (pipe / script) so no browser is ever opened', () => {
    expect(ceremonyLaunch('http://localhost/x', 'darwin', false)).toBeNull();
  });
  it('names Chrome explicitly on macOS', () => {
    const r = ceremonyLaunch('http://localhost/x', 'darwin', true);
    expect(r).toEqual({ command: 'open', args: ['-a', 'Google Chrome', 'http://localhost/x'] });
  });
  it('uses cmd on Windows', () => {
    const r = ceremonyLaunch('http://localhost/x', 'win32', true);
    expect(r?.command).toBe('cmd');
  });
  it('falls back to google-chrome elsewhere', () => {
    const r = ceremonyLaunch('http://localhost/x', 'linux', true);
    expect(r).toEqual({ command: 'google-chrome', args: ['http://localhost/x'] });
  });
});

describe('openCeremony', () => {
  it('returns false without spawning when not a TTY', async () => {
    const spawn = () => {
      throw new Error('should not spawn');
    };
    const ok = await openCeremony('http://localhost/x', { tty: false, spawn: spawn as never });
    expect(ok).toBe(false);
  });
  it('returns false when Chrome fails to start (spawn error)', async () => {
    const child = {
      unref() {},
      on(event: string, cb: (code?: number | null) => void) {
        if (event === 'error') setTimeout(() => cb(), 0);
      },
    };
    const ok = await openCeremony('http://localhost/x', {
      tty: true,
      platform: 'linux',
      spawn: () => child as never,
    });
    expect(ok).toBe(false);
  });
  it('returns true when Chrome exits 0', async () => {
    const child = {
      unref() {},
      on(event: string, cb: (code?: number | null) => void) {
        if (event === 'exit') setTimeout(() => cb(0), 0);
      },
    };
    const ok = await openCeremony('http://localhost/x', {
      tty: true,
      platform: 'linux',
      spawn: () => child as never,
    });
    expect(ok).toBe(true);
  });
});
