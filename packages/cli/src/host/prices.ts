/**
 * The provider list-price table the host prices model calls from (ADR 583 Consequences: one table,
 * dated provenance per row, an unknown model prices to `undefined` and the ledger records
 * `no_price_row` — never a guess). Shared by the native engine's turn pricing (ADR 251 §6) and
 * the metering gateway (ADR 583 §2), so a wake priced either way reconciles against the same rows.
 *
 * Rows match on model-id PREFIX, longest prefix first, so `claude-opus-5-5` can carry its own row
 * beside a `claude-opus` fallback. Prices are USD per million tokens. Cache read / write are
 * multipliers on the input rate (Anthropic: 0.1× / 1.25× at the 5m TTL; OpenAI: cached input is
 * 0.1× for the GPT-5.x line; xAI: cached input 0.25×). Every row names where its number was read
 * and when — stale rows misprice a wake rather than leaving it unpriced, so the date is the audit.
 * Cache multipliers are per row because they differ per model (ADR 583 lane research, 2026-10-13).
 */
export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface PriceRow {
  prefix: string;
  /** USD per MTok. */
  input: number;
  output: number;
  /** Multipliers on `input`. */
  cacheRead: number;
  cacheWrite: number;
  /** Where the number was read, and when. */
  source: string;
}

const row = (
  prefix: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  source: string,
): PriceRow => ({ prefix, input, output, cacheRead, cacheWrite, source });

const ANTHROPIC_SRC = 'platform.claude.com/docs/en/about-claude/pricing, read 2026-10-13';
const OPENAI_SRC = 'developers.openai.com/api/docs/pricing, read 2026-10-13';
const XAI_SRC = 'docs.x.ai/developers/pricing, read 2026-10-13 (<200k-prompt tier)';
const OPENCODE_SRC =
  'models.dev/api.json `opencode` (Zen) / `opencode-go` provider cost, read 2026-10-19 (≤200k-context tier)';
const MUSE_SRC =
  'dev.meta.ai/docs/pricing-rate-limits (Muse Wonder $4/$20/$0.20 standard; contributor n/a) + /products/muse-code (Muse Spark), read 2026-10-16';

/** The table. Keep provider rows together; the lookup sorts by prefix length, not by position.
 *  Long-context tiers (Anthropic >100k on Haiku, OpenAI >272k, xAI ≥200k) are NOT modelled: a
 *  wake over them is under-priced by the tier ratio, and the row's source says which tier it is. */
