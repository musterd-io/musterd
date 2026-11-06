import type { Envelope } from '@musterd/protocol';
// The schema-free module: the barrel would carry Zod into the settings chunk.
import { vouchCheckCode } from '@musterd/protocol/approval-contracts';
import { authorityProofForVouch } from './authorityProof';
import { apiGet, apiPost, LiveFetchError, sendAct, type LiveConfig } from './client';
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

/**
 * ADR 769: the admin vouches from their PHONE — for an admin with no passkey that signs on this
 * page. Mints the key-bound descriptor, asks the daemon to send it to the admin's own paired phone
 * (the phone works the check code out from the payload it signs), waits up to four minutes for the
 * signed approval to be parked, then posts the vouch exactly as the passkey path does. `onWaiting`
 * fires once the ask is on its way.
 */
export async function vouchViaPhone(
  cfg: LiveConfig,
  member: string,
  digest: string,
  onWaiting?: () => void,
): Promise<void> {
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const created = await apiPost<{ descriptor: { nonce: string } }>(cfg, `${teamPath}/descriptors`, {
    act: 'device_key_admin',
    target: member,
    payload: { action: 'enroll', kind: 'passkey', member, key: digest },
  });
  const nonce = created.descriptor.nonce;
  await apiPost<{ ask_id: string }>(cfg, `${teamPath}/descriptors/${encodeURIComponent(nonce)}/ask-phone`, {
    origin: location.origin,
    vouch: { member, key: digest },
  });
  onWaiting?.();
  const deadline = Date.now() + 4 * 60_000;
  let approval: unknown = null;
  while (!approval) {
    if (Date.now() > deadline)
      throw new Error('no answer from your phone in four minutes; nothing was vouched');
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      approval = (await apiGet<{ proof: unknown }>(cfg, `${teamPath}/approvals/${encodeURIComponent(nonce)}`)).proof;
    } catch (e) {
      if (!(e instanceof LiveFetchError && e.status === 404)) throw e;
    }
  }
  await apiPost<{ key: { id: string } }>(cfg, `${teamPath}/passkeys/vouch`, {
    member,
    enrollment_digest: digest,
    approval,
  });
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
    return 'your vouch has to be signed by a key that works on this hub — a passkey here, or your paired phone';
  if (/no paired phone/.test(text)) return 'you have no paired phone to vouch from';
  return text;
}
