//
//  PhoneKeys.swift
//  MusterdKeys
//
//  The phone's two keys and the primitives that use them (ADR 676 §2, spec §4).
//
//  Plain CryptoKit over Security and DeviceCheck — no Expo types, so the whole security surface
//  reads as ordinary Swift and `swiftc -typecheck`s on its own. The Expo wrapper
//  (MusterdKeysModule.swift) is a thin name-mapping layer over this file, and the TypeScript
//  contract it must match is `packages/mobile/src/native/phoneKeys.ts`.
//
//  This module holds no wire format: `purpose` and `aad` pass through to HPKE's `info` and AAD,
//  and `verifyEd25519` takes raw bytes, so the delivery composition (the route, the inner `{p,s}`
//  JSON, which bytes the daemon signed and which pinned key checks them) stays in TypeScript
//  where the protocol schemas live.
//

import CryptoKit
import Foundation
import LocalAuthentication
import Security

#if !NOTIFICATION_EXTENSION
  import DeviceCheck
#endif

/// Why a call refused, in the five shapes the design names (spec §9). Every case's message is
/// safe to log: it names the situation, never key material, plaintext, or which check failed
/// inside a seal/open (that distinction is an oracle).
enum PhoneKeysError: Error {
  /// No Secure Enclave (simulator, old OS) or a keychain failure that leaves the module inert.
  case unavailable(String)
  /// Face ID failed, was cancelled, or is not enrolled — the signing key's guard firing.
  case biometryFailed(String)
  /// The key is gone from the enclave (Face ID changed, device restored). Re-pair.
  case keyInvalidated(String)
  /// HPKE open or seal threw: wrong key, wrong route, a tampered byte. Says which never.
  case sealedOpenFailed(String)
  /// App Attest refused: unsupported, or the service rejected the key or assertion.
  case attestFailed(String)

  /// The code the TypeScript contract (`PhoneKeysErrorCode`) reads off the thrown error.
  var code: String {
    switch self {
    case .unavailable: return "unavailable"
    case .biometryFailed: return "biometry-failed"
    case .keyInvalidated: return "key-invalidated"
    case .sealedOpenFailed: return "sealed-open-failed"
    case .attestFailed: return "attest-failed"
    }
  }

  var message: String {
    switch self {
    case .unavailable(let m),
         .biometryFailed(let m),
         .keyInvalidated(let m),
         .sealedOpenFailed(let m),
         .attestFailed(let m):
      return m
    }
  }
}

/// The Secure Enclave keys and the primitives over them.
///
/// - **signing** — P-256 guarded by Face ID (`privateKeyUsage` + `biometryCurrentSet`, accessible
///   only while unlocked). Every use prompts; a Face ID change invalidates the key, which is
///   wanted: someone who adds their face to a stolen unlocked phone gets nothing (spec §4).
/// - **receive** — a P-256 key-agreement key the notification extension opens deliveries with.
///   Usable while the phone is locked (`AfterFirstUnlockThisDeviceOnly`, no biometry) because a
///   push arrives when the phone may be in a pocket.
/// - **question** — a P-256 signing key with **no** biometry (ADR 774 §5), so a notification
///   action can answer a *question* while the phone is locked. The daemon accepts it only on an
///   answer to a question, under its own domain tag; approvals and verdicts keep the Face ID key.
///   It is enrolled once per binding by an enrollment the signing key signs.
///
/// CryptoKit stores enclave keys in the keychain itself and hands back a `dataRepresentation`
/// reference blob; we persist that blob in our own keychain items so the app and the notification
/// extension reload the *same* enclave keys across processes. A reload failure means the enclave
/// destroyed the key — that is the `key-invalidated` case, and `publicKeys()` re-creates it so the
/// daemon sees a new key at the next pair (ADR 662's recovery, not a silent continuation).
enum PhoneKeys {
  /// One keychain service for our two reference items; the account discriminates them.
  private static let service = "dev.musterd.keys"
  private static let signingAccount = "signing"
  private static let receiveAccount = "receive"
  private static let questionAccount = "question"
  /// `appQuestionAnswerSigningBytes`' first line (`@musterd/protocol` appChannel.ts).
  private static let questionAnswerTag = "musterd-app-question-answer/v1\n"

  /// Serializes key creation: two concurrent first calls must produce one keypair, not two.
  private static let createLock = NSLock()

  // MARK: - The TS contract (phoneKeys.ts)

  /// Both public keys as raw uncompressed points (65 bytes, `0x04` first), base64url — the same
  /// bytes the daemon's `p256SpkiFromRaw` and the pairing QR carry. Creates both keys on the first
  /// call; an existing enclave key is reloaded, never re-generated.
  static func publicKeys() throws -> (signing: String, receive: String) {
    guard SecureEnclave.isAvailable else {
      throw PhoneKeysError.unavailable("no Secure Enclave on this device")
    }
    createLock.lock()
    defer { createLock.unlock() }
    let signing = try loadOrCreateSigningKey()
    let receive = try loadOrCreateReceiveKey()
    return (
      b64url(signing.publicKey.x963Representation),
      b64url(receive.publicKey.x963Representation)
    )
  }

