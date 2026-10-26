import { describe, expect, it } from 'vitest';
import {
  accountKey,
  claudeAccountKey,
  cursorAccountKey,
  elevenAccountKey,
  machineAccountKey,
  museAccountKey,
  openaiAccountKey,
  publicAccountId,
} from './accountKey.js';

describe('account keys', () => {
  it('collapses one public id across different refresh tokens', () => {
    const first = claudeAccountKey({
      claudeAiOauth: {
        accountUuid: 'account-uuid-1',
        refreshToken: 'refresh-a',
        accessToken: 'access-a',
      },
    });
    const second = claudeAccountKey({
      claudeAiOauth: {
        accountUuid: 'account-uuid-1',
        refreshToken: 'refresh-b',
        accessToken: 'access-b',
      },
    });
    expect(first).toBe(second);
    expect(first).toBe(accountKey('claude', 'id:account-uuid-1'));
    expect(first).not.toContain('refresh');
    expect(first).not.toContain('access');
  });

  it('hashes the refresh token when Claude sends no public id, and not the access token', () => {
    const key = claudeAccountKey({
      claudeAiOauth: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
    });
    expect(key).toBe(accountKey('claude', 'refresh:refresh-secret'));
    expect(key).not.toBe(accountKey('claude', 'refresh:access-secret'));
    expect(key).not.toContain('refresh-secret');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not put an ElevenLabs key or a Codex account id into the hash text', () => {
    const rawKey = 'xi-live-secret-key';
    const hashed = elevenAccountKey(rawKey);
    expect(hashed).toBe(accountKey('elevenlabs', `key:${rawKey}`));
    expect(hashed).not.toContain(rawKey);
    const rawId = 'chatgpt-account-id';
    expect(openaiAccountKey(rawId)).not.toContain(rawId);
  });

  it('uses one machine key per provider on this host, and ignores a Cursor access token', () => {
    expect(machineAccountKey('cursor')).toBe(machineAccountKey('cursor'));
    expect(machineAccountKey('cursor')).not.toBe(machineAccountKey('claude'));
    const key = cursorAccountKey({ accessToken: 'cursor-secret', email: 'ada@example.com' });
    expect(key).toBe(accountKey('cursor', 'id:ada@example.com'));
    expect(key).not.toContain('cursor-secret');
    expect(cursorAccountKey({ accessToken: 'cursor-secret' })).toBe(machineAccountKey('cursor'));
  });

  it('hashes a Muse email and not the access token', () => {
    const email = 'ada@example.com';
    const token = 'secret-token-value';
    const first = museAccountKey({
      user_email: email,
      providers: { muse: { access_token: token, user_email: 'other@example.com' } },
    });
    const second = museAccountKey({
      providers: { muse: { user_email: email, access_token: 'other-token-value' } },
    });
    expect(first).toBe(accountKey('muse', `id:${email}`));
    expect(second).toBe(first);
    expect(first).not.toContain(email);
    expect(first).not.toContain(token);
    expect(museAccountKey({ access_token: token })).toBe(machineAccountKey('muse'));
    expect(museAccountKey({ user_email: 'short', access_token: token })).toBe(
      machineAccountKey('muse'),
    );
  });

  it('refuses a token-shaped or short public id', () => {
    expect(publicAccountId('sk-ant-secret')).toBeNull();
    expect(publicAccountId('short')).toBeNull();
    expect(publicAccountId('aaaa.bbbb.cccc')).toBeNull();
    expect(publicAccountId('account-uuid-1')).toBe('account-uuid-1');
  });
});
