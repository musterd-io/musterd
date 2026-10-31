import {
  AppCallbackSchema,
  appQuestionAnswerSigningBytes,
  questionKeyEnrollBytes,
} from '@musterd/protocol/app-channel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskDelivery } from './asks';
import type { OutboxStorage } from './outbox';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import {
  buildQuestionKeyEnroll,
  enrollQuestionKey,
  needsQuestionKey,
  sendQuestionAnswer,
  signQuestionAnswer,
} from './questionKey';

const KEY = `B${'Q'.repeat(86)}`;

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    questionPublicKey: vi.fn(async () => `B${'Q'.repeat(86)}`),
    sign: vi.fn(async () => 'signed-by-face-id'),
    signQuestion: vi.fn(async () => 'signed-silently'),
    randomNonce: vi.fn(async () => 'r'.repeat(32)),
    seal: vi.fn(async () => ({ v: 1, enc: 'ENC', ct: 'CT' })),
    questionEnrollment: vi.fn(() => null),
    saveQuestionEnrollment: vi.fn(() => true),
  },
  phoneKeysErrorCode: (e: unknown) => (e as { code?: string }).code ?? null,
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

  it('matches the Swift lock-screen signer byte for byte (logic-check.swift)', () => {
    const text = 'ship "it"\nafter\tlunch 🚀 a/b \u2028 \u007f \\ é';
    expect(
      appQuestionAnswerSigningBytes({
        team: 'revive',
        binding: 'bind-1',
        ask: 'q1',
        token: 't1',
        nonce: 'n1',
        answer: { choice: 2, text },
      }),
    ).toBe(
      'musterd-app-question-answer/v1\nrevive\nbind-1\nq1\nt1\nn1\n2\n"ship \\"it\\"\\nafter\\tlunch 🚀 a/b \u2028 \u007f \\\\ é"',
    );
  });
});

const NOW = 1_800_000_000_000;

function accepting(status = 202) {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe('enrollQuestionKey', () => {
  it('sends a question_key callback whose seal expires inside the window, then records it', async () => {
    const fetchImpl = accepting();
    expect(await enrollQuestionKey({ pin, now: NOW, fetchImpl, pauseMs: 0 })).toBe('enrolled');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://relay.example/app/revive/callback');
    const callback = AppCallbackSchema.parse(JSON.parse(String(init?.body)));
    expect(callback.kind).toBe('question_key');
    if (callback.kind !== 'question_key') throw new Error('unreachable');
    expect(callback.expires_at).toBeGreaterThan(NOW);
    expect(callback.expires_at).toBeLessThanOrEqual(NOW + 10 * 60_000);
    expect(vi.mocked(phoneKeys.seal).mock.calls[0]?.[0].purpose).toBe('question_key');
    // The nonce is the phone's own random one, never reused.
    expect(JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext).nonce).toBe(
      'r'.repeat(32),
    );
    expect(phoneKeys.saveQuestionEnrollment).toHaveBeenCalledWith(
      'bind-1',
      KEY,
      callback.expires_at,
    );
  });

  it('expires later than the last enrollment', async () => {
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValueOnce({
      binding: 'bind-1',
      key: KEY,
      expires_at: NOW + 9.5 * 60_000,
    });
    const fetchImpl = accepting();
    await enrollQuestionKey({ pin, now: NOW, fetchImpl, pauseMs: 0 });
    const callback = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body));
    expect(callback.expires_at).toBe(NOW + 9.5 * 60_000 + 1);
  });

  it('records nothing when the relay does not take it', async () => {
    const fetchImpl = accepting(503);
    expect(await enrollQuestionKey({ pin, now: NOW, fetchImpl, pauseMs: 0 })).toBe('failed');
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(2);
    expect(phoneKeys.saveQuestionEnrollment).not.toHaveBeenCalled();
  });

  it('says cancelled when Face ID does not confirm', async () => {
    vi.mocked(phoneKeys.sign).mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'biometry-failed' }),
    );
    expect(await enrollQuestionKey({ pin, now: NOW, fetchImpl: accepting(), pauseMs: 0 })).toBe(
      'cancelled',
    );
  });
});

describe('needsQuestionKey', () => {
  it('asks until this binding has enrolled this key', async () => {
    expect(await needsQuestionKey(pin)).toBe(true);
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValueOnce({
      binding: 'bind-1',
      key: KEY,
      expires_at: 1,
    });
    expect(await needsQuestionKey(pin)).toBe(false);
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValueOnce({
      binding: 'old',
      key: KEY,
      expires_at: 1,
    });
    expect(await needsQuestionKey(pin)).toBe(true);
    expect(await needsQuestionKey(null)).toBe(false);
  });
});

describe('sendQuestionAnswer', () => {
  const route = { team: 'revive', binding: 'bind-1', ref: 'q1', expires_at: NOW + 60_000 };
  const delivery = {
    v: 1,
    kind: 'ask',
    team: 'revive',
    binding: 'bind-1',
    ask: {
      id: 'q1',
      from: 'ryder',
      from_kind: 'agent',
      body: 'Which branch?',
      tier: 'advisory',
      species: null,
      action_class: 'advisory',
      ts: NOW,
      question: {
        text: 'Which branch?',
        options: [{ label: 'main' }, { label: 'next' }],
        blocking: false,
        audience: 'addressee',
        inferred: false,
      },
    },
    token: 't1',
    nonce: 'nonce-1',
    expires_at: route.expires_at,
  } as AskDelivery;
  const memory = (): OutboxStorage => {
    let value: string | null = null;
    return { get: async () => value, set: async (v) => void (value = v) };
  };

  it('signs with the Face ID key until the question key is enrolled', async () => {
    const outcome = await sendQuestionAnswer({
      pin,
      route,
      delivery,
      answer: { choice: 1 },
      fetchImpl: accepting(),
      outbox: { storage: memory(), pauseMs: 0 },
    });
    expect(outcome).toBe('sent');
    expect(phoneKeys.sign).toHaveBeenCalled();
    expect(phoneKeys.signQuestion).not.toHaveBeenCalled();
    const body = JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext);
    expect(body).toMatchObject({ key: 'signing', answer: { choice: 1 }, token: 't1' });
  });

  it('signs silently once enrolled for this binding', async () => {
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValueOnce({
      binding: 'bind-1',
      key: KEY,
      expires_at: 1,
    });
    await sendQuestionAnswer({
      pin,
      route,
      delivery,
      answer: { text: 'next, please' },
      fetchImpl: accepting(),
      outbox: { storage: memory(), pauseMs: 0 },
    });
    expect(phoneKeys.signQuestion).toHaveBeenCalled();
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });

  it('refuses an option the question does not have, and a plain ask', async () => {
    const opts = { pin, route, fetchImpl: accepting(), outbox: { storage: memory(), pauseMs: 0 } };
    expect(await sendQuestionAnswer({ ...opts, delivery, answer: { choice: 2 } })).toBe('refused');
    const { question: _q, ...plainAsk } = delivery.ask;
    expect(
      await sendQuestionAnswer({
        ...opts,
        delivery: { ...delivery, ask: plainAsk },
        answer: { choice: 0 },
      }),
    ).toBe('refused');
    expect(phoneKeys.seal).not.toHaveBeenCalled();
  });
});
