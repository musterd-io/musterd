import { describe, expect, it } from 'vitest';
import {
  median,
  promptTokens,
  readTrigger,
  summarise,
  type HarnessRow,
  type WakeFacts,
} from './wake-contract-rail.js';

/**
 * ADR 436's wake contract rail. This file guards the ways the trigger goes quietly wrong: a floor
 * compared across harnesses that count cached tokens differently, an unsettled wake read as
 * "unpriced", a work order counted against the in-thread share, and a missing Claude Code floor
 * read as "the ratio holds".
 */
const wake = (over: Partial<WakeFacts>): WakeFacts => ({
  seat: 'ghost',
  harness: 'opencode',
  kind: 'reply',
  ts: 0,
  act: '01M3QRPZAQE94Z9B6S4SGNRJ1E',
  session: 'fresh',
  priced: false,
  unpricedReason: 'harness_price_unverified',
  priceSource: null,
  promptTokens: 100,
  musterdReads: 1,
  toolCalls: null,
  firstAct: { act: 'message', inThread: true },
  ...over,
});

describe('promptTokens — normalised per harness', () => {
  it('Claude Code: input + cache read + cache creation (the trace usage row)', () => {
    expect(
      promptTokens('claude-code', {
        input_tokens: 32,
        cache_read_tokens: 731_528,
        cache_creation_tokens: 619,
      }),
    ).toBe(732_179);
  });
  it('OpenCode reports the cached prefix beside input (ghost 2026-09-29: 62,157 + 416,904)', () => {
    expect(promptTokens('opencode', { input_tokens: 62_157, cached_input_tokens: 416_904 })).toBe(
      479_061,
    );
  });
  it('Grok and Codex report it inside input, so input alone is the whole prompt (#1650: 443,286)', () => {
    expect(promptTokens('grok', { input_tokens: 443_286, cached_input_tokens: 360_320 })).toBe(
      443_286,
    );
    expect(promptTokens('codex', { input_tokens: 1_557_224, cached_input_tokens: 1_407_744 })).toBe(
      1_557_224,
    );
  });
});

describe('median', () => {
  it('odd, even, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe('summarise', () => {
  it('an unsettled wake is neither priced nor unpriced — it is unsettled', () => {
    const [row] = summarise([wake({ priced: null, unpricedReason: null })]);
    expect(row).toMatchObject({ wakes: 1, settled: 0, priced: 0, unpricedReasons: {} });
  });

  it('a work order has no thread, so it never counts against the in-thread share', () => {
    const [row] = summarise([
      wake({
        act: 'lane:01M3QTEJ3W26CJC96PA8755BEQ',
        firstAct: { act: 'status_update', inThread: false },
      }),
      wake({ firstAct: { act: 'message', inThread: false } }),
    ]);
    expect(row!.inThread).toEqual({ yes: 0, n: 1 });
  });

  it('reads and tool calls are medians over wakes that acted; a wake with no act is counted apart', () => {
    const [row] = summarise([
      wake({ musterdReads: 0, toolCalls: 4 }),
      wake({ musterdReads: 2, toolCalls: null }),
      wake({ musterdReads: 9, firstAct: null }),
    ]);
    expect(row!.musterdReads).toEqual({ median: 1, n: 2 });
    expect(row!.toolCalls).toEqual({ median: 4, n: 1 });
    expect(row!.noAct).toBe(1);
  });
});

describe('readTrigger — ADR 436 Decision 5', () => {
  const row = (over: Partial<HarnessRow>): HarnessRow => ({
    harness: 'claude-code',
    kind: 'reply',
    wakes: 5,
    settled: 5,
    priced: 5,
    viaGateway: 0,
    unpricedReasons: {},
    floor: { median: 100_000, n: 5 },
    musterdReads: { median: 1, n: 5 },
    toolCalls: { median: 3, n: 5 },
    inThread: { yes: 5, n: 5 },
    noAct: 0,
    ...over,
  });

  it('fires when a harness has priced none of its settled wakes', () => {
    const t = readTrigger([row({}), row({ harness: 'grok', priced: 0 })]);
    expect(t.fires).toBe(true);
    expect(t.reasons).toEqual(['grok: 0/5 settled wakes priced']);
  });

  it('local wakes leave the denominator: they neither trip nor silence the priced clause (ADR 663)', () => {
    const allLocal = row({
      harness: 'opencode',
      settled: 3,
      priced: 0,
      unpricedReasons: { local: 3 },
    });
    expect(readTrigger([row({}), allLocal]).reasons).toEqual([]);
    const mixed = row({
      harness: 'opencode',
      settled: 5,
      priced: 0,
      unpricedReasons: { local: 3, harness_price_unverified: 2 },
    });
    expect(readTrigger([row({}), mixed]).reasons).toEqual(['opencode: 0/2 settled wakes priced']);
  });

  it('fires when a median floor exceeds 3× Claude Code, and holds at exactly 3×', () => {
    expect(
      readTrigger([row({}), row({ harness: 'grok', floor: { median: 300_001, n: 5 } })]).reasons,
    ).toEqual(["grok: median floor 3.0× Claude Code's"]);
    expect(
      readTrigger([row({}), row({ harness: 'grok', floor: { median: 300_000, n: 5 } })]).fires,
    ).toBe(false);
  });

  it('work orders never enter the floor ratio, but their unpriced lives still count', () => {
    const t = readTrigger([
      row({}),
      row({ kind: 'work_order', floor: { median: 10_000_000, n: 5 } }),
      row({ harness: 'grok', floor: { median: 200_000, n: 5 } }),
    ]);
    expect(t.fires).toBe(false);
    const u = readTrigger([row({}), row({ harness: 'codex', kind: 'work_order', priced: 0 })]);
    expect(u.reasons).toEqual(['codex: 0/5 settled wakes priced']);
  });

  it('summarise splits one harness into its reply and work-order rows', () => {
    const rows = summarise([
      wake({ harness: 'claude-code' }),
      wake({ harness: 'claude-code', kind: 'work_order', act: 'lane:01M3QTEJ3W26CJC96PA8755BEQ' }),
    ]);
    expect(rows.map((r) => [r.harness, r.kind])).toEqual([
      ['claude-code', 'reply'],
      ['claude-code', 'work_order'],
    ]);
  });

  it('a missing Claude Code floor is "not judged", never "holds"', () => {
    const t = readTrigger([row({ harness: 'grok' })]);
    expect(t.fires).toBe(false);
    expect(t.unjudged).toEqual(['floor ratio: no Claude Code floor to compare against']);
  });
});

describe('ADR 583 — a gateway-priced wake', () => {
  it('counts as priced via the gateway and its floor reads from the one usage shape', () => {
    const rows = summarise([
      wake({
        harness: 'grok',
        priced: true,
        unpricedReason: null,
        priceSource: 'gateway',
        promptTokens: 1500,
      }),
      wake({
        harness: 'grok',
        priced: true,
        unpricedReason: null,
        priceSource: 'harness_artifact',
        promptTokens: 900,
      }),
    ]);
    const row = rows.find((r) => r.harness === 'grok');
    expect(row!.priced).toBe(2);
    expect(row!.viaGateway).toBe(1);
    expect(
      promptTokens('gateway', {
        input_tokens: 1000,
        cached_input_tokens: 400,
        cache_write_input_tokens: 100,
      }),
    ).toBe(1500);
  });
});
