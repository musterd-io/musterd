import type { ApprovalProof } from '@musterd/protocol';
import {
  authorityProofForKeyRevoke,
  authorityProofForPasskeyEnroll,
  b64urlToBytes,
  bytesToB64url,
  isLoopbackIp,
} from './authorityProof';
import { apiGet, apiPost, LiveFetchError, type LiveConfig } from './client';

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
  /** ADR 808: where the key was made (`app` for a phone); absent or null when unrecorded. */
  origin?: string | null;
  /** ADR 808: the hostname a passkey is bound to; it signs only on a page with that hostname. */
  rp_id?: string | null;
  created_at: number;
  revoked_at: number | null;
}

/**
 * ADR 808: can this passkey sign on the page we are on? `null` when unrecorded (a key from before
 * the origin was kept), which a surface treats as "maybe" rather than refusing it.
 */
export function signsHere(key: DeviceKey, hostname: string): boolean | null {
  if (key.kind !== 'passkey') return null;
  if (key.rp_id === undefined || key.rp_id === null) return null;
  return key.rp_id === hostname;
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
  if (/usable_key_stands/.test(text))
    return 'a recovery code is for when no key of yours signs anywhere — one still does, so use it, or revoke it first';
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
  return registerPasskey(cfg, member, approval);
}

/**
 * ADR 808 inc C: enroll a passkey here with the PHONE's approval, for a human none of whose
 * passkeys sign on this origin. Mints the enrollment descriptor, asks the daemon to send it to the
 * paired phone as an approval ask, waits for the phone's signed proof to be parked on the nonce
 * (up to four minutes, polled every two seconds), then runs the registration ceremony with it.
 * `onWaiting` fires once the ask is on its way, so the page can say "check your phone".
 */
export async function enrollPasskeyViaPhone(
  cfg: LiveConfig,
  member: string,
  onWaiting?: () => void,
): Promise<DeviceKey> {
  if (!navigator.credentials?.create) throw new Error('passkeys are unavailable in this browser');
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const created = await apiPost<{ descriptor: { nonce: string } }>(cfg, `${teamPath}/descriptors`, {
    act: 'device_key_admin',
    target: member,
    payload: { action: 'enroll', kind: 'passkey' },
  });
  const nonce = created.descriptor.nonce;
  await apiPost<{ ask_id: string }>(
    cfg,
    `${teamPath}/descriptors/${encodeURIComponent(nonce)}/ask-phone`,
    { origin: location.origin },
  );
  onWaiting?.();
  const deadline = Date.now() + 4 * 60_000;
  let approval: ApprovalProof | null = null;
  while (!approval) {
    if (Date.now() > deadline) throw new Error('no answer from your phone in four minutes; nothing was enrolled');
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      approval = (await apiGet<{ proof: ApprovalProof }>(
        cfg,
        `${teamPath}/approvals/${encodeURIComponent(nonce)}`,
      )).proof;
    } catch (e) {
      if (!(e instanceof LiveFetchError && e.status === 404)) throw e;
    }
  }
  return registerPasskey(cfg, member, approval);
}

/**
 * ADR 808 inc D: enroll a passkey here with a RECOVERY code the hub's operator minted, for a human
 * none of whose keys sign anywhere the hub serves. The code is the ceremony's challenge; the daemon
 * waives the standing-key approval and the admin countersign for it, once, within five minutes.
 */
export async function enrollPasskeyWithRecoveryCode(
  cfg: LiveConfig,
  member: string,
  code: string,
): Promise<DeviceKey> {
  if (!navigator.credentials?.create) throw new Error('passkeys are unavailable in this browser');
  return registerPasskey(cfg, member, null, code.trim());
}

/** The registration ceremony itself, with whatever approval the caller collected (or none). */
async function registerPasskey(
  cfg: LiveConfig,
  member: string,
  approval: ApprovalProof | null,
  recoveryCode?: string,
): Promise<DeviceKey> {
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const challenge =
    recoveryCode ??
    (await apiPost<{ challenge: string }>(cfg, `${teamPath}/enrollment-challenges`, {})).challenge;
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
  return {
    id: key.id,
    kind: key.kind,
    origin: location.origin,
    rp_id: location.hostname,
    created_at: Date.now(),
    revoked_at: null,
  };
}

/**
 * ADR 808 inc B: revoke one of this human's keys from /live. The approval is a standing key's
 * signature over the server-built `device_key_admin` descriptor (ADR 662 decision 6), collected on
 * this page; the daemon decides, as it does for `musterd authority revoke`. The sole standing key
 * may retire itself (the lost-device path), and the caller says so before asking.
 */
export async function revokeDeviceKey(
  cfg: LiveConfig,
  member: string,
  keyId: string,
): Promise<void> {
  const approval = await authorityProofForKeyRevoke(cfg, member, keyId);
  if (!approval) {
    throw new Error(
      'none of your passkeys can sign on this page, so it cannot approve a revocation here',
    );
  }
  await apiPost<{ ok: true }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/authority/keys/${encodeURIComponent(keyId)}/revoke`,
    { approval },
  );
}
