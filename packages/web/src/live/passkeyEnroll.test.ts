import { describe, expect, it } from 'vitest';
import { enrollRefusal } from './passkeyEnroll';

describe('enrolling a passkey from /live (ADR 767)', () => {
  it('turns the daemon’s countersign refusal into the one step that is still in the terminal', () => {
    const why = enrollRefusal(new Error('passkey enrollment refused (countersign_required)'));
    expect(why).toMatch(/admin must vouch/);
    expect(why).toContain('musterd authority enroll --confirmed-by <admin>');
  });

  it('says an expired code expired, and passes anything else through', () => {
    expect(enrollRefusal(new Error('passkey enrollment refused (bad_challenge)'))).toMatch(/expired/);
    expect(enrollRefusal(new Error('passkey cancelled; nothing was enrolled'))).toBe(
      'passkey cancelled; nothing was enrolled',
    );
  });
});
