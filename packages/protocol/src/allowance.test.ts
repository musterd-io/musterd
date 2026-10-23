import { describe, expect, it } from 'vitest';
import { AllowancePostSchema, AllowanceViewSchema } from './allowance.js';

const percent = { name: '5h', left: 0.38, resetsAt: 20, kind: 'percent' as const };

const account = {
  provider: 'claude' as const,
  account: 'abcdef0123456789',
  label: 'Claude Max',
  readAt: 10,
  windows: [percent],
};

describe('AllowancePostSchema', () => {
  it('accepts a percent account', () => {
    expect(AllowancePostSchema.safeParse({ accounts: [account] }).success).toBe(true);
  });

  it('rejects a token field instead of stripping it', () => {
    const extra = AllowancePostSchema.safeParse({
      accounts: [{ ...account, accessToken: 'sk-nope' }],
    });
    expect(extra.success).toBe(false);
  });

  it('requires 16 lowercase hex for the account key', () => {
    expect(
      AllowancePostSchema.safeParse({ accounts: [{ ...account, account: 'abc' }] }).success,
    ).toBe(false);
    expect(
      AllowancePostSchema.safeParse({
        accounts: [{ ...account, account: 'ABCDEF0123456789' }],
      }).success,
    ).toBe(false);
  });

  it('keeps counts on an amount window and refuses them on a percent window', () => {
    const amount = {
      ...account,
      provider: 'elevenlabs' as const,
      windows: [
        {
          name: 'characters',
          left: 0.4,
          resetsAt: null,
          kind: 'amount' as const,
          used: 1000,
          limit: 10000,
          unit: 'characters',
        },
      ],
    };
    expect(AllowancePostSchema.safeParse({ accounts: [amount] }).success).toBe(true);
    expect(
      AllowancePostSchema.safeParse({
        accounts: [{ ...account, windows: [{ ...percent, used: 62 }] }],
      }).success,
    ).toBe(false);
  });
});

describe('AllowanceViewSchema', () => {
  it('carries the windows and refuses the account key', () => {
    const view = {
      readAt: 10,
      accounts: [
        {
          provider: 'claude' as const,
          label: 'Claude Max',
          readAt: 10,
          windows: [percent],
        },
      ],
    };
    expect(AllowanceViewSchema.safeParse(view).success).toBe(true);
    expect(
      AllowanceViewSchema.safeParse({
        ...view,
        accounts: [{ ...view.accounts[0], account: account.account }],
      }).success,
    ).toBe(false);
  });
});
