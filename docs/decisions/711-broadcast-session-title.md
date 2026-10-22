# 711 — Broadcast session titles

- Status: accepted
- Date: 2026-10-22

## Context

The Twitch archive is many recordings with one name, because the channel title has never changed
(`docs/design/twitch-channel-copy-spec.md` §3.1). The format is fixed: `Coffee & musterd - ` plus a
tail. The tail names the work, in the present tense, lowercase, with no end punctuation, under 35
characters, true for the whole session, with no names and no counts. The standing title
`Coffee & musterd - watch musterd agents build the platform live` is the fallback, and its tail is
the specified exception to the 35-character cap.

A title per machine bounce would be dozens a day. The daemon bounced 15 times on 2026-09-16 before
any of this, and the spec's answer is that the title is sticky for a working session: restarts
inside that session inherit it.

The spec also says to change the title before `stream start` if a mid-broadcast edit does not
retitle the recording in progress. Whether it does is still unverified. The same spec says stream
info takes effect immediately when edited mid-stream, which does not settle the recording.

A grep on 2026-09-16 found no Helix call in the repo. Lane `01M2P2D07AYKV1Q0Q5FJZZA023` is that
call. Sloane owns §3.1. The derivation below is mechanical. She sees real strings before this ships.

## Problem

`stream start` knows the goal and the lanes, and the channel title does not. Putting a Twitch user
token on the operator CLI would put a credential where musterd has so far only checked that a
secret is present. Setting the title on every restart would replace a title a person typed, and
getting that wrong is worse than the untitled archive.

Lane titles are paragraphs. A short-name field would be a protocol change, and this lane does not
need one.

## Decision

The container sets the title once, before ffmpeg starts. `scripts/broadcast/entrypoint.sh` runs
`musterd stream apply-title` before the supervised loop, so an in-machine relaunch does not set it
again. A missing subcommand on an older image is ignored (`|| true`), and the stream still starts.

The token is two Fly secrets, `MUSTERD_TWITCH_CLIENT_ID` and `MUSTERD_TWITCH_TOKEN` (a user token,
scope `channel:manage:broadcast`). The operator CLI checks that both names are present and never
reads, prints, or accepts the values. They are not in `REQUIRED_SECRETS`. Absent is `skip` on
`stream doctor`, the `fly secrets set` line is in that row's detail, and `stream start` proceeds.
The machine process is the one that reads them, the same way it already reads `MUSTERD_STREAM_KEY`.

`stream start` derives the title from the board and passes it as `MUSTERD_STREAM_TITLE`, plus
`MUSTERD_STREAM_TITLE_PREV` (the title the previous start asked for, empty the first time). Both
are ordinary env, one argv element each (`spawn`, so `&` is not a shell metacharacter). The derived
string is stored on the stream state file, including a `--once` run. A supervisor relaunch passes
the stored string as both desired and previous, and does not read the board again. A state file
with no title passes neither variable.

Derivation, in `sessionTitle`, ignores incident lanes. Among contending lanes
(`LANE_CONTENDING_STATES`), more than one distinct goal is the standing title. One goal that is not
retracted: the first clause of `story`, then of the goal title, then — when exactly one such lane
— of that lane's title. No goal and exactly one such lane: that lane's title. Anything else is the
standing title. A board read that fails is not "no single subject": the command keeps the previous
stored title, or the standing title when there is none. A successful derivation of the standing
title may replace a title we own.

A clause is the text up to the first `?`, `!`, em dash, ` - `, `:`, or ` (`. A period is not a cut,
so `musterd.io` survives. Backticks go, whitespace collapses, `ADR` plus a number is removed, then
lowercase, then trailing punctuation. The result is refused when it is empty, longer than 35
characters, contains a digit, or ends with `.!?`. _(Amended 2026-10-27: a tail of fewer than two
words is refused too — see Consequences.)_ Refusal falls through to the next source, then
to the standing title. Naming the work rather than the process is not a check this function can
make.

Ownership, in `decideTitle`. The channel is ours when its current title is empty, the standing
title, the desired title, or the non-empty previous title. Otherwise it is left alone, including
`game_id`. When it is ours and the title or the category differs, one PATCH sets both. The category
is Software and Game Development, game id `1469308723`, taken from the twitchtracker.com and
twitchstats.net URL slugs on 2026-10-22 and not from a live Helix call. When the title and the
category already match, there is no write.

Helix runs from inside the container only: `GET /helix/users`, then
`GET /helix/channels?broadcaster_id=`, then `PATCH` of that same path with `{title, game_id}` when
the decision is to set. Each request has its own 8 second abort. No token or client id:
`title off — twitch token unset`. 401 or 403: `title off — twitch token rejected`. Any other read
or write failure, including a thrown error: `title off — could not read the channel`, and the error
text is not printed. Not ours: `title left alone — channel title is not one we set`. Ours and
unchanged: `title unchanged`. A write was sent: `title set`. The command exits 0 in every case.

A PATCH that fails leaves the channel where it was. The next start still owns the standing title
and tries again. There is no ack to wait for.

A person who types exactly the string we were about to set, before we have set it, cannot be told
apart from us. A title we used to set, put back after we have moved on to another, is treated as
theirs.

## Consequences

- The title is applied before ingest, so a mid-broadcast edit is not what this lane relies on. Whether that edit retitles the recording in progress stays unverified.
- A human title survives `stream start`, a supervisor relaunch, and a later session whose derived title is different.
- Setting the channel back to the standing title releases it: the next start may set again.
- Doctor stays green for a stream that has no title token. The skip row is where the repair is written, because skip rows are not copied into the fail-fix block. `fly secrets list` cannot show expiry. A rejected token shows up as the apply line in `fly logs`.
- An older capture image streams with the title unchanged.
- _(2026-10-27: sloane's copy read added a two-word floor.)_ Reading the derived strings against §3.1, she passed `office café rework`, `wake latency, codex seats` and `wake latency, claude code seats`, and failed `security`, `experiment` and `/broadcast` as a bare category or path rather than work. The rule is therefore a word count — a tail with fewer than two words falls back to the next source, then to the standing title — and deliberately not a process-word blocklist, which would drift. `act lane read` passes the floor and is still a judgement call: the operator hand-sets the title, and `decideTitle` leaves a human title alone. Falsify: a lane titled only `Security` now derives the standing title, and `stream start` on a streaming session leaves the channel as it is.
- _(2026-10-27: the read asks the board only for the contending states — the ones `sessionTitle` can use — rather than the whole team's lanes.)_ The unfiltered board carries every done lane ever, and one such lane whose `claims` exceed what `LaneBoardSchema` allows fails the schema for the whole response, which would have made the derivation fall back on every start without saying so. A read that fails for any other reason still keeps the previous title.

## Observability & Evaluation

- Traces: one line from `stream apply-title` in the machine log (`title set`, `title unchanged`, `title left alone — …`, or `title off — …`). The line never contains the token or the client id. `stream start` prints the title it asked for, and a board-read failure names that it kept the last title.
- Eval: `packages/cli/src/broadcast/channelTitle.test.ts` covers `sessionTitle`, `decideTitle`, and `applyChannelTitle` (a human title, the standing title, the game id, a missing token, a 401, and a thrown error whose text contains the token). `stream.test.ts` covers the env the launch passes and a failed board read keeping the previous title.
- Experiment: n/a — sloane reading the derived strings before merge is this lane's ship gate, not a rate.
