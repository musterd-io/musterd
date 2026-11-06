import { describe, expect, it } from 'vitest';
import { lastUsedLabel, signInRows } from './signIns';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  label: 'Chrome on macOS',
  created_at: NOW - DAY,
  last_used_at: NOW - 5 * MIN,
  expires_at: NOW + 10 * DAY,
  revoked_at: null,
  current: false,
  ...over,
});

describe('lastUsedLabel (sign-in copy spec §6)', () => {
  it('reads Active now inside two minutes, then minutes, hours and days ago', () => {
    expect(lastUsedLabel(NOW - 30_000, NOW)).toBe('Active now');
    expect(lastUsedLabel(NOW - 5 * MIN, NOW)).toBe('5m ago');
    expect(lastUsedLabel(NOW - 3 * 60 * MIN, NOW)).toBe('3h ago');
    expect(lastUsedLabel(NOW - 4 * DAY, NOW)).toBe('4d ago');
  });
});

describe('signInRows', () => {
  it('puts this browser first as "This browser", then the rest by last use', () => {
    const rows = signInRows({
      sessions: [
        session({ id: 'old', last_used_at: NOW - DAY }),
        session({ id: 'here', current: true, last_used_at: NOW - 10 * MIN }),
      ],
      clients: [
        {
          chain_id: 'c1',
          client_id: 'cid',
          client_name: 'Claude',
          connected_at: NOW - 2 * DAY,
          last_used_at: NOW - MIN,
        },
      ],
      phones: [],
      now: NOW,
    });
    expect(rows.map((r) => [r.device, r.how])).toEqual([
      ['This browser', 'Browser'],
      ['Connected app', 'Claude'],
      ['Chrome on macOS', 'Browser'],
    ]);
    expect(rows[0]!.current).toBe(true);
    expect(rows.every((r) => r.action === 'Sign out')).toBe(true);
  });

  it('leaves out revoked, expired and idle browsers, and phones that are not live app pairings', () => {
    const rows = signInRows({
      sessions: [
        session({ id: 'revoked', revoked_at: NOW - MIN }),
        session({ id: 'expired', expires_at: NOW - 1 }),
        session({ id: 'idle', last_used_at: NOW - 4 * DAY }),
      ],
      clients: [],
      phones: [
        {
          id: 'p1',
          channel: 'app',
          status: 'active',
          created_at: NOW - DAY,
          app_keys: '{"device_name":"Nick’s iPhone"}',
        },
        { id: 'p2', channel: 'app', status: 'revoked', created_at: NOW - DAY },
        { id: 'p3', channel: 'app', status: 'active', created_at: NOW - DAY, ended: 'superseded' },
        { id: 's1', channel: 'slack', status: 'active', created_at: NOW - DAY },
      ],
      now: NOW,
    });
    expect(rows.map((r) => [r.kind, r.id, r.device, r.how])).toEqual([
      ['phone', 'p1', 'Nick’s iPhone', 'Phone'],
    ]);
  });

  it('names a phone that gave no name "Phone"', () => {
    const [row] = signInRows({
      sessions: [],
      clients: [],
      phones: [{ id: 'p1', channel: 'app', status: 'active', created_at: NOW - DAY }],
      now: NOW,
    });
    expect(row!.device).toBe('Phone');
  });
});
