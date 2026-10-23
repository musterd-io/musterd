import { describe, expect, it } from 'vitest';
import { ALLOWANCE_QUIET_MS, allowanceLines, type AllowanceLineView } from './allowanceLine';

const NOW = 1_000_000;

function view(accounts: AllowanceLineView['accounts']): AllowanceLineView {
  return { readAt: NOW, accounts };
}

describe('allowanceLines', () => {
  it('names the tightest percent window and mutes the rest', () => {
    const lines = allowanceLines(
      view([
        {
          label: 'Claude Max',
          readAt: NOW,
          windows: [
            { name: '5h', left: 0.38, resetsAt: 2, kind: 'percent' },
            { name: 'week', left: 0.18, resetsAt: 9, kind: 'percent' },
          ],
        },
      ]),
      NOW,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('Claude Max 18% left');
    expect(lines[0]?.suffixes).toEqual(['5h 38%']);
    expect(lines[0]?.bar).toBe(18);
    expect(lines[0]?.warn).toBe(false);
    expect(lines[0]?.quiet).toBe(false);
    expect(lines[0]?.title).toContain('18% of the week window left');
    expect(lines[0]?.title).toContain('38% of the 5h window left');
  });

  it('uses warn ink under 15% left and quiets the type after two minutes', () => {
    const low = allowanceLines(
      view([
        {
          label: 'Claude Max',
          readAt: NOW,
          windows: [{ name: '5h', left: 0.14, resetsAt: null, kind: 'percent' }],
        },
      ]),
      NOW,
    );
    expect(low[0]?.warn).toBe(true);
    expect(low[0]?.text).toBe('Claude Max 14% left');
    const quiet = allowanceLines(
      view([
        {
          label: 'Claude Max',
          readAt: NOW - ALLOWANCE_QUIET_MS - 1,
          windows: [{ name: '5h', left: 0.14, resetsAt: null, kind: 'percent' }],
        },
      ]),
      NOW,
    );
    expect(quiet[0]?.quiet).toBe(true);
    expect(quiet[0]?.title).toContain('14%');
  });

  it('prints no percent for an amount window, and keeps the counts in the title', () => {
    const lines = allowanceLines(
      view([
        {
          label: 'ElevenLabs',
          readAt: NOW,
          windows: [
            {
              name: 'characters',
              left: 0.9,
              resetsAt: null,
              kind: 'amount',
              used: 1000,
              limit: 10000,
              unit: 'characters',
            },
          ],
        },
      ]),
      NOW,
    );
    expect(lines[0]?.text).toBe('ElevenLabs');
    expect(lines[0]?.text).not.toContain('%');
    expect(lines[0]?.title).toContain('9,000');
    expect(lines[0]?.title).toContain('10,000');
  });

  it('draws one line per account', () => {
    const lines = allowanceLines(
      view([
        {
          label: 'Claude Max',
          readAt: NOW,
          windows: [{ name: '5h', left: 0.38, resetsAt: 1, kind: 'percent' }],
        },
        {
          label: 'Claude Pro',
          readAt: NOW,
          windows: [{ name: '5h', left: 0.71, resetsAt: 1, kind: 'percent' }],
        },
      ]),
      NOW,
    );
    expect(lines.map((line) => line.text)).toEqual(['Claude Max 38% left', 'Claude Pro 71% left']);
  });

  it('is absent when there is no reading', () => {
    expect(allowanceLines(null, NOW)).toEqual([]);
    expect(allowanceLines(undefined, NOW)).toEqual([]);
  });
});
