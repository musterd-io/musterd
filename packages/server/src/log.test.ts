import { describe, expect, it } from 'vitest';
import { failureFields, redactPath } from './log.js';

/**
 * Hard rule 5: a secret never reaches a log. The request log records `path`, and a remote MCP
 * connector URL carries its credential or team in the path (`/mcp/<token>`, ADR 446's `/mcp/:team`),
 * so the path itself must be redacted before it is logged or echoed in an error body.
 */
describe('redactPath', () => {
  it('redacts everything under /mcp/', () => {
    expect(redactPath('/mcp/mscr_abc123')).toBe('/mcp/[redacted]');
    expect(redactPath('/mcp/revive/extra')).toBe('/mcp/[redacted]/[redacted]');
    expect(redactPath('/.well-known/oauth-protected-resource/mcp/revive')).toBe(
      '/.well-known/oauth-protected-resource/mcp/[redacted]',
    );
  });

  it('keeps the bare /mcp mount visible', () => {
    expect(redactPath('/mcp')).toBe('/mcp');
    expect(redactPath('/mcp/')).toBe('/mcp/');
  });

  it('redacts any credential-shaped segment, anywhere, including percent-encoded', () => {
    expect(redactPath('/teams/revive/join/msgr_deadbeef')).toBe('/teams/revive/join/[redacted]');
    expect(redactPath('/x/MSKEY_upper')).toBe('/x/[redacted]');
    expect(redactPath('/x/%6Dscr_encoded')).toBe('/x/[redacted]');
  });

  it('leaves ordinary paths alone', () => {
    expect(redactPath('/teams/revive/lanes')).toBe('/teams/revive/lanes');
    expect(redactPath('/')).toBe('/');
    expect(redactPath('/x/%E0%A4%A')).toBe('/x/%E0%A4%A');
  });
});

/**
 * `String(error)` for a failed network call is `TypeError: fetch failed` and nothing else: undici
 * puts the reason (a reset socket, `other side closed`, a connect timeout) on `.cause`. A joiner's
 * pull failed once a minute for ten minutes behind exactly that line (second-machine run,
 * 2026-10-02), with no way to tell a flaky link from a hub that hung up.
 */
describe('failureFields', () => {
  it('surfaces the cause an undici fetch failure carries, code first', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    expect(failureFields(new TypeError('fetch failed', { cause }))).toEqual({
      error: 'TypeError: fetch failed',
      cause: 'UND_ERR_SOCKET: other side closed',
    });
  });

  it('keeps a cause with no code, and a cause that is not an Error', () => {
    expect(failureFields(new Error('x', { cause: new Error('inner') }))).toEqual({
      error: 'Error: x',
      cause: 'inner',
    });
    expect(failureFields(new Error('x', { cause: 'plain text' }))).toEqual({
      error: 'Error: x',
      cause: 'plain text',
    });
  });

  it('is just the error when there is no cause, and never throws on a non-Error', () => {
    expect(failureFields(new Error('boom'))).toEqual({ error: 'Error: boom' });
    expect(failureFields('plain')).toEqual({ error: 'plain' });
    expect(failureFields(undefined)).toEqual({ error: 'undefined' });
  });
});
