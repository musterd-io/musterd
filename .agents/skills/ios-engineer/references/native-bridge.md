# Native bridge: Expo modules, Swift, and hardware-backed keys

Where the app stops being JavaScript. Kept deliberately small: one native module behind a
config plugin beats an eject, every time the capability allows it.

## Rules

1. **One small module, config plugin, no eject.** A native capability (Secure Enclave keys,
   CryptoKit sealing, App Attest, a notification service extension) goes in a single local
   Expo module with its config plugin for entitlements, usage strings and extension
   targets. If a capability appears to need ejecting, stop: that is the toolchain
   decision's stated falsifier — take it to the team as a decision, do not decide alone.
2. **Swift reads current Apple documentation, not memory.** Secure Enclave, CryptoKit HPKE,
   App Attest and DeviceCheck APIs, availability and entitlements change yearly. Read the
   current docs (Xcode's documentation search or a docs MCP) for every API you touch, and
   write modern Swift: async/await over completion handlers, actors over lock-guarded
   classes, no force-unwraps, `@MainActor` only at the UI boundary. The Swift/SwiftUI
   skills in `PROVENANCE.md` encode the agent failure modes; apply them to module code
   even though the module has no SwiftUI surface of its own.
3. **Keys are born in the Enclave and never leave.** The signing key is generated in the
   Secure Enclave, non-exportable, with the strictest access control the design names
   (biometry-current-set where a signature must mean "this human, now"). Enrolling a new
   biometric invalidating the key is a feature: re-keying follows the team's recovery
   path, never a fallback to a software key. Check Enclave availability and fail closed
   with a named error — never silently downgrade to Keychain or plaintext storage.
4. **The receive/decrypt key matches where it runs.** Code that runs while the device is
   locked (a notification extension decrypting a sealed payload) cannot require biometry.
   Use the accessibility class the design names (this-device-only), and test the locked
   path on a device: the simulator has no Secure Enclave and will lie to you by succeeding
   differently.
5. **Sign what you rendered.** For any human-approval signature: rebuild the descriptor
   from the fields you rendered (never sign the descriptor as received), render it with
   fixed, app-owned wording, canonicalise the payload with the protocol's `canonicalJson`,
   hash that string with the platform's SHA-256 (CryptoKit on iOS — the protocol's
   approval subpath supplies `canonicalJson`, `approvalWording` and
   `descriptorSigningBytes`, not the hash), and sign the signing bytes built from the
   rebuilt descriptor after biometric authentication. Never sign a caller-supplied
   digest, and never let caller-supplied words into the approval header.
6. **Attestation binds everything it vouches for.** An App Attest challenge commits to the
   enrollment code and both public keys, exactly as the protocol defines. Verify on the
   server side: certificate chain to Apple's App Attest root, app id, challenge, and that
   the attested key matches the key being enrolled. The phone never enrolls itself; an
   existing authenticator approves the phone's key.
7. **Extensions are separate targets with separate limits.** A notification service
   extension has tight time and memory budgets and no biometry prompt. It verifies before
   it displays: decrypt, check the sender signature, drop a replayed nonce or an expired
   payload, and on any failure show the generic unverified notice with no actions.
8. **Errors cross the bridge as named cases.** The TypeScript side receives a closed set
   of error names (unavailable, biometry-failed, key-invalidated, verify-failed, …) it can
   render and test — never a raw platform error string, and never key material, sealed
   bodies or codes in an error or a log.

## Procedure for a native change

1. State the capability, the Apple APIs and their availability, and the fallback on
   unsupported devices — from current docs — before writing Swift.
2. Write the module's TypeScript interface first; the Swift implementation satisfies it.
3. Unit-test what Node can test (wire shapes, digest canonicalisation through the
   protocol's own code where the design says so); name the device-only checks explicitly.
4. Build through the team's cloud path and verify on a real device: key generation,
   biometric prompt, invalidation on biometric change, locked-device decrypt, replay drop.
   Record which were run; "simulator passed" is not evidence for any of them.
5. Security role reviews the diff before it ships (charter boundary in the core file).

## Sources

Apple's CryptoKit, Secure Enclave, App Attest and notification-extension documentation;
the Expo Modules API documentation for the pinned SDK; the Swift skills recorded in
`PROVENANCE.md`; the team's design and decision records named in `references/team.md`.
