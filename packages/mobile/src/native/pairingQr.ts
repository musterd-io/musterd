/**
 * The pairing QR, read on the phone (ADR 676 §5, ADR 727).
 *
 * The QR text is `AppPairingQrSchema` JSON (ADR 690). This file parses it, turns the relay into
 * the https origin the pin store accepts, and computes the two hashes the daemon already
 * computes: the identity fingerprint shown beside the QR, and the App Attest challenge. Nothing
 * here touches a key, the camera, or the network. The screen confirms the fingerprint before
 * `pair.ts` generates keys or sends anything — the code is single-use, and a request sealed to
 * the wrong daemon burns it.
 *
 * No `node:` import. The screen imports this file directly; `pair.ts` is the part that needs the
 * native module.
 */

import {
  APP_PAIRING_BINDING,
  AppPairingQrSchema,
  AppPairRequestSchema,
  type AppPairRequest,
  type AppPairingQr,
} from '@musterd/protocol/app-channel';
import { b64urlDecode, b64urlEncode, utf8Encode } from './bytes';
import { sha256, toHex } from './sha256';

export interface ScannedPairing {
  qr: AppPairingQr;
  /** `https` origin, no userinfo and no path. The pin and every callback use this. */
  relay: string;
  /** The daemon identity fingerprint, grouped the way the page prints it. */
  fingerprint: string;
}

export type QrRefusal = 'unreadable' | 'expired' | 'relay';

export type QrRead = { ok: true; scanned: ScannedPairing } | { ok: false; reason: QrRefusal };

/**
 * The relay the QR carries, as an `https` origin.
 *
 * Policy stores `away_relay_url`, which may be `wss:` and may carry a path. The pin and the
 * callback are built on the origin: `wss://relay.example/team` becomes `https://relay.example`.
 * A userinfo, or anything that is not `https` or `wss`, is refused — the phone does not send a
 * pairing request at a host the QR did not name, and it does not send one in the clear.
 */
export function relayOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return null;
  if (url.hostname === '') return null;
  return `https://${url.host}`;
}

/**
 * What the page prints beside the QR (`keyFingerprint`): sha256 of the raw identity key, first
 * 16 hex characters, grouped in fours. The identity key only — not the receive key.
 */
export function daemonFingerprint(identityB64url: string): string | null {
  const raw = b64urlDecode(identityB64url);
  if (!raw || raw.length !== 32) return null;
  const groups = toHex(sha256(raw)).slice(0, 16).match(/.{4}/g);
  if (!groups || groups.length !== 4) return null;
  return groups.join(' ');
}

/**
 * The App Attest clientDataHash: sha256(utf8(code) ‖ raw signing public ‖ raw receive public),
 * base64url. `generateAttestationKey` decodes that to the 32 bytes `attestKey` takes.
 */
export function pairingChallenge(
  code: string,
  signingB64url: string,
  receiveB64url: string,
): string | null {
  const signing = b64urlDecode(signingB64url);
  const receive = b64urlDecode(receiveB64url);
  if (!signing || signing.length !== 65 || !receive || receive.length !== 65) return null;
  const codeBytes = utf8Encode(code);
  const joined = new Uint8Array(codeBytes.length + signing.length + receive.length);
  joined.set(codeBytes, 0);
  joined.set(signing, codeBytes.length);
  joined.set(receive, codeBytes.length + signing.length);
  return b64urlEncode(sha256(joined));
}

/** The route a pair request is sealed under. The binding is the literal `pairing`, not a channel. */
export function pairRoute(qr: AppPairingQr): {
  team: string;
  binding: typeof APP_PAIRING_BINDING;
  ref: string;
  expires_at: number;
} {
  return {
    team: qr.team,
    binding: APP_PAIRING_BINDING,
    ref: qr.pairing,
    expires_at: qr.expires_at,
  };
}

/** `https://relay.example/app/<team>/callback`, and nothing that leaves that origin. */
export function callbackUrl(relay: string, team: string): string | null {
  if (relayOrigin(relay) !== relay) return null;
  if (team.length < 1 || team.includes('/')) return null;
  const url = new URL(`app/${encodeURIComponent(team)}/callback`, `${relay}/`);
  if (url.origin !== relay) return null;
  return url.toString();
}

const PUSH_TOKEN = /^[0-9a-f]{64,200}$/;

/**
 * The sealed body's plaintext. A push token is included only when it is the shape the daemon
 * stores; a missing or odd token still pairs, and that binding gets no push (ADR 676 §5).
 */
export function pairRequest(input: {
  qr: AppPairingQr;
  signing: string;
  receive: string;
  keyId: string;
  attestation: string;
  push?: { token: string; environment: 'production' | 'development' };
}): AppPairRequest | null {
  const push =
    input.push && PUSH_TOKEN.test(input.push.token)
      ? { push_token: input.push.token, push_environment: input.push.environment }
      : {};
  const parsed = AppPairRequestSchema.safeParse({
    v: 1,
    code: input.qr.code,
    signing_public_key: input.signing,
    receive_public_key: input.receive,
    attest_key_id: input.keyId,
    attestation: input.attestation,
    ...push,
  });
  return parsed.success ? parsed.data : null;
}

/** Parse the QR text. A refusal names the class and never the code or the keys. */
export function readPairingQr(text: string, now = Date.now()): QrRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const parsed = AppPairingQrSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'unreadable' };
  if (parsed.data.expires_at <= now) return { ok: false, reason: 'expired' };
  const relay = relayOrigin(parsed.data.relay);
  if (!relay) return { ok: false, reason: 'relay' };
  const fingerprint = daemonFingerprint(parsed.data.daemon_identity_public_key);
  if (!fingerprint) return { ok: false, reason: 'unreadable' };
  return { ok: true, scanned: { qr: parsed.data, relay, fingerprint } };
}
