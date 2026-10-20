// The observer mint under ADR 662: a human admin's unsigned mint is refused, so the mint runs the
// passkey ceremony and retries with the proof (lane 01M5D89BKX: `musterd stream start` could not
// start the stream for anyone).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';

const addMember = vi.fn();
const collectApproval = vi.fn();
vi.mock('./helpers.js', () => ({ resolve: () => ({ http: { addMember } }) }));
vi.mock('./authority.js', () => ({ collectApproval: (...a: unknown[]) => collectApproval(...a) }));

const { mintBroadcastSeat } = await import('./broadcast.js');

const unsigned = new CliError(
  'authority refused (no_signature): admin.roster requires an A2 device signature (ADR 662)',
  4,
  'forbidden',
);
const proof = { key_id: 'k1', nonce: 'n1', signature: 's1' };

describe('mintBroadcastSeat under ADR 662', () => {
  beforeEach(() => {
    addMember.mockReset();
    collectApproval.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('signs the roster change with the passkey and retries the mint with the proof', async () => {
    addMember.mockRejectedValueOnce(unsigned).mockResolvedValueOnce({ human_credential: 'mscr_x' });
    collectApproval.mockResolvedValue(proof);

    const seat = await mintBroadcastSeat({}, 'revive');

    const name = seat.name;
    expect(seat).toEqual({ team: 'revive', name, token: 'mscr_x' });
    // The payload is what the daemon digests for POST /members, or the signature won't verify.
    expect(collectApproval).toHaveBeenCalledWith(
      expect.anything(),
      'revive',
      'admin.roster',
      name,
      {
        name,
        kind: 'human',
        role: null,
        observer: true,
      },
    );
    expect(addMember).toHaveBeenLastCalledWith('revive', {
      name,
      kind: 'human',
      observer: true,
      observer_scope: 'broadcast',
      approval: proof,
    });
  });

  it('mints without a ceremony where the daemon needs no signature', async () => {
    addMember.mockResolvedValueOnce({ human_credential: 'mscr_y' });
    await mintBroadcastSeat({}, 'revive');
    expect(collectApproval).not.toHaveBeenCalled();
    expect(addMember).toHaveBeenCalledTimes(1);
  });

  it('runs no ceremony for a refusal that a signature would not fix', async () => {
    addMember.mockRejectedValueOnce(new CliError('human-admin required', 4, 'forbidden'));
    await expect(mintBroadcastSeat({}, 'revive')).rejects.toThrow(
      /minting one takes a human admin/,
    );
    expect(collectApproval).not.toHaveBeenCalled();
  });
});
