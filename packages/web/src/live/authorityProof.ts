import { apiGet, apiPost, type LiveConfig } from './client';
import type { ApprovalProof } from '@musterd/protocol';
import {
  humanAskAnswerApproval,
  requestDecisionApproval,
} from '@musterd/protocol/approval-contracts';

/**
 * The A2 proof a human's verdict on a lane needs (ADR 662, lane 01M5DTPMXN): the server
 * builds the descriptor, this browser signs it with the human's passkey, and the proof
 * rides back as `meta.approval`. Returns null when this human has no passkey enrolled —
 * the gate passes unenrolled humans unsigned, so the caller sends plain. Throws when the
 * ceremony is cancelled or fails: the caller must send nothing, because an unsigned
 * verdict from an enrolled human is refused — and used to vanish silently. A human
 * whose only enrolled key is not a passkey gets that refusal surfaced on the ack
 * instead; the CLI helper can sign with such a key.
 *
 * Its own module so the rail can import it lazily: a verdict is rare, and the ceremony
 * code should not ride in every /live load.
 */
export const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const bytesToB64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const isLoopbackIp = (hostname: string): boolean =>
  hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

export async function authorityProofForVerdict(
  cfg: LiveConfig,
  lane: string,
  verdict: 'accept' | 'decline',
): Promise<ApprovalProof | null> {
  return authorityProofForDescriptor(cfg, 'human_accept', lane, { lane, verdict });
}

export async function authorityProofForAsk(
  cfg: LiveConfig,
  askId: string,
  verdict: 'accept' | 'decline',
): Promise<ApprovalProof | null> {
  const approval = humanAskAnswerApproval(askId, verdict);
  return authorityProofForDescriptor(cfg, approval.act, approval.target, approval.payload);
}

export async function authorityProofForRequest(
  cfg: LiveConfig,
  input: {
    requestId: string;
    requestTarget: string | null;
    decision: 'approve' | 'deny';
    lifetime?: 'once' | 'ttl' | 'standing';
    ttlHours?: number;
  },
): Promise<ApprovalProof | null> {
  const approval = requestDecisionApproval(input);
  return authorityProofForDescriptor(cfg, approval.act, approval.target, approval.payload);
}

/** A watch-link observer is a roster change (`admin.roster`, ADR 662). The payload is the one the
 * daemon rebuilds from the mint body, field for field, or the signature reads as a mismatch. */
export async function authorityProofForObserver(
  cfg: LiveConfig,
  name: string,
): Promise<ApprovalProof | null> {
  return authorityProofForDescriptor(cfg, 'admin.roster', name, {
    name,
    kind: 'human',
    role: null,
    observer: true,
  });
}

/**
 * A team policy write (`admin.team_policy`, ADR 662): the whole stored doc is the payload, exactly as
 * `POST /policy` will parse it, so the caller signs the doc it is about to send and nothing else.
 */
export async function authorityProofForPolicy(
  cfg: LiveConfig,
  stored: Record<string, unknown>,
): Promise<ApprovalProof | null> {
  return authorityProofForDescriptor(cfg, 'admin.team_policy', cfg.team, stored);
}

/**
 * Confirming an app pairing enrolls the phone's key (`device_key_admin`, ADR 676 §5): the payload
 * is the `enroll_payload` the daemon listed for that pairing, exactly as the CLI signs it.
 */
export async function authorityProofForPhone(
  cfg: LiveConfig,
  member: string,
  enrollPayload: unknown,
): Promise<ApprovalProof | null> {
  return authorityProofForDescriptor(cfg, 'device_key_admin', member, enrollPayload);
}

/**
 * A further passkey for a human who already has one (`device_key_admin`, ADR 662 decision 6): the
 * standing passkey approves the enrollment, with the payload the daemon's guard rebuilds.
 */
export async function authorityProofForPasskeyEnroll(
  cfg: LiveConfig,
  member: string,
): Promise<ApprovalProof | null> {
  return authorityProofForDescriptor(cfg, 'device_key_admin', member, {
    action: 'enroll',
    kind: 'passkey',
  });
}

async function authorityProofForDescriptor(
  cfg: LiveConfig,
  act: string,
  target: string,
  payload: unknown,
): Promise<ApprovalProof | null> {
  const teamPath = `/teams/${encodeURIComponent(cfg.team)}/authority`;
  const created = await apiPost<{ descriptor: { nonce: string } }>(cfg, `${teamPath}/descriptors`, {
    act,
    target,
    payload,
  });
  const nonce = created.descriptor.nonce;
  const view = await apiGet<{ passkeys?: { key_id: string; credential_id: string }[] }>(
    cfg,
    `${teamPath}/descriptors/${encodeURIComponent(nonce)}`,
  );
  if (!view.passkeys || view.passkeys.length === 0) return null;
  if (!navigator.credentials?.get) throw new Error('passkeys are unavailable in this browser');
  // A cancel or timeout rejects with NotAllowedError (or AbortError) rather than
  // returning null — translate it, or the person reads the browser's raw error and
  // never learns the verdict went nowhere (slippy, review of #3078).
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(nonce) as BufferSource,
        allowCredentials: view.passkeys.map((p) => ({
          type: 'public-key' as const,
          id: b64urlToBytes(p.credential_id) as BufferSource,
        })),
        // A high-authority act: the authenticator must verify the person, not
        // merely be present (slippy, review of #3078).
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (
      e instanceof DOMException &&
      e.name === 'SecurityError' &&
      isLoopbackIp(window.location.hostname)
    )
      throw new Error('open musterd’s localhost URL to use passkeys; nothing was sent');
    if (e instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(e.name))
      throw new Error('passkey cancelled; nothing was sent');
    throw e;
  }
  if (!assertion) throw new Error('passkey cancelled; nothing was sent');
  const resp = assertion.response as AuthenticatorAssertionResponse;
  const key = view.passkeys.find(
    (p) => bytesToB64url(assertion.rawId) === p.credential_id.replace(/=+$/, ''),
  );
  if (!key) throw new Error('passkey mismatch; nothing was sent');
  return {
    key_id: key.key_id,
    nonce,
    signature: bytesToB64url(resp.signature),
    authenticator_data: bytesToB64url(resp.authenticatorData),
    // The verifier parses this as JSON text and hashes it as utf8 — the approve page
    // posts it decoded, and so do we. Base64url-encoding it here (the first cut did)
    // made every passkey verdict fail verification as descriptor_mismatch.
    client_data_json: new TextDecoder().decode(resp.clientDataJSON),
  };
}
