import { requireNativeModule } from 'expo';

/**
 * The phone's two keys and the three primitives that use them (ADR 676 §2, spec §4):
 *
 * - **signing** — a Secure Enclave P-256 key guarded by Face ID (`biometryCurrentSet` +
 *   `privateKeyUsage`). Every use prompts; a Face ID change invalidates it, which is wanted:
 *   someone who adds their face to a stolen unlocked phone gets nothing (spec §4).
 * - **receive** — a Secure Enclave P-256 key-agreement key the notification extension opens
 *   deliveries with. It is usable while the phone is locked (`AfterFirstUnlockThisDeviceOnly`,
 *   no biometry) because a push arrives when the phone may be in a pocket.
 *
 * Both public keys travel as raw uncompressed points, 65 bytes base64url (`0x04` first) — the
 * same bytes the daemon's `p256SpkiFromRaw` and the pairing QR carry.
 *
 * This file is the whole TypeScript surface of the native module `modules/musterd-keys`. The
 * module is plain Swift over CryptoKit, Security and DeviceCheck; it holds no wire format —
 * `purpose` and `aad` pass through to HPKE's `info` and AAD, and `verifyEd25519` takes raw
 * bytes, so the delivery composition (the route, the inner `{p,s}` JSON, which bytes the
 * daemon signed and which pinned key checks them) stays in TypeScript where the protocol
 * schemas live (spec §6; lane `01M5K5ZK0KYJ34D2BDB0WRFJ25`).
 *
 * Every call fails closed with a named error — `phoneKeysErrorCode(e)` reads it — and no error
 * carries key material or plaintext.
 */

/** HPKE `info` discriminator, exactly the daemon's `SealPurpose` (`appSeal.ts`). */
export type SealPurpose = 'deliver' | 'answer' | 'pair';

/** Why a call refused, in the five shapes the design names. */
export type PhoneKeysErrorCode =
  /** No Secure Enclave (simulator, old OS) or the OS is below the module's floor. */
  | 'unavailable'
  /** Face ID failed, was cancelled, or the set changed — the signing key's guard firing. */
  | 'biometry-failed'
  /** The key is gone from the enclave (Face ID changed, device restored). Re-pair. */
  | 'key-invalidated'
  /** HPKE open or seal threw: wrong key, wrong route, a tampered byte. Says which never. */
  | 'sealed-open-failed'
  /** App Attest refused: unsupported, or the service rejected the key or assertion. */
  | 'attest-failed';

/** An error thrown by the module. `message` is safe to log; it names the case, not the data. */
export interface PhoneKeysError extends Error {
  code: PhoneKeysErrorCode;
}

/** Read the named error case off anything the module threw; `null` if it is not one of ours. */
export function phoneKeysErrorCode(e: unknown): PhoneKeysErrorCode | null {
  const code = (e as Partial<PhoneKeysError> | null)?.code;
  return code === 'unavailable' ||
    code === 'biometry-failed' ||
    code === 'key-invalidated' ||
    code === 'sealed-open-failed' ||
    code === 'attest-failed'
    ? code
    : null;
}

/** An HPKE-sealed body, both halves base64url — the wire shape `SealedBody` in `appSeal.ts`. */
export interface SealedBody {
  v: 1;
  /** The encapsulated key (DHKEM P-256), 65 bytes. */
  enc: string;
  /** The AES-128-GCM ciphertext. */
  ct: string;
}

export interface PhoneKeys {
  /**
   * Both public keys, creating the two enclave keys on first call. Idempotent: an existing
   * enclave key is reloaded, never re-generated, so the pinned key at the daemon stays valid.
   * A signing key invalidated by a Face ID change is re-created here — the daemon sees a new
   * key at the next pair, which is ADR 662's recovery, not a silent continuation.
   */
  getPublicKeys(): Promise<{ signing: string; receive: string }>;

  /** Sign `message` with the signing key after Face ID. DER-encoded ECDSA P-256/SHA-256. */
  sign(message: string): Promise<string>;

