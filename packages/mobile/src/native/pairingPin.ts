/**
 * The pairing pin the extension and the answer action share (ADR 676 §5).
 *
 * Pairing writes it, on the same service as the enclave key references (`dev.musterd.keys`,
 * account `pairing-pin`), so the extension can read it while the phone is locked. `relay` is
 * an `https` origin with no userinfo and no path: every answer and every body fetch is built
 * under it, and a pin that is not that shape is treated as absent.
 *
 * `binding` is absent until the first delivery the extension verifies. The phone does not
 * know the channel binding id when it sends the pair request — that id is created when a
 * standing key approves the phone — and the extension cannot require a binding it has not
 * been told. After that verified open it writes the route's binding back here and does not
 * overwrite it. An answer still requires the binding (`answer.ts`).
 */

import { phoneKeys } from './phoneKeys';

export interface PairingPin {
  v: 1;
  /** Daemon Ed25519 identity, raw 32 bytes, base64url. */
  identity: string;
  /** Daemon P-256 receive key, uncompressed point, base64url. */
  receive: string;
  relay: string;
  team: string;
  /**
   * The channel binding. Absent on the pin stored after the relay accepts the pair request,
   * and set by the extension from the first delivery it verifies.
   */
  binding?: string;
  /**
   * This phone's ADR 662 device key id, minted by the daemon when a standing key approved it.
   * Set by the extension from the signed `paired` delivery; a listed-act answer names it.
   */
  device_key_id?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** An `https` origin: no userinfo, no path, no query, no hash. A trailing slash is the origin. */
export function httpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  return url.origin === value || `${url.origin}/` === value;
}

function b64(value: unknown, length: number): string | null {
  if (typeof value !== 'string' || value.length !== length || !B64URL.test(value)) return null;
  return value;
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null;
  return value;
}

export function readPairingPin(value: unknown): PairingPin | null {
  const record = asRecord(value);
  if (!record || record.v !== 1) return null;
  const identity = b64(record.identity, 43);
  const receive = b64(record.receive, 87);
  const team = bounded(record.team, 64);
  if (!identity || !receive || !team) return null;
  if (typeof record.relay !== 'string' || record.relay.length > 512 || !httpsOrigin(record.relay)) {
    return null;
  }
  // Missing is "not yet". Present and wrong is a pin we will not trust.
  let binding: string | undefined;
  if (record.binding !== undefined) {
    const text = bounded(record.binding, 64);
    if (!text) return null;
    binding = text;
  }
  let deviceKeyId: string | undefined;
  if (record.device_key_id !== undefined) {
    const text = bounded(record.device_key_id, 64);
    if (!text) return null;
    deviceKeyId = text;
  }
  return {
    v: 1,
    identity,
    receive,
    relay: new URL(record.relay).origin,
    team,
    ...(binding !== undefined ? { binding } : {}),
    ...(deviceKeyId !== undefined ? { device_key_id: deviceKeyId } : {}),
  };
}

/** Validate, then write the JSON the extension reads back. A bad pin is not stored. */
export async function savePairingPin(value: unknown): Promise<void> {
  const pin = readPairingPin(value);
  if (!pin) throw new Error('pairing pin is malformed');
  await phoneKeys.savePairingPin(JSON.stringify(pin));
}

/** The stored pin, or null when it is missing or no longer the shape this app writes. */
export async function loadPairingPin(): Promise<PairingPin | null> {
  const raw = await phoneKeys.loadPairingPin();
  if (!raw) return null;
  try {
    return readPairingPin(JSON.parse(raw));
  } catch {
    return null;
  }
}
