import { describe, expect, it } from 'vitest';
import { redact, isGenerated } from './dataset.ts';
import { frame } from './questions.ts';
import { argmax, brier, ece, fitTemperature, temper } from './score.ts';

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
