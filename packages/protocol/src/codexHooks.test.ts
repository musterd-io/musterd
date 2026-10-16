import { describe, expect, it } from 'vitest';
import { parseCodexHookEvent, parseCodexAttendedMeta } from './codexHooks.js';

describe('Codex hook event boundary', () => {
  it('accepts SessionStart only for the start command', () => {
    expect(
      parseCodexHookEvent(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/workspace' }),
        'start',
      ),
    ).toEqual({ event: 'start', session_id: 's1', cwd: '/workspace' });
  });

  it('accepts PostToolUse model evidence without a transcript', () => {
    expect(
      parseCodexHookEvent(
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 's1',
          cwd: '/workspace',
          model: 'gpt-5.6',
        }),
        'post-tool-use',
      ),
    ).toEqual({ event: 'post-tool-use', session_id: 's1', cwd: '/workspace', model: 'gpt-5.6' });
  });

  it('rejects an event/subcommand mismatch, malformed values, and unknown events', () => {
    expect(
      parseCodexHookEvent('{"hook_event_name":"SessionEnd","session_id":"s1","cwd":"/w"}', 'start'),
    ).toBeUndefined();
    expect(
      parseCodexHookEvent(
        '{"hook_event_name":"PostToolUse","session_id":"s1","cwd":"/w"}',
        'post-tool-use',
      ),
    ).toBeUndefined();
    expect(
      parseCodexHookEvent('{"hook_event_name":"Unknown","session_id":"s1","cwd":"/w"}', 'start'),
    ).toBeUndefined();
  });
});

describe('Codex attended rollout boundary (ADR 632)', () => {
  const raw = (source: unknown, cwd: unknown = '/ws/body') =>
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 's1', cwd, source, secret: 'discard' },
    });
  it('accepts desktop and interactive CLI source metadata only', () => {
    expect(parseCodexAttendedMeta(raw('vscode'))).toEqual({ id: 's1', cwd: '/ws/body' });
    expect(parseCodexAttendedMeta(raw('cli'))).toEqual({ id: 's1', cwd: '/ws/body' });
  });
  it('excludes headless and subagent sessions and refuses incomplete evidence', () => {
    for (const source of ['exec', 'app-server', { subagent: { thread_spawn: {} } }, undefined])
      expect(parseCodexAttendedMeta(raw(source))).toBeUndefined();
    expect(parseCodexAttendedMeta(raw('vscode', ''))).toBeUndefined();
    expect(parseCodexAttendedMeta('{')).toBeUndefined();
  });
});
