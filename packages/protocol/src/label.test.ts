import { describe, expect, it } from 'vitest';
import {
  LABEL_DIVIDER,
  SEAT_CHIP,
  formatLabelWhen,
  renderSessionLabel,
  renderTerminalTitle,
  stripSessionLabel,
} from './label.js';

// A fixed "now": Sat 2026-07-25 12:00 local.
const NOW = new Date(2026, 6, 25, 12, 0).getTime();

describe('formatLabelWhen', () => {
  it('uses weekday form within six days, date form beyond', () => {
    const friday3pm = new Date(2026, 6, 24, 15, 0).getTime();
    expect(formatLabelWhen(friday3pm, NOW)).toBe('Fri 3p');

    const twoWeeksBack = new Date(2026, 6, 11, 15, 30).getTime();
    expect(formatLabelWhen(twoWeeksBack, NOW)).toBe('Jul 11 3p');
  });

  it('flips at exactly the six-day boundary (a weekday must never be ambiguous)', () => {
    const boundary = NOW - 6 * 86_400_000;
    expect(formatLabelWhen(boundary, NOW)).toMatch(/^Jul \d+ /);
    expect(formatLabelWhen(boundary + 1, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}[ap]$/);
  });

  it('renders midnight and noon as 12a / 12p', () => {
    expect(formatLabelWhen(new Date(2026, 6, 25, 0, 5).getTime(), NOW)).toBe('Sat 12a');
    expect(formatLabelWhen(new Date(2026, 6, 25, 12, 0).getTime(), NOW)).toBe('Sat 12p');
  });
});

describe('renderSessionLabel (ADR 468) / renderTerminalTitle', () => {
  const friday3pm = new Date(2026, 6, 24, 15, 0).getTime();

  it('renders seat · time · team · subject, lowercase seat, no chip', () => {
    expect(renderSessionLabel('miley', friday3pm, 'revive', 'Daemon refresh', NOW)).toBe(
      'miley · Fri 3p · revive · Daemon refresh',
    );
    expect(LABEL_DIVIDER).toBe(' · ');
  });

  it('drops the trailing divider when there is no subject to carry', () => {
    expect(renderSessionLabel('miley', friday3pm, 'revive', '   ', NOW)).toBe(
      'miley · Fri 3p · revive',
    );
  });

  it('uses the date form for a session older than six days', () => {
    const twoWeeksBack = new Date(2026, 6, 11, 15, 30).getTime();
    expect(renderSessionLabel('dolly', twoWeeksBack, 'revive', 'x', NOW)).toBe(
      'dolly · Jul 11 3p · revive · x',
    );
  });

  it('renders the terminal title lowercase, with and without a subject', () => {
    expect(renderTerminalTitle('stanley', 'agents-stanley')).toBe(
      `${SEAT_CHIP} stanley · agents-stanley`,
    );
    expect(renderTerminalTitle('stanley')).toBe(`${SEAT_CHIP} stanley`);
  });
});

describe('stripSessionLabel — the subject behind a label this seat already wrote', () => {
  it('strips the ADR 468 stem so a re-orient is idempotent', () => {
    const once = renderSessionLabel('dolly', NOW, 'revive', 'orient after mcp reload', NOW);
    expect(stripSessionLabel(once, 'dolly')).toBe('orient after mcp reload');
    expect(renderSessionLabel('dolly', NOW, 'revive', stripSessionLabel(once, 'dolly'), NOW)).toBe(
      once,
    );
  });

  it('strips the ADR 468 stem with a date-form time and a hyphenated team', () => {
    expect(stripSessionLabel('dolly · Jul 11 3p · agents-live · fix(x): y', 'dolly')).toBe(
      'fix(x): y',
    );
  });

  it('strips the pre-468 sweep grammar, chipped and dated', () => {
    expect(stripSessionLabel(`${SEAT_CHIP} Miley (Fri 3p) - MCP list`, 'miley')).toBe('MCP list');
  });

  it('strips a pre-468 label without chip, and a hand-seated title without stamp', () => {
    expect(stripSessionLabel('Stanley (Mon 9p) - ADR 153 terminal', 'stanley')).toBe(
      'ADR 153 terminal',
    );
    expect(stripSessionLabel('Miley - fix(broadcast): three things', 'miley')).toBe(
      'fix(broadcast): three things',
    );
    expect(stripSessionLabel('Ryder- ADR-158 model attestation PR', 'ryder')).toBe(
      'ADR-158 model attestation PR',
    );
  });

  it('returns a title that is not this seat’s label untouched', () => {
    expect(stripSessionLabel('Daemon refresh and MCP reload', 'miley')).toBe(
      'Daemon refresh and MCP reload',
    );
    expect(stripSessionLabel(`${SEAT_CHIP} Miley (Fri 3p) - x`, 'izzo')).toBe(
      `${SEAT_CHIP} Miley (Fri 3p) - x`,
    );
    expect(stripSessionLabel('izzo · Fri 3p · revive · x', 'dolly')).toBe(
      'izzo · Fri 3p · revive · x',
    );
    expect(stripSessionLabel("Reviewing Miley's PR", 'miley')).toBe("Reviewing Miley's PR");
  });

  it('requires a word boundary — seat "miley" does not claim "Mileystone planning"', () => {
    expect(stripSessionLabel('Mileystone planning', 'miley')).toBe('Mileystone planning');
  });

  it('a bare seat name strips to an empty subject', () => {
    expect(stripSessionLabel('Miley', 'miley')).toBe('');
    expect(stripSessionLabel('dolly · Mon 1p · revive', 'dolly')).toBe('');
  });

  it('a seat name with regex metacharacters is matched literally', () => {
    expect(stripSessionLabel('a.c - x', 'a.c')).toBe('x');
    expect(stripSessionLabel('abc - x', 'a.c')).toBe('abc - x');
  });
});
