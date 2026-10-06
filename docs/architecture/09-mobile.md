# 09 — Mobile surface (`@musterd/mobile`)

> **Living document.** Direction, not gospel: if it disagrees with the code, fix the smaller of the two
> in the same commit; a real disagreement is an ADR. The decisions behind this surface are
> [ADR 519](../decisions/519-calendar-entries-as-team-data.md) (the calendar as team data) and
> [ADR 520](../decisions/520-mobile-toolchain-expo.md) (Expo on the New Architecture).

## What the mobile package is

`@musterd/mobile` is musterd on a phone. For now it does one thing: the Team's **calendar** — read it,
add to it, edit it, on iOS (Android is one more build target, not a second app). It is an Expo app on
React Native's New Architecture, with Expo Router for navigation.

It is a surface like the CLI and the MCP adapter: it talks to the daemon **over the wire** and imports
`@musterd/protocol` only — through the zod-carrying `@musterd/protocol/calendar` and
`@musterd/protocol/errors` subpaths, never the barrel, because the barrel pulls Node built-ins a phone
does not have. Every response is parsed through the protocol schemas (hard rule 4), and the edit form
validates with `CalendarEntryInputSchema` itself, so the phone refuses exactly what the daemon would.

## How it talks to the daemon

- **Routes:** the four calendar routes of SPEC A.16 — `GET /teams/:slug/calendar[?since]`, `POST`,
  `PUT /:id`, `DELETE /:id` — with the Member's human credential (`mscr_`) as a bearer token, the same
  shape `musterd calendar` sends.
- **Where:** the server URL is a setting (ADR 520 §5). For a laptop daemon it is the laptop's Tailscale
  address on port 4849 — the MagicDNS name (`http://<laptop>.<tailnet>.ts.net:4849`), or the laptop's
  `100.x` Tailscale IP where MagicDNS does not resolve. Tailscale encrypts the link, so plain `http` is
  correct here; `app.json` carries an App Transport Security exception for `ts.net` and local
  networking, and nothing else. iOS refuses plain `http` to an IP address even over Tailscale (build
  2, 2026-10-06: `http://100.x…:4849` failed with an App Transport Security error), so the
  Connection screen refuses that shape itself and names the `.ts.net` fix. Whichever address the phone uses must be in the daemon's
  `MUSTERD_ALLOWED_HOSTS` (`musterd service install --allowed-hosts …`,
  `docs/guides/cross-network-overlay.md` §2b): the ADR 040 gate checks the `Host` of plain HTTP
  requests too, not only WebSocket upgrades, and answers
  `403 forbidden — request Host or Origin is not allowed` (measured 2026-10-05). The settings screen
  shows that message on Connect. `musterd service status` prints the list.
- **Credential:** server, Team and credential live in the iOS Keychain (`expo-secure-store`,
  this-device-only, readable after first unlock). Connecting reads the calendar once before anything is
  kept, so a wrong URL, Team or credential is refused on the settings screen.

## Local-first sync

The phone keeps the whole calendar in SQLite (`expo-sqlite`) and renders that copy, so it works on a
plane and while the laptop sleeps. A sync — on launch, on every return to the foreground, after every
write, and on pull-to-refresh — does two things in order:

1. **Pull** `?since=<cursor>`, where the cursor is the daemon's `now` from the previous pull (never the
   phone's clock). A first pull, or one after a refusal, reads everything and treats any entry the
   phone holds that the daemon no longer lists as deleted.
2. **Replay** the queue of writes made on the phone, oldest first.

**The daemon wins a conflict, and the phone says so.** Each queued edit or delete remembers the
`updated_at` it was made against. If a pull shows the daemon's copy moved past that, the queued write
is dropped and the sync line names it (`"Demo day" — changed on the daemon while you were away — your
edit was dropped`). A write the daemon refuses (`400`, `404`) is dropped and named the same way; an
unreachable daemon or a `5xx` stops the replay with the queue intact. The queue holds one write per
entry: a second edit folds into the first and keeps its base, and deleting an entry that never left
the phone cancels its create.