export const PRICE_ROWS: readonly PriceRow[] = [
  // Anthropic — cache read 0.1× standard, 0.05× on Opus/Sonnet 5.5, 0.025× on Fable 5.1; 5m write 1.25×.
  row('claude-fable-5-1', 10, 50, 0.025, 1.25, ANTHROPIC_SRC),
  row('claude-fable', 10, 50, 0.1, 1.25, ANTHROPIC_SRC),
  row('claude-mythos', 10, 50, 0.1, 1.25, ANTHROPIC_SRC),
  row('claude-opus-5-5', 4, 20, 0.05, 1.25, ANTHROPIC_SRC),
  row('claude-opus', 5, 25, 0.1, 1.25, 'the phase-1 native engine table, 2026-08-12 (ADR 251)'),
  row('claude-sonnet-5-5', 2, 10, 0.05, 1.25, ANTHROPIC_SRC),
  row('claude-sonnet', 3, 15, 0.1, 1.25, 'the phase-1 native engine table, 2026-08-12 (ADR 251)'),
  row('claude-haiku-5-5', 0.1, 0.5, 0.1, 1.25, `${ANTHROPIC_SRC} (≤100k-prompt tier)`),
  row('claude-haiku', 1, 5, 0.1, 1.25, 'the phase-1 native engine table, 2026-08-12 (ADR 251)'),
  // OpenAI — cached input as the page's own ratio; no cache-write charge.
  row('gpt-6-astra', 10, 50, 0.1, 0, OPENAI_SRC),
  row('gpt-6.1-sol', 2, 10, 0.05, 0, OPENAI_SRC),
  row('gpt-6-sol', 2, 10, 0.1, 0, OPENAI_SRC),
  row('gpt-6-luna', 0.1, 0.5, 0.1, 0, OPENAI_SRC),
  row('gpt-5.6-sol', 4, 20, 0.1, 0, `${OPENAI_SRC} (promotional through 2026-11-21)`),
  row('gpt-5.6-terra', 2, 12, 0.1, 0, OPENAI_SRC),
  row('gpt-5.6-luna', 0.2, 1.2, 0.1, 0, OPENAI_SRC),
  // xAI — cached input 0.25×; no cache-write charge.
  row('grok-4.7', 2, 6, 0.25, 0, XAI_SRC),
  row('grok-4.6', 2, 6, 0.25, 0, XAI_SRC),
  row('grok-build', 1, 2, 0.2, 0, XAI_SRC),
  // Meta — contributor tier pays 0.02× input on cache read; standard 0.12×; no cache-write
  // charge published. Contributor and standard are distinct model ids, hence distinct rows —
  // longest-prefix match keeps them apart.
  row('muse-spark-1.3-contributor', 0.1, 0.2, 0.02, 0, MUSE_SRC),
  row('muse-spark-1.3', 1.25, 4.25, 0.12, 0, MUSE_SRC),
  row('muse-spark-1.2-contributor', 0.1, 0.2, 0.02, 0, MUSE_SRC),
  row('muse-spark-1.2', 1.25, 4.25, 0.12, 0, MUSE_SRC),
  // Meta — Muse Wonder (published 2026-10-16): $4.00/M input, $20.00/M output,
  // $0.20/M cached input, no cache-write. cacheRead is a fraction of the input
  // price, so $0.20 / $4.00 = 0.05 (0.2 would bill cached tokens at $0.80/M).
  // Meta publishes no contributor arm for Wonder; the contributor-tagged runtime
  // id therefore mirrors the standard rate (owner decision 2026-10-16).
  // Longest-prefix keeps the two rows apart.
  row('muse-wonder-1.0-contributor', 4.0, 20.0, 0.05, 0, MUSE_SRC),
  row('muse-wonder-1.0', 4.0, 20.0, 0.05, 0, MUSE_SRC),
  // OpenCode-hosted models our OpenCode seats run (presence attestations, 2026-10-05..19), as the
  // gateway's opencode / opencode-go routes see them. A `-free` model is $0 there; its row also
  // keeps it from falling into a paid prefix (`muse-spark-1.3-contributor-free` priced as the paid
  // contributor row before this). Cache read is the listed cached rate over the input rate.
  row('muse-spark-1.3-contributor-free', 0, 0, 0, 0, OPENCODE_SRC),
  row('muse-spark-1.2-contributor-free', 0, 0, 0, 0, OPENCODE_SRC),
  row('minimax-m3.1-flash-free', 0, 0, 0, 0, OPENCODE_SRC),
  row('beam-free', 0, 0, 0, 0, OPENCODE_SRC),
  row('cat-jam-free', 0, 0, 0, 0, OPENCODE_SRC),
  row('gemini-4-argon-contributor', 4, 20, 0.05, 0, OPENCODE_SRC),
  row('gemini-3.8-flash', 1.5, 7.5, 0.1, 0, OPENCODE_SRC),
  row('kimi-k3', 3, 15, 0.1, 0, OPENCODE_SRC),
];

/** The row a model id prices by: the longest matching prefix, or undefined. */
export function priceRowFor(
  model: string,
  rows: readonly PriceRow[] = PRICE_ROWS,
): PriceRow | undefined {
  const normalized = model.trim().toLowerCase();
  let best: PriceRow | undefined;
  for (const row of rows) {
    if (!normalized.startsWith(row.prefix)) continue;
    if (!best || row.prefix.length > best.prefix.length) best = row;
  }
  return best;
}

/** Price one call's usage in USD from the table; undefined when the model has no row. */
export function priceUsage(
  model: string,
  usage: UsageLike,
  rows: readonly PriceRow[] = PRICE_ROWS,
): number | undefined {
  const row = priceRowFor(model, rows);
  if (!row) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * row.input +
      output * row.output +
      read * row.cacheRead * row.input +
      write * row.cacheWrite * row.input) /
    1e6
  );
}
