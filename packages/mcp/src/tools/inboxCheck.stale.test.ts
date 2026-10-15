import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { STALE_OBLIGATION_MS, planInboxCheck } from './inboxCheck.js';

/**
 * ADR 599 — a stale obligation folds to a counted line; it is never dropped and never expires.
 *
 * Measured 2026-10-14 (alfie, lane 01M4YYQCAP): eight directed asks from August sat at the top of
 * every read, in full, with 15.5k unread behind them. The pinned set has no clock — right, because
 * nothing but an answer discharges an obligation — but a reader owed the same eight acts for two
 * months is not helped by reading them in full on every check. So an obligation older than a week
 * moves out of the full-row budget into its own one-line group with a count, below the fresh pins.
 */

const NOW = 10_000_000_000;
const WEEK = STALE_OBLIGATION_MS;

function ask(id: string, age: number): Envelope {
  return {
    id,
    from: 'izzo',
    act: 'ask',
    body: `ask ${id}`,
    ts: NOW - age,
    to: { kind: 'member', name: 'Ada' },
    meta: { species: 'consult', tier: 'standard' },
  } as Envelope;
}

describe('ADR 599: stale obligations fold', () => {
  it('folds an obligation older than a week into `stale`, keeps a fresh one in `shown`', () => {
    const plan = planInboxCheck(
      [ask('old', WEEK * 8), ask('fresh', 1000)],
      50,
      0,
      [],
      [],
      new Set(),
      undefined,
      NOW,
    );
    expect(plan.shown.map((e) => e.id)).toEqual(['fresh']);
    expect(plan.stale.map((e) => e.id)).toEqual(['old']);
    expect(plan.elided).toBe(0);
  });

  it('a stale row is rendered, so the cursor walks it (ADR 287)', () => {
    const rows = [ask('old', WEEK * 8), ask('fresh', 1000)];
    const plan = planInboxCheck(rows, 50, 0, [], rows, new Set(), undefined, NOW);
    expect(plan.advanceTo).toBe('fresh');
  });

  it('oldest first inside the stale group', () => {
    const plan = planInboxCheck(
      [ask('b', WEEK * 2), ask('a', WEEK * 9)],
      50,
      0,
      [],
      [],
      new Set(),
      undefined,
      NOW,
    );
    expect(plan.stale.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('exactly a week old is still fresh', () => {
    const plan = planInboxCheck([ask('edge', WEEK)], 50, 0, [], [], new Set(), undefined, NOW);
    expect(plan.shown.map((e) => e.id)).toEqual(['edge']);
    expect(plan.stale).toEqual([]);
  });
});
