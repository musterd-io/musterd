# 594 — /broadcast carries its own observer

- Status: accepted
- Date: 2026-10-14
- Deciders: nick, miley
- Lane: `01M4YD9AMFS2MS6RZQ2HKSDNFK`
- Builds on: [ADR 580](580-human-credentials-require-human-admin.md),
  [ADR 157](157-broadcast-mode.md)

## Context

`/broadcast` connected to the team the way every read-only surface used to: the page called
`acquireObserver`, which minted an observer seat with an unauthenticated `POST /members`, and the
daemon allowed it because the request came from loopback (ADR 134). The hosted stream reached the
same loopback through `tailscale serve`.

ADR 580 (#2501, merged 2026-10-13 17:24) amended that boundary: loopback no longer provisions
observers, because an observer can read team traffic. That was a deliberate decision, not a slip.

## Problem

After #2501 every broadcast stopped at the start. The page showed ADR 580's refusal, never set
`window.__broadcastReady`, and `musterd broadcast` exited with "the broadcast page never reported
ready". It hit the Fly capture bench on 2026-10-14 (`CAPTURE_AB_FAILED 13`) and reproduced on the
live daemon at `localhost:4849/broadcast?team=revive` (a 401 and the refusal text). `musterd
broadcast` on the laptop and `musterd stream start` take the same path, so they fail the same way.

## Decision

1. **The capturer brings the page its observer.** `musterd broadcast` gets one seat per run, before
   Chrome starts: from `MUSTERD_BROADCAST_SEAT` (JSON `{team, name, token}`) if set, else it mints
   one with the identity of the folder it runs in. That identity must be a human admin, as ADR 580
   requires. If it is not, the CLI says so and names both ways out.
2. **The seat is public-grade.** A stream shows its audience team traffic. It never needs DMs, so
   the CLI never mints a full-grade seat for one.
3. **The seat goes in over CDP, never in the URL or argv.** `Page.addScriptToEvaluateOnNewDocument`
   sets `window.__musterdBroadcastSeat` before the page's own code runs. The page uses that seat
   (`handedObserver`) and falls back to `acquireObserver` only when no seat was handed over. Every
   Chrome relaunch in a run (ADR 551) gets the same seat.
4. **A handed seat is not re-minted by the page.** If the daemon refuses it, the page shows that on
   the stage and leaves recovery to the capturer's ready and stall watchdogs.
5. **`musterd broadcast --mint-seat --team <slug>`** prints one seat as JSON, once, on stdout. It is
   for a capturer that is not `musterd broadcast` itself, such as the bench's x11 arm.
6. **`musterd stream start` mints on the operator's machine.** The box has no identity of its own.
   The seat goes to the machine as `MUSTERD_BROADCAST_SEAT` and is saved 0600 beside the stream's
   state file, so the supervisor's relaunch (streamwatch, an agent seat that cannot mint) hands over
   the same one. The mint happens before the "live" intent is recorded, so a refused mint leaves
   nothing for the supervisor to relaunch.

## Consequences

- ADR 580 stays whole. No loopback path mints an observer again.
- Running `musterd broadcast` now takes a human admin's folder or a pre-minted seat. On this team
  that is nick's folder. An agent seat that runs it gets the refusal and the hint.
- The hosted seat can be read in the Fly machine's config by anyone in the Fly org. It is
  public-grade, and the stream already publishes what it can read to Twitch, so that exposure is
  accepted, not hidden.
- An observer idle for 24h is reaped (ADR 064). A streaming page keeps its seat active. A stream
  relaunched after a long gap can find its saved seat gone, show the refusal, and need a new
  `stream start`.
- Not covered here: `/live`'s signed-out observer view and "copy watch link" also mint through
  loopback and are refused the same way. They are browser surfaces with no capturer to bring a
  seat, so they need their own answer.
  Follows-up: a lane for `/live`'s observer and watch link after ADR 580, opened with this PR.

## Observability & Evaluation

- **Traces:** n/a — no new spans. A refused mint is an ordinary 403 on `POST /members`, and the
  daemon already audits it.
- **Eval:** the Fly capture bench (`scripts/perf/capture-ab.sh`) is the end-to-end check. It
  printed `CAPTURE_AB_FAILED 13` before this change and must print three `CAPTURE_AB` arm lines
  after it. Unit tests pin env parsing, the team match, injection, the 0600 seat file and no-intent
  on a refused mint (`broadcast.test.ts`, `stream.test.ts`).
- **Experiment:** n/a — a fix to a regression, not a tuning choice.
