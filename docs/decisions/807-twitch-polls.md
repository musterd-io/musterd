# 807 — Twitch polls: a human admin's poll crosses ADR 740's chat boundary, and only counts come back

- Status: accepted
- Date: 2026-11-04

## Context

nick wants viewers of the musterd stream to interact with the team (brainstorm, 2026-11-04; design
[`docs/superpowers/specs/2026-11-04-twitch-polls-design.md`](../superpowers/specs/2026-11-04-twitch-polls-design.md),
plan [`docs/superpowers/plans/2026-11-04-twitch-polls.md`](../superpowers/plans/2026-11-04-twitch-polls.md)).
The first step is a poll: a human admin asks the stream a question with 2–4 fixed options, viewers vote in
Twitch chat, a tally shows on the stream, and the team keeps the result.

[ADR 740](740-twitch-chat-who.md) made `!who` the only chat command and drew a structural line. The
chat reader holds no team credential, opens no connection to the daemon, and its bot token cannot post.
A poll needs both things that line forbids. musterdbot has to post the admin's question in chat, and the
votes have to reach the team's record.

## Problem

How does a poll go out to chat and its result come back without opening a path from strangers in chat
to the team? nick's worst case, in his words: "a viewer tricking an agent to hack or do something
malicious".

## Decision

1. **Viewers only choose; they never write to the team.** A poll's question and options are written by a
   human admin. Viewers pick an option with `!vote N` (case-insensitive, N from 1 to the option count). No
   viewer text, display name or user id reaches the daemon, the board or any seat. The only thing that
   crosses from chat to the team is **integers**: one count per option and a distinct-voter count, plus two
   booleans the stream machine observes itself (`live`, `post_failed`). `PollCountsSchema` is `.strict()`
   and has no string field.
2. **Only a human admin with a passkey opens a poll.** Opening mints the poll's credential, so it is
   `credential_mint` under [ADR 662](662-one-machine-per-hosted-seat.md) and takes A2 proof. The route
   refuses `bearer_unenrolled`, the pass `requireAuthority` gives a human with no enrolled key. Without
   that refusal, an agent working in an admin's folder, which resolves as the admin, could open a poll.
   Ending or cancelling a poll mints nothing and needs no proof. The phone opens a poll with a new
   app-channel `poll_open` callback, signed with the Face ID key, as its A2 path for this act.
3. **The hub owns polls.** One open poll per team, its record and its admin check all live on the hub
   daemon. A joiner opens one through [ADR 728](728-hub-owned-human-authority.md)'s authority relay (a new
   `poll.open` op, carrying the proof). End and cancel follow the holds forward ([ADR 516](516-holds-a-time-bounded-rule-a-human-activates.md)).
4. **A poll opens only while Twitch reports the channel live.** The stream machine checks Helix
   `streams` with the bot's token and reports the result. That is what a viewer sees, and our own
   capture can run without reaching Twitch. A poll closes as `interrupted` after 90 s of Twitch reporting
   offline, so the stream's routine self-restarts ([ADR 293](293-stream-desired-state.md),
   [551](551-capture-relaunches-alone.md), [553](553-sink-loss-restarts-in-place.md)) do not end it.
5. **The poll credential is counts-only, for one poll, and expires.** Opening mints an `mspoll_` token
   (stored as sha256, hard rule 5). It can do exactly one thing: `POST /teams/:slug/polls/:id/counts`
   for that poll id while the poll is open. `GET /polls/open` returns it only to the broadcast's own
   observer seat (`observer_scope: 'broadcast'`), never to a public watch link.
6. **The boundary is per module, and this restates 740's claim honestly.** The `musterd broadcast`
   process already holds the observer seat token. The chat module is handed only `{ poll, pollToken }`:
   never the seat token, the page, or any other credential. 740's "holds no team credential" becomes
   "holds no team credential except one counts-only, one-poll, expiring token". A separate process was
   considered and rejected: it costs a process and gains nothing the counts schema does not already
   enforce.
7. **musterdbot posts, on the same bot account and secrets as `!who`.** The bot's token gains
   `user:write:chat` and `user:bot` beside `user:read:chat`. It posts only the admin's text inside fixed
   wording (the open line, the options, how to vote, and one closing sentence per outcome). It never
   repeats viewer text. A revoke stops `!who` and polls together, which is intended.
8. **Votes are tallied on the stream machine by Twitch user id.** A viewer's latest vote counts, and
   they may change it until close. At most one counted vote per viewer per 2 s. After a restart, the
   reader seeds from the daemon's last counts and adds new votes on top. A viewer who changes their vote
   across a restart is counted twice. This is accepted: the alternative sends viewer ids to the team,
   which point 1 forbids.
9. **The record is two daemon-composed acts.** Opening posts a `message` with
   `meta.poll = { state: 'open', … }`, and closing posts a `resolve` on that thread with
   `meta.poll = { state: 'closed', … }`. The closed form carries the counts, the voter count, how the poll
   ended (`deadline | ended | cancelled | interrupted`) and its winners (none, one, or several for a tie).
   A client-sent `meta.poll` is stripped. Only the daemon writes it.
10. **Asking a member a question needs its own ADR.** The next Twitch idea lets a viewer's words reach a
    seat. That is outside this boundary and is not licensed here.

## Consequences

- `@musterd/protocol` gains `poll.wire.ts` (shapes and limits: 2–4 options, 1–15 minutes with a default
  of 5, a 90 s offline grace, a 2 s vote gap), `poll.ts` (the schemas), the envelope's `meta.poll` rule and
  the `poll.open` relay op. SPEC.md Appendix A lists them as unreleased.
- The daemon gains a `polls` table, the open, end, cancel, read and counts routes, a close sweep, and a
  stream liveness report (`POST /stream/live` on the observer seat). Those are increment 2 of the plan.
- Going live needs nick: he re-authorizes musterdbot with the added scopes and sets the new refresh
  token on the stream machine (740's Consequences already name him for that).
- A future step that acts on the winner, for example by opening a lane, hangs off the closed record.
  It is not built here.

## Observability & Evaluation

- **Traces:** the stream machine logs one line per poll state change (`poll: opened <id>`, `poll: posted`,
  `poll: post refused`, `poll: closed <end>`) and one per counts report error. It never logs a vote, a
  viewer or a token. The daemon writes the two record acts and an audit row for each open (`poll.open`,
  with the admin and the assurance).
- **Eval:** protocol tests cover the limits, `winnersOf`, the strict counts schema, and `meta.poll` being
  bound to its act and state. Later increments test the route refusals (agent, non-admin,
  `bearer_unenrolled`, not live, one open), the token's scope, and the tally's change and restart
  behaviour against a stand-in socket.
- **Experiment:** n/a. This is a stream feature with no tunable whose effect we would measure. The
  go-live run (plan increment 8) records timings and any refused post in `docs/wiki/broadcast-stream.md`.
