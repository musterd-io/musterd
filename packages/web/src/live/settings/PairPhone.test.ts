import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { countdown, qrSvg } from './PairPhone';

describe('pairing a phone from /live (lane 01M64DSBQV)', () => {
  it('draws the QR as dark modules on a white field, one module per unit', async () => {
    const text = JSON.stringify({ v: 1, pairing: 'p1', code: 'c'.repeat(43) });
    const svg = await qrSvg(text);
    const n = encode(text, { ecc: 'L', border: 4 }).data.length;
    expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`);
    expect(svg).toContain('fill="#fff"');
    const dark = encode(text, { ecc: 'L', border: 4 }).data.flat().filter(Boolean).length;
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
  });

  it('counts down in minutes and seconds, never below zero', () => {
    expect(countdown(272_000)).toBe('4:32');
    expect(countdown(1_000)).toBe('0:01');
    expect(countdown(-5_000)).toBe('0:00');
  });
});
