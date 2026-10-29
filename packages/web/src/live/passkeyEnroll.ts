import {
  authorityProofForPasskeyEnroll,
  b64urlToBytes,
  bytesToB64url,
  isLoopbackIp,
} from './authorityProof';
import { apiGet, apiPost, type LiveConfig } from './client';

/**
 * Enrolling a passkey from /live (ADR 767): the ceremony the daemon's `/authority/passkey` page runs
 * for `musterd authority enroll`, run in the settings sheet instead. The daemon's rules are unchanged,
 * because the same two routes decide: a challenge bound to this human
 * (`POST /authority/enrollment-challenges`), then the registration
 * (`POST /authority/passkeys`). A further passkey carries the standing passkey's approval; a first one
 * past team genesis needs an admin countersign, which the daemon refuses as `countersign_required`.
 *
 * Its own module so only the settings sheet's lazy chunk carries it.
 */

export interface DeviceKey {
  id: string;
  kind: string;
  created_at: number;
  revoked_at: number | null;
}

/** This human's device keys (passkeys and phones), revoked ones included. */
export async function fetchMyDeviceKeys(cfg: LiveConfig): Promise<DeviceKey[]> {
  const out = await apiGet<{ keys: DeviceKey[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/authority/keys`,
  );
  return out.keys;
}

/** Why an enrollment was refused, in words a person can act on. */
export function enrollRefusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/countersign_required/.test(text)) {
    return (
      'this team already has passkeys, so an admin must vouch for your first one, and that ' +
      'step is still in the terminal: run `musterd authority enroll --confirmed-by <admin>` ' +
      'and it prints what the admin runs on the hub'
    );
  }
  if (/bad_challenge/.test(text)) return 'the enrollment code expired — try again';
  return text;
}

/**
 * Run the ceremony and register the passkey. `standing` says whether this human already has an
 * active key: then the new passkey needs that key's approval first, collected the same way a verdict's
 * is, by the passkey already enrolled.
 */
export async function enrollPasskey(
  cfg: LiveConfig,
  member: string,
  standing: boolean,
): Promise<DeviceKey> {
  if (!navigator.credentials?.create) throw new Error('passkeys are unavailable in this browser');
  const approval = standing ? await authorityProofForPasskeyEnroll(cfg, member) : null;
  if (standing && !approval) {
    throw new Error(
      'your enrolled key is not a passkey, so this browser cannot approve another one — run `musterd authority enroll`',
    );
  }
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const { challenge } = await apiPost<{ challenge: string }>(
    cfg,
    `${teamPath}/enrollment-challenges`,
    {},
  );
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(challenge) as BufferSource,
        rp: { name: 'musterd' },
        user: {
          id: new TextEncoder().encode(member) as BufferSource,
          name: member,
          displayName: member,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
        ],
        authenticatorSelection: { userVerification: 'required' },
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    // WebAuthn refuses an IP-literal origin; the daemon's localhost URL works (ADR 662 decision 5).
    if (e instanceof DOMException && e.name === 'SecurityError' && isLoopbackIp(location.hostname))
      throw new Error('open musterd’s localhost URL to use passkeys; nothing was enrolled');
    if (e instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(e.name))
      throw new Error('passkey cancelled; nothing was enrolled');
    throw e;
  }
  if (!cred) throw new Error('passkey cancelled; nothing was enrolled');
  const resp = cred.response as AuthenticatorAttestationResponse;
  const { key } = await apiPost<{ key: { id: string; kind: string } }>(cfg, `${teamPath}/passkeys`, {
    actor: member,
    challenge,
    ...(approval ? { approval } : {}),
    registration: {
      attestation_object: bytesToB64url(resp.attestationObject),
      // Posted decoded, as the daemon's own enroll page does: the verifier hashes this utf8 text.
      client_data_json: new TextDecoder().decode(resp.clientDataJSON),
    },
  });
  return { id: key.id, kind: key.kind, created_at: Date.now(), revoked_at: null };
}
