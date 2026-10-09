import { describe, expect, it } from 'vitest';
import {
  NOW_KEY,
  NOW_PERIOD_MS,
  readBriefedAt,
  startMode,
  writeBriefedAt,
  type NowStorage,
} from './nowWhen';

const NOW = 1_800_000_000_000;
const memory = (initial: Record<string, string> = {}): NowStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};

describe('startMode', () => {
  it('opens on the very first visit', () => {
    expect(startMode(null, NOW, { phone: false })).toEqual({ mode: 'overlay', opened: true });
  });

  it('stays docked for the rest of the period', () => {
    expect(startMode(NOW - 60_000, NOW, { phone: false })).toEqual({ mode: 'docked', opened: false });
    expect(startMode(NOW - NOW_PERIOD_MS + 1, NOW, { phone: false }).mode).toBe('docked');
  });

  it('opens again once a period has passed', () => {
    expect(startMode(NOW - NOW_PERIOD_MS, NOW, { phone: false }).mode).toBe('overlay');
    expect(startMode(NOW - 3 * NOW_PERIOD_MS, NOW, { phone: false }).opened).toBe(true);
  });

  it('treats a stamp from the future (a clock that moved) as due, not as forever-docked', () => {
    expect(startMode(NOW + 60_000, NOW, { phone: false }).mode).toBe('overlay');
  });

  it('never auto-opens on a phone, and does not spend the period there', () => {
    expect(startMode(null, NOW, { phone: true })).toEqual({ mode: 'docked', opened: false });
  });
});

describe('storage', () => {
  it('round-trips the stamp', () => {
    const s = memory();
    writeBriefedAt(s, NOW);
    expect(readBriefedAt(s)).toBe(NOW);
  });

  it('reads nonsense, nothing and a missing store as "never"', () => {
    expect(readBriefedAt(memory({ [NOW_KEY]: 'soon' }))).toBeNull();
    expect(readBriefedAt(memory({ [NOW_KEY]: '-5' }))).toBeNull();
    expect(readBriefedAt(memory())).toBeNull();
    expect(readBriefedAt(null)).toBeNull();
  });

  it('survives a store that throws, both ways', () => {
    const angry: NowStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readBriefedAt(angry)).toBeNull();
    expect(() => writeBriefedAt(angry, NOW)).not.toThrow();
  });
});
