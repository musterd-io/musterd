import { describe, expect, it } from 'vitest';
import type { Parsed } from '../args.js';
import { claimCommand } from './claim.js';
import { doneCommand } from './done.js';
import { laneCommand } from './lane.js';

/**
 * Lane `01M5D907S74XVT5YECNWB5VW5A` — the general parser layer.
 *
 * `musterd send` refuses a flag it does not know (lane `01M5D5J8HQG688C0QWEN0633H2`). Every other
 * command still let an unknown flag take the NEXT argument as its value and drop it, so a typo
 * lost an argument silently: `musterd lane claim --lan 01M5ABC` lost the lane id.
 *
 * A command now declares the flags it reads and refuses the rest. These are the commands that
 * take ids — lane, claim and done — in alfie's order, because those are the ones where a lost
 * argument is an id.
 *
 * The refusal is the FIRST thing the command does, so this needs no server: the flag is refused
 * before anything is composed.
 */
function parsed(flags: Record<string, string | boolean>): Parsed {
  return { positionals: [], flags, metaPairs: [] };
}

describe('a command refuses a flag it does not know', () => {
  const commands = [
    { name: 'musterd lane', run: laneCommand },
    { name: 'musterd claim', run: claimCommand },
    { name: 'musterd done', run: doneCommand },
  ] as const;

  for (const cmd of commands) {
    it(`${cmd.name} refuses a flag it does not know, and says the value was not used`, async () => {
      await expect(cmd.run(parsed({ lan: '01M5ABC' }))).rejects.toThrow(
        /unknown flag --lan for this command/,
      );
      await expect(cmd.run(parsed({ lan: '01M5ABC' }))).rejects.toThrow(
        /the value after --lan was not used/,
      );
    });

    it(`${cmd.name} names the command whose flags are listed`, async () => {
      await expect(cmd.run(parsed({ bdy: 'the words' }))).rejects.toThrow(
        new RegExp(`the flags \`${cmd.name}\` takes are listed by \`musterd help`),
      );
    });

    it(`${cmd.name} does not quote the value it did not use`, async () => {
      // The CLI holds secret-bearing flags (away-token, seeds-token, slack-bot-token, tls-key,
      // sig): a mistyped one must not put a credential in the terminal (hard rule 5).
      await expect(cmd.run(parsed({ 'away-tokne': 'msgr_abcdef0123456789' }))).rejects.toThrow(
        /unknown flag --away-tokne/,
      );
      await expect(cmd.run(parsed({ 'away-tokne': 'msgr_abcdef0123456789' }))).rejects.not.toThrow(
        /msgr_abcdef0123456789/,
      );
    });
  }
});
