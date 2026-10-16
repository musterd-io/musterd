import { describe, expect, it } from 'vitest';
import {
  BootstrapCutoverRequestSchema,
  BootstrapMigrationRequestSchema,
  containsMusterdCredential,
  PolicyOverrideSchema,
  PolicySchema,
  SPEND_CAP_USD_MAX,
  sparsifyPolicy,
} from './credentials.js';
import { StylePolicySchema } from './style.js';

describe('PolicySchema.style (ADR 514)', () => {
  it('a team that never set style reads the shipped default', () => {
    expect(PolicySchema.parse({}).style).toEqual(StylePolicySchema.parse({}));
  });
  it('a sparse floor override stays sparse on the wire and dense on read', () => {
    const wire = PolicyOverrideSchema.parse({
      style: { floor: { assess_before_agreeing: false } },
    });
    expect(wire.style).toEqual({ floor: { assess_before_agreeing: false } });
    const read = PolicySchema.parse(wire);
    expect(read.style.floor).toEqual({
      assess_before_agreeing: false,
      disagree_once_then_commit: true,
      concession_names_check: true,
      human_critique_weighed_as_peer: true,
    });
  });
  it('sparsifyPolicy keeps a sparse floor override sparse (review I5)', () => {
    expect(sparsifyPolicy({ style: { floor: { assess_before_agreeing: false } } })).toEqual({
      style: { floor: { assess_before_agreeing: false } },
    });
  });
  it('sparsifyPolicy drops a style block that equals the default and keeps one that differs', () => {
    expect(sparsifyPolicy({ style: StylePolicySchema.parse({}) })).toEqual({});
    expect(
      sparsifyPolicy({ style: { ...StylePolicySchema.parse({}), prose: 'Units on numbers.' } }),
    ).toEqual({ style: { prose: 'Units on numbers.' } });
  });
});

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

describe('PolicySchema.agent_host / invite_requires_expiry (ADR 463)', () => {
  it('defaults: max_per_host 5, empty policy, invites need no expiry', () => {
    const p = PolicySchema.parse({});
    expect(p.agent_host).toEqual({ max_per_host: 5, policy: {} });
    expect(p.invite_requires_expiry).toBe(false);
  });
  it('bounds max_per_host to 1..100 and keeps budget_usd optional at the schema (required at claim, not here)', () => {
    expect(PolicySchema.safeParse({ agent_host: { max_per_host: 0 } }).success).toBe(false);
    expect(PolicySchema.safeParse({ agent_host: { max_per_host: 101 } }).success).toBe(false);
    expect(
      PolicySchema.parse({ agent_host: { policy: { budget_usd: 2 } } }).agent_host.policy
        .budget_usd,
    ).toBe(2);
  });
  it('PolicyOverrideSchema keeps agent_host sparse', () => {
    expect(PolicyOverrideSchema.parse({ agent_host: { max_per_host: 2 } })).toEqual({
      agent_host: { max_per_host: 2 },
    });
  });
  it('sparsifyPolicy drops a dense agent_host that equals the defaults, keeps a chosen budget', () => {
    expect(sparsifyPolicy({ agent_host: { max_per_host: 5, policy: {} } })).toEqual({});
    expect(sparsifyPolicy({ agent_host: { max_per_host: 5, policy: { budget_usd: 3 } } })).toEqual({
      agent_host: { policy: { budget_usd: 3 } },
    });
  });
});

describe('PolicySchema.spend_cap_usd (ADR 602)', () => {
  it('is unset on an empty policy — absent, not zero', () => {
    expect(PolicySchema.parse({}).spend_cap_usd).toBeUndefined();
    expect(PolicyOverrideSchema.parse({}).spend_cap_usd).toBeUndefined();
  });

  it('accepts a positive finite amount up to the ceiling, including cents', () => {
    expect(PolicySchema.parse({ spend_cap_usd: 12.5 }).spend_cap_usd).toBe(12.5);
    expect(PolicySchema.parse({ spend_cap_usd: SPEND_CAP_USD_MAX }).spend_cap_usd).toBe(
      SPEND_CAP_USD_MAX,
    );
  });

  it('rejects zero, negatives, non-finite values, and a fat-finger past the ceiling', () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, SPEND_CAP_USD_MAX + 0.01]) {
      expect(PolicySchema.safeParse({ spend_cap_usd: bad }).success).toBe(false);
      expect(PolicyOverrideSchema.safeParse({ spend_cap_usd: bad }).success).toBe(false);
    }
  });

  it('sparsifyPolicy keeps a chosen cap — the key has no schema default to collapse into', () => {
    expect(sparsifyPolicy({ spend_cap_usd: 12.5 })).toEqual({ spend_cap_usd: 12.5 });
  });
});

describe('PolicySchema.spend_approval_usd (ADR 635)', () => {
  it('is unset on an empty policy — absent, and never zero', () => {
    expect(PolicySchema.parse({}).spend_approval_usd).toBeUndefined();
    expect(PolicyOverrideSchema.parse({}).spend_approval_usd).toBeUndefined();
  });

  it('accepts a positive finite amount up to the ceiling, including cents', () => {
    expect(PolicySchema.parse({ spend_approval_usd: 12.5 }).spend_approval_usd).toBe(12.5);
    expect(PolicySchema.parse({ spend_approval_usd: SPEND_CAP_USD_MAX }).spend_approval_usd).toBe(
      SPEND_CAP_USD_MAX,
    );
  });

  it('rejects zero, negatives, non-finite values, and a fat-finger past the ceiling', () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, SPEND_CAP_USD_MAX + 0.01]) {
      expect(PolicySchema.safeParse({ spend_approval_usd: bad }).success).toBe(false);
      expect(PolicyOverrideSchema.safeParse({ spend_approval_usd: bad }).success).toBe(false);
    }
  });

  it('sparsifyPolicy keeps a chosen threshold — the key has no schema default to collapse into', () => {
    expect(sparsifyPolicy({ spend_approval_usd: 12.5 })).toEqual({ spend_approval_usd: 12.5 });
  });
});
