import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMuseSessionLog, parseMuseSessionLog, readMuseWakeUsage } from './museUsage.js';

/** Token counts from the 2026-10-16 credentialed run recorded in ADR 619. No prose. */
const MEASURED = {
  payload: {
    event: {
      kind: 'model_completed',
      model: 'muse-wonder-1.0',
      usage: {
        input_tokens: 28411,
        output_tokens: 16,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        reasoning_tokens: 5,
      },
    },
  },
};

function line(usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    payload: { event: { kind: 'model_completed', usage, ...extra } },
  });
}

describe('parseMuseSessionLog', () => {
  it('maps the measured model_completed usage onto WakeUsage', () => {
    expect(parseMuseSessionLog(JSON.stringify(MEASURED))).toEqual({
      input_tokens: 28411,
      output_tokens: 16,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 5,
    });
  });

  it('uses cached_tokens when the older keyset has no cache_read_tokens', () => {
    expect(
      parseMuseSessionLog(
        line({ input_tokens: 10, output_tokens: 2, cached_tokens: 4, reasoning_tokens: 1 }),
      ),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cached_input_tokens: 4,
      reasoning_output_tokens: 1,
    });
  });

  it('prefers cache_read_tokens over cached_tokens so the two are not summed', () => {
    expect(
      parseMuseSessionLog(
        line({
          input_tokens: 3,
          output_tokens: 1,
          cached_tokens: 100,
          cache_read_tokens: 7,
          cache_write_tokens: 2,
          reasoning_tokens: 0,
        }),
      )?.cached_input_tokens,
    ).toBe(7);
  });

  it('sums every model_completed in the session and skips a bad line', () => {
    const text = [
      '{"not":"a model event"}',
      'not json',
      line({ input_tokens: 10, output_tokens: 1, cached_tokens: 2, reasoning_tokens: 1 }),
      line({
        input_tokens: 'lots',
        output_tokens: 1,
      } as unknown as Record<string, number>),
      line({
        input_tokens: 5,
        output_tokens: 4,
        cached_tokens: 9,
        cache_read_tokens: 3,
        cache_write_tokens: 1,
        reasoning_tokens: 2,
      }),
    ].join('\n');
    expect(parseMuseSessionLog(text)).toEqual({
      input_tokens: 15,
      output_tokens: 5,
      cached_input_tokens: 5,
      cache_write_input_tokens: 1,
      reasoning_output_tokens: 3,
    });
  });

  it('is undefined when nothing completed a model — never zeros', () => {
    expect(parseMuseSessionLog('')).toBeUndefined();
    expect(parseMuseSessionLog('not json\n{"payload":{}}')).toBeUndefined();
  });
});

describe('readMuseWakeUsage', () => {
  it('reads the session id under the date tree and ignores a sibling and a subagent log', () => {
    const root = mkdtempSync(join(tmpdir(), 'muse-data-'));
    const mine = join(root, 'sessions', '2026', '10', '16', 'ses-mine');
    const other = join(root, 'sessions', '2026', '10', '16', 'ses-other');
    const sub = join(mine, 'subagent', 'child');
    mkdirSync(sub, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(mine, 'session.jsonl'),
      line({ input_tokens: 8, output_tokens: 3, cached_tokens: 1, reasoning_tokens: 0 }),
    );
    writeFileSync(
      join(other, 'session.jsonl'),
      line({ input_tokens: 999, output_tokens: 999, cached_tokens: 0, reasoning_tokens: 0 }),
    );
    writeFileSync(
      join(sub, 'session.jsonl'),
      line({ input_tokens: 5000, output_tokens: 5000, cached_tokens: 0, reasoning_tokens: 0 }),
    );
    expect(findMuseSessionLog('ses-mine', root)).toBe(join(mine, 'session.jsonl'));
    expect(readMuseWakeUsage('ses-mine', root)).toEqual({
      input_tokens: 8,
      output_tokens: 3,
      cached_input_tokens: 1,
      reasoning_output_tokens: 0,
    });
  });

  it('refuses a path-shaped id and a missing log', () => {
    const root = mkdtempSync(join(tmpdir(), 'muse-data-'));
    mkdirSync(join(root, 'sessions'), { recursive: true });
    expect(readMuseWakeUsage('../etc', root)).toBeUndefined();
    expect(readMuseWakeUsage('a/b', root)).toBeUndefined();
    expect(readMuseWakeUsage('..', root)).toBeUndefined();
    expect(readMuseWakeUsage('ses-missing', root)).toBeUndefined();
    expect(findMuseSessionLog('ses/../other', root)).toBeUndefined();
  });
});
