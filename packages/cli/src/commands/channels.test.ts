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
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    http: {
      startChannelPairing: h.startChannelPairing,
      listChannelPairings: h.listChannelPairings,
      confirmChannelPairing: h.confirmChannelPairing,
      killChannelSwitch: h.killChannelSwitch,
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

  it('pair without --channel is a usage error', async () => {
    await expect(channelsCommand(parsed(['pair']))).rejects.toMatchObject({ exitCode: 2 });
  });
});
