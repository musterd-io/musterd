import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Binding } from '../config.js';
import { formatClaudeCodeInterrupt } from './inbox.js';
import {
  NO_SEAT_NUDGE_TEXT,
  ORIENT_NUDGE_TEXT,
  formatCursorInterrupt,
  formatCursorOrientation,
  orientNudge,
  orientNudgeDue,
  writeOrientStamp,
} from './session.js';

/** Mirrors the capture suite's temp-workspace idiom: never a real binding.json. */
describe('session orient stamp/nudge', () => {
  let ws: string;

  const bindingOf = (over: Partial<Binding> = {}): Binding =>
    ({
      version: 2,
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      grant: 'msgr_standing',
      model: 'claude-test-1',
      session: { harness: 'claude-code', id: 'sess-1', started_at: Date.now() },
      // A seated workspace: the adapter wrote the lease it holds (ADR 471). Without one the folder
      // has no live Presence — the unseated cases below take it away.
      session_lease: 'msls_live',
      ...over,
    }) as Binding;

  const writeBinding = (binding: Binding): void => {
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
    writeBinding(bindingOf());
    delete process.env['MUSTERD_PROVENANCE'];
  });
  afterEach(() => {
    delete process.env['MUSTERD_PROVENANCE'];
  });

  it('nudge is due when no stamp exists', () => {
    expect(orientNudgeDue(ws)).toBe(true);
  });

  it('stamp writes {session_id, oriented_at} keyed to the captured slot id, and quiets the nudge', () => {
    writeOrientStamp(ws);
    const rec = JSON.parse(readFileSync(join(ws, '.musterd', 'orient-stamp.json'), 'utf8')) as {
      session_id: string;
      oriented_at: number;
    };
    expect(rec.session_id).toBe('sess-1');
    expect(typeof rec.oriented_at).toBe('number');
    expect(orientNudgeDue(ws)).toBe(false);
  });

  it('a NEW captured session id makes the old stamp stale — nudge fires again', () => {
    writeOrientStamp(ws);
    writeBinding(
      bindingOf({ session: { harness: 'claude-code', id: 'sess-2', started_at: Date.now() } }),
    );
    expect(orientNudgeDue(ws)).toBe(true);
  });

  // Measured on izzo 2026-09-28: SessionStart was gated by a predecessor's live-looking slot, the
  // skill stamped while the slot still named that predecessor, and when the heal handed the slot to
  // the running session ~6 minutes later the nudge fired on a session that had already oriented.
  it('a stamp taken while the slot names a predecessor survives the heal to the running session', () => {
    writeBinding(
      bindingOf({ session: { harness: 'claude-code', id: 'pred', started_at: Date.now() } }),
    );
    writeOrientStamp(ws, Date.now(), 'live');
    writeBinding(
      bindingOf({ session: { harness: 'claude-code', id: 'live', started_at: Date.now() } }),
    );
    expect(orientNudgeDue(ws, 'live')).toBe(false);
    expect(orientNudgeDue(ws)).toBe(false); // the slot-only read agrees once healed
  });

  it('the nudge reads the running id, so a stamp for the predecessor alone does not quiet it', () => {
    writeBinding(
      bindingOf({ session: { harness: 'claude-code', id: 'pred', started_at: Date.now() } }),
    );
    writeOrientStamp(ws); // no running id known: keyed to the slot, the old behaviour
    expect(orientNudgeDue(ws, 'live')).toBe(true);
  });

  it('a running id leaked from a parent harness does not strand the nudge: the slot id also matches', () => {
    // e.g. a Codex seat launched from a Claude Code shell inherits CLAUDE_CODE_SESSION_ID.
    writeOrientStamp(ws, Date.now(), 'parent-claude');
    expect(orientNudgeDue(ws, 'sess-1')).toBe(false);
    expect(orientNudgeDue(ws)).toBe(false);
  });

  it('silent outside a seat workspace: no dir, no captured session, or no seat claim', () => {
    expect(orientNudgeDue(null)).toBe(false);
    writeBinding(bindingOf({ session: undefined }));
    expect(orientNudgeDue(ws)).toBe(false);
    writeBinding(bindingOf({ claim: undefined }));
    expect(orientNudgeDue(ws)).toBe(false);
  });

  describe('an unseated session is told to get a seat, not to orient (lane 01M4E4MSW1)', () => {
    // alfie, 2026-10-07: autojoin failed on a revoked credential, the session had no seat, and the
    // hook still said "run the musterd-orient skill" — whose last step then stamped it oriented.
    const unseated = (): void => writeBinding(bindingOf({ session_lease: undefined }));

    it('the nudge asks for a seat, and the orient text waits until there is one', () => {
      unseated();
      expect(orientNudge(ws)).toBe('no-seat');
      writeBinding(bindingOf());
      expect(orientNudge(ws)).toBe('orient');
    });

    it('stays silent exactly where the orient nudge is: no dir, no captured session, no seat claim', () => {
      expect(orientNudge(null)).toBeNull();
      writeBinding(bindingOf({ session: undefined, session_lease: undefined }));
      expect(orientNudge(ws)).toBeNull();
      writeBinding(bindingOf({ claim: undefined, session_lease: undefined }));
      expect(orientNudge(ws)).toBeNull();
    });

    it('orient-stamp refuses without a live seat and writes nothing, so the nudge keeps asking', () => {
      unseated();
      expect(writeOrientStamp(ws)).toBe(false);
      expect(() => readFileSync(join(ws, '.musterd', 'orient-stamp.json'), 'utf8')).toThrow();
      expect(orientNudge(ws)).toBe('no-seat');
    });

    it('a seated stamp still lands and quiets the nudge', () => {
      expect(writeOrientStamp(ws)).toBe(true);
      expect(orientNudge(ws)).toBeNull();
    });

    it('the no-seat text is one line, names the way in, and the credential repair', () => {
      expect(NO_SEAT_NUDGE_TEXT).not.toContain('\n');
      expect(NO_SEAT_NUDGE_TEXT).toContain('team_join');
      expect(NO_SEAT_NUDGE_TEXT).toContain('musterd team bootstrap mint --seat');
      expect(NO_SEAT_NUDGE_TEXT).not.toContain('musterd-orient');
    });
  });

  it('the nudge text names the skill and stays one line', () => {
    expect(ORIENT_NUDGE_TEXT).toContain('musterd-orient');
    expect(ORIENT_NUDGE_TEXT).not.toContain('\n');
  });

  it('formatCursorOrientation wraps the block as Cursor additional_context JSON (ADR 333)', () => {
    expect(formatCursorOrientation(null)).toBeNull();
    const json = formatCursorOrientation('musterd orientation — seat "scout" on team "dawn"');
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toEqual({
      additional_context: 'musterd orientation — seat "scout" on team "dawn"',
    });
  });

  it('formatCursorInterrupt wraps the interrupt line as Cursor additional_context JSON (ADR 369)', () => {
    expect(formatCursorInterrupt(null)).toBeNull();
    const json = formatCursorInterrupt('⚑ 1 urgent request waiting for you since 11:30');
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toEqual({
      additional_context: '⚑ 1 urgent request waiting for you since 11:30',
    });
  });

  // ADR 088 amendment (2026-09-05): Claude Code's PostToolUse seam is `hookSpecificOutput`, not bare
  // stdout — bare stdout from that event never reaches the model. The Cursor twin above knew its
  // seam from day one (ADR 369); this one arrived after 67 silent raises in a single transcript.
  it('formatClaudeCodeInterrupt wraps the line as Claude Code PostToolUse additionalContext JSON (ADR 088 am.)', () => {
    expect(formatClaudeCodeInterrupt(null)).toBeNull();
    const json = formatClaudeCodeInterrupt('⚡ musterd: huddle — ryder took a turn');
    expect(JSON.parse(json!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '⚡ musterd: huddle — ryder took a turn',
      },
    });
  });
});
