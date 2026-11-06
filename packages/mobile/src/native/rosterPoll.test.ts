import { describe, expect, it } from 'vitest';
import { nextPollDelay, ROSTER_POLL_MS } from './rosterPoll';

const NOW = 1_800_000_000_000;

describe('nextPollDelay (ADR 814 decision 4): the Now screen’s 30 s cadence', () => {
  it('waits out the rest of the interval while focused and active', () => {
    expect(
      nextPollDelay({ focused: true, appActive: true, lastAt: NOW - 10_000 }, NOW, 30_000),
    ).toBe(20_000);
  });

  it('polls now when the last pull is older than the interval', () => {
    expect(
      nextPollDelay({ focused: true, appActive: true, lastAt: NOW - 40_000 }, NOW, 30_000),
    ).toBe(0);
  });

  it('does not poll while another screen is in front (the ask screen holds its own token)', () => {
    expect(nextPollDelay({ focused: false, appActive: true, lastAt: NOW }, NOW, 30_000)).toBeNull();
  });

  it('does not poll while the app is in the background', () => {
    expect(nextPollDelay({ focused: true, appActive: false, lastAt: NOW }, NOW, 30_000)).toBeNull();
  });

  it('defaults to thirty seconds', () => {
    expect(ROSTER_POLL_MS).toBe(30_000);
  });
});
