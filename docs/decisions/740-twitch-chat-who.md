# 740 — Twitch chat can open a nameplate, and nothing else

- Status: accepted
- Date: 2026-10-26

## Context

The stream's first real engagement was a viewer asking "can you show their occupations". Plates now carry roles, and an idle plate folds to its pictures (lane 01M5G7A9H1, #3146). /broadcast opens every folded plate in a roll call every five minutes, so a viewer who wants one member now waits up to five minutes.

Nothing reads Twitch chat today. The only Twitch code is `twitchLiveness.ts`, the site's live check. The stream runs on a hosted machine: `musterd broadcast` launches Chrome on `/broadcast` and drives it over CDP, and the page publishes its scene handle as `window.__office` (ADR 594, ADR 293).

## Problem

Viewers can ask from chat, and the stream cannot hear them. Hearing them adds an outside input to a product whose every other input comes from a member. An input from strangers must not become a path to the team.

## Decision

`!who <member>` in the channel's Twitch chat opens that member's plate on /broadcast for 5 seconds. Chat can change only what the stream shows. It never sends an act, never reaches a seat, the board or the daemon, and never starts work.

1. **Where it reads.** The reader runs inside the `musterd broadcast` process on the stream machine, next to Chrome. It reaches the page only through one CDP call: `window.__office?.spotlight?.(<name>)`. It holds no team credential and opens no connection to the daemon, so the boundary is structural: there is no code path from chat to the team.
2. **How it reads.** Twitch EventSub over WebSocket, subscription `channel.chat.message` v1, on a bot account's user token with only `user:read:chat`. The bot is a mod of the channel or the broadcaster grants the app `channel:bot`. Anonymous IRC (`justinfan`) was the easier read and needs no token, and is rejected: EventSub is Twitch's supported path, and the team builds on it (nick, 2026-10-26).
3. **What it accepts.** A fixed allowlist, compiled in. Today it holds one command: `!who`, case-insensitive, followed by one name of 1–32 characters from `[A-Za-z0-9_-]`. Anything else is ignored without a reply. The bot never posts to chat; its token cannot.
4. **Rate limits.** One accepted command per viewer per 30 s, and one plate across the channel per 6 s. A command over either limit is dropped, not queued.
5. **What the page does.** `spotlight(name)` opens that member's plate for 5 s, with the roll call's spot and layout hold so neighbours do not move. A name that is not a member on the floor is ignored. A newer spotlight closes the previous one. Under reduced motion it is a swap, as the roll call is.
6. **Secrets.** The client id, client secret and refresh token are stream-machine secrets, set like the stream key and never logged. The reader refreshes its own access token. Without them the reader does not start and the stream runs as before.

## Consequences

- A second chat command is a change to this allowlist, with its own line here. A command that reaches the team is out of scope for this ADR and needs one of its own.
- Revoking access is deleting the bot account or the app's authorization; the stream keeps running without the reader.
- _(2026-10-26, izzo's acceptance decline)_ Twitch may return a new refresh token on any refresh, and the old one can stop working. The reader now uses the newest token for the rest of its run and logs once that the stored secret may be behind. It cannot write the secret back: the machine is `--rm` and the token is never logged. So after a rotation, the operator re-authorizes the bot and sets `MUSTERD_TWITCH_CHAT_REFRESH_TOKEN` again before the next start; a start on a dead token logs `chat: off` and the stream runs without the reader.
- Going live needs a human: the app registration, the bot account and its authorization are nick's to do. Until then the reader logs once that it is off.

## Observability & Evaluation

- **Traces:** the reader logs to the broadcast log one line per accepted command (`chat: !who <name>`) and one per state change (connected, subscribed, reconnecting, off). It never logs a token, a message body it rejected, or a viewer's name.
- **Eval:** unit tests cover the parser, the allowlist, both rate limits, and the EventSub message handling (welcome, keepalive, reconnect, revocation) against a stand-in socket. The page's `spotlight` is covered beside the roll call.
- **Experiment:** n/a — a display feature with no tunable whose effect we would measure.