  /**
   * Sign one or two messages under a single Face ID evaluation, in order (ADR 694: a listed-act
   * answer's signature and its descriptor signature are made together). After the first, the
   * native side forbids another prompt, so a second signature that would need one fails closed.
   */
  signAll(messages: string[]): Promise<string[]>;

  /** Seal `plaintext` to `recipientPublic` (a raw P-256 point, base64url). */
  seal(input: {
    recipientPublic: string;
    plaintext: string;
    purpose: SealPurpose;
    /** AAD — the canonical-JSON route bytes, base64url. Binds the body to its place. */
    aad: string;
  }): Promise<SealedBody>;

  /** Open a body sealed to this phone's receive key. Fails closed on any check. */
  open(input: { sealed: SealedBody; purpose: SealPurpose; aad: string }): Promise<string>;

  /**
   * Verify an Ed25519 signature over `message` with `publicKey` — the daemon's identity key as
   * pinned at pairing (raw 32 bytes, base64url). The phone's check on everything it displays
   * (ADR 676 decision 3). A pure public-key operation: no enclave, no keychain, no Face ID, so
   * the notification extension can run it while the phone is locked.
   *
   * `message` is the signed bytes themselves, base64url — unlike `sign`, which takes text;
   * verification runs over the exact bytes the daemon signed. A tampered signature or message
   * returns `false`; a malformed *pinned key* rejects with `sealed-open-failed`, because that is
   * our own stored value being wrong rather than the wire. Either way the caller shows one
   * generic failure and no detail.
   */
  verifyEd25519(input: { publicKey: string; message: string; signature: string }): Promise<boolean>;

  /**
   * App Attest: a fresh key and its attestation, the challenge being
   * `sha256(pairing code ∥ signing public ∥ receive public)` (spec §5 step 2). Runs on a real
   * device with the App Attest entitlement; the simulator refuses with `attest-failed`.
   */
  generateAttestationKey(challenge: string): Promise<{ keyId: string; attestation: string }>;

  /** App Attest assertion over `clientDataHash` for an already-attested key. */
  generateAssertion(input: { keyId: string; clientDataHash: string }): Promise<string>;

  /**
   * Register the advisory category (Approve / Decline, each `authenticationRequired` and
   * `foreground`) and ask for notification permission, including Time Sensitive. Idempotent.
   * The extension cannot register categories; the app does, from launch and from here.
   */
  prepareNotifications(): Promise<void>;

  /** The APNs device token, hex, once registration has succeeded. Absent until then. */
  getPushToken(): Promise<{ token: string; environment: 'production' | 'development' } | null>;

  /** Write the pairing-pin JSON. The caller has already validated it (`pairingPin.ts`). */
  savePairingPin(json: string): Promise<void>;

  /** The pairing-pin JSON, or null when the item is absent. Validation is the caller's. */
  loadPairingPin(): Promise<string | null>;

  /**
   * The notification action that opened the app, once. `userInfo` is the payload JSON, still
   * carrying `musterd`, so the answer can open the same seal the extension displayed.
   */
  takePendingAnswer(): Promise<{ action: string; userInfo: string } | null>;

  /**
   * The musterd notifications in Notification Center — what the extension admitted — each with
   * its whole payload JSON, still carrying the `musterd` block. The asks list's source.
   */
  deliveredPushes(): Promise<{ id: string; userInfo: string; deliveredAt: number }[]>;

  /**
   * `onPendingAnswer` fires when a notification action arrives while the app is running;
   * `onDelivery` when a musterd notification is presented while the app is in front.
   */
  addListener(event: 'onPendingAnswer' | 'onDelivery', listener: () => void): { remove(): void };
}

/**
 * The module is native-only: `requireNativeModule` throws in Expo Go and on web. The app runs
 * it from a dev build or TestFlight, so the throw surfaces at first key use, not at import.
 */
export const phoneKeys: PhoneKeys = requireNativeModule<PhoneKeys>('MusterdKeys');
