import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { mintBootstrapCredentialSigned } from './team.js';

const h = vi.hoisted(() => ({
  server: 'http://localhost:4849',
  createAuthorityDescriptor: vi.fn(async () => ({
    descriptor: {
      v: 1,
      actor: 'nick',
      act: 'credential_mint',
      target: 'ghost',
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

vi.mock('./helpers.js', () => ({ resolve: () => ({}) }));

const body = { use: 'claim_seat' as const, target: 'ghost' };
const minted = { credential: { id: 'bc-1', use: 'claim_seat', target: 'ghost' }, agent_key: 'msk' };

function http(mint: ReturnType<typeof vi.fn>) {
  return {
    server: h.server,
    mintBootstrapCredential: mint,
    createAuthorityDescriptor: h.createAuthorityDescriptor,
    getParkedApproval: h.getParkedApproval,
  } as unknown as HttpClient;
}

describe('mintBootstrapCredentialSigned (ADR 662 credential_mint)', () => {
  it('mints without a ceremony when the server needs no proof', async () => {
    h.createAuthorityDescriptor.mockClear();
    const mint = vi.fn(async () => minted);
    await expect(mintBootstrapCredentialSigned(http(mint), 'revive', body)).resolves.toBe(minted);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(h.createAuthorityDescriptor).not.toHaveBeenCalled();
  });

  it('on no_signature, approves the server-built descriptor over the exact mint and resends with the proof', async () => {
    h.createAuthorityDescriptor.mockClear();
    const mint = vi
      .fn()
      .mockRejectedValueOnce(
        new CliError(
          'authority refused (no_signature): credential_mint requires an A2 device signature (ADR 662)',
          5,
          'forbidden',
        ),
      )
      .mockResolvedValueOnce(minted);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(mintBootstrapCredentialSigned(http(mint), 'revive', body)).resolves.toBe(minted);
    } finally {
      out.mockRestore();
    }
    expect(h.createAuthorityDescriptor).toHaveBeenCalledWith('revive', {
      act: 'credential_mint',
      target: 'ghost',
      payload: { action: 'bootstrap_mint', use: 'claim_seat', target: 'ghost' },
    });
    expect(mint).toHaveBeenLastCalledWith('revive', {
      ...body,
      approval: { key_id: 'key-1', nonce: 'nonce-at-least-16-chars', signature: 'sig' },
    });
  });

  it('passes any other refusal through untouched', async () => {
    h.createAuthorityDescriptor.mockClear();
    const mint = vi.fn(async () => {
      throw new CliError('no seat "ghost" in team "revive"', 4, 'not_found');
    });
    await expect(mintBootstrapCredentialSigned(http(mint), 'revive', body)).rejects.toThrow(
      /no seat "ghost"/,
    );
    expect(h.createAuthorityDescriptor).not.toHaveBeenCalled();
  });
});
