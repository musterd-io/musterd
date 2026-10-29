import { describe, expect, it } from 'vitest';
import { recipientInBody, requireWords } from './send.js';

/**
 * Lane `01M5D5J8HQG688C0QWEN0633H2`. An act with an empty body is stored, counts in the acts log,
 * and renders as a blank message on every surface that shows one — indistinguishable from a
 * deliberate silence. On 2026-10-20 five of a seat's acts went out that way, each reported as
 * sent, because `--body` is not a flag `musterd send` knows and the parser took the body as its
 * value.
 */
describe('requireWords', () => {
  it('refuses a message with no body, and names the shape', () => {
    expect(() => requireWords('message', '')).toThrow(/a message needs words/);
    expect(() => requireWords('message', '')).toThrow(/the body is positional/);
  });

  it('refuses a status_update with no body — a blank one reads as noise on every surface', () => {
    expect(() => requireWords('status_update', '   ')).toThrow(/a status_update needs words/);
  });

  it('lets a message with words through', () => {
    expect(() => requireWords('message', 'the words')).not.toThrow();
  });

  it('lets a decision carry no body — its meaning is the act itself', () => {
    for (const act of ['accept', 'decline', 'wait', 'resolve']) {
      expect(() => requireWords(act, '')).not.toThrow();
    }
  });
});

describe('recipientInBody', () => {
  const members = ['nick', 'Ada', 'scout'];

  it('finds a teammate named as the first word', () => {
    expect(recipientInBody(['nick', 'can', 'you', 'look?'], members)).toBe('nick');
    expect(recipientInBody(['ada', 'hi'], members)).toBe('Ada');
  });

  it('leaves a body whose first word is no member alone', () => {
    expect(recipientInBody(['shipping', 'the', 'board'], members)).toBeNull();
  });

  it('leaves a one-word body alone — a name alone is not a message to that name', () => {
    expect(recipientInBody(['nick'], members)).toBeNull();
  });
});
