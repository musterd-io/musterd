import { describe, expect, it } from 'vitest';
import { summarise, type Reply } from './sycophancy-readout.js';

/**
 * The definitions and their tests live in `@musterd/protocol` (`sycophancy.ts`, ADR 481). This file
 * guards only the script's own shape, so `--json` output stays comparable across reads.
 */
const reply = (over: Partial<Reply>): Reply => ({
  id: 'r',
  seat: 'kimi',
  act: 'message',
  body: '',
  parentAct: null,
  ...over,
});

describe('summarise (script shape over the protocol block)', () => {
  it('keeps concessions / challengeAnswers / bySeat', () => {
    const r = summarise([
      reply({ act: 'accept', parentAct: 'challenge', body: 'fine' }),
      reply({ act: 'decline', parentAct: 'challenge', body: 'no: `pnpm test` fails' }),
    ]);
    expect(r).toEqual({
      concessions: { challenge: { unverified: 1, n: 1 }, phrase: { unverified: 0, n: 0 } },
      challengeAnswers: { declines: 1, answered: 2 },
      bySeat: [
        { seat: 'kimi', challenge: { unverified: 1, n: 1 }, phrase: { unverified: 0, n: 0 } },
      ],
    });
  });
});
