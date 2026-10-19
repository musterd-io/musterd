import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { authorityCommand } from './authority.js';

const h = vi.hoisted(() => ({
  keys: [] as { id: string; kind: string; created_at: number; revoked_at: number | null }[],
  issueEnrollmentCode: vi.fn(async () => ({ code: 'code-once', expires_at: 123 })),
  enrollDeviceKey: vi.fn(async () => ({ key: { id: 'key-1', kind: 'platform' } })),
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
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    identity: { name: 'nick' },
    http: {
      issueEnrollmentCode: h.issueEnrollmentCode,
      enrollDeviceKey: h.enrollDeviceKey,
      listDeviceKeys: h.listDeviceKeys,
      revokeDeviceKey: h.revokeDeviceKey,
      createAuthorityDescriptor: h.createAuthorityDescriptor,
      presenceNeutral: () => ({}),
    },
  }),
  viewerFlags: async () => ({}),
}));

function parsed(positionals: string[], flags: Parsed['flags'] = {}): Parsed {
  return { positionals, flags, rest: [] } as unknown as Parsed;
}

describe('musterd authority (ADR 662 decision 6)', () => {
  it('enroll asks for a code and enrolls the fresh public key with it', async () => {
    process.env.MUSTERD_CONFIG = '/tmp/musterd-authority-test/config.json';
    expect(await authorityCommand(parsed(['enroll']))).toBe(0);
    expect(h.issueEnrollmentCode).toHaveBeenCalledWith('revive');
    expect(h.enrollDeviceKey).toHaveBeenCalledWith(
      'revive',
      expect.objectContaining({ kind: 'platform', enrollment_code: 'code-once' }),
    );
  });

  it('keys lists the daemon keys', async () => {
    h.keys = [{ id: 'key-1', kind: 'platform', created_at: 1, revoked_at: null }];
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await authorityCommand(parsed(['keys']))).toBe(0);
    expect(out.join('')).toContain('key-1  platform  active');
    vi.restoreAllMocks();
  });
});
