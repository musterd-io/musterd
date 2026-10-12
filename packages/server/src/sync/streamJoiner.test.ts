import { describe, expect, it } from 'vitest';
import {
  SYNC_STREAM_BACKOFF_MAX_MS,
  SYNC_STREAM_BACKOFF_MIN_MS,
  backoffMs,
  streamUrl,
} from './streamJoiner.js';

describe('streamUrl (ADR 552)', () => {
  it('maps the hub URL scheme and names the team stream path', () => {
    expect(streamUrl('http://100.1.2.3:4849', 'revive').href).toBe(
      'ws://100.1.2.3:4849/teams/revive/sync/stream',
    );
    expect(streamUrl('https://hub.example', 'revive').href).toBe(
      'wss://hub.example/teams/revive/sync/stream',
    );
  });
});

describe('backoffMs (ADR 552 §4)', () => {
  it('starts at the floor and doubles toward the cap with jitter', () => {
    expect(backoffMs(0, () => 1)).toBe(SYNC_STREAM_BACKOFF_MIN_MS);
    expect(backoffMs(3, () => 1)).toBe(8_000);
    expect(backoffMs(3, () => 0)).toBe(SYNC_STREAM_BACKOFF_MIN_MS);
  });

  it('never exceeds the cap, however many failures', () => {
    expect(backoffMs(50, () => 1)).toBe(SYNC_STREAM_BACKOFF_MAX_MS);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ms = backoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(SYNC_STREAM_BACKOFF_MIN_MS);
      expect(ms).toBeLessThanOrEqual(SYNC_STREAM_BACKOFF_MAX_MS);
    }
  });
});
