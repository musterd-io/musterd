import { describe, expect, it } from 'vitest';
import { GLOBAL_FLAGS, parseArgs, rejectUnknownFlags } from './args.js';

/**
 * Lane `01M5D5J8HQG688C0QWEN0633H2`. On 2026-10-20 a seat's messages went out with zero bytes
 * three times: `musterd send` takes its body POSITIONALLY, and `--body` is not a flag it knows — so
 * the parser took "text" as `--body`'s VALUE, dropped it, and the command sent an act with an
 * empty body while reporting success. The recipient saw nothing and the sender saw "sent".
 */
describe('rejectUnknownFlags', () => {
  it('refuses a flag the command does not know', () => {
    expect(() => rejectUnknownFlags({ body: 'text' }, ['to', 'act'], 'the shape')).toThrow(
      /unknown flag --body for this command/,
    );
  });

  it('names the shape, so the mistake is fixable at once', () => {
    expect(() => rejectUnknownFlags({ body: 'text' }, [], 'the body is positional')).toThrow(
      /the body is positional/,
    );
  });

  it('passes when every flag is known', () => {
    expect(() =>
      rejectUnknownFlags({ to: 'stanley', act: 'message' }, ['to', 'act'], 'the shape'),
    ).not.toThrow();
  });

  it('the global flags are known to every command', () => {
    for (const name of GLOBAL_FLAGS) {
      expect(() => rejectUnknownFlags({ [name]: true }, GLOBAL_FLAGS, 'the shape')).not.toThrow();
    }
  });

  it('is what stops the body from vanishing: the parser takes the value, the command refuses it', () => {
    // The two halves, in order: the parser cannot know `--body` is not a flag, so it eats the value.
    const parsed = parseArgs(['--to', 'stanley', '--act', 'message', '--body', 'the words']);
    expect(parsed.positionals).toEqual([]); // the words are gone — this is the bug
    // …and the command refuses the flag rather than sending the empty act.
    expect(() => rejectUnknownFlags(parsed.flags, ['to', 'act'], 'the shape')).toThrow(
      /unknown flag --body/,
    );
  });
});
