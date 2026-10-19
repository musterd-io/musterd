import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { configPath } from '../config.js';
import { CliError } from '../errors.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd authority enroll [--kind platform]\n' +
  '       musterd authority keys\n' +
  '       musterd authority revoke <key-id>';

/**
 * ADR 662 decision 6 — the device-key lifecycle from the terminal. `enroll` is the explicit
 * human path: it asks the daemon for a one-time enrollment code with the human's own
 * credential, generates an Ed25519 keypair here, keeps the private half in a 0600 file
 * beside the CLI config (never beside the workspace, never on the server), and enrolls the
 * public half. Run it as the human, from the human's terminal — the daemon audits every
 * step. Lane 3 replaces this file storage with real authenticators (Secure Enclave,
 * passkey); what is enrolled here is a key whose private half a person holds, and the gate
 * (lane 1) is already live for it.
 */

interface StoredDeviceKey {
  key_id: string;
  kind: string;
  public_key: string;
  private_key: string;
}

function keyFile(team: string, member: string): string {
  const safe = `${team}-${member}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(dirname(configPath()), 'device-keys', `${safe}.json`);
}

function readStoredKey(team: string, member: string): StoredDeviceKey | null {
  const path = keyFile(team, member);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as StoredDeviceKey;
}

function writeStoredKey(team: string, member: string, key: StoredDeviceKey): void {
  const path = keyFile(team, member);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function printJson(value: unknown): number {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return 0;
}

export async function authorityCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0] ?? 'keys';
  const { team, identity, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;
  const member = identity.name;

  if (sub === 'enroll') {
    const kind = flagStr(parsed.flags, 'kind') ?? 'platform';
    const { code } = await http.issueEnrollmentCode(team);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const { key } = await http.enrollDeviceKey(team, {
      public_key,
      kind,
      enrollment_code: code,
    });
    writeStoredKey(team, member, {
      key_id: key.id,
      kind,
      public_key,
      private_key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    });
    if (json) return printJson(key);
    process.stdout.write(
      success(`device key enrolled for ${member} (${kind}, ${key.id})`, {
        next: 'high-authority acts now need this key’s signature (ADR 662)',
      }) + '\n',
    );
    process.stdout.write(`  private key: ${keyFile(team, member)} (0600, never sent anywhere)\n`);
    return 0;
  }

  if (sub === 'keys') {
    const { keys } = await http.listDeviceKeys(team);
    if (json) return printJson(keys);
    if (keys.length === 0) process.stdout.write('no device keys enrolled\n');
    const stored = readStoredKey(team, member);
    for (const k of keys) {
      process.stdout.write(
        `${k.id}  ${k.kind}  ${k.revoked_at ? 'revoked' : 'active'}${stored?.key_id === k.id ? '  (private key on this machine)' : ''}\n`,
      );
    }
    return 0;
  }

  if (sub === 'revoke') {
    const keyId = parsed.positionals[1];
    if (!keyId) throw new CliError(USAGE, 2);
    const stored = readStoredKey(team, member);
    if (stored && stored.key_id !== keyId) {
      // Revoke with the standing key's signature (never the target key's own).
      const { descriptor } = await http.createAuthorityDescriptor(team, {
        act: 'device_key_admin',
        target: member,
        payload: { action: 'revoke', key_id: keyId },
      });
      const signature = cryptoSign(
        null,
        Buffer.from(descriptorSigningBytes(descriptor as ApprovalDescriptor), 'utf8'),
        createPrivateKey({
          key: Buffer.from(stored.private_key, 'base64url'),
          format: 'der',
          type: 'pkcs8',
        }),
      ).toString('base64url');
      await http.revokeDeviceKey(team, keyId, {
        approval: { key_id: stored.key_id, nonce: descriptor.nonce, signature },
      });
    } else {
      // No other standing key here: the lost-device path, by enrollment code.
      const { code } = await http.issueEnrollmentCode(team);
      await http.revokeDeviceKey(team, keyId, { enrollment_code: code });
    }
    if (json) return printJson({ ok: true, key_id: keyId });
    process.stdout.write(success(`device key ${keyId} revoked`) + '\n');
    return 0;
  }

  throw new CliError(USAGE, 2);
}