  /// Sign `message` (UTF-8) with the signing key after Face ID; DER-encoded ECDSA P-256/SHA-256,
  /// base64url — the daemon verifies it with `cryptoVerify('sha256', …)` (Node's default DER).
  static func sign(_ message: String) throws -> String {
    let key = try loadSigningKey()
    do {
      let signature = try key.signature(for: Data(message.utf8))
      return b64url(signature.derRepresentation)
    } catch {
      // The key loaded, so the enclave refused the operation: Face ID failed, was cancelled, or
      // is not enrolled. (An invalidated key never gets here — its reload throws first.)
      throw PhoneKeysError.biometryFailed("Face ID did not authorize signing")
    }
  }

  /// Sign each of `messages` (UTF-8) under one Face ID evaluation (ADR 694: a listed-act answer
  /// carries the answer signature and the descriptor signature, made together). The key is loaded
  /// with a fresh `LAContext`; the first signature evaluates it, and after that the context is
  /// told `interactionNotAllowed`, so a second prompt can never appear — a signature that would
  /// need one fails closed as `biometry-failed`. At most two messages: the one caller needs two.
  static func signAll(_ messages: [String]) throws -> [String] {
    guard !messages.isEmpty, messages.count <= 2 else {
      throw PhoneKeysError.unavailable("signAll takes one or two messages")
    }
    guard let reference = loadReference(account: signingAccount) else {
      throw PhoneKeysError.keyInvalidated("no signing key on this phone; pair again")
    }
    let context = LAContext()
    context.localizedReason = "Sign your answer"
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: reference,
        authenticationContext: context
      )
    } catch {
      throw PhoneKeysError.keyInvalidated("the signing key was invalidated; pair again")
    }
    var signatures: [String] = []
    for message in messages {
      do {
        let signature = try key.signature(for: Data(message.utf8))
        signatures.append(b64url(signature.derRepresentation))
      } catch {
        throw PhoneKeysError.biometryFailed("Face ID did not authorize signing")
      }
      context.interactionNotAllowed = true
    }
    return signatures
  }

  /// The question key's public point (raw uncompressed, base64url), creating the key on first call.
  static func questionPublicKey() throws -> String {
    guard SecureEnclave.isAvailable else {
      throw PhoneKeysError.unavailable("no Secure Enclave on this device")
    }
    createLock.lock()
    defer { createLock.unlock() }
    return b64url(try loadOrCreateQuestionKey().publicKey.x963Representation)
  }

  /// Sign `message` (UTF-8) with the question key: no Face ID, no prompt (ADR 774 §5). The caller
  /// passes only `appQuestionAnswerSigningBytes`; the daemon refuses this key on anything else, and
  /// so does this function: a message without the question-answer domain tag is never signed.
  static func signQuestion(_ message: String) throws -> String {
    guard message.hasPrefix(questionAnswerTag) else {
      throw PhoneKeysError.unavailable("the question key signs only answers to questions")
    }
    guard let reference = loadReference(account: questionAccount) else {
      throw PhoneKeysError.keyInvalidated("no question key on this phone; enroll it again")
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: reference)
    } catch {
      throw PhoneKeysError.keyInvalidated("the question key was invalidated; enroll it again")
    }
    do {
      return b64url(try key.signature(for: Data(message.utf8)).derRepresentation)
    } catch {
      throw PhoneKeysError.unavailable("the Secure Enclave refused the question key")
    }
  }

  /// A fresh nonce, for a question-key enrollment: 24 random bytes, base64url (32 characters).
  static func randomNonce() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 24)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw PhoneKeysError.unavailable("no random bytes")
    }
    return b64url(Data(bytes))
  }

  /// Seal `plaintext` to `recipientPublic` (a raw P-256 point, base64url) with the daemon's exact
  /// suite: DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM, base mode, `info` =
  /// `musterd-app/v1 <purpose>`, `aad` = the canonical-JSON route bytes.
  static func seal(recipientPublic: String, plaintext: String, purpose: String, aad: String) throws
    -> (enc: String, ct: String)
  {
    let recipient: P256.KeyAgreement.PublicKey
    let aadData: Data
    let info: Data
    do {
      recipient = try P256.KeyAgreement.PublicKey(x963Representation: try unb64url(recipientPublic))
      aadData = try unb64url(aad)
      info = try hpkeInfo(purpose)
    } catch let error as PhoneKeysError {
      throw error
    } catch {
      throw PhoneKeysError.sealedOpenFailed("seal input is malformed")
    }

    do {
      var sender = try HPKE.Sender(
        recipientKey: recipient,
        ciphersuite: musterdCiphersuite,
        info: info
      )
      let ciphertext = try sender.seal(Data(plaintext.utf8), authenticating: aadData)
      return (b64url(sender.encapsulatedKey), b64url(ciphertext))
    } catch {
      // A malformed recipient point is caught above; what is left is the KEM refusing.
      throw PhoneKeysError.sealedOpenFailed("seal failed")
    }
  }

  /// Open a body sealed to this phone's receive key. Fails closed on every check: wrong key,
  /// wrong route (AAD), a tampered byte — all one error, never which.
  static func open(enc: String, ct: String, purpose: String, aad: String) throws -> String {
    let key = try loadReceiveKey()
    let encData: Data
    let ctData: Data
    let aadData: Data
    let info: Data
    do {
      encData = try unb64url(enc)
      ctData = try unb64url(ct)
      aadData = try unb64url(aad)
      info = try hpkeInfo(purpose)
    } catch let error as PhoneKeysError {
      throw error
    } catch {
      throw PhoneKeysError.sealedOpenFailed("sealed body is malformed")
    }

    do {
      var recipient = try HPKE.Recipient(
        privateKey: key,
        ciphersuite: musterdCiphersuite,
        info: info,
        encapsulatedKey: encData
      )
      let plaintext = try recipient.open(ctData, authenticating: aadData)
      return String(decoding: plaintext, as: UTF8.self)
    } catch {
      throw PhoneKeysError.sealedOpenFailed("sealed body did not open")
    }
  }

  /// Verify an Ed25519 signature over `message` (base64url bytes) with `publicKey` — the daemon's
  /// identity key as pinned at pairing (raw 32 bytes, base64url): the phone's check on everything
  /// it displays (ADR 676 decision 3). Pure public-key work — no enclave, no keychain, no Face ID —
  /// so the notification extension can run it while the device is locked.
  ///
  /// A malformed message or signature is a tampered byte: `false`, never which. A malformed
  /// *pinned key* is our own stored value being wrong rather than the wire, so it throws instead
  /// of reading as a bad signature. Either way the TypeScript side shows one generic failure.
  static func verifyEd25519(publicKey: String, message: String, signature: String) throws -> Bool {
    let keyData = try unb64url(publicKey)
    guard keyData.count == 32 else {
      throw PhoneKeysError.sealedOpenFailed("the pinned identity key is not 32 bytes")
    }
    guard let messageData = try? unb64url(message),
      let signatureData = try? unb64url(signature),
      signatureData.count == 64,
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
    else {
      return false
    }
    // CryptoKit verifies Ed25519 over the raw 64-byte signature. There is no Signature type.
    return key.isValidSignature(signatureData, for: messageData)
  }

  // App Attest is unavailable in an app extension. The extension compiles this file with
  // NOTIFICATION_EXTENSION set and never calls these two methods.
  #if !NOTIFICATION_EXTENSION
  /// App Attest: a fresh key and its attestation object (base64url). `challenge` is the pairing
  /// challenge, `sha256(code ‖ signing public ‖ receive public)`, base64url (spec §5 step 2) —
  /// computed in TypeScript by the daemon's `appPairingChallenge`; this method only hands the
  /// bytes to the service as `clientDataHash`. Refuses on a simulator with `attest-failed`.
  static func attestationKey(challenge: String) async throws -> (keyId: String, attestation: String)
  {
    let clientDataHash = try attestationChallenge(challenge)
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      throw PhoneKeysError.attestFailed("App Attest is not supported on this device")
    }
    let keyId: String
    let attestation: Data
    do {
      keyId = try await service.generateKey()
      attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)
    } catch {
      throw PhoneKeysError.attestFailed("App Attest refused to certify a key")
    }
    return (keyId, b64url(attestation))
  }

  /// App Attest assertion over `clientDataHash` (base64url, 32 bytes) for an already-attested
  /// key — the per-request vouch.
  static func assertion(keyId: String, clientDataHash: String) async throws -> String {
    let hash = try attestationChallenge(clientDataHash)
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      throw PhoneKeysError.attestFailed("App Attest is not supported on this device")
    }
    do {
      let assertion = try await service.generateAssertion(keyId, clientDataHash: hash)
      return b64url(assertion)
    } catch {
      throw PhoneKeysError.attestFailed("App Attest refused to assert")
    }
  }
  #endif

  // MARK: - HPKE

  /// The daemon's suite, from its public Ciphersuite init: DHKEM(P-256, HKDF-SHA256),
  /// HKDF-SHA256, AES-128-GCM. (CryptoKit's canned `.P256_SHA256_AES_GCM_256` is AES-256 —
  /// the wrong AEAD — so the suite is built from parts.)
  private static let musterdCiphersuite = HPKE.Ciphersuite(
    kem: .P256_HKDF_SHA256,
    kdf: .HKDF_SHA256,
    aead: .AES_GCM_128
  )

  /// `musterd-app/v1 <purpose>` — byte-for-byte the daemon's `info()` in `appSeal.ts`, so a body
  /// sealed one way opens the other. An unknown purpose is a client bug; refuse it.
  private static func hpkeInfo(_ purpose: String) throws -> Data {
    switch purpose {
    case "deliver", "answer", "pair", "question_key":
      return Data("musterd-app/v1 \(purpose)".utf8)
    default:
      throw PhoneKeysError.sealedOpenFailed("unknown seal purpose")
    }
  }

  // MARK: - The enclave keys

  /// Load-or-create the signing key. A reload failure (the enclave destroyed the key after a
  /// Face ID change) re-creates it: the daemon sees a new key at the next pair — ADR 662.
  private static func loadOrCreateSigningKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
    if let reference = loadReference(account: signingAccount),
       let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: reference) {
      return key
    }
    return try createSigningKey()
  }

  private static func createSigningKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
    var error: Unmanaged<CFError>?
    // Face ID guards every use; the key dies with the face set, which is the point.
    guard
      let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet],
        &error
      )
    else {
      throw PhoneKeysError.unavailable("could not create the signing key's access control")
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
      throw PhoneKeysError.unavailable("no Secure Enclave, or key creation was refused")
    }
    try saveReference(
      key.dataRepresentation,
      account: signingAccount,
      accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    )
    return key
  }

  private static func loadSigningKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
    guard let reference = loadReference(account: signingAccount) else {
      throw PhoneKeysError.keyInvalidated("no signing key on this phone; pair again")
    }
    do {
      return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: reference)
    } catch {
      throw PhoneKeysError.keyInvalidated("the signing key was invalidated; pair again")
    }
  }

  /// Load-or-create the receive key. No biometry: a push arrives while the phone may be locked.
  private static func loadOrCreateReceiveKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    if let reference = loadReference(account: receiveAccount),
       let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: reference) {
      return key
    }
    return try createReceiveKey()
  }

  private static func createReceiveKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        [.privateKeyUsage],
        &error
      )
    else {
      throw PhoneKeysError.unavailable("could not create the receive key's access control")
    }
    let key: SecureEnclave.P256.KeyAgreement.PrivateKey
    do {
      key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    } catch {
      throw PhoneKeysError.unavailable("no Secure Enclave, or key creation was refused")
    }
    try saveReference(
      key.dataRepresentation,
      account: receiveAccount,
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    return key
  }

  /// Load-or-create the question key. No biometry and usable after first unlock, like the receive
  /// key, because a notification action answers while the phone is locked. ThisDeviceOnly: it never
  /// leaves this phone, in a backup or otherwise.
  private static func loadOrCreateQuestionKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
    if let reference = loadReference(account: questionAccount),
       let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: reference) {
      return key
    }
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        [.privateKeyUsage],
        &error
      )
    else {
      throw PhoneKeysError.unavailable("could not create the question key's access control")
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
      throw PhoneKeysError.unavailable("no Secure Enclave, or key creation was refused")
    }
    try saveReference(
      key.dataRepresentation,
      account: questionAccount,
      accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    )
    return key
  }

  private static func loadReceiveKey() throws -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    guard let reference = loadReference(account: receiveAccount) else {
      throw PhoneKeysError.keyInvalidated("no receive key on this phone; pair again")
    }
    do {
      return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: reference)
    } catch {
      throw PhoneKeysError.keyInvalidated("the receive key was invalidated; pair again")
    }
  }

  // MARK: - Keychain reference items

  private static func loadReference(account: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return data
  }

  /// Overwrites an existing reference (a re-created key replaces an invalidated one in place).
  private static func saveReference(_ data: Data, account: String, accessible: CFString) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: accessible,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add.merge(attributes) { current, _ in current }
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
        throw PhoneKeysError.unavailable("could not store the key reference")
      }
    } else if status != errSecSuccess {
      throw PhoneKeysError.unavailable("could not update the key reference")
    }
  }

  // MARK: - Encoding

  static func b64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func unb64url(_ string: String) throws -> Data {
    var base64 = string
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: base64) else {
      throw PhoneKeysError.sealedOpenFailed("input is not base64url")
    }
    return data
  }

  /// An App Attest `clientDataHash`: exactly 32 bytes of base64url. Anything else is a client bug.
  private static func attestationChallenge(_ challenge: String) throws -> Data {
    guard let hash = try? unb64url(challenge), hash.count == 32 else {
      throw PhoneKeysError.attestFailed("the attestation challenge is not a 32-byte hash")
    }
    return hash
  }
}
