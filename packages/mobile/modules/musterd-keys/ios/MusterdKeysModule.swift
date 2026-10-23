//
//  MusterdKeysModule.swift
//  MusterdKeys
//
//  The Expo surface of the phone keys — a name-mapping layer over PhoneKeys.swift, matching the
//  TypeScript contract in `packages/mobile/src/native/phoneKeys.ts` function for function. All
//  security lives in PhoneKeys.swift; this file only converts arguments, results, and the five
//  named error codes into what a JS `Promise` rejects with.
//

import ExpoModulesCore
import Foundation

/// Object arguments, mirroring the TS interfaces. Fields are decoded positionally by key; a
/// missing key keeps the default, and validation (lengths, purpose names) happens in PhoneKeys,
/// which fails closed with a named case either way.
struct SealInput: Record {
  @Field var recipientPublic: String = ""
  @Field var plaintext: String = ""
  @Field var purpose: String = ""
  @Field var aad: String = ""
}

struct SealedBodyRecord: Record {
  @Field var v: Int = 1
  @Field var enc: String = ""
  @Field var ct: String = ""
}

struct OpenInput: Record {
  @Field var sealed: SealedBodyRecord = SealedBodyRecord()
  @Field var purpose: String = ""
  @Field var aad: String = ""
}

struct AssertionInput: Record {
  @Field var keyId: String = ""
  @Field var clientDataHash: String = ""
}

public final class MusterdKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MusterdKeys")

    AsyncFunction("getPublicKeys") { () -> [String: String] in
      let keys = try run { try PhoneKeys.publicKeys() }
      return ["signing": keys.signing, "receive": keys.receive]
    }

    AsyncFunction("sign") { (message: String) -> String in
      try run { try PhoneKeys.sign(message) }
    }

    AsyncFunction("seal") { (input: SealInput) -> [String: Any] in
      let sealed = try run {
        try PhoneKeys.seal(
          recipientPublic: input.recipientPublic,
          plaintext: input.plaintext,
          purpose: input.purpose,
          aad: input.aad
        )
      }
      return ["v": 1, "enc": sealed.enc, "ct": sealed.ct]
    }

    AsyncFunction("open") { (input: OpenInput) -> String in
      try run {
        try PhoneKeys.open(
          enc: input.sealed.enc,
          ct: input.sealed.ct,
          purpose: input.purpose,
          aad: input.aad
        )
      }
    }

    AsyncFunction("generateAttestationKey") { (challenge: String) async throws -> [String: String] in
      let result = try await runAsync { try await PhoneKeys.attestationKey(challenge: challenge) }
      return ["keyId": result.keyId, "attestation": result.attestation]
    }

    AsyncFunction("generateAssertion") { (input: AssertionInput) async throws -> String in
      try await runAsync {
        try await PhoneKeys.assertion(
          keyId: input.keyId,
          clientDataHash: input.clientDataHash
        )
      }
    }
  }

  /// Re-throw a `PhoneKeysError` as an Expo exception carrying its named code — what
  /// `phoneKeysErrorCode()` reads in TypeScript. Anything else is a bug in this module; surface it
  /// as `unavailable` rather than leaking an internal description across the bridge.
  private func run<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch let error as PhoneKeysError {
      throw Exception(name: "PhoneKeys", description: error.message, code: error.code)
    } catch {
      throw Exception(name: "PhoneKeys", description: "unexpected key operation failure", code: "unavailable")
    }
  }

  private func runAsync<T>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch let error as PhoneKeysError {
      throw Exception(name: "PhoneKeys", description: error.message, code: error.code)
    } catch {
      throw Exception(name: "PhoneKeys", description: "unexpected key operation failure", code: "unavailable")
    }
  }
}
