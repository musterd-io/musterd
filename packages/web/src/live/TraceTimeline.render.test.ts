import type { TraceSessionEvent } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { foldTraceRead, timelineSummary, TraceTimeline, type TraceView } from './TraceTimeline';

/**
 * What the per-seat timeline RENDERS (ADR 445 increment 4b). Rendered with `react-dom/server`
 * and no DOM, like the other `*.render.test.ts` files here: the question is the markup and the
 * vocabulary, not the paint, and effects never run — so the pure component is what is pinned, and
 * the fetch lives in `SeatTraceToggle` which this file deliberately does not mount.
 */

const ev = (over: Partial<TraceSessionEvent> = {}): TraceSessionEvent => ({
  seq: 0,
  ts: Date.UTC(2026, 8, 26, 17, 4, 5),
  received_at: 1,
  seat: 'ryder',
  harness: 'claude-code',
  kind: 'PostToolUse',
  tool_name: 'Bash',
  duration_ms: 42,
  outcome: 'ok',
  detail: null,
  content: null,
  truncated: false,
  ...over,
});

const render = (events: TraceSessionEvent[], state: 'loading' | 'ready' | 'error' = 'ready') =>
  renderToStaticMarkup(createElement(TraceTimeline, { seat: 'ryder', events, state }));

describe('TraceTimeline', () => {
  it('speaks each kind’s vocabulary and dims the R2 rail', () => {
    expect(timelineSummary(ev())).toBe('Bash · 42ms');
    expect(timelineSummary(ev({ kind: 'PostToolUseFailure', outcome: 'error' }))).toBe(
      'Bash · 42ms · error',
    );
    expect(
      timelineSummary(
        ev({ kind: 'usage', detail: { input_tokens: 10, output_tokens: 2, model: 'claude-opus-5-5' } }),
      ),
    ).toBe('in 10 · out 2  claude-opus-5-5');
    expect(timelineSummary(ev({ kind: 'reasoning', detail: { reasoning_bytes: 99 } }))).toBe('99 bytes');
    expect(timelineSummary(ev({ kind: 'HookOutcome', outcome: 'ok', detail: { hook: 'gate' } }))).toBe(
      'gate · ok',
    );
    expect(timelineSummary(ev({ kind: 'unknown', detail: { downgraded: true } }))).toBe('downgraded');

    const html = render([ev({ seq: 1 }), ev({ seq: 2, kind: 'reasoning', detail: { reasoning_bytes: 5 } })]);
    expect(html).toContain('aria-label="ryder&#x27;s recent trace"');
    expect(html).toContain('lc-trace__kind">PostToolUse<');
    expect(html).toContain('lc-trace__row is-r2');
  });

  it('never renders a content field even when a row carries one', () => {
    const html = render([
      ev({ content: { tool_input: 'cat SECRET' } as unknown as TraceSessionEvent['content'] }),
    ]);
    expect(html).not.toContain('SECRET');
  });

  it('says the honest thing for loading, error, and an empty (unreadable or untraced) seat', () => {
    expect(render([], 'loading')).toContain('Reading ryder&#x27;s trace');
    expect(render([], 'error')).toContain('Could not read ryder&#x27;s trace');
    expect(render([])).toContain('not traced, or not yours to read');
  });
});

describe('foldTraceRead (following an open trace)', () => {
  const loading: TraceView = { state: 'loading', events: [] };

  it('a successful read replaces the list, including with an empty one', () => {
    const first = foldTraceRead(loading, { events: [ev({ seq: 1 })] });
    expect(first).toEqual({ state: 'ready', events: [ev({ seq: 1 })] });
    expect(foldTraceRead(first, { events: [] })).toEqual({ state: 'ready', events: [] });
  });

  it('a failed refresh keeps the last list', () => {
    const shown = foldTraceRead(loading, { events: [ev({ seq: 1 })] });
    expect(foldTraceRead(shown, null)).toBe(shown);
  });

  it('a read that never succeeded says so', () => {
    expect(foldTraceRead(loading, null).state).toBe('error');
  });
});
