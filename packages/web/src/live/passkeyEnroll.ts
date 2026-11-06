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
 * (`POST /authority/passkeys`). A further passkey carries the standing passkey's approval. A first
 * one past team genesis, or one for a member none of whose keys sign here, is HELD by the daemon for
 * an admin's vouch (ADR 769): the registration is sent with `hold: true` and comes back as `held`.
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
  /** The WebAuthn credential id of a passkey (null for a phone key; absent from an older daemon). */
  credential_id?: string | null;
  /** A phone key whose pairing ended (superseded or unpaired): not standing authority, whatever
   *  `revoked_at` says until the daemon's sweep catches up (lane 01M6Q1RDTK). */
  pairing_ended?: boolean;
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

/** ADR 769: a registration the daemon verified and holds until an admin vouches for it. */
export interface HeldEnrollment {
  digest: string;
  expiresAt: number;
  /** The admins whose vouch could be signed here; empty means nobody on the team can. */
  countersigners: string[];
}

export type EnrollOutcome =
  | { kind: 'enrolled'; key: DeviceKey }
  | { kind: 'held'; held: HeldEnrollment };

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
  if (/already holds a passkey/.test(text)) return text;
  if (/countersign_required/.test(text))
    return 'an admin must vouch for this passkey — start again and ask one from this sheet';
  if (/already_held/.test(text))
    return 'this enrollment code already holds another passkey — start again';
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
): Promise<EnrollOutcome> {
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
 * ADR 769: make a passkey here with no approval of your own, for an admin to vouch for — the path
 * for a member none of whose keys sign here and who has no phone. The daemon decides: it holds the
 * registration (`held`) when a vouch is needed, and refuses as usual when it is not.
 */
export async function enrollPasskeyForVouch(
  cfg: LiveConfig,
  member: string,
): Promise<EnrollOutcome> {
  if (!navigator.credentials?.create) throw new Error('passkeys are unavailable in this browser');
  return registerPasskey(cfg, member, null);
}

/** An outcome that must be an enrolled key (an approval or a recovery code was presented). */
function enrolledKey(outcome: EnrollOutcome): DeviceKey {
  if (outcome.kind === 'held') throw new Error('an admin must vouch for this passkey');
  return outcome.key;
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
  return enrolledKey(await registerPasskey(cfg, member, approval));
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
  return enrolledKey(await registerPasskey(cfg, member, null, code.trim()));
}

/**
 * The credentials a registration must EXCLUDE: every active passkey of the member's whose
 * credential id the daemon knows. A platform authenticator keeps one discoverable credential per
 * (relying party, user handle), and this page registers every passkey under the member's name, so
 * a create() that does not name the existing credentials REPLACES the one this device already
 * holds while the daemon keeps listing it: nick's Nov 4 passkey died the moment his Nov 5 one was
 * made (2026-11-05, lane 01M6Q3ZJJB). Named, the authenticator refuses with InvalidStateError and
 * the person is told to use the key they have. Pure, so it is testable without WebAuthn.
 */
export function excludeCredentialsFrom(
  keys: readonly Pick<DeviceKey, 'kind' | 'revoked_at' | 'credential_id'>[],
): string[] {
  return keys
    .filter((k) => k.kind === 'passkey' && k.revoked_at === null && !!k.credential_id)
    .map((k) => k.credential_id as string);
}

/**
 * The registration ceremony itself, with whatever approval the caller collected (or none). With
 * neither an approval nor a recovery code it asks the daemon to hold the registration for a vouch
 * (ADR 769), so a refusal for want of a countersign comes back as `held` instead.
 */
async function registerPasskey(
  cfg: LiveConfig,
  member: string,
  approval: ApprovalProof | null,
  recoveryCode?: string,
): Promise<EnrollOutcome> {
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const challenge =
    recoveryCode ??
    (await apiPost<{ challenge: string }>(cfg, `${teamPath}/enrollment-challenges`, {})).challenge;
  const held = await apiGet<{ keys: DeviceKey[] }>(cfg, `${teamPath}/keys`);
  const exclude = excludeCredentialsFrom(held.keys);
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(challenge) as BufferSource,
        rp: { name: 'musterd' },
        excludeCredentials: exclude.map((id) => ({
          type: 'public-key' as const,
          id: b64urlToBytes(id) as BufferSource,
        })),
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
    if (e instanceof DOMException && e.name === 'InvalidStateError')
      throw new Error(
        'this device already holds a passkey for you — use that one, revoke it first, or add the passkey on another device; nothing was enrolled',
      );
    if (e instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(e.name))
      throw new Error('passkey cancelled; nothing was enrolled');
    throw e;
  }
  if (!cred) throw new Error('passkey cancelled; nothing was enrolled');
  const resp = cred.response as AuthenticatorAttestationResponse;
  const out = await apiPost<{
    key?: { id: string; kind: string };
    held?: { enrollment_digest: string; expires_at: number; countersigners?: string[] };
  }>(cfg, `${teamPath}/passkeys`, {
    actor: member,
    challenge,
    ...(approval ? { approval } : {}),
    ...(!approval && !recoveryCode ? { hold: true } : {}),
    registration: {
      attestation_object: bytesToB64url(resp.attestationObject),
      // Posted decoded, as the daemon's own enroll page does: the verifier hashes this utf8 text.
      client_data_json: new TextDecoder().decode(resp.clientDataJSON),
    },
  });
  if (out.held) {
    return {
      kind: 'held',
      held: {
        digest: out.held.enrollment_digest,
        expiresAt: out.held.expires_at,
        countersigners: out.held.countersigners ?? [],
      },
    };
  }
  if (!out.key) throw new Error('the daemon answered without a key; nothing was enrolled');
  return {
    kind: 'enrolled',
    key: {
      id: out.key.id,
      kind: out.key.kind,
      origin: location.origin,
      rp_id: location.hostname,
      created_at: Date.now(),
      revoked_at: null,
    },
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
