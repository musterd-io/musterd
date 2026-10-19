import { describe, expect, it } from 'vitest';
import {
  foldPulseKind,
  projectPulse,
  PULSE_FOLD_HARNESSES,
  PULSE_WINDOW_MS,
  type PulseInput,
} from './pulse.js';
import { TRACE_TOOL_NAMESPACES } from './traceSync.js';

describe('foldPulseKind (ADR 660 §1) — four kinds from the structural name, never the body', () => {
  it('folds the common tools of each harness', () => {
    expect(foldPulseKind('claude-code', 'Read')).toBe('read');
    expect(foldPulseKind('claude-code', 'Edit')).toBe('edit');
    expect(foldPulseKind('claude-code', 'Bash')).toBe('run');
    expect(foldPulseKind('codex', 'apply_patch')).toBe('edit');
    expect(foldPulseKind('codex', 'exec_command')).toBe('run');
    expect(foldPulseKind('cursor', 'Shell')).toBe('run');
    expect(foldPulseKind('opencode', 'grep')).toBe('read');
    expect(foldPulseKind('grok', 'write_file')).toBe('edit');
  });

  it("musterd's own tools, `other` and the plan/ask tools have no kind (they still count)", () => {
    expect(foldPulseKind('claude-code', 'mcp__musterd__team_send')).toBeNull();
    expect(foldPulseKind('claude-code', 'other')).toBeNull();
    expect(foldPulseKind('claude-code', 'AskUserQuestion')).toBeNull();
    expect(foldPulseKind('codex', 'update_plan')).toBeNull();
    expect(foldPulseKind('unknown-harness', 'Bash')).toBeNull();
  });

  it('classifies every namespaced name without throwing, and never as `test` (spec §3.4)', () => {
    for (const [harness, names] of Object.entries(TRACE_TOOL_NAMESPACES)) {
      for (const n of names) {
        const k = foldPulseKind(harness, n);
        expect([null, 'read', 'edit', 'run']).toContain(k);
      }
    }
  });

  it('knows only harnesses the namespace table knows', () => {
    for (const h of PULSE_FOLD_HARNESSES) expect(TRACE_TOOL_NAMESPACES[h]).toBeDefined();
    expect(PULSE_FOLD_HARNESSES).toContain('claude-code');
  });
});

describe('projectPulse — distinct calls in the trailing minute', () => {
  const now = 1_000_000;
  const c = (id: string, ts: number, kind: PulseInput['kind'] = 'read'): PulseInput => ({
    tool_use_id: id,
    ts,
    kind,
  });

  it('is empty for an empty window', () => {
    expect(projectPulse([], now)).toEqual({ intensity: 0, kind: null, last_ts: 0 });
  });

  it('counts one call that produced two rows once (Cursor shell + postToolUse)', () => {
    expect(projectPulse([c('a', now - 10, 'run'), c('a', now - 9, 'run')], now).intensity).toBe(1);
  });

  it('includes a call exactly at the window edge and excludes one just outside', () => {
    expect(projectPulse([c('edge', now - PULSE_WINDOW_MS)], now).intensity).toBe(1);
    expect(projectPulse([c('out', now - PULSE_WINDOW_MS - 1)], now).intensity).toBe(0);
  });

  it('kind and last_ts come from the latest call that had a kind', () => {
    const p = projectPulse(
      [c('r', now - 300, 'read'), c('m', now - 100, null), c('e', now - 200, 'edit')],
      now,
    );
    expect(p).toEqual({ intensity: 3, kind: 'edit', last_ts: now - 200 });
  });

  it('a producer clock ahead of the daemon still counts', () => {
    expect(projectPulse([c('f', now + 2_000, 'run')], now)).toEqual({
      intensity: 1,
      kind: 'run',
      last_ts: now + 2_000,
    });
  });
});
