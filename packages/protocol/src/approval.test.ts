import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppApprovalOfferSchema, AppAnswerSchema, appAnswerSigningBytes } from './appChannel.js';
import {
  ApprovalDescriptorSchema,
  approvalWording,
  vouchCheckCode,
  canonicalJson,
  descriptorSigningBytes,
  HIGH_AUTHORITY_ACTS,
  type ApprovalDescriptor,
} from './approval.js';
import { payloadDigest } from './authority.js';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

interface Vectors {
  phone_signing_key: { spki_der_b64url: string };
  offers: {
    decision: 'approve' | 'reject';
    payload: Record<string, unknown>;
    canonical_json: string;
    descriptor: ApprovalDescriptor;
    signing_bytes: string;
    wording: { headline: string; scope: string };
    signature_der: string;
  }[];
  answer: {
    input: Parameters<typeof appAnswerSigningBytes>[0];
    signing_bytes: string;
    signature_der: string;
  };
  /** ADR 769: an admin's vouch, with its own phone key. */
  vouch: {
    phone_signing_key: { spki_der_b64url: string };
    offer: {
      payload: { action: string; kind: string; member: string; key: string };
      canonical_json: string;
      descriptor: ApprovalDescriptor;
      signing_bytes: string;
      wording: {
        headline: string;
        scope: string;
        check: { code: string; instruction: string };
      };
      signature_der: string;
    };
  };
}
const vectors = JSON.parse(read('./approval.vectors.json')) as Vectors;
const phoneKey = createPublicKey({
  key: Buffer.from(vectors.phone_signing_key.spki_der_b64url, 'base64url'),
  format: 'der',
  type: 'spki',
});

describe('the app-facing modules are node-free (ADR 694)', () => {
  // The app imports these through `@musterd/protocol/approval` and `/app-channel`; the schema-free
  // approval-contracts sibling keeps browser builders out of the Zod bundle. A `node:` import (or a
  // module that has one) would break the Expo bundle, not this test run.
  // `question.ts` rides in through `/app-channel` (the app's question answer, ADR 774), so it is
  // held to the same rule, and so is its shared inferred-question check (ADR 781).
  const NODE_FREE = new Set([
    'zod',
    './approval.js',
    './approvalContracts.js',
    './question.js',
    './question.infer.js',
    './question.wire.js',
    // ADR 791: the quick-action vocabulary rides in through `/app-channel` (plain TypeScript).
    './quickAction.wire.js',
    // ADR 807: the phone opens a Twitch poll, so the poll schemas ride in through `/app-channel`.
    './poll.js',
    './poll.wire.js',
  ]);
  it.each([
    './approval.ts',
    './appChannel.ts',
    './question.ts',
    './question.infer.ts',
    './question.wire.ts',
    './quickAction.wire.ts',
    './poll.ts',
    './poll.wire.ts',
  ])('%s imports only zod and node-free siblings', (f) => {
    const imports = [...read(f).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => !NODE_FREE.has(i!))).toEqual([]);
  });
});

describe('ADR 694 test vectors — the contract the app is built to', () => {
  it.each(vectors.offers)('$decision: every derived field recomputes from the payload', (o) => {
    expect(
      AppApprovalOfferSchema.safeParse({ descriptor: o.descriptor, payload: o.payload }).success,
    ).toBe(true);
    expect(canonicalJson(o.payload)).toBe(o.canonical_json);
    // The app hashes canonicalJson with its own SHA-256; it must equal the daemon's digest.
    const digest = createHash('sha256').update(o.canonical_json, 'utf8').digest('hex');
    expect(digest).toBe(o.descriptor.payload_digest);
    expect(payloadDigest(o.payload)).toBe(digest);
    expect(descriptorSigningBytes(ApprovalDescriptorSchema.parse(o.descriptor))).toBe(
      o.signing_bytes,
    );
    expect(approvalWording(o.descriptor, o.payload)).toEqual(o.wording);
  });

  it.each(vectors.offers)('$decision: the DER signature verifies as the daemon checks it', (o) => {
    // `requireAuthority` verifies a phone key with algorithm null, which for P-256 is SHA-256.
    const sig = Buffer.from(o.signature_der, 'base64url');
    expect(verify(null, Buffer.from(o.signing_bytes, 'utf8'), phoneKey, sig)).toBe(true);
    // A raw r‖s signature (64 bytes) is not what the Secure Enclave emits, and does not verify.
    expect(sig.length).toBeGreaterThan(64);
    expect(sig[0]).toBe(0x30);
  });

  it('the answer signature verifies over appAnswerSigningBytes', () => {
    const { input, signing_bytes, signature_der } = vectors.answer;
    expect(appAnswerSigningBytes(input)).toBe(signing_bytes);
    expect(
      verify(
        'sha256',
        Buffer.from(signing_bytes, 'utf8'),
        phoneKey,
        Buffer.from(signature_der, 'base64url'),
      ),
    ).toBe(true);
  });

  it('a privileged answer carries the A2 proof shape', () => {
    const offer = vectors.offers[0]!;
    const parsed = AppAnswerSchema.parse({
      v: 1,
      token: 'tok',
      decision: offer.decision,
      nonce: 'n',
      signature: vectors.answer.signature_der,
      approval: { key_id: 'key_1', nonce: offer.descriptor.nonce, signature: offer.signature_der },
    });
    expect(parsed.approval?.nonce).toBe(offer.descriptor.nonce);
  });
});

