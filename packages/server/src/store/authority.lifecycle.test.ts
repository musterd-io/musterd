import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import {
  buildDescriptor,
  enrollDeviceKey,
  enrollKeyGuarded,
  revokeKeyGuarded,
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

withDrivers('device-key lifecycle (ADR 662 decision 6)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('passkey-first: a Bearer alone enrolls nothing; standing keys enroll and revoke', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const base = { teamId: team.id, audience: team.slug, member: nick };

    // An agent can never enroll a key.
    await expect(
      enrollKeyGuarded(db, {
        teamId: team.id,
        audience: team.slug,
        member: ada,
        publicKey: keypair().publicKey,
        kind: 'platform',
      }),
    ).resolves.toEqual({ ok: false, reason: 'agent_credential' });

    // Lazara's attack (HA2 decline of #2966): the human's Bearer, an attacker key,
    // no standing key — refused. The first key is a passkey ceremony, never raw.
    const attacker = keypair();
    await expect(
      enrollKeyGuarded(db, { ...base, publicKey: attacker.publicKey, kind: 'platform' }),
    ).resolves.toEqual({ ok: false, reason: 'passkey_first' });

    // The first key stands (enrolled by the passkey ceremony in the passkey suite).
    const k1 = keypair();
    const key1 = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: k1.publicKey,
      kind: 'platform',
    });

    // A second key needs the standing key's signature over device_key_admin.
    const k2 = keypair();
    await expect(
      enrollKeyGuarded(db, { ...base, publicKey: k2.publicKey, kind: 'phone' }),
    ).resolves.toEqual({ ok: false, reason: 'no_signature' });
    const d = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'enroll', public_key: k2.publicKey, kind: 'phone' },
    });
    const second = await enrollKeyGuarded(db, {
      ...base,
      publicKey: k2.publicKey,
      kind: 'phone',
      proof: { key_id: key1.id, nonce: d.nonce, signature: k1.sign(d) },
    });
    expect(second.ok).toBe(true);
    const key2 = second.ok ? second.key : null;

    // A key never revokes itself while another stands; the other key can revoke it.
    const dSelf = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key1.id },
    });
    await expect(
      revokeKeyGuarded(db, {
        ...base,
        keyId: key1.id,
        proof: { key_id: key1.id, nonce: dSelf.nonce, signature: k1.sign(dSelf) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
    const dRevoke = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key1.id },
    });
    await expect(
      revokeKeyGuarded(db, {
        ...base,
        keyId: key1.id,
        proof: { key_id: key2!.id, nonce: dRevoke.nonce, signature: k2.sign(dRevoke) },
      }),
    ).resolves.toEqual({ ok: true, via: 'approval' });

    // The sole standing key may retire itself (lost-device path). Recovery after
    // that is a fresh passkey ceremony: raw enrollment still refuses.
    const dLast = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key2!.id },
    });
    await expect(
      revokeKeyGuarded(db, {
        ...base,
        keyId: key2!.id,
        proof: { key_id: key2!.id, nonce: dLast.nonce, signature: k2.sign(dLast) },
      }),
    ).resolves.toEqual({ ok: true, via: 'approval' });
    await expect(
      enrollKeyGuarded(db, { ...base, publicKey: keypair().publicKey, kind: 'platform' }),
    ).resolves.toEqual({ ok: false, reason: 'passkey_first' });

    const rows = await listAudit(db, team.id, { limit: 50 });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('device_key.enrolled');
    expect(actions).toContain('device_key.revoked');
  });
});
