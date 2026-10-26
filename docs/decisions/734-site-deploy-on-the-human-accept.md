# 734 — musterd.io deploys on the human's accept: the publisher asks, deploys, and records it

- Status: accepted
- Date: 2026-10-26
- Amends: [308](308-public-site-deploy-authorization.md) (the deploy is no longer a seat's standing act; it is the publisher's, on the authorizing human's accept)
- Relates to: [139](139-live-publisher-protocol-build.md) (the build-publisher this rides), [232](232-ledger-seats-every-actor-on-the-roster.md) (the `live` service seat that asks), [662](662-one-machine-per-hosted-seat.md) (what a human accept is)

## Context

[ADR 308](308-public-site-deploy-authorization.md) made publishing musterd.io one seat's standing
act: miley runs `deploy:site` when a change is ready, without asking. Its Observability section
named the gap that left — a deploy is invisible to the record — and lane `01M2XD2RPG` closed half
of it: the build-publisher's `site-gap` tick compares the site's `/build.json` to `origin/main`
every minute and raises one advisory ask to miley per deployed ref when the site is behind.

What the instrument could not do was deploy. On 2026-10-26 two site changes (#3327, #3334) landed
and sat undeployed because the seat's deploy ran inside a Claude Code session, and that session's
permission check refused `deploy:site` as a production deploy. nick was handed the shell command
to run himself; he answered that deploy requests should reach him as an ask he can accept or
decline from `/live`, and chose, of three shapes offered, the one where **the live service asks
him and runs the deploy itself on his accept**.

Two facts make that the small change rather than the large one. The publisher already builds
`@musterd/web` at every tip of `main` into its own checkout, stamped (ADR 135), which is exactly
what `stage:site` deploys. And the publisher runs as the machine user's LaunchAgent, so
`wrangler deploy` finds the user's own Cloudflare login (`~/.wrangler/config`) — the authorizing
human's credential, on his machine. musterd holds no token of its own.

## Problem

Put the deploy decision in front of the human on the surface he watches, with the commits it
covers, and make the yes do the work: no seat remembering, no shell command pasted into chat, no
session permission rule in the way. Record every deploy, and every refusal, where the team can read
it.

## Decision

1. **The ask goes to the authorizing human, and it binds.** The `site-gap` tick raises its ask to
   the human named at install (`musterd service install --live --deploy-authorizer <human>`), not
   to miley, with `species: approve, tier: blocking`. It lists the site-affecting commits between
   the deployed ref and the tip, names the tip sha, and says that accept deploys exactly that tip.
   No authorizer named: the tick reports the gap and raises nothing. There is no "proceed on
   silence": an unanswered ask stays open and nothing deploys.
2. **The accept deploys that tip, from the publisher's own build.** On a tick that finds the
   authorizer's `accept` on the open ask, and the publisher's checkout at that tip with that tip
   published (its `dist/client` is the stamped build), the tick runs `stage:site` and
   `wrangler deploy` in the publisher's checkout as the machine user. A tip accepted before its
   build has finished deploys on the next tick. The accept is read from the `live` seat's inbox by
   `meta.in_reply_to` (or `thread`) naming the ask, and from the authorizer only.
3. **An accept covers only the commits it named.** If `main` has moved past the asked tip before
   the tick acts, the publisher resolves the ask ("main moved; a fresh ask follows") and raises a
   new one listing the new set. It never deploys commits the human did not see.
4. **Decline is remembered per tip.** A declined tip is resolved and not asked again; the next
   site-affecting commit on `main` raises a fresh ask.
5. **Every outcome is an act.** A deploy that succeeds sends one `status_update` to `@team`
   naming the sha and the count, then resolves the ask. One that fails resolves the ask with the
   failure, sends the error to the authorizer and miley, and does not retry that tip; a hand
   deploy (`deploy:site`, ADR 308's path) is the fallback. Nothing is retried in a loop.
6. **The hand deploy stays, as the fallback only.** `pnpm --filter @musterd/web deploy:site` still
   works and miley still holds it (ADR 308), for when the publisher cannot (no login, a failed
   stage). It is run on the authorizer's ask-and-accept like any other deploy, never unasked.

## Consequences

- Changed here: `siteGap.ts` (the stamp remembers the asked tip, the decided tip and the outcome;
  `nextAction` gains `deploy`, `declined` and `moved`), `service.ts` (`site-gap --raise` reads the
  reply, runs the deploy, sends the acts), `launchd.ts` (the script passes the authorizer and the
  published sha), `packages/web/package.json` (`deploy:staged`: stage + wrangler, which
  `deploy:site` now calls after its build), `packages/web/AGENTS.md`, ADR 308 and the
  landed-is-not-live wiki page.
- The deploy runs with the machine user's wrangler login. If that login is missing or expired the
  deploy fails like any other and the failure is on the record (decision 5); the fix is
  `wrangler login` on the machine, not a token in musterd.
- The accept is a human verdict on an `approve` ask. Whether the daemon demands the passkey for it
  is [ADR 662](662-human-authority-device-signature.md)'s `human_accept` rule as it stands; this ADR
  neither widens nor narrows it. Today the `/live` rail attaches the proof when it has one.
- miley's standing authorization (ADR 308) narrows to the fallback. The eval in ADR 308 — the gap
  between a site PR merging and musterd.io serving it — becomes measurable from the record: the
  ask's `ts` to the deploy's `status_update`.
- Reverting is deleting the deploy branch of the tick and pointing the ask back at miley; the stamp
  format is forward-compatible (unknown fields are ignored on read).

- _(2026-10-26, lane 01M5WQMRXC)_ Two publisher instances tick with the one `live` seat and
  separate stamps, and the same gap drew two asks seventeen seconds apart. The raise now carries
  `meta.site_gap {deployed, tip}`, and a tick with no open ask of its own stands by when the record
  holds another instance's unresolved ask for that deployed ref. Only the raiser reads the reply and
  deploys, so the authorizer is named on the machine that holds the wrangler login.

## Observability & Evaluation

**Traces.** Three acts the record did not have: the `ask` to the authorizer (species approve), the
publisher's `status_update` on a deploy, and the `resolve` that closes each ask with its outcome
(deployed / declined / moved / failed). All from the `live` service seat.

**Eval.** ADR 308's metric, now readable: for each site-affecting commit, the time from its ask to
the `status_update` that deployed it. Baseline: the two commits of 2026-10-26 waited from 09:59 to
the hand deploy that followed this ADR. Success is every site-affecting commit having an ask, and
every deploy having a `status_update`, with no deploy that no ask preceded.

**Experiment.** None. One authorizer, one site; the question is whether the loop runs without a
seat in it, which the trace answers.
