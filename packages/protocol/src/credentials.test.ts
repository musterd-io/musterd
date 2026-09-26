import { describe, expect, it } from 'vitest';
import {
  BootstrapCutoverRequestSchema,
  BootstrapMigrationRequestSchema,
  containsMusterdCredential,
  PolicyOverrideSchema,
  PolicySchema,
} from './credentials.js';

describe('bootstrap retirement credentials (ADR 350)', () => {
  it('accepts only a strict legacy-key plus agent-seat proof', () => {
    expect(
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'msac_ada',
      }),
    ).toEqual({
      legacy_key: 'mskey_legacy',
      seat_credential: 'msac_ada',
    });
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'msac_wrong',
        seat_credential: 'msac_ada',
      }),
    ).toThrow();
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'mscr_human',
      }),
    ).toThrow();
    expect(() =>
      BootstrapMigrationRequestSchema.parse({
        legacy_key: 'mskey_legacy',
        seat_credential: 'msac_ada',
        seat: 'Ada',
      }),
    ).toThrow();
  });

  it('defaults cutover to readiness-gated and rejects unknown bypasses', () => {
    expect(BootstrapCutoverRequestSchema.parse({})).toEqual({ force: false });
    expect(BootstrapCutoverRequestSchema.parse({ force: true })).toEqual({ force: true });
    expect(() => BootstrapCutoverRequestSchema.parse({ force: false, yes: true })).toThrow();
  });
});

describe('containsMusterdCredential (ADR 452 §1, big-body 01M3FAF83Z)', () => {
  // Synthetic values only — the prefix is what is detected, never a real secret.
  it('finds a credential prefix anywhere a token can start, not only at the beginning', () => {
    expect(containsMusterdCredential('mscr_x')).toBe(true);
    expect(containsMusterdCredential('https://h/join/t?t=mscr_x#n=abc')).toBe(true);
    expect(containsMusterdCredential('https://h/join/t#n=abc&k=MSAC_x')).toBe(true);
    expect(containsMusterdCredential('paste: msat_x')).toBe(true);
    expect(containsMusterdCredential('a/mskey_x')).toBe(true);
  });

  it('does not fire inside a base64url run, so a random nonce cannot trip it', () => {
    expect(containsMusterdCredential('https://h/join/t#n=AAAAmscr_AAAA')).toBe(false);
    expect(containsMusterdCredential('Z-mscr_')).toBe(false);
    expect(containsMusterdCredential('https://h/join/t#n=' + 'A'.repeat(43))).toBe(false);
  });
});

describe('PolicySchema.agent_connect (ADR 456 §2)', () => {
  it("defaults to 'sponsor' and accepts 'any_member'", () => {
    expect(PolicySchema.parse({}).agent_connect).toBe('sponsor');
    expect(PolicySchema.parse({ agent_connect: 'any_member' }).agent_connect).toBe('any_member');
    expect(PolicySchema.safeParse({ agent_connect: 'admin' }).success).toBe(false);
  });

  it('rides the sparse override — omitted stays omitted (ADR 185)', () => {
    expect(PolicyOverrideSchema.parse({}).agent_connect).toBeUndefined();
    expect(PolicyOverrideSchema.parse({ agent_connect: 'any_member' }).agent_connect).toBe(
      'any_member',
    );
  });
});
