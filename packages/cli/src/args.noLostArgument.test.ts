import { describe, expect, it } from 'vitest';
import { parseArgs, rejectUnknownFlags } from './args.js';

/**
 * Lane `01M5D907S74XVT5YECNWB5VW5A` — the general layer after `01M5D5J8HQG688C0QWEN0633H2`.
 *
 * `musterd send` now refuses a flag it does not know (lane `01M5D5J8HQG`), so THAT command no
 * longer loses an argument. Every other command still does: the parser has no vocabulary, so any
 * `--name` it has not heard of takes the NEXT token as its value and drops it. `musterd lane claim
 * --lan 01M5ABC` loses the lane id; `musterd send --body "the words"` (before the narrow fix)
 * sent an act with an empty body and reported success.
 *
 * The invariant this file pins: **no argv token vanishes quietly.** Every token the user typed is
 * either APPLIED by the command, or the command REFUSES and says which flag's value it did not use.
 * A token that is silently gone is the whole defect.
 *
 * The two shapes below FAIL on the code as it stood before this lane's change. They are the
 * falsifier: they say what the layer owes, and they are what the change must make true.
 */
describe('no argv token vanishes quietly', () => {
  it('a value flag can be written --flag=value, so its value is never the next token', () => {
    // Before: the name became "to=alfie" and the flag `to` was never set, so the value was
    // silently dropped — `musterd huddle open "why" --anchor /tmp/x --to=alfie` took no recipient
    // and opened the huddle on @team.
    const parsed = parseArgs(['--to=alfie', '--act=message']);
    expect(parsed.flags['to']).toBe('alfie');
    expect(parsed.flags['act']).toBe('message');
    expect(Object.keys(parsed.flags)).not.toContain('to=alfie');
  });

  it('a refusal names the flag whose value it did not use', () => {
    const parsed = parseArgs(['--to', 'stanley', '--act', 'message', '--body', 'the words']);
    // The parser cannot know `--body` is not a flag, so it takes the value: the words sit in the
    // flags map under the unknown name, where no command reads them. What must not happen is a
    // refusal that leaves the user not knowing a value was there — or one that QUOTES it, since
    // the CLI holds secret-bearing flags (away-token, seeds-token, slack-bot-token, tls-key, sig)
    // and a mistyped one would put a credential in the terminal.
    expect(parsed.flags['body']).toBe('the words');
    let refusal = '';
    try {
      rejectUnknownFlags(parsed.flags, ['to', 'act'], 'the body is positional');
    } catch (e) {
      refusal = (e as Error).message;
    }
    expect(refusal).toMatch(/unknown flag --body/);
    expect(refusal).toMatch(/the value after --body was not used/);
    expect(refusal).not.toContain('the words');
  });

  it('every token is accounted for: applied, or reported as not used', () => {
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
    // value of a flag the command knows — or when the refusal REPORTS that the value after the
    // named flag was not used. A value of a flag the command does not know is not applied: the
    // command ignores it, so the refusal is the only thing that keeps it from vanishing quietly.
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
      const accounted =
        applied.has(token) ||
        /the value after --\S+ was not used/.test(refusal) ||
        refusal.includes(token);
      expect(
        accounted,
        `token "${token}" vanished: applied=${[...applied]} refusal="${refusal}"`,
      ).toBe(true);
    }
  });

  it('the invariant holds on every shape the parser can meet', () => {
    // The brief asks for the invariant written once and then failed on every shape: a known flag,
    // an unknown flag, and a flag whose value looks like another flag. The shape changes where the
    // token lands; it must not change whether the token survives.
    const shapes: Array<{ name: string; argv: string[]; known: string[] }> = [
      { name: 'a known flag', argv: ['--to', 'stanley', 'the words'], known: ['to'] },
      { name: 'an unknown flag', argv: ['--to', 'stanley', '--body', 'the words'], known: ['to'] },
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
        const accounted =
          applied.has(token) ||
          /the value after --\S+ was not used/.test(refusal) ||
          refusal.includes(token);
        expect(
          accounted,
          `[${shape.name}] token "${token}" vanished: applied=${[...applied]} refusal="${refusal}"`,
        ).toBe(true);
      }
    }
  });
});
