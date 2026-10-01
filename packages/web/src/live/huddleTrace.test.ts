import type { HuddleTrace } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { seatPath } from './huddleTrace';

const t0 = 1_790_879_035_791;
const trace: HuddleTrace = {
  huddle: { id: '01R', topic: 'goal:demo', anchor: 'x', opener: 'izzo', opened_at: t0, body: 'b', closed: null },
  seats: [
    {
      seat: 'miley',
      harness: 'claude-code',
      summoned: 'named',
      summoned_at: t0,
      summoned_by: '01R',
      wake: { lease_id: 'l', leased_at: t0 + 1_000, spawned_at: t0 + 3_000, session: 'resumed', outcome: 'woke', duration_ms: 81_000, cost_usd: 0.4 },
      first_turn_at: t0 + 84_000,
      time_to_turn_ms: 84_000,
    },
    { seat: 'ghost', harness: null, summoned: 'named', summoned_at: t0, summoned_by: '01R', wake: null, first_turn_at: null, time_to_turn_ms: null },
  ],
  events: [
    { ts: t0, seat: 'izzo', kind: 'act', label: 'opened' },
    { ts: t0 + 1_000, seat: 'miley', kind: 'wake', label: 'leased' },
    { ts: t0 + 40_000, seat: 'miley', kind: 'tool', label: 'PreToolUse', tool_name: 'mcp__musterd__team_inbox_check', outcome: 'ok', duration_ms: 420 },
    { ts: t0 + 20_000, seat: 'miley', kind: 'hook', label: 'SessionStart' },
    { ts: t0 + 60_000, seat: 'miley', kind: 'tool', label: 'Bash', tool_name: 'Bash', outcome: 'error', duration_ms: 2_400 },
    { ts: t0 + 84_000, seat: 'miley', kind: 'act', label: 'turn', act_id: '01T' },
    { ts: t0 + 50_000, seat: 'ghost', kind: 'tool', label: 'Read', tool_name: 'Read' },
  ],
  truncated: false,
};

describe('seatPath — one seat through a huddle (ADR 493)', () => {
  it('opens with the wake, then every tool/hook row for that seat, in time order', () => {
    const p = seatPath(trace, 'miley');
    expect(p.map((l) => l.kind)).toEqual(['wake', 'hook', 'tool', 'tool']);
    expect(p[0]).toMatchObject({ text: 'woke · resumed session', since: '+3s', note: 'ran 81.0s' });
    expect(p[2]).toMatchObject({ text: 'mcp__musterd__team_inbox_check', note: '420ms' });
  });

  it('says an outcome only when it was not ok', () => {
    expect(seatPath(trace, 'miley')[3]).toMatchObject({ text: 'Bash', note: 'error · 2.4s' });
  });

  it('leaves out the acts (the turn is already the card line) and other seats', () => {
    const p = seatPath(trace, 'ghost');
    expect(p).toEqual([{ ts: t0 + 50_000, since: '+50s', kind: 'tool', text: 'Read' }]);
  });
});
