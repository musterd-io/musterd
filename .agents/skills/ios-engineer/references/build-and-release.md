# Build and release: cloud builds, TestFlight, updates

The app reaches a phone through the team's cloud build service, never through a local
Xcode build where the team has banned one (`references/team.md` names this team's rule).

## Rules

1. **Cloud builds only, pinned toolchain.** Build profiles live in the repo (`eas.json` or
   equivalent) with Node and package-manager versions pinned to the repo's. The build
   number is kept by the build service (`appVersionSource: remote` / auto-increment or
   the team's stated scheme); never hand-edit a build number in a native file.
2. **A human holds the keys.** Signing certificates, provisioning profiles, App Store
   Connect API keys (`.p8`) and build-service tokens are the account holder's. They live
   on the account holder's machine or in the service's secret store — never in the repo,
   an agent workspace, an act, or a log. You prepare the exact command; the human runs
   the step that needs their credential, or lends it for one lane with an expiry.
3. **JavaScript-only iteration needs no store build.** Use the dev client / Expo Go path
   the team's docs name for JS changes. A native change (module, config plugin,
   entitlement, SDK bump) is what earns a new binary; say which kind a change is before
   building.
4. **Over-the-air updates never smuggle a native change.** An OTA update ships JS and
   assets compatible with the binaries already on phones. If a change needs new native
   code, it waits for a build; publishing it as an update breaks installed apps quietly.
5. **Upload is scripted, submission is human.** Where the team has an upload script
   (for example fastlane with an App Store Connect API key config on the holder's
   machine), use it and record the build id it uploaded. Submitting for review, answering
   review questions, and release timing are the account holder's acts.
6. **Record every shipped binary.** For each build that reaches a phone: build id, commit,
   profile, version/build number, who uploaded it, and the TestFlight or store state.
   "It should be there by now" is not a record; the service's own status is.
7. **A stuck queue is a cost decision, not a workaround.** If the build service's submit
   queue stalls, the scripted direct upload is the team's documented faster path — use
   it rather than inventing a new one, and note the substitution in the build record.

## Procedure for a release

1. Confirm the tree: commit, clean state, the repo-root test run that covers the app
   package green (the app package may have no test script of its own) and typecheck green.
2. State the change kind (JS-only or native) and the profile; trigger the cloud build
   non-interactively where the credentials allow.
3. Watch the build to a terminal state; on failure, read the service's build log (the
   Expo MCP server reads EAS logs) and fix the cause — do not retry blind.
4. Upload by the team's scripted path; record the build as in rule 6.
5. On the phone: install, run the changed flow, confirm the version shown is the build
   recorded. Only then call it shipped.

## Sources

Expo EAS Build / Submit / Update documentation for the pinned SDK; the `eas-*` and
deployment skills in `PROVENANCE.md`; this team's build record and scripts, named in
`references/team.md`.
