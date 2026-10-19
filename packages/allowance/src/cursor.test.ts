import { describe, expect, it, vi } from 'vitest';
import { includedLabel, parseCursor, readCursor, resolveCursorToken } from './cursor.js';

describe('includedLabel', () => {
  it('calls a cycle of about a month monthly', () => {
    const start = 1_700_000_000_000;
    expect(includedLabel(start, start + 30 * 86_400_000)).toBe('monthly window');
    expect(includedLabel(start, start + 7 * 86_400_000)).toBe('included window');
    expect(includedLabel(null, start)).toBe('included window');
  });
});

describe('parseCursor', () => {
  it('reads the included share and on-demand dollars, and drops the message', () => {
    const start = 1_700_000_000_000;
    const end = start + 30 * 86_400_000;
    const read = parseCursor({
      billingCycleStart: String(start),
      billingCycleEnd: String(end),
      planUsage: { totalPercentUsed: 12.6, autoPercentUsed: 4, apiPercentUsed: 8 },
      spendLimitUsage: { individualLimit: 2000, individualRemaining: 1500, limitType: 'user' },
      displayMessage: 'hello person@example.com',
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.detail).toBeNull();
    expect(read.windows.map((window) => window.id)).toEqual(['included', 'on-demand']);
    expect(read.windows[0]).toMatchObject({
      used: 13,
      limit: 100,
      label: 'monthly window',
      resetsAt: end,
    });
    expect(read.windows[1]).toMatchObject({ unit: 'dollars', used: 5, limit: 20, resetsAt: end });
    const text = JSON.stringify(read);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('hello');
    expect(text).not.toContain('autoPercentUsed');
  });

  it('skips on-demand when the cap is missing', () => {
    const read = parseCursor({
      planUsage: { totalPercentUsed: 1 },
      spendLimitUsage: { individualRemaining: 10, limitType: 'user' },
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.windows).toHaveLength(1);
  });
});

describe('resolveCursorToken', () => {
  it('does not look the machine up when the caller passed null', async () => {
    const lookup = vi.fn(async () => 'from-machine');
    expect(await resolveCursorToken(null, { accessToken: 'from-file' }, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('prefers the file over the lookup', async () => {
    const lookup = vi.fn(async () => 'from-machine');
    expect(await resolveCursorToken(undefined, { accessToken: ' from-file ' }, lookup)).toBe(
      'from-file',
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('readCursor', () => {
  it('sends the token only on the request, and says when sign-in is missing', async () => {
    const fetchSub = vi.fn<typeof fetch>(async () => Response.json({ planUsage: {} }));
    const missing = await readCursor(null, fetchSub, AbortSignal.timeout(1000));
    expect(missing).toMatchObject({ state: 'missing' });
    expect(fetchSub).not.toHaveBeenCalled();

    const fetchLive = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer cursor-token');
      expect(headers.get('user-agent')).toBe('allowance/0.1');
      return Response.json({ planUsage: { totalPercentUsed: 1 } });
    });
    const live = await readCursor('cursor-token', fetchLive, AbortSignal.timeout(1000));
    expect(live.state).toBe('live');
    expect(JSON.stringify(live)).not.toContain('cursor-token');
  });
});
