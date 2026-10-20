import { describe, expect, it } from 'vitest';
import { parseArgs, rejectUnknownFlags } from './args.js';

/**
 * Lane `01M5D907S74XVT5YECNWB5VW5A` — the general layer after `01M5D5J8HQG688C0QWEN0633H2`.
 *
 * `musterd send` now refuses a flag it does not know (lane `01M5D5J8HQG`), so THAT command no
 * longer loses an argument. Every other command still does: the parser has no vocabulary, so any
 * `--name` it has not heard of takes the NEXT token as its value and drops it. `musterd lane claim
 * --lan 01M5ABC` loses the lane id; `musterd send --body "the words"` (before the narrow fix) sent
 * an act with an empty body and reported success.
 *
 * The invariant this file pins: **no argv token vanishes.** Every token the user typed ends up
 * used — a positional, a flag value, a meta pair — or named in the refusal, so the mistake is
 * fixable at once. A token that is silently gone is the whole defect.
 *
 * The two cases below FAIL on the current code. They are the falsifier: they say what the general
 * layer owes, and they are what the change must make true.
 */
describe('no argv token vanishes', () => {
  it('a flag the CLI does not know is refused, and the refusal names the value it would have eaten', () => {
    const parsed = parseArgs(['--to', 'stanley', '--act', 'message', '--body', 'the words']);
    // The parser cannot know `--body` is not a flag, so it takes the value — the words are in the
    // flags map under the unknown name, not gone. What must not happen is a refusal that drops the
    // value on the floor: the user is left not knowing WHERE THE WORDS WENT.
    expect(parsed.flags['body']).toBe('the words');
    expect(() => rejectUnknownFlags(parsed.flags, ['to', 'act'], 'the body is positional')).toThrow(
      /the words/,
    );
  });

  it('a value flag can be written --flag=value, so its value is never the next token', () => {
    // Today the name becomes "to=alfie" and the flag `to` is never set: the flag is ignored and
    // the value is lost, silently. `--to=alfie` is the form every other CLI teaches, and it is
    // the shape in which a value can never be eaten by a neighbouring flag.
    const parsed = parseArgs(['--to=alfie', '--act=message']);
    expect(parsed.flags['to']).toBe('alfie');
    expect(parsed.flags['act']).toBe('message');
    expect(Object.keys(parsed.flags)).not.toContain('to=alfie');
  });

  it('every token is accounted for: used, or named in the refusal', () => {
    const argv = ['--to', 'stanley', '--act', 'message', '--body', 'the words'];
    const known = ['to', 'act'];
    const parsed = parseArgs(argv);
    let refusal = '';
    try {
      rejectUnknownFlags(parsed.flags, known, 'the body is positional');
    } catch (e) {
      refusal = (e as Error).message;
    }
    // A token is accounted for when the command APPLIES it — a positional, a meta pair, or the
    // value of a flag the command knows — or when the refusal NAMES it. A value of a flag the
    // command does not know is not applied: the command ignores it, so the only thing that keeps
    // it from vanishing is the refusal naming it.
    const applied = new Set<string>([
      ...parsed.positionals,
      ...parsed.metaPairs,
      ...known.flatMap((k) => {
        const v = parsed.flags[k];
        return typeof v === 'string' ? [v] : [];
      }),
    ]);
    for (const token of argv) {
      if (token.startsWith('--')) continue; // the flag name itself: it is either known or refused
      const accounted = applied.has(token) || refusal.includes(token);
      expect(accounted, `token "${token}" vanished: applied=${[...applied]} refusal="${refusal}"`).toBe(
        true,
      );
    }
  });

  it('the invariant holds on every shape the parser can meet', () => {
    // The brief asks for the invariant written once and then failed on every shape: a known flag,
    // an unknown flag, and a flag whose value looks like another flag. The shape changes where the
    // token lands; it must not change whether the token survives.
    const shapes: Array<{ name: string; argv: string[]; known: string[] }> = [
      {
        name: 'a known flag',
        argv: ['--to', 'stanley', 'the words'],
        known: ['to'],
      },
      {
        name: 'an unknown flag',
        argv: ['--to', 'stanley', '--body', 'the words'],
        known: ['to'],
      },
      {
        name: 'a flag whose value looks like another flag',
        argv: ['--to', '--alfie', 'the words'],
        known: ['to'],
      },
      {
        name: 'an unknown flag at the end, with no value',
        argv: ['--to', 'stanley', '--body'],
        known: ['to'],
      },
    ];
    for (const shape of shapes) {
      const parsed = parseArgs(shape.argv);
      let refusal = '';
      try {
        rejectUnknownFlags(parsed.flags, shape.known, 'the body is positional');
      } catch (e) {
        refusal = (e as Error).message;
      }
      const applied = new Set<string>([
        ...parsed.positionals,
        ...parsed.metaPairs,
        ...shape.known.flatMap((k) => {
          const v = parsed.flags[k];
          return typeof v === 'string' ? [v] : [];
        }),
      ]);
      for (const token of shape.argv) {
        if (token.startsWith('--')) continue;
        const accounted = applied.has(token) || refusal.includes(token);
        expect(
          accounted,
          `[${shape.name}] token "${token}" vanished: applied=${[...applied]} refusal="${refusal}"`,
        ).toBe(true);
      }
    }
  });
});
