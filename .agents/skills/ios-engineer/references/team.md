# This team: musterd

The only file in this skill that names musterd's specifics. Read before the first piece of
work in a session. A team adopting this skill replaces this file with its own.

## The role here

- **Role file**: `ios-engineer` in the team home (`.musterd/roles/ios-engineer.toml`,
  outside the repository). Charter: Expo-first plus the Swift native bridge; harness-agnostic.
  It names this skill (`skill = "ios-engineer"`) and its equipment (`toolkit = "ios"`,
  ADR 708): the built-in `ios` toolkit carries Expo's remote MCP server
  (`https://mcp.expo.dev/mcp` — authenticate with your own Expo account on first use),
  XcodeBuildMCP and an Apple-docs MCP server, both `npx`-launched. Creating the seat
  (`musterd agent <name> --role ios-engineer --profile ios`, or any seat whose recorded
  toolkit is `ios`) provisions those into every wired harness automatically.
- **Holder**: none yet. The seat is created only after this skill has a recorded blind
  eval run and a human accepts it (building-a-role-skill steps 5–7).
- **The human who approves**: nick — Apple Developer Program and App Store Connect account
  holder, EAS/TestFlight credentials, any local-Xcode exception, any App Store submission.
- **Routing in**: product direction from nick/founder; look and feel to designer
  (miley, slippy); security review of Enclave/HPKE/App Attest code to security (big-body);
  daemon, relay and shared-service work to platform; protocol/wire changes to engineer
  via a protocol lane (hard rule 1: an ADR).

## The app

| Fact | Value |
| --- | --- |
| Package | `packages/mobile` (`@musterd/mobile`, private) — surface doc [09-mobile.md](../../../../docs/architecture/09-mobile.md) |
| Toolchain | Expo SDK 57 · React Native 0.86.3 (New Architecture) · React 19.2.3 · Expo Router — [ADR 520](../../../../docs/decisions/520-mobile-toolchain-expo.md) |
| Current job | Sealed ask client and phone authenticator (asks + listed-act signatures; calendar screens leave) — [ADR 676](../../../../docs/decisions/676-mobile-app-sealed-ask-client.md), design `docs/superpowers/specs/2026-10-19-mobile-app-design.md` |
| Wire | Daemon over HTTP; imports `@musterd/protocol` only, via `/calendar` and `/errors` subpaths (never the barrel, never `@musterd/server`); responses parsed with protocol schemas |
| Local-first | `expo-sqlite` store, pull `?since` then replay queued writes, daemon wins and names drops; `expo-secure-store` for server/team/`mscr_` credential (this-device-only, after first unlock) |
| Server address | Setting; laptop daemon via Tailscale MagicDNS `http://<laptop>.<tailnet>.ts.net:4849` (ATS exception for `ts.net` + local networking only; IP form refused by the app itself); host must be in daemon `MUSTERD_ALLOWED_HOSTS` |

## Build and ship here

- **No local Xcode** (nick, 2026-10-05: local builds bog the shared laptop down). Native
  builds are EAS Build in the cloud; JS-only iteration is Expo Go / dev client.
- Expo project `@nas4146/musterd`; `eas.json` has one `production` profile, Node/pnpm
  pinned to the repo, `appVersionSource: remote` + auto-increment, and an
  `eas-build-post-install` hook that builds `@musterd/protocol`.
- Ship: `cd packages/mobile && npx eas-cli@latest build --platform ios --profile production --non-interactive`,
  then `packages/mobile/scripts/upload-testflight.sh` (fastlane, App Store Connect API key
  at `~/.appstoreconnect/fastlane-musterd.json` on nick's machine — a human runs it).
  A build reaches TestFlight 10–15 min after Apple processes it.
- **Gates**: root `pnpm test` runs `packages/mobile/src/lib/*.test.ts` in Node;
  `pnpm typecheck` runs its `tsc --noEmit`. No gate runs a native build or Metro.

## The native bridge owed by ADR 676

One Expo native module via config plugin (no eject): Secure Enclave P-256 signing key
(`biometryCurrentSet`, Face ID per signature), CryptoKit HPKE receive key (this-device-only,
usable locked), App Attest with challenge `sha256(code ‖ signing key ‖ receive key)`,
and a notification service extension that decrypts and verifies before display.
Daemon-side pairing/verification already exists in `packages/protocol/src/appChannel.ts`;
the app recomputes listed-act digests with `approvalWording` from `@musterd/protocol/approval`.
Security review (big-body) is required before this ships; device verification is owed —
the simulator has no Secure Enclave.

## Local rules and incidents behind them

- Plain HTTP to a Tailscale IP fails ATS on iOS even over Tailscale (build 2, 2026-10-06):
  the Connection screen refuses that shape and names the `.ts.net` fix.
- EAS Submit's free-plan queue sat 40+ minutes (2026-10-06): build without
  `--auto-submit` and upload with the fastlane script instead.
- The calendar app shipped and was barely used (2026-10-19): do not rebuild a general
  surface on a guess — the app's job is the two things nick reaches for his phone for.
