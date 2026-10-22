# Platform and security: storage, transport, privacy, accessibility

The platform's rules are not style. Breaking them loses user data, leaks credentials, or
gets the app rejected — usually silently, weeks later.

## Storage and keys

1. Credentials and keys live in the Keychain (via the SDK's secure-store module) or the
   Secure Enclave, with the accessibility class the design names: this-device-only, and
   readable only after first unlock unless locked-device code must reach it. Never in
   AsyncStorage/UserDefaults, never in the JS bundle, never in a file the backup includes
   unless the design says the item may leave the device.
2. Deleting the account/connection deletes the stored credential. "Disconnect clears the
   phone" means the Keychain item is gone, verified — not just that the UI forgot it.
3. Key invalidation is handled, not discovered by users: a biometric-set change or a
   restored backup that invalidates a key produces the team's re-key/re-pair flow with a
   plain explanation, never a generic failure.

## Transport

4. HTTPS by default. Any App Transport Security exception is scoped to a named host
   pattern, justified in the decision record (for example, an encrypted overlay network
   carrying plain HTTP), and paired with the app refusing address shapes it knows fail
   or are unsafe, with the fix named in the error. No wildcard ATS allowances.
5. The server address is a user setting, never compiled in; a connection is proven with a
   real authenticated request before anything is stored.

## Sealed and signed payloads (where the app has them)

6. Verify before display, and keep the two failures distinct: a replayed nonce or an
   expired payload is dropped before display, silently; a failed decrypt or a failed
   sender-signature check shows one generic unverified notice, no partial content, no
   actions, nothing logged beyond the fact of failure.
7. Pin the server's identity at pairing and show its fingerprint where the user can
   compare it. A changed server key is a re-pairing event, never a silent re-pin.
8. Rate and queue human approvals as the design states (one at a time, an hourly ceiling,
   a held-summary) — approval fatigue is a security bug, and the client enforces its half.

## Privacy and the store

9. Collect nothing the feature does not use. Usage-description strings say what the
   permission is for in the user's terms; the privacy manifest and store privacy labels
   match what the code and its dependencies actually do — checked at release time, not
   from memory.
10. Entitlements are minimal and match the code: a capability the code no longer uses is
    removed from the profile at the next build.

## Accessibility and the Human Interface Guidelines

11. Dynamic Type, VoiceOver labels and traits on every interactive element, sufficient
    contrast in both appearances, touch targets at platform size, and nothing conveyed
    by colour alone. Follow the current Human Interface Guidelines; where the team's
    design system is stricter, it wins.
12. Respect the system: reduced motion, transparency and contrast settings change the
    app's behaviour where the SDK exposes them.

## Sources

Apple's Keychain, App Transport Security, privacy-manifest and Human Interface
Guidelines documentation; the security role's skill for threat models and findings
(this file is platform hygiene, not a substitute); the team's design records in
`references/team.md`.
