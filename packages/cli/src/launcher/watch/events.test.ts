import { describe, expect, it } from 'vitest';
import { formatWatchLine, oneLine, textEvent, toolEvent } from './events.js';

describe('textEvent / toolEvent — what watch may show, once (ADR 546)', () => {
  it('quotes words on one line', () => {
    expect(textEvent(1, 'line one\n  line   two')?.line).toBe('“line one line two”');
    expect(textEvent(1, '   ')).toBeNull();
  });

  it('scrubs a credential from words and from a tool argument', () => {
    const key = 'mskey_abcdefabcdefabcdefabcdef0123456789';
    expect(textEvent(null, `export KEY=${key}`)?.line).not.toContain('mskey_abcdef');
    expect(toolEvent(null, 'Bash', `echo ${key}`).line).not.toContain('mskey_abcdef');
    expect(textEvent(null, `export KEY=${key}`)?.line).toContain('<redacted:');
  });

  it('drops terminal escape sequences and other control characters from both', () => {
    const evil = 'hi \u001b[2J\u001b]0;pwned\u0007there\u009b31m';
    // eslint-disable-next-line no-control-regex
    const control = /[\u0000-\u001f\u007f-\u009f]/;
    expect(textEvent(null, evil)?.line).not.toMatch(control);
    expect(toolEvent(null, 'Ba\u001bsh', 'ls\u001b[31m /tmp').line).not.toMatch(control);
    expect(oneLine('a\u001b[0mb')).toBe('a[0mb');
  });

  it('a tool call is its name and the one argument, or just the name', () => {
    expect(toolEvent(null, 'Bash', 'ls -la').line).toBe('▸ Bash  ls -la');
    expect(toolEvent(null, 'Bash', '').line).toBe('▸ Bash');
  });
});

describe('WatchEvent is branded (ADR 546)', () => {
  it('an object literal is not a WatchEvent — only the constructors make one', () => {
    // @ts-expect-error a hand-built event skips the scrub, so it must not typecheck
    const bad: import('./events.js').WatchEvent = { ts: null, kind: 'text', line: 'raw' };
    expect(bad.line).toBe('raw');
  });
});

describe('formatWatchLine (ADR 546)', () => {
  it('is one row, trimmed to the width', () => {
    const row = formatWatchLine(toolEvent(null, 'Bash', 'x'.repeat(200)), 40);
    expect([...row].length).toBeLessThanOrEqual(40);
    expect(row.endsWith('…')).toBe(true);
  });
  it('prefixes the time when it is known, and leaves a short line alone', () => {
    const ts = new Date(2026, 9, 7, 9, 5).getTime();
    expect(formatWatchLine(toolEvent(ts, 'Bash', 'ls'), 80)).toBe('09:05  ▸ Bash  ls');
    expect(formatWatchLine(toolEvent(null, 'Bash', 'ls'), 80)).toBe('▸ Bash  ls');
  });
});
