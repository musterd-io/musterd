import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { authorityCommand, browserOrigin, setPolicySigned } from './authority.js';

const h = vi.hoisted(() => ({
  server: 'http://localhost:4849',
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
      server: h.server,
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

  it('enroll passes a hub-issued countersign proof into the ceremony link', async () => {
    const proof = { key_id: 'admin-key', nonce: 'nonce-at-least-16-chars', signature: 'sig' };
    h.createAuthorityDescriptor.mockClear();
    h.listDeviceKeys.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({
      keys: [{ id: 'key-7', kind: 'passkey', created_at: 2, revoked_at: null }],
    });
    const out = captureStdout();
    expect(
      await authorityCommand(
        parsed(['enroll'], {
          'confirmed-by': 'root',
          'countersign-proof': JSON.stringify(proof),
        }),
      ),
    ).toBe(0);
    expect(h.createAuthorityDescriptor).not.toHaveBeenCalled();
    const encoded = out.join('').match(/#countersign=([^\s]+)/)?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))).toEqual({
      confirmer: 'root',
      approval: proof,
    });
    vi.restoreAllMocks();
  });

  it('requires the countersign proof to be minted on the hub', async () => {
    h.issueEnrollmentChallenge.mockClear();
    h.listDeviceKeys.mockResolvedValue({ keys: [] });
    await expect(authorityCommand(parsed(['enroll'], { 'confirmed-by': 'root' }))).rejects.toThrow(
      /Countersigning must happen on the hub/,
    );
    expect(h.issueEnrollmentChallenge).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('browserOrigin rewrites IP literals to localhost and leaves domains alone', () => {
    // Falsifier for the 2026-10-19 failure: a 127.0.0.1 ceremony URL can
    // never complete — WebAuthn rejects an IP relying-party ID.
    expect(browserOrigin('http://127.0.0.1:4849')).toBe('http://localhost:4849');
    expect(browserOrigin('http://[::1]:4849')).toBe('http://localhost:4849');
    expect(browserOrigin('http://localhost:4849')).toBe('http://localhost:4849');
    expect(browserOrigin('https://musterd.example:4849')).toBe('https://musterd.example:4849');
  });

  it('enroll prints a localhost ceremony URL when the server is 127.0.0.1', async () => {
    h.server = 'http://127.0.0.1:4849';
    try {
      h.listDeviceKeys.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({
        keys: [{ id: 'key-10', kind: 'passkey', created_at: 2, revoked_at: null }],
      });
      const out = captureStdout();
      expect(await authorityCommand(parsed(['enroll']))).toBe(0);
      expect(out.join('')).toContain('Open http://localhost:4849/authority/passkey?');
      expect(out.join('')).not.toContain('Open http://127.0.0.1:4849/authority/passkey?');
    } finally {
      h.server = 'http://localhost:4849';
      vi.restoreAllMocks();
    }
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

describe('setPolicySigned (ADR 662 admin.team_policy)', () => {
  const policy = { loops: { review: true }, away_relay_url: 'https://relay.example' };
  const result = { policy: {}, stored: policy };

  function http(setPolicy: ReturnType<typeof vi.fn>) {
    return {
      server: h.server,
      setPolicy,
      createAuthorityDescriptor: h.createAuthorityDescriptor,
      getParkedApproval: h.getParkedApproval,
    } as unknown as Parameters<typeof setPolicySigned>[0];
  }

  it('writes without a ceremony when the server needs no proof', async () => {
    h.createAuthorityDescriptor.mockClear();
    const setPolicy = vi.fn(async () => result);
    await expect(setPolicySigned(http(setPolicy), 'revive', policy)).resolves.toBe(result);
    expect(setPolicy).toHaveBeenCalledTimes(1);
    expect(h.createAuthorityDescriptor).not.toHaveBeenCalled();
  });

  it('on no_signature, approves the server-built descriptor over the exact doc and resends with the proof', async () => {
    h.createAuthorityDescriptor.mockClear();
    const setPolicy = vi
      .fn()
      .mockRejectedValueOnce(
        new CliError(
          'authority refused (no_signature): admin.team_policy requires an A2 device signature (ADR 662)',
          5,
          'forbidden',
        ),
      )
      .mockResolvedValueOnce(result);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(setPolicySigned(http(setPolicy), 'revive', policy)).resolves.toBe(result);
    } finally {
      out.mockRestore();
    }
    expect(h.createAuthorityDescriptor).toHaveBeenCalledWith('revive', {
      act: 'admin.team_policy',
      target: 'revive',
      payload: policy,
    });
    expect(setPolicy).toHaveBeenLastCalledWith('revive', policy, {
      key_id: 'key-1',
      nonce: 'nonce-at-least-16-chars',
      signature: 'sig',
    });
  });

  it('passes any other refusal through untouched', async () => {
    const setPolicy = vi.fn(async () => {
      throw new CliError('the team policy changed on the hub', 9, 'conflict');
    });
    await expect(setPolicySigned(http(setPolicy), 'revive', policy)).rejects.toThrow(
      /changed on the hub/,
    );
    expect(setPolicy).toHaveBeenCalledTimes(1);
  });
});
