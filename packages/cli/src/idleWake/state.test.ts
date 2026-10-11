import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noteTurnMarker } from '../commands/trace.js';
import { readIdleWakeState, writeIdleWakeState } from './state.js';

const ws = () => {
  const d = mkdtempSync(join(tmpdir(), 'iw-'));
  mkdirSync(join(d, '.musterd'));
  return d;
};

describe('idle-wake state file (ADR 558)', () => {
  it('reads empty when absent or corrupt', () => {
    const d = ws();
    expect(readIdleWakeState(d)).toEqual({});
    writeFileSync(join(d, '.musterd', 'idle-wake.json'), '{nope');
    expect(readIdleWakeState(d)).toEqual({});
  });
  it('merges patches and keeps the switch across a new session id', () => {
    const d = ws();
    writeIdleWakeState(d, { switch: 'off' });
    writeIdleWakeState(d, { session_id: 's1', last_prompt_at: 5 });
    expect(readIdleWakeState(d)).toEqual({ switch: 'off', session_id: 's1', last_prompt_at: 5 });
  });
  it('a new session id drops the previous session markers', () => {
    const d = ws();
    writeIdleWakeState(d, { session_id: 's1', last_stop_at: 9 });
    writeIdleWakeState(d, { session_id: 's2', last_prompt_at: 10 });
    expect(readIdleWakeState(d)).toEqual({ session_id: 's2', last_prompt_at: 10 });
  });
  it('is written 0600 and atomically', () => {
    const d = ws();
    writeIdleWakeState(d, { switch: 'on' });
    expect(statSync(join(d, '.musterd', 'idle-wake.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(d, '.musterd', 'idle-wake.json'), 'utf8'))).toEqual({
      switch: 'on',
    });
  });
});

describe('noteTurnMarker (the trace tap writes the markers)', () => {
  const hook = (event: string, session = 's1') =>
    JSON.stringify({ hook_event_name: event, session_id: session });
  it('UserPromptSubmit and Stop stamp their marker; other events and junk write nothing', () => {
    const d = ws();
    noteTurnMarker(hook('PreCompact'), d, 1);
    noteTurnMarker('not json', d, 2);
    expect(readIdleWakeState(d)).toEqual({});
    noteTurnMarker(hook('UserPromptSubmit'), d, 3);
    noteTurnMarker(hook('Stop'), d, 4);
    expect(readIdleWakeState(d)).toEqual({ session_id: 's1', last_prompt_at: 3, last_stop_at: 4 });
  });
  it('never throws, even with no .musterd directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'iw-'));
    expect(() => noteTurnMarker(hook('Stop'), d, 1)).not.toThrow();
  });
});