## Screens

| Route | What it is |
| --- | --- |
| `/` | The calendar: **Up next**, Upcoming / Month / Past, Picks / Everything, the kind chips, and the sync line. Pull to sync. |
| `/entry/[id]` | The edit sheet (`id` = `new` to create; `?date=` prefills). Every SPEC A.16 field; Delete asks first. |
| `/settings` | Server, Team, credential; Connect checks before keeping; Disconnect clears the phone. |

Times are wall-clock in the entry's `tz` (ADR 519 §1). When that is not the phone's zone, the row and
the edit sheet say whose clock the times are on.

## Running it on a phone (TestFlight)

The app reaches the phone through **TestFlight**, built in Expo's cloud (EAS Build) and uploaded by EAS
Submit, so no Xcode runs on the laptop that hosts the seats (nick, 2026-10-05: local Xcode builds bog
the shared laptop down). It needs the Apple Developer Program membership. `eas.json` holds one
`production` profile: Node and pnpm pinned to the repo's, the build number kept by EAS
(`appVersionSource: remote`, `autoIncrement`), and an `eas-build-post-install` hook that builds
`@musterd/protocol` so Metro can read its `dist`. The Expo project is `@nas4146/musterd`.

```bash
cd packages/mobile
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

The first run asks for the Apple ID, with 2FA, and creates the signing certificate, the provisioning
profile and the App Store Connect app. A human has to run it, because those credentials are the
Apple account holder's. Every later run is non-interactive. A build appears in TestFlight after Apple
processes it (10–15 minutes); add yourself as an internal tester once in App Store Connect, and each
later build arrives on the phone by itself.

Then on the phone: Tailscale on, open musterd, **Connection**, then enter the laptop's address, the
Team slug, and your `mscr_` credential.

For JavaScript-only iteration without a store build, `npx expo start` and the Expo Go app run the same
code against the same daemon. Expo Go on iOS supports only the current SDK.

## Gates

The root `pnpm test` runs `src/lib/*.test.ts` (views, sync, the wire client) in Node; `pnpm typecheck`
runs the package's `tsc --noEmit`. No gate runs a native build or Metro — those happen on a developer
machine or EAS (ADR 520 §2).

## File tree `packages/mobile/src/`

```
src/
  lib/
    api.ts            // the wire client: the four SPEC A.16 routes with a bearer mscr_, responses parsed by protocol schemas; CalendarApiError tells unreachable (status 0) from a refusal
    sync.ts           // LocalCalendar: optimistic save/remove into the device store, one queued write per entry, pull-then-replay sync, daemon-wins conflicts reported by name; memoryStore for tests
    views.ts          // pure view rules: wall-clock in an entry's tz, isOver/upNext, Picks/kind filter, Upcoming/Past sections, the Sunday-first month grid, day and time labels
  data/
    settings.ts       // server, Team and credential in the iOS Keychain (expo-secure-store, this-device-only)
    sqlite-store.ts   // the LocalStore over expo-sqlite: entries as wire JSON, the pending queue, the pull cursor
  ui/
    theme.ts          // brand.md palette (mustard accent on zinc, light and dark) and the kind colours
```

The screens and components are `.tsx` and outside the drift check; kept honest by hand:

```
src/app/_layout.tsx        // the Stack and the CalendarProvider
src/app/index.tsx          // the calendar screen
src/app/entry/[id].tsx     // the edit sheet
src/app/settings.tsx       // the connection screen
src/data/calendar-context.tsx // the provider: opens the store, reads the Keychain, syncs on launch / foreground / write
src/ui/components.tsx      // Segmented, Chip, KindDot, EntryRow, SyncLine
src/ui/month-view.tsx      // the month grid
```