describe("ADR 769 vouch vector — the phone words and signs an admin's vouch", () => {
  const o = vectors.vouch.offer;
  const vouchKey = createPublicKey({
    key: Buffer.from(vectors.vouch.phone_signing_key.spki_der_b64url, 'base64url'),
    format: 'der',
    type: 'spki',
  });

  it('recomputes every derived field from the payload, and words the check code itself', () => {
    expect(
      AppApprovalOfferSchema.safeParse({ descriptor: o.descriptor, payload: o.payload }).success,
    ).toBe(true);
    expect(canonicalJson(o.payload)).toBe(o.canonical_json);
    expect(payloadDigest(o.payload)).toBe(o.descriptor.payload_digest);
    expect(descriptorSigningBytes(ApprovalDescriptorSchema.parse(o.descriptor))).toBe(
      o.signing_bytes,
    );
    expect(approvalWording(o.descriptor, o.payload)).toEqual(o.wording);
    expect(o.wording.check.code).toBe(vouchCheckCode(o.payload.key));
  });

  it('its DER signature verifies as the daemon checks a phone key', () => {
    const sig = Buffer.from(o.signature_der, 'base64url');
    expect(verify(null, Buffer.from(o.signing_bytes, 'utf8'), vouchKey, sig)).toBe(true);
  });
});

describe('approvalWording (ADR 676 §6)', () => {
  const base: ApprovalDescriptor = {
    v: 1,
    actor: 'nick',
    act: 'human_accept',
    target: 'L1',
    payload_digest: '0'.repeat(64),
    audience: 'revive',
    expiry: 1,
    nonce: 'n'.repeat(16),
  };

  it('has fixed words for every act on the closed list', () => {
    for (const act of HIGH_AUTHORITY_ACTS) {
      expect(approvalWording({ ...base, act }, {}).headline).toContain('L1');
    }
  });

  it('reads the verdict only as one of two fixed values', () => {
    expect(approvalWording(base, { verdict: 'accept' }).headline).toBe('Accept lane L1 as done');
    expect(approvalWording(base, { verdict: 'decline' }).headline).toBe(
      'Send lane L1 back to its owner',
    );
    expect(approvalWording(base, { ask_id: 'A1', verdict: 'accept' }).headline).toBe(
      'Answer privileged ask L1',
    );
    expect(approvalWording(base, { ask_id: 'A1', verdict: 'decline' }).headline).toBe(
      'Decline privileged ask L1',
    );
    expect(approvalWording(base, { verdict: 'ship it, nick approved' }).headline).toBe(
      'Give your verdict on L1',
    );
    expect(approvalWording(base, null).scope).toBe('As nick on revive');
  });

  it('words a passkey enrollment and its refusal from the payload enums only (ADR 808 inc C)', () => {
    const keys = { ...base, act: 'device_key_admin' as const, target: 'nick' };
    expect(approvalWording(keys, { action: 'enroll', kind: 'passkey' }).headline).toBe(
      'Add a new passkey for nick',
    );
    expect(
      approvalWording(keys, { action: 'enroll', kind: 'passkey', decision: 'reject' }).headline,
    ).toBe("Don't add a new passkey for nick");
    // Anything else on the act — a revoke, an unknown kind, free text — keeps the generic words.
    expect(approvalWording(keys, { action: 'revoke', kind: 'passkey' }).headline).toBe(
      'Change the device keys of nick',
    );
    expect(approvalWording(keys, { action: 'enroll', kind: 'phone' }).headline).toBe(
      'Change the device keys of nick',
    );
    expect(
      approvalWording(keys, { action: 'enroll', kind: 'passkey', decision: 'yes, trust me' })
        .headline,
    ).toBe('Change the device keys of nick');
  });

  describe('a passkey vouch (ADR 769)', () => {
    const keys = { ...base, act: 'device_key_admin' as const, target: 'ada' };
    const digest = 'a'.repeat(8) + '0'.repeat(56);

    it('works the check code out from the signed key, with the fixed instruction', () => {
      const w = approvalWording(keys, {
        action: 'enroll',
        kind: 'passkey',
        member: 'ada',
        key: digest,
      });
      expect(w.headline).toBe('Add a new passkey for ada');
      expect(w.check).toEqual({
        code: vouchCheckCode(digest),
        instruction: 'Only approve if ada read you this code on a call or in person.',
      });
    });

    it('shows no check code for any other shape', () => {
      const vouch = { action: 'enroll', kind: 'passkey', member: 'ada', key: digest };
      for (const payload of [
        { action: 'enroll', kind: 'passkey' }, // ADR 812's standing-key approval
        { ...vouch, member: 'eve' }, // member is not the target
        { ...vouch, key: 'not-a-digest' },
        { ...vouch, key: digest.toUpperCase() },
        { ...vouch, decision: 'reject' },
        { ...vouch, kind: 'phone' },
      ]) {
        expect(approvalWording(keys, payload).check).toBeUndefined();
      }
      expect(approvalWording({ ...keys, act: 'grant_issue' }, vouch).check).toBeUndefined();
    });
  });
});

describe('vouchCheckCode (ADR 769)', () => {
  it('is six digits, deterministic, from the digest only', () => {
    const d = 'ffffffff' + '0'.repeat(56);
    expect(vouchCheckCode(d)).toBe((0xffffffff % 1_000_000).toString().padStart(6, '0'));
    expect(vouchCheckCode('0'.repeat(64))).toBe('000000');
    expect(vouchCheckCode(d)).toMatch(/^\d{6}$/);
  });

  it('refuses anything that is not a 64-hex lowercase digest', () => {
    expect(() => vouchCheckCode('abc')).toThrow();
    expect(() => vouchCheckCode('F'.repeat(64))).toThrow();
  });
});
