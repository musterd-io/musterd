import { describe, expect, it } from 'vitest';
import { PRICE_ROWS, priceRowFor, priceUsage } from './prices.js';

describe('host price table (ADR 583 Consequences — one table, dated provenance, no guesses)', () => {
  it('matches the longest prefix, so a dated model row beats its family fallback', () => {
    expect(priceRowFor('claude-opus-5-5')?.prefix).toBe('claude-opus-5-5');
    expect(priceRowFor('claude-opus-4-8')?.prefix).toBe('claude-opus');
    expect(priceRowFor('Claude-Sonnet-5-5 ')?.prefix).toBe('claude-sonnet-5-5');
  });

  it('prices input, output, cache read and cache write from the row', () => {
    // haiku-5-5: $0.10 in / $0.50 out; cache read 0.1×, write 1.25× of input.
    const usd = priceUsage('claude-haiku-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 6);
  });

  it('an unknown model prices to undefined — the ledger records no_price_row, never a guess', () => {
    expect(priceUsage('muse-spark-1.3', { input_tokens: 10, output_tokens: 10 })).toBeUndefined();
    expect(priceUsage('', { input_tokens: 10 })).toBeUndefined();
  });

  it('every row names where its number was read', () => {
    for (const row of PRICE_ROWS) expect(row.source).toMatch(/20\d\d/);
  });
});
