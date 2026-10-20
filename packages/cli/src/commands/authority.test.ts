import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { authorityCommand } from './authority.js';

const h = vi.hoisted(() => ({
  keys: [] as { id: string; kind: string; created_at: number; revoked_at: number | null }[],
  issueEnrollmentChallenge: vi.fn(async () => ({
    challenge: 'challenge-at-least-16-chars',
    expires_at: 123,
  })),
  listDeviceKeys: vi.fn(async () => ({ keys: h.keys })),
  revokeDeviceKey: vi.fn(async () => ({ ok: true as const })),
  createAuthorityDescriptor: vi.fn(async () => ({
    descriptor: {
      v: 1,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload_digest: 'a'.repeat(64),
      audience: 'revive',
      expiry: 9999999999999,
      nonce: 'nonce-at-least-16-chars',
    },
  })),
  getParkedApproval: vi.fn(async () => ({
    proof: { key_id: 'key-1', nonce: 'nonce-at-least-16-chars', signature: 'sig' },
  })),
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    identity: { name: 'nick' },
    http: {
      server: 'http://localhost:4849',
      issueEnrollmentChallenge: h.issueEnrollmentChallenge,
      enrollDeviceKey: vi.fn(),
      listDeviceKeys: h.listDeviceKeys,
      revokeDeviceKey: h.revokeDeviceKey,
      createAuthorityDescriptor: h.createAuthorityDescriptor,
      getParkedApproval: h.getParkedApproval,
      presenceNeutral: () => ({}),
    },
  }),
  viewerFlags: async () => ({}),
}));

function parsed(positionals: string[], flags: Parsed['flags'] = {}): Parsed {
  return { positionals, flags, rest: [] } as unknown as Parsed;
}

function captureStdout() {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return out;
}

describe('musterd authority (ADR 662 decisions 5/6, passkey-first)', () => {
  it('enroll with no standing key prints the ceremony link and waits for the new key', async () => {
    h.keys = [];
    h.listDeviceKeys.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({
      keys: [{ id: 'key-9', kind: 'passkey', created_at: 2, revoked_at: null }],
    });
    const out = captureStdout();
    expect(await authorityCommand(parsed(['enroll']))).toBe(0);
    expect(out.join('')).toContain(
      '/authority/passkey?team=revive&member=nick&challenge=challenge-at-least-16-chars',
    );
    expect(out.join('')).toContain('passkey enrolled for nick (key-9)');
    expect(h.issueEnrollmentChallenge).toHaveBeenCalledWith('revive');
    vi.restoreAllMocks();
  });

  it('enroll with a standing key collects its approval first', async () => {
    h.keys = [{ id: 'key-1', kind: 'passkey', created_at: 1, revoked_at: null }];
    h.listDeviceKeys
      .mockResolvedValueOnce({
        keys: [{ id: 'key-1', kind: 'passkey', created_at: 1, revoked_at: null }],
      })
      .mockResolvedValue({
        keys: [
          { id: 'key-1', kind: 'passkey', created_at: 1, revoked_at: null },
          { id: 'key-2', kind: 'passkey', created_at: 2, revoked_at: null },
        ],
      });
    const out = captureStdout();
    expect(await authorityCommand(parsed(['enroll']))).toBe(0);
    expect(out.join('')).toContain('/authority/approve?team=revive');
    expect(out.join('')).toContain('#approval=');
    expect(h.createAuthorityDescriptor).toHaveBeenCalledWith(
      'revive',
      expect.objectContaining({ act: 'device_key_admin' }),
    );
    vi.restoreAllMocks();
  });

  it('keys lists the daemon keys', async () => {
    h.keys = [{ id: 'key-1', kind: 'platform', created_at: 1, revoked_at: null }];
    h.listDeviceKeys.mockResolvedValue({ keys: h.keys });
    const out = captureStdout();
    expect(await authorityCommand(parsed(['keys']))).toBe(0);
    expect(out.join('')).toContain('key-1  platform  active');
    vi.restoreAllMocks();
  });

  it('revoke collects a standing-key approval and submits it', async () => {
    h.listDeviceKeys.mockResolvedValue({ keys: [] });
    const out = captureStdout();
    expect(await authorityCommand(parsed(['revoke', 'key-1']))).toBe(0);
    expect(h.revokeDeviceKey).toHaveBeenCalledWith('revive', 'key-1', {
      approval: expect.objectContaining({ key_id: 'key-1' }),
    });
    expect(out.join('')).toContain('device key key-1 revoked');
    vi.restoreAllMocks();
  });
});
