import { describe, expect, it } from 'vitest';
import { WAKE_YIELD_FILE, WakeLeaseFileSchema, WakeYieldFileSchema } from './wakeLease.js';

describe('wake take-over fields (ADR 546)', () => {
  const base = {
    lease_id: 'L1',
    provenance: 'wake',
    harness: 'claude-code',
    spawner_pid: 42,
    started_at: 1,
    expires_at: 2,
  };
  it('the lease file carries the session id, and stays optional for older hosts', () => {
    expect(WakeLeaseFileSchema.parse({ ...base, session_id: 'c5b415ef' }).session_id).toBe(
      'c5b415ef',
    );
    expect(WakeLeaseFileSchema.parse(base).session_id).toBeUndefined();
  });
  it('provenance carries the derivation honestly (ADR 604): `dream` accepted, anything else refused', () => {
    expect(WakeLeaseFileSchema.parse({ ...base, provenance: 'dream' }).provenance).toBe('dream');
    expect(WakeLeaseFileSchema.safeParse({ ...base, provenance: 'session' }).success).toBe(false);
  });
  it('the yield file names the lease it stops, who asked, and when', () => {
    expect(WAKE_YIELD_FILE).toBe('wake-yield.json');
    expect(WakeYieldFileSchema.parse({ lease_id: 'L1', by: 'nick', at: 5 })).toEqual({
      lease_id: 'L1',
      by: 'nick',
      at: 5,
    });
    expect(WakeYieldFileSchema.safeParse({ by: 'nick', at: 5 }).success).toBe(false);
  });
});
