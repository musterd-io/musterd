import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import {
  buildDescriptor,
  enrollDeviceKey,
  requireAuthority,
  revokeDeviceKey,
} from './authority.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (d: ApprovalDescriptor) =>
      cryptoSign(null, Buffer.from(descriptorSigningBytes(d), 'utf8'), privateKey).toString(
        'base64url',
      ),
  };
}

withDrivers('human authority (ADR 662)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed(db: Driver) {
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    return { team, nick, ada };
  }

  const act = {
    act: 'human_accept' as const,
    target: '01LANE',
    payload: { state: 'done' },
  };

  it('an unenrolled human proceeds on the old path; an agent credential never does', async () => {
    const db = await openStore();
    const { team, nick, ada } = await seed(db);
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: nick,
        credential: 'human',
        ...act,
      }),
    ).resolves.toEqual({ ok: true, assurance: 'bearer_unenrolled' });
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: ada,
        credential: 'agent',
        ...act,
      }),
    ).resolves.toEqual({ ok: false, reason: 'agent_credential' });
  });

  it('once enrolled, a listed act needs a fresh signature over the server descriptor', async () => {
    const db = await openStore();
    const { team, nick } = await seed(db);
    const kp = keypair();
    const key = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: kp.publicKey,
      kind: 'platform',
    });
    const base = {
      teamId: team.id,
      audience: team.slug,
      presenter: nick,
      credential: 'human' as const,
      ...act,
    };
    // The config.json attack: the human's own Bearer, no signature.
    await expect(requireAuthority(db, base)).resolves.toEqual({
      ok: false,
      reason: 'no_signature',
    });
    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    const proof = { key_id: key.id, nonce: descriptor.nonce, signature: kp.sign(descriptor) };
    const ok = await requireAuthority(db, { ...base, proof });
    expect(ok).toEqual({ ok: true, assurance: 'A2', keyId: key.id, kind: 'platform' });
    // One-use: the same proof never works twice.
    await expect(requireAuthority(db, { ...base, proof })).resolves.toEqual({
      ok: false,
      reason: 'nonce_reused',
    });
    // The audit carries the refusal and the approval, with no signature material.
    const rows = await listAudit(db, team.id, { limit: 20 });
    const refused = rows.filter((r) => r.action === 'authority.refused');
    const approved = rows.filter((r) => r.action === 'authority.approved');
    expect(
      refused.map((r) => (JSON.parse(r.detail ?? '{}') as { reason: string }).reason).sort(),
    ).toEqual(['no_signature', 'nonce_reused']);
    expect(approved).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(proof.signature);
    expect(JSON.stringify(rows)).not.toContain(descriptor.nonce);
  });

  it('a phone key signs as ECDSA P-256, DER; checkOnly verifies without spending (ADR 694)', async () => {
    const db = await openStore();
    const { team, nick } = await seed(db);
    const phone = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const key = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: phone.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'phone',
    });
    const base = {
      teamId: team.id,
      audience: team.slug,
      presenter: nick,
      credential: 'human' as const,
      ...act,
    };
    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    // What the Secure Enclave emits for ecdsaSignatureMessageX962SHA256: SHA-256, DER.
    const proof = {
      key_id: key.id,
      nonce: descriptor.nonce,
      signature: cryptoSign(
        'sha256',
        Buffer.from(descriptorSigningBytes(descriptor), 'utf8'),
        phone.privateKey,
      ).toString('base64url'),
    };
    const expected = { ok: true, assurance: 'A2', keyId: key.id, kind: 'phone' };
    await expect(requireAuthority(db, { ...base, proof, checkOnly: true })).resolves.toEqual(
      expected,
    );
    await expect(requireAuthority(db, { ...base, proof, checkOnly: true })).resolves.toEqual(
      expected,
    );
    const rows = await listAudit(db, team.id, { limit: 20 });
    expect(rows.filter((r) => r.action === 'authority.approved')).toHaveLength(0);
    // The real presentation spends it, once.
    await expect(requireAuthority(db, { ...base, proof })).resolves.toEqual(expected);
    await expect(requireAuthority(db, { ...base, proof })).resolves.toEqual({
      ok: false,
      reason: 'nonce_reused',
    });
    // checkOnly still refuses what the gate refuses, and audits it.
    await expect(
      requireAuthority(db, { ...base, payload: { state: 'other' }, proof, checkOnly: true }),
    ).resolves.toEqual({ ok: false, reason: 'nonce_reused' });
  });

  it('a software key never qualifies as A2, however valid its signature', async () => {
    const db = await openStore();
    const { team, nick } = await seed(db);
    const kp = keypair();
    const key = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: kp.publicKey,
      kind: 'software',
    });
    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: nick,
        credential: 'human',
        ...act,
        proof: { key_id: key.id, nonce: descriptor.nonce, signature: kp.sign(descriptor) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'assurance_too_low' });
  });

  it('two concurrent presentations of one proof: exactly one spends the nonce', async () => {
    const db = await openStore();
    const { team, nick } = await seed(db);
    const kp = keypair();
    const key = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: kp.publicKey,
      kind: 'platform',
    });
    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    const proof = { key_id: key.id, nonce: descriptor.nonce, signature: kp.sign(descriptor) };
    const base = {
      teamId: team.id,
      audience: team.slug,
      presenter: nick,
      credential: 'human' as const,
      ...act,
      proof,
    };
    const results = await Promise.all([
      requireAuthority(db, base),
      requireAuthority(db, base),
      requireAuthority(db, base),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  it('a signature over a different payload, an expired descriptor, and a revoked key all refuse', async () => {
    const db = await openStore();
    const { team, nick } = await seed(db);
    const kp = keypair();
    const key = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: kp.publicKey,
      kind: 'passkey',
    });
    const base = {
      teamId: team.id,
      audience: team.slug,
      presenter: nick,
      credential: 'human' as const,
      ...act,
    };
    const d1 = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    // Signed for {state:'done'}; presented for a different payload.
    await expect(
      requireAuthority(db, {
        ...base,
        payload: { state: 'active' },
        proof: { key_id: key.id, nonce: d1.nonce, signature: kp.sign(d1) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
    // Expired.
    const d2 = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
      now: Date.now() - 10 * 60 * 1000,
    });
    await expect(
      requireAuthority(db, {
        ...base,
        proof: { key_id: key.id, nonce: d2.nonce, signature: kp.sign(d2) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    // Revoked.
    await revokeDeviceKey(db, team.id, key.id);
    const d3 = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: nick.name,
      ...act,
    });
    await expect(
      requireAuthority(db, {
        ...base,
        proof: { key_id: key.id, nonce: d3.nonce, signature: kp.sign(d3) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'key_revoked' });
  });
});
