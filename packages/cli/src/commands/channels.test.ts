import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { channelsCommand } from './channels.js';

const h = vi.hoisted(() => ({
  startChannelPairing: vi.fn(async () => ({
    pairing_id: 'pair-1',
    nonce: 'nonce-once',
    check_code: '42',
    expires_at: 999,
  })),
  listChannelPairings: vi.fn(async () => ({
    pairings: [
      {
        id: 'pair-1',
        channel: 'slack',
        check_code: '42',
        state: 'awaiting_confirmation',
        provider_tenant_id: 'T1',
        provider_user_id: 'U1',
        expires_at: 999,
        created_at: 1,
      },
    ],
  })),
  confirmChannelPairing: vi.fn(async () => ({
    ok: true as const,
    binding: {
      id: 'b1',
      channel: 'slack',
      provider_tenant_id: 'T1',
      provider_user_id: 'U1',
      generation: 1,
      status: 'active' as const,
      created_at: 1,
      revoked_at: null,
    },
  })),
  killChannelSwitch: vi.fn(async () => ({ bindingsRevoked: 2, tokensRevoked: 3 })),
  startAppPairing: vi.fn(async () => ({
    pairing_id: 'pair-app',
    qr: {
      v: 1,
      relay: 'https://relay.example',
      team: 'revive',
      pairing: 'pair-app',
      code: 'c'.repeat(43),
      expires_at: 999,
      daemon_identity_public_key: 'i'.repeat(43),
      daemon_receive_public_key: 'r'.repeat(87),
    },
    daemon_fingerprint: 'ab:cd',
    expires_at: 999,
  })),
  collectApproval: vi.fn(async () => ({ proof: 'signed' })),
  listChannelBindings: vi.fn(async () => ({
    bindings: [
      { id: 'b-app', channel: 'app', status: 'active' },
      { id: 'b-old', channel: 'app', status: 'revoked' },
    ],
  })),
}));

vi.mock('./authority.js', () => ({ collectApproval: h.collectApproval }));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    identity: { name: 'nick' },
    http: {
      startAppPairing: h.startAppPairing,
      startChannelPairing: h.startChannelPairing,
      listChannelPairings: h.listChannelPairings,
      confirmChannelPairing: h.confirmChannelPairing,
      killChannelSwitch: h.killChannelSwitch,
      listChannelBindings: h.listChannelBindings,
    },
  }),
}));

function parsed(positionals: string[], flags: Parsed['flags'] = {}): Parsed {
  return { positionals, flags, rest: [] } as unknown as Parsed;
}

describe('musterd channels (ADR 618 §7)', () => {
  it('pair shows the nonce once with its check code', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await channelsCommand(parsed(['pair'], { channel: 'slack' }))).toBe(0);
    expect(h.startChannelPairing).toHaveBeenCalledWith('revive', 'slack');
    expect(out.join('')).toContain('nonce-once');
    expect(out.join('')).toContain('42');
    vi.restoreAllMocks();
  });

  it('pairings lists the daemon-held tenant and user awaiting confirmation', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await channelsCommand(parsed(['pairings']))).toBe(0);
    expect(out.join('')).toContain('tenant T1');
    expect(out.join('')).toContain('user U1');
    vi.restoreAllMocks();
  });

  it('pairings after a confirm names the paired phone instead of only an empty list', async () => {
    h.listChannelPairings.mockResolvedValueOnce({ pairings: [] });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await channelsCommand(parsed(['pairings']))).toBe(0);
    expect(out.join('')).toContain('no pairings waiting for confirmation');
    expect(out.join('')).toContain('paired: your phone (app, binding b-app)');
    expect(out.join('')).not.toContain('b-old');
    vi.restoreAllMocks();
  });

  it('kill-switch reports what it revoked', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await channelsCommand(parsed(['kill-switch']))).toBe(0);
    expect(out.join('')).toContain('2 binding(s) revoked');
    expect(out.join('')).toContain('3 token(s) consumed');
    vi.restoreAllMocks();
  });

  it('pair --channel app prints the QR once with the daemon fingerprint (ADR 690)', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await channelsCommand(parsed(['pair'], { channel: 'app' }))).toBe(0);
    expect(h.startAppPairing).toHaveBeenCalledWith('revive');
    expect(h.startChannelPairing).not.toHaveBeenCalledWith('revive', 'app');
    const text = out.join('');
    expect(text).toContain('\u2580');
    expect(text).toContain('ab:cd');
    expect(text).toContain('pair-app');
    // The one-time code rides only inside the QR, never as text.
    expect(text).not.toContain('c'.repeat(43));
    vi.restoreAllMocks();
  });

  it('confirm on an app pairing carries a device_key_admin approval over the enroll payload', async () => {
    const enroll = { action: 'enroll' as const, public_key: 'spki', kind: 'phone' as const };
    h.listChannelPairings.mockResolvedValueOnce({
      pairings: [
        {
          id: 'pair-app',
          channel: 'app',
          check_code: '00',
          state: 'awaiting_confirmation',
          provider_tenant_id: null as unknown as string,
          provider_user_id: null as unknown as string,
          expires_at: 999,
          created_at: 1,
          app: {
            fingerprint: 'ff',
            environment: 'production',
            device_name: null,
            enroll_payload: enroll,
          },
        } as never,
      ],
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await channelsCommand(parsed(['confirm', 'pair-app']))).toBe(0);
    expect(h.collectApproval).toHaveBeenCalledWith(
      expect.anything(),
      'revive',
      'device_key_admin',
      'nick',
      enroll,
    );
    expect(h.confirmChannelPairing).toHaveBeenCalledWith('revive', 'pair-app', { proof: 'signed' });
    vi.restoreAllMocks();
  });

  it('confirm on a Slack pairing sends no approval', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    h.collectApproval.mockClear();
    expect(await channelsCommand(parsed(['confirm', 'pair-1']))).toBe(0);
    expect(h.collectApproval).not.toHaveBeenCalled();
    expect(h.confirmChannelPairing).toHaveBeenLastCalledWith('revive', 'pair-1', undefined);
    vi.restoreAllMocks();
  });

  it('pair without --channel is a usage error', async () => {
    await expect(channelsCommand(parsed(['pair']))).rejects.toMatchObject({ exitCode: 2 });
  });
});
