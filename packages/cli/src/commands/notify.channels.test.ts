import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { notifyCommand } from './notify.js';

const h = vi.hoisted(() => ({
  settings: [
    {
      channel: 'slack',
      deliver: false,
      answer: false,
      presenceGating: true,
      tierFloor: null as string | null,
    },
  ],
  getChannelSettings: vi.fn(async () => ({ settings: h.settings })),
  setChannelSettings: vi.fn(async (_team: string, channel: string, body: unknown) => ({
    settings: {
      channel,
      deliver: true,
      answer: false,
      presenceGating: false,
      tierFloor: 'standard',
      ...(body as object),
    },
  })),
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    identity: { name: 'nick' },
    http: {
      getChannelSettings: h.getChannelSettings,
      setChannelSettings: h.setChannelSettings,
      presenceNeutral: () => ({}),
    },
  }),
  viewerFlags: async () => ({}),
}));

function parsed(positionals: string[], flags: Parsed['flags'] = {}): Parsed {
  return { positionals, flags, rest: [] } as unknown as Parsed;
}

describe('musterd notify channels (away channels 6)', () => {
  it('lists settings with the all-off default visible', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await notifyCommand(parsed(['channels']))).toBe(0);
    expect(out.join('')).toContain('slack  deliver off  answer off');
    vi.restoreAllMocks();
  });

  it('shows the effective answer state when delivery is off', async () => {
    const stored = h.settings;
    h.settings = [
      {
        channel: 'slack',
        deliver: false,
        answer: true,
        presenceGating: true,
        tierFloor: null as string | null,
      },
    ];
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    try {
      expect(await notifyCommand(parsed(['channels']))).toBe(0);
      expect(out.join('')).toContain('slack  deliver off  answer off (delivery off)');
      out.length = 0;
      expect(await notifyCommand(parsed(['channels', 'set', 'slack'], { deliver: 'off' }))).toBe(0);
      expect(out.join('')).toContain('answer off (delivery off)');
    } finally {
      h.settings = stored;
      vi.restoreAllMocks();
    }
  });

  it('set merges onto current settings and writes through the client', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(
      await notifyCommand(
        parsed(['channels', 'set', 'slack'], { deliver: 'on', 'tier-floor': 'standard' }),
      ),
    ).toBe(0);
    expect(h.setChannelSettings).toHaveBeenCalledWith('revive', 'slack', {
      deliver: true,
      answer: false,
      presence_gating: true,
      tier_floor: 'standard',
    });
    expect(out.join('')).toContain('deliver on');
    vi.restoreAllMocks();
  });
});
