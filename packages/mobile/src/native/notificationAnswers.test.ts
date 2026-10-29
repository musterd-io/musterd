import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_OPEN } from './notice';
import { takeNotificationAnswer } from './notificationAnswers';

const h = vi.hoisted(() => ({
  pending: null as { action: string; userInfo: string } | null,
  pin: null as unknown,
}));

vi.mock('./phoneKeys', () => ({
  phoneKeys: { takePendingAnswer: vi.fn(async () => h.pending) },
  phoneKeysErrorCode: () => null,
}));
vi.mock('./pairingPin', () => ({ loadPairingPin: vi.fn(async () => h.pin) }));

const route = { team: 'revive', binding: 'bind-1', ref: 'ask-1', expires_at: 4_102_444_800_000 };

describe('a plain tap on a notification', () => {
  beforeEach(() => {
    h.pin = {
      v: 1,
      identity: 'A'.repeat(43),
      receive: 'C'.repeat(87),
      relay: 'https://relay.example',
      team: 'revive',
      binding: 'bind-1',
    };
  });

  it('opens the ask it was tapped for and answers nothing', async () => {
    h.pending = { action: ACTION_OPEN, userInfo: JSON.stringify({ musterd: { v: 1, ...route } }) };
    expect(await takeNotificationAnswer()).toEqual({ open: route });
  });

  it('opens nothing for another team’s push, or before pairing', async () => {
    h.pending = {
      action: ACTION_OPEN,
      userInfo: JSON.stringify({ musterd: { v: 1, ...route, team: 'other' } }),
    };
    expect(await takeNotificationAnswer()).toBeNull();
    h.pin = null;
    h.pending = { action: ACTION_OPEN, userInfo: JSON.stringify({ musterd: { v: 1, ...route } }) };
    expect(await takeNotificationAnswer()).toBeNull();
  });
});
