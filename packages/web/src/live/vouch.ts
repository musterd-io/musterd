import type { Envelope } from '@musterd/protocol';
// The schema-free module: the barrel would carry Zod into the settings chunk.
import { vouchCheckCode } from '@musterd/protocol/approval-contracts';
import { authorityProofForVouch } from './authorityProof';
import { apiPost, sendAct, type LiveConfig } from './client';
import { signsHere, type DeviceKey } from './passkeyEnroll';
import type { VouchRequest } from './vouchRequests';

export { vouchCheckCode };
export { pendingVouches, VOUCH_TTL_MS, type VouchRequest } from './vouchRequests';

/**
 * ADR 769: an admin vouches for a member's first (or post-origin-move) passkey from /live. The
 * member's registration is held by the daemon; the member asks one admin with a `request_help`
 * carrying `meta.vouch {member, enrollment_digest}`; the admin types the code the member reads them
 * and signs `device_key_admin` over `{action:'enroll', kind:'passkey', member, key}`.
 *
 * Its own module so only the settings sheet's lazy chunk carries it.
 */

/**
 * The member's passkeys a vouched key replaces, as the sheet names them (slippy's design read):
 * `away` were made on another hostname and cannot sign here; `unrecorded` were made before origins
 * were kept, which the daemon counts as unusable for a vouch (ADR 769, a stated trade).
 */
export function replacedPasskeys(
  keys: readonly DeviceKey[],
  hostname: string,
): { away: DeviceKey[]; unrecorded: DeviceKey[] } {
  const live = keys.filter((k) => k.kind === 'passkey' && k.revoked_at === null);
  return {
    away: live.filter((k) => signsHere(k, hostname) === false),
    unrecorded: live.filter((k) => signsHere(k, hostname) === null),
  };
}

/**
 * The admin's gate on the vouch card: Vouch is enabled only on `match` — the six digits the
 * member read them equal the code worked out from the held enrollment's digest. Pure.
 */
export function vouchGate(typed: string, digest: string): 'partial' | 'mismatch' | 'match' {
  if (!/^\d{6}$/.test(typed)) return 'partial';
  return typed === vouchCheckCode(digest) ? 'match' : 'mismatch';
}

/** The member asks one admin to vouch. The body is for a human reader; the meta is what counts. */
export async function askVouch(
  cfg: LiveConfig,
  admin: string,
  member: string,
  digest: string,
): Promise<Envelope> {
  return sendAct(cfg, {
    act: 'request_help',
    to: { kind: 'member', name: admin },
    body: `${member} asks you to vouch for a new passkey. Call them or ask in person: they will read you a 6-digit code to type in Settings → You.`,
    meta: { vouch: { member, enrollment_digest: digest } },
  });
}

/**
 * The admin vouches: sign the key-bound descriptor with a passkey that works on this page, then
 * the daemon re-checks everything and enrolls. Null proof means none of this admin's passkeys sign
 * here — said in words, and nothing is sent.
 */
export async function vouchFor(cfg: LiveConfig, member: string, digest: string): Promise<void> {
  const approval = await authorityProofForVouch(cfg, member, digest);
  if (!approval) {
    throw new Error(
      'none of your passkeys can sign on this page, so it cannot vouch here — open musterd where one does',
    );
  }
  await apiPost<{ key: { id: string } }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/authority/passkeys/vouch`,
    { member, enrollment_digest: digest, approval },
  );
}

/** Close the request on its thread, so it leaves "Waiting for you" and the member's stream says so. */
export async function resolveVouch(
  cfg: LiveConfig,
  request: VouchRequest,
  outcome: 'vouched' | 'declined',
): Promise<void> {
  await sendAct(cfg, {
    act: 'resolve',
    to: { kind: 'member', name: request.member },
    thread: request.id,
    body:
      outcome === 'vouched'
        ? `vouched for ${request.member}'s new passkey`
        : `did not vouch for ${request.member}'s new passkey`,
  });
}

/** Why a vouch was refused, in words a person can act on. */
export function vouchRefusal(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/already_spent/.test(text)) return 'this request was already vouched for or used';
  if (/expired|no_held_enrollment/.test(text))
    return 'this request has expired; ask them to start again from Settings → You';
  if (/usable_key_stands/.test(text))
    return 'they now have a passkey that works here, so they need no vouch';
  if (/not_a_countersigner/.test(text)) return 'only another admin can vouch for this';
  if (/countersigner_unenrolled|countersigner_key_unusable/.test(text))
    return 'your vouch has to be signed by a passkey that works on this hub';
  return text;
}
