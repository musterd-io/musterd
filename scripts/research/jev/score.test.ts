import { describe, expect, it } from 'vitest';
import { redact, isGenerated } from './dataset.ts';
import type { Item } from './dataset.ts';
import { frame } from './questions.ts';
import type { Answer } from './run.ts';
import {
  argmax,
  brier,
  ece,
  fitTemperature,
  keep,
  pickCutoff,
  queueReport,
  temper,
  wilsonLow,
} from './score.ts';

describe('jev offline judge — pure halves', () => {
  it('ECE is 0 for a perfectly calibrated set and large for a confidently wrong one', () => {
    const right = Array.from({ length: 10 }, () => ({ p: { a: 1, b: 0 }, truth: 'a' }));
    const wrong = Array.from({ length: 10 }, () => ({ p: { a: 1, b: 0 }, truth: 'b' }));
    expect(ece(right)).toBeCloseTo(0);
    expect(ece(wrong)).toBeCloseTo(1);
    expect(brier(wrong)).toBeCloseTo(2);
  });

  it('temperature fit softens an overconfident judge (T > 1) and never changes the argmax', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      p: { a: 0.99, b: 0.01 },
      truth: i % 2 ? 'a' : 'b',
    }));
    const t = fitTemperature(rows);
    expect(t).toBeGreaterThan(1);
    expect(argmax(temper({ a: 0.7, b: 0.3 }, t))).toBe('a');
  });

  it('renamed framing maps opaque keys back to the same canonical option', () => {
    const f = frame('act_choice', 'renamed', 'seed');
    const keys = Object.keys((f.question as { criteria: Record<string, string> }).criteria);
    expect(keys.every((k) => k.startsWith('option_'))).toBe(true);
    expect(new Set(keys.map(f.toCanonical))).toContain('handoff');
    const n = frame('owes_reply', 'renamed', 'seed');
    expect(n.pYes!(0.2)).toBeCloseTo(0.8);
  });

  it('redact pseudonymises names, masks ULIDs, scrubs credentials; generated bodies are excluded', () => {
    const out = redact(
      'dolly to Ryder: lane 01M3QCVE6EKF004X9PXM274HY6 key mskey_abcdefghijklmnopqrstuvwxyz0123',
      ['dolly', 'ryder'],
    );
    expect(out).not.toMatch(/dolly|ryder|01M3QCVE|mskey_abc/i);
    expect(out).toContain('<id>');
    expect(isGenerated('[lane] claimed x', {})).toBe(true);
    expect(isGenerated('a real body that is long enough', { lane_warning: {} })).toBe(true);
  });
});

describe('jev review queue — finding 014', () => {
  // 10 confident-right, 10 unsure (half right) — the queue keeps the confident ten.
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, p: { a: 0.97, b: 0.03 }, truth: 'a' })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `u${i}`,
      p: { a: 0.55, b: 0.45 },
      truth: i % 2 ? 'a' : 'b',
    })),
  ];

  it('keeps only answers at or above the cut-off and scores them', () => {
    expect(keep(rows, 0.9)).toEqual({ kept: 10, correct: 10, coverage: 0.5, acc: 1 });
    expect(keep(rows, 0.5)).toMatchObject({ kept: 20, correct: 15, coverage: 1, acc: 0.75 });
  });

  it('the framing guard drops an item whose renamed answer disagrees or is missing', () => {
    const agree = new Map(rows.map((r) => [r.id, 'a']));
    agree.set('c0', 'b');
    agree.delete('c1');
    expect(keep(rows, 0.9, agree)).toMatchObject({ kept: 8, correct: 8 });
  });

  it('picks the lowest cut-off that reaches 90% on kept items, and none when nothing does', () => {
    expect(pickCutoff(rows)).toBe(0.6);
    const allWrong = rows.map((r) => ({ ...r, truth: 'b' }));
    expect(pickCutoff(allWrong)).toBeNull();
    // too few kept to count as evidence, even at 100%
    expect(pickCutoff(rows.slice(0, 5))).toBeNull();
  });

  it('Wilson lower bound sits below the point estimate and is 0 for no data', () => {
    expect(wilsonLow(0, 0)).toBe(0);
    expect(wilsonLow(10, 10)).toBeLessThan(1);
    expect(wilsonLow(10, 10)).toBeGreaterThan(0.69);
  });

  it('queueReport chooses on tune, measures on test, and applies the pre-registered bar', () => {
    const items: Item[] = rows.flatMap((r) =>
      (['tune', 'test'] as const).map((split) => ({
        id: `${split}-${r.id}`,
        question: 'act_choice' as const,
        text: '',
        truth: r.truth,
        split,
      })),
    );
    const answers: Answer[] = items.flatMap((i) => {
      const r = rows.find((x) => i.id.endsWith(`-${x.id}`))!;
      return (['canonical', 'renamed'] as const).map((framing) => ({
        item: i.id,
        backend: 'test',
        framing,
        // the renamed framing flips every confident test answer
        probs:
          framing === 'renamed' && i.split === 'test' && r.id.startsWith('c')
            ? { a: 0.1, b: 0.9 }
            : r.p,
        ms: 1,
      }));
    });
    const plain = queueReport(items, answers, 'act_choice', 'confidence');
    expect(plain).toMatchObject({ n: 20, cut: 0.6, kept: 10, acc: 1, verdict: 'pass' });
    const guarded = queueReport(items, answers, 'act_choice', 'confidence+framing');
    expect(guarded).toMatchObject({ cut: 0.6, kept: 0, verdict: 'reject' });
    expect(queueReport(items, answers, 'owes_reply', 'confidence').verdict).toBe('no data');
  });
});
