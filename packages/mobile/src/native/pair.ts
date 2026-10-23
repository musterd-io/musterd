/**
 * Send a pairing request (ADR 676 §5, ADR 727).
 *
 * The caller has already shown the fingerprint and the person has said it matches the page.
 * This function is what runs after that tap: the two enclave keys (Face ID on the signing key),
 * the App Attest challenge, a body sealed to the daemon's receive key with purpose `pair`, and
 * one POST to the relay. A `202` means the relay took the body. It does not mean the phone is
 * paired. The pin is stored then, without a binding — the binding id does not exist until a
 * standing key approves this phone, and the extension learns it from that signed delivery.
 * This phone never approves itself.
 */

import { AppCallbackSchema } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { b64urlEncode, utf8Encode } from './bytes';
import { savePairingPin } from './pairingPin';
import {
  callbackUrl,
  pairingChallenge,
  pairRequest,
  pairRoute,
  type ScannedPairing,
} from './pairingQr';
import { phoneKeys, phoneKeysErrorCode } from './phoneKeys';

export type PairOutcome =
  | 'waiting'
  | 'undelivered'
  | 'unstored'
  | 'cancelled'
  | 'attest-failed'
  | 'unavailable'
  | 'unverified';

const FETCH_TIMEOUT_MS = 10_000;
const PUSH_ATTEMPTS = 4;

async function pushToken(
  sleep: (ms: number) => Promise<void>,
): Promise<{ token: string; environment: 'production' | 'development' } | undefined> {
  try {
    await phoneKeys.prepareNotifications();
  } catch {
    // Permission refused or the module cannot register. Pairing without a token is valid.
  }
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
    try {
      const token = await phoneKeys.getPushToken();
      if (token) return token;
    } catch {
      return undefined;
    }
    if (attempt + 1 < PUSH_ATTEMPTS) await sleep(1_000);
  }
  return undefined;
}

export async function sendPairingRequest(input: {
  scanned: ScannedPairing;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PairOutcome> {
  const { qr, relay } = input.scanned;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const push = await pushToken(sleep);

  let keys: { signing: string; receive: string };
  try {
    keys = await phoneKeys.getPublicKeys();
  } catch (error) {
    const code = phoneKeysErrorCode(error);
    if (code === 'biometry-failed') return 'cancelled';
    if (code === 'unavailable') return 'unavailable';
    return 'unverified';
  }

  const challenge = pairingChallenge(qr.code, keys.signing, keys.receive);
  if (!challenge) return 'unverified';
  let attested: { keyId: string; attestation: string };
  try {
    attested = await phoneKeys.generateAttestationKey(challenge);
  } catch (error) {
    const code = phoneKeysErrorCode(error);
    if (code === 'attest-failed' || code === 'unavailable') return 'attest-failed';
    return 'unverified';
  }

  const request = pairRequest({
    qr,
    signing: keys.signing,
    receive: keys.receive,
    keyId: attested.keyId,
    attestation: attested.attestation,
    ...(push ? { push } : {}),
  });
  if (!request) return 'unverified';

  const route = pairRoute(qr);
  let sealed;
  try {
    sealed = await phoneKeys.seal({
      recipientPublic: qr.daemon_receive_public_key,
      plaintext: JSON.stringify(request),
      purpose: 'pair',
      aad: b64urlEncode(utf8Encode(canonicalJson(route))),
    });
  } catch {
    return 'unverified';
  }

  const callback = {
    app: 1 as const,
    kind: 'pair' as const,
    binding: route.binding,
    ref: route.ref,
    expires_at: route.expires_at,
    sealed,
  };
  if (!AppCallbackSchema.safeParse(callback).success) return 'unverified';
  const url = callbackUrl(relay, qr.team);
  if (!url) return 'unverified';

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let status: number;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callback),
      signal: controller.signal,
    });
    status = response.status;
  } catch {
    return 'undelivered';
  } finally {
    clearTimeout(timer);
  }
  if (status !== 202) return 'undelivered';

  try {
    await savePairingPin({
      v: 1,
      identity: qr.daemon_identity_public_key,
      receive: qr.daemon_receive_public_key,
      relay,
      team: qr.team,
    });
  } catch {
    return 'unstored';
  }
  return 'waiting';
}
