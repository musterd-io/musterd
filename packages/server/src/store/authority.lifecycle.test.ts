import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import {
  buildDescriptor,
  enrollKeyGuarded,
  issueEnrollmentCode,
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

  it('first key by code only; further keys by code or a standing key; revoke by another key or code', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    const base = { teamId: team.id, audience: team.slug, member: nick };

    // An agent can never enroll a key, even with a code minted for the human.
    const adaCode = await issueEnrollmentCode(db, {
      teamId: team.id,
      memberId: ada.id,
      actor: 'ada',
    });
    await expect(
      enrollKeyGuarded(db, {
        teamId: team.id,
        audience: team.slug,
        member: ada,
        publicKey: keypair().publicKey,
        kind: 'platform',
        code: adaCode.code,
      }),
    ).resolves.toEqual({ ok: false, reason: 'agent_credential' });

    // No code, no standing key: refused.
    const k1 = keypair();
    await expect(
      enrollKeyGuarded(db, { ...base, publicKey: k1.publicKey, kind: 'platform' }),
    ).resolves.toEqual({ ok: false, reason: 'code_required' });
    await expect(
      enrollKeyGuarded(db, { ...base, publicKey: k1.publicKey, kind: 'platform', code: 'nope' }),
    ).resolves.toEqual({ ok: false, reason: 'bad_code' });

    // The explicit human path: one code, one key, one use.
    const issued = await issueEnrollmentCode(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    const first = await enrollKeyGuarded(db, {
      ...base,
      publicKey: k1.publicKey,
      kind: 'platform',
      code: issued.code,
    });
    expect(first.ok).toBe(true);
    const key1 = first.ok ? first.key : null;
    await expect(
      enrollKeyGuarded(db, {
        ...base,
        publicKey: keypair().publicKey,
        kind: 'platform',
        code: issued.code,
      }),
    ).resolves.toEqual({ ok: false, reason: 'bad_code' });

    // A second key by the first key's signature over device_key_admin.
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
      proof: { key_id: key1!.id, nonce: d.nonce, signature: k1.sign(d) },
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
      payload: { action: 'revoke', key_id: key1!.id },
    });
    await expect(
      revokeKeyGuarded(db, {
        ...base,
        keyId: key1!.id,
        proof: { key_id: key1!.id, nonce: dSelf.nonce, signature: k1.sign(dSelf) },
      }),
    ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
    const dRevoke = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key1!.id },
    });
    await expect(
      revokeKeyGuarded(db, {
        ...base,
        keyId: key1!.id,
        proof: { key_id: key2!.id, nonce: dRevoke.nonce, signature: k2.sign(dRevoke) },
      }),
    ).resolves.toEqual({ ok: true, via: 'approval' });

    // Lost-device recovery: the last key goes by code, and a fresh key enrolls by code.
    const recovery = await issueEnrollmentCode(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    await expect(
      revokeKeyGuarded(db, { ...base, keyId: key2!.id, code: recovery.code }),
    ).resolves.toEqual({ ok: true, via: 'code' });
    const recovery2 = await issueEnrollmentCode(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    const recovered = await enrollKeyGuarded(db, {
      ...base,
      publicKey: keypair().publicKey,
      kind: 'platform',
      code: recovery2.code,
    });
    expect(recovered.ok).toBe(true);

    // The audit shows the lifecycle and never a code.
    const rows = await listAudit(db, team.id, { limit: 50 });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('device_key.enrolled');
    expect(actions).toContain('device_key.revoked');
    expect(JSON.stringify(rows)).not.toContain(issued.code);
    expect(JSON.stringify(rows)).not.toContain(recovery.code);
  });
});
