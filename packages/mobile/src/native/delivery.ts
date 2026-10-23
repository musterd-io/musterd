import { AppDeliverySchema, type AppDelivery } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { b64urlDecode, b64urlEncode, utf8Decode, utf8Encode } from './bytes';
import { phoneKeys, type SealedBody } from './phoneKeys';

/**
 * The delivery composition — what the phone does with anything sealed to it (ADR 676 decisions 3
 * and 8, spec §6 step 4), in TypeScript where the protocol schemas live:
 *
 * 1. bind the body to its place: the canonical-JSON route is the HPKE AAD, base64url;
 * 2. open the seal with `phoneKeys.open` (the native HPKE primitive);
 * 3. read the inner `{p, s}` JSON — the payload and the daemon's Ed25519 signature;
 * 4. check that signature over `musterd-app/v1 signed\n<route>\n<payload>` against the identity
 *    key pinned at pairing, via `phoneKeys.verifyEd25519` — byte-for-byte the daemon's
 *    `signingBytes` in `notify/appSeal.ts`, so a signature made there checks here;
 * 5. parse the payload through `AppDeliverySchema` (hard rule 4);
 * 6. drop an expired delivery.
 *
 * Every failure of steps 1–5 is one thing: {@link DeliveryUnverifiedError}, carrying the design's
 * single generic text — "an ask could not be verified" — and nothing about which check refused
 * (that distinction is an oracle). A verified-but-expired delivery is different: it was honest,
 * just late, so it raises {@link DeliveryExpiredError} for the caller to drop silently. The
 * seen-nonce drop of decision 8 comes after this function returns, against the caller's nonce
 * store — this module holds no state.
 *
 * The module holds no key material and no wire secrets: it composes bytes and lets the native
 * module hold the crypto. In tests the two native calls are mocked at `./phoneKeys`.
 */
export interface DeliveryRoute {
  team: string;
  binding: string;
  /** The ask id for a delivery. */
  ref: string;
  expires_at: number;
}

/** Byte-for-byte the daemon's `SIGN_DOMAIN` (`notify/appSeal.ts`). */
const SIGN_DOMAIN = 'musterd-app/v1 signed';

/** A failed verification, with the design's one generic message and no detail (decision 3). */
export class DeliveryUnverifiedError extends Error {
  constructor() {
    super('an ask could not be verified');
    this.name = 'DeliveryUnverifiedError';
  }
}

/** A delivery that verified but whose expiry has passed: dropped before display, not a failure. */
export class DeliveryExpiredError extends Error {
  constructor() {
    super('delivery expired');
    this.name = 'DeliveryExpiredError';
  }
}

/**
 * Open, verify and parse one sealed delivery. `primitives` defaults to the native module; tests
 * mock `./phoneKeys` instead of passing one. Throws only the two errors above — anything else
 * that goes wrong (a bad base64 half, a schema violation, a native refusal) is one of them by
 * the time it leaves this function.
 */
export async function openDelivery(input: {
  sealed: SealedBody;
  route: DeliveryRoute;
  /** The daemon's Ed25519 identity key pinned at pairing: raw 32 bytes, base64url. */
  pinnedIdentity: string;
  /** Clock for the expiry check; injectable so a test never waits on one. */
  now?: number;
}): Promise<AppDelivery> {
  try {
    if (input.sealed.v !== 1) throw new Error('unsupported sealed body version');
    const routeJson = canonicalJson(input.route);
    const aad = b64urlEncode(utf8Encode(routeJson));
    const innerText = await phoneKeys.open({
      sealed: input.sealed,
      // The one purpose this composition opens: bodies sealed *to* the phone.
      purpose: 'deliver',
      aad,
    });
    const inner: unknown = JSON.parse(innerText);
    const p = (inner as { p?: unknown }).p;
    const s = (inner as { s?: unknown }).s;
    if (typeof p !== 'string' || typeof s !== 'string')
      throw new Error('inner payload is malformed');
    const payload = b64urlDecode(p);
    if (payload === null) throw new Error('payload is not base64url');
    // The exact bytes the daemon signed: its domain line, the canonical route, then the payload.
    const signed = utf8Encode(`${SIGN_DOMAIN}\n${routeJson}\n`);
    const message = new Uint8Array(signed.length + payload.length);
    message.set(signed);
    message.set(payload, signed.length);
    const ok = await phoneKeys.verifyEd25519({
      publicKey: input.pinnedIdentity,
      message: b64urlEncode(message),
      signature: s,
    });
    if (!ok) throw new Error('signature did not verify');
    const delivery = AppDeliverySchema.parse(JSON.parse(utf8Decode(payload)));
    if ('expires_at' in delivery && delivery.expires_at <= (input.now ?? Date.now())) {
      throw new DeliveryExpiredError();
    }
    return delivery;
  } catch (e) {
    if (e instanceof DeliveryExpiredError) throw e;
    throw new DeliveryUnverifiedError();
  }
}
