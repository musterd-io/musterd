import { describe, expect, it, vi } from 'vitest';
import { parseElevenLabs, readElevenLabs } from './elevenlabs.js';

const SECRET = 'xi-test-secret-key-do-not-leak';

const sample = {
  tier: 'starter<script>',
  character_count: 1000,
  character_limit: 10000,
  voice_slots_used: 1,
  voice_limit: 10,
  next_character_count_reset_unix: 1738356858,
  status: 'past_due',
  open_invoices: [{ amount_due_cents: 1000 }],
};

describe('parseElevenLabs', () => {
  it('keeps the windows and drops everything else', () => {
    const read = parseElevenLabs(sample);
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.detail).toBe('starter<script> · past due');
    expect(read.windows).toEqual([
      {
        id: 'characters',
        unit: 'characters',
        used: 1000,
        limit: 10000,
        resetsAt: 1738356858000,
      },
      { id: 'voices', unit: 'voice slots', used: 1, limit: 10, resetsAt: null },
    ]);
    expect(JSON.stringify(read)).not.toContain('amount_due');
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it('says when the character window is missing', () => {
    expect(parseElevenLabs({ tier: 'starter' })).toEqual({
      state: 'error',
      reason: 'ElevenLabs left out the character window.',
    });
    expect(parseElevenLabs(null).state).toBe('error');
  });
});

describe('readElevenLabs', () => {
  it('does not call out when no key is set', async () => {
    const fetchSub = vi.fn<typeof fetch>();
    const read = await readElevenLabs('  ', fetchSub, AbortSignal.timeout(1000));
    expect(read).toEqual({ state: 'missing', reason: 'Set ELEVENLABS_API_KEY, then refresh.' });
    expect(fetchSub).not.toHaveBeenCalled();
  });

  it('sends the key as a header and leaves it off the result', async () => {
    const fetchSub = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('xi-api-key')).toBe(SECRET);
      return new Response(JSON.stringify(sample), { status: 200 });
    });
    const read = await readElevenLabs(SECRET, fetchSub, AbortSignal.timeout(1000));
    expect(read.state).toBe('live');
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  it('refuses a rejected key and a silent network', async () => {
    const denied = vi.fn<typeof fetch>(async () => new Response('no', { status: 401 }));
    const refused = await readElevenLabs(SECRET, denied, AbortSignal.timeout(1000));
    expect(refused.state).toBe('error');
    if (refused.state === 'live') return;
    expect(refused.reason).toBe('ElevenLabs refused the key.');
    const down = vi.fn<typeof fetch>(async () => {
      throw new Error('down');
    });
    const silent = await readElevenLabs(SECRET, down, AbortSignal.timeout(1000));
    expect(silent.state).toBe('error');
    if (silent.state === 'live') return;
    expect(silent.reason).toBe('ElevenLabs did not answer.');
  });
});
