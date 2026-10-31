import {
  appQuestionAnswerSigningBytes,
  questionKeyEnrollBytes,
} from '@musterd/protocol/app-channel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import { buildQuestionKeyEnroll, signQuestionAnswer } from './questionKey';

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    questionPublicKey: vi.fn(async () => `B${'Q'.repeat(86)}`),
    sign: vi.fn(async () => 'signed-by-face-id'),
    signQuestion: vi.fn(async () => 'signed-silently'),
  },
}));

const pin: PairingPin = {
  v: 1,
  identity: 'I'.repeat(43),
  receive: 'C'.repeat(87),
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

beforeEach(() => vi.clearAllMocks());

describe('buildQuestionKeyEnroll', () => {
  it('signs the question key with the Face ID key, over the enrollment bytes', async () => {
    const enroll = await buildQuestionKeyEnroll({ pin, nonce: 'n'.repeat(16) });
    expect(enroll).toEqual({
      v: 1,
      binding: 'bind-1',
      question_key: `B${'Q'.repeat(86)}`,
      nonce: 'n'.repeat(16),
      signature: 'signed-by-face-id',
    });
    expect(phoneKeys.sign).toHaveBeenCalledWith(
      questionKeyEnrollBytes({
        team: 'revive',
        binding: 'bind-1',
        question_key: `B${'Q'.repeat(86)}`,
        nonce: 'n'.repeat(16),
      }),
    );
    expect(phoneKeys.signQuestion).not.toHaveBeenCalled();
  });

  it('enrolls nothing before the phone has a binding', async () => {
    const { binding: _binding, ...unbound } = pin;
    expect(await buildQuestionKeyEnroll({ pin: unbound, nonce: 'n'.repeat(16) })).toBeNull();
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });
});

describe('signQuestionAnswer', () => {
  const base = { pin, ask: 'q1', token: 't1', nonce: 'nonce-1' };

  it('signs silently with the question key, over the question-answer bytes', async () => {
    const answer = { choice: 1, text: 'ship it\nafter lunch' };
    const signed = await signQuestionAnswer({ ...base, answer });
    expect(signed).toEqual({
      v: 1,
      token: 't1',
      answer,
      nonce: 'nonce-1',
      key: 'question',
      signature: 'signed-silently',
    });
    expect(phoneKeys.signQuestion).toHaveBeenCalledWith(
      appQuestionAnswerSigningBytes({
        team: 'revive',
        binding: 'bind-1',
        ask: 'q1',
        token: 't1',
        nonce: 'nonce-1',
        answer,
      }),
    );
    // PhoneKeys.signQuestion refuses any message without this first line.
    expect(vi.mocked(phoneKeys.signQuestion).mock.calls[0]?.[0]).toMatch(
      /^musterd-app-question-answer\/v1\n/,
    );
    // Never the Face ID key: a question answer is not a decision.
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });

  it('refuses an empty answer and signs nothing', async () => {
    expect(await signQuestionAnswer({ ...base, answer: {} })).toBeNull();
    expect(await signQuestionAnswer({ ...base, answer: { text: '' } })).toBeNull();
    expect(phoneKeys.signQuestion).not.toHaveBeenCalled();
  });

  it('refuses a choice past the nine options', async () => {
    expect(await signQuestionAnswer({ ...base, answer: { choice: 9 } })).toBeNull();
  });
});
