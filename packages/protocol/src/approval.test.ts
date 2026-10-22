import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppApprovalOfferSchema, AppAnswerSchema, appAnswerSigningBytes } from './appChannel.js';
import {
  ApprovalDescriptorSchema,
  approvalWording,
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
}
const vectors = JSON.parse(read('./approval.vectors.json')) as Vectors;
const phoneKey = createPublicKey({
  key: Buffer.from(vectors.phone_signing_key.spki_der_b64url, 'base64url'),
  format: 'der',
  type: 'spki',
});

describe('the app-facing modules are node-free (ADR 694)', () => {
  // The app imports these through `@musterd/protocol/approval` and `/app-channel`; a `node:`
  // import (or a module that has one) would break the Expo bundle, not this test run.
  it.each(['./approval.ts', './appChannel.ts'])(
    '%s imports only zod and node-free siblings',
    (f) => {
      const imports = [...read(f).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => i !== 'zod' && i !== './approval.js')).toEqual([]);
    },
  );
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
});
