import { describe, expect, it } from 'vitest';
import { parseArgs } from './sweep.ts';

describe('parseArgs full-text sweep flags', () => {
  it('requires triage for full-text reads and accepts an explicit retry limit', () => {
    expect(parseArgs(['--full-text', '--triage', '--retry-limit', '50'])).toMatchObject({
      fullText: true,
      triage: true,
      retryLimit: 50,
    });
    expect(() => parseArgs(['--full-text'])).toThrow(/--triage/);
  });

  it('rejects invalid retry limits', () => {
    expect(() => parseArgs(['--retry-limit', '0'])).toThrow(/--retry-limit/);
  });
});
