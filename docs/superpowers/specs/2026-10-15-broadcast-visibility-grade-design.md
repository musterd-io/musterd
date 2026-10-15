# The broadcast shows the team's DMs, except human to human, with secrets masked — design

**Status:** design approved in chat 2026-10-15, section by section, by nick. Written spec awaiting
nick's review. Decision: [ADR 601](../../decisions/601-broadcast-visibility-grade.md). Goal:
`broadcast-shows-the-work`. Lanes: inc 1 `01M50C1PY58STPY0CWPFPPTAE1` (this spec and the ADR), inc 2
`01M50C1T9P735H4Z4P7KW7XJX3` (server), inc 3 `01M50C1ZZMJFRG409G6TC4S303` (CLI and page).

## What nick asked for (2026-10-15)

- The broadcast shows every direct message (DM) that is agent to agent, human to agent, or agent to
  human. That includes the to-human asks that name a seat, which today only admins and full observers
  see.
- It never shows a DM where both ends are humans.
- It never shows a secret. Asked how strict to be, nick chose **mask what is recognisable**: replace
  the credential-shaped part of the text with a marker and show the rest of the message. A secret
  written as plain prose ("the password is hunter2") is not recognisable and is not caught. That
  limit was stated and accepted.
- The filtering and the masking happen in the daemon, not in the page (approach A of three). Nothing
  the stream must not show leaves the daemon for the rented Fly machine.

Assumptions stated in the brainstorm and not corrected: "human" is a member of kind `human` that is
not an observer seat; service seats (autorefresh, streamwatch) count as agents; the `/live` watch link
stays public-grade; starting the broadcast still needs a human admin (ADR 580).

## How visibility works today (2026-10-15, `origin/main` 1da9beb)

- **Grades.** `messageVisibilityOf` (`packages/server/src/store/rows.ts:222`): an admin is `full`; an
  observer is its `observer_scope`, `full` or `public` (ADR 136); any other seat is `team`. `team`
  sees DMs except confidential asks (ADR 407 §3). `public` sees team and broadcast acts, plus acts
  it is a party to.
- **Only two places enforce a grade:** the live fan-out `hub.broadcastFirehose`
  (`transport/hub.ts:168`), which gets `directed` and `confidential` booleans from
  `protocol/route.ts:746` and `:877`; and the history read `readScopeSql`
  (`store/messages.ts:956`), used only by `GET /teams/:slug/messages`.
- **The broadcast seat is public-grade** (ADR 594 decision 2), minted by `mintBroadcastSeat`
  (`packages/cli/src/commands/broadcast.ts:218`), and `musterd stream start` stages it as the Fly
  app's `MUSTERD_BROADCAST_SEAT` secret.
- **What `/broadcast` reads:** `GET /health`, `GET /teams/:slug` (the roster, including each member's
  `state` line), `GET /teams/:slug/messages?limit=200`, `GET /lanes?brief=1`, `GET /report`, and the
  WS firehose (`subscribe` scope `team-all`).
- **Nothing scrubs message text today.** `scrubCredentials` (`packages/protocol/src/traceScrub.ts`)
  is used only by the trace store.
- **An existing leak, found here.** A member's roster `state` is their latest `status_update`
  regardless of who it was sent to (`store/messages.ts` `latestStatusUpdates`). A human-to-human DM
  sent as a `status_update` shows on today's public-grade broadcast.

## Design

### 1. The `broadcast` grade — what it sees

- A fourth `observer_scope` value, `broadcast`. `MessageVisibility` becomes
  `'full' | 'team' | 'broadcast' | 'public'`.
- **The rule:** a `broadcast` reader gets everything a `full` reader gets, except a message whose
  `to_kind` is `member` and whose sender and recipient are both **human, non-observer** members.
  Confidential asks are included.
- **Live fan-out.** The send path computes a third flag, `humanPair`, from the sender row's kind and
  observer bit and the recipient row's (the recipient row is in scope in the `to.kind === 'member'`
  block at `route.ts:521` and at `:857` for replicated messages; lift it out or compute the flag
  there). `broadcastFirehose` gains the parameter; a `broadcast` connection skips `humanPair`
  messages and receives directed and confidential ones.
- **History.** `readScopeSql` gets a `broadcast` branch: no filter, except
  `NOT (to_kind = 'member' AND <from_member is a human non-observer> AND <to_member is a human
  non-observer>)`, as `EXISTS` subqueries on `members` (both SQLite and Postgres stores).
- **Roster status.** For a `broadcast` or `public` reader, a member's `state` comes from their latest
  `status_update` that is not a human-pair DM. For `public`, this closes the leak above: the rule
  for public stays what ADR 136 says (team and broadcast acts), and its status line now follows it.
- **Fail closed.** A missing or unknown grade is `public`, as `broadcastFirehose` already does.
  `resolveObserverScope` returns `broadcast` only for the exact stored string.

### 2. Masking secrets

- **One function:** `scrubCredentials` from `traceScrub.ts`, unchanged. It covers every musterd
  token prefix in the `TOKEN_PREFIXES` registry, `sk-…`, GitHub, AWS and Slack tokens, `Bearer` and
  `Basic` values, PEM private keys, and key-ish values assigned to names like `token`, `key`,
  `secret` or `password`. Each match becomes `<redacted:kind>`; the rest of the text stays.
- **What is masked:** every string a `broadcast` reader receives that can carry free text: an
  envelope's body and every string value in its `meta` (walked recursively), the roster `state`
  line, lane titles (and `detail` when not `brief`), goal titles and stories, and the report's text.
- **Where:** on the way out, only for a `broadcast` reader. Stored rows, caches and every other
  reader are unchanged. The report is a shared cache, so it is masked when served, never in the
  cache.
  - Live fan-out: the frame is shared, so the masked copy is made at most once per message, and only
    when at least one `broadcast` connection is subscribed, then sent to each of them.
  - `GET /teams/:slug/messages`, `GET /teams/:slug`, `GET /lanes`, `GET /goals`, `GET /report`: mask
    the response for a `broadcast` reader after it is built.
- **Not in scope:** secrets written as prose; `/memory/search`, `/seeds`, `/next` and other endpoints
  the page does not read. A `broadcast` seat is a stream's seat and nothing else reads with it.
- **Cost:** a few regex passes per message, paid once per message and only while a broadcast is
  connected. Twitch viewers never reach the daemon.

### 3. Minting, the page, and who builds what

- **Mint.** `AddMemberBody.observer_scope` (`transport/http.ts:1190`) accepts `broadcast`; minting
  any observer still needs a human admin (ADR 580). `mintBroadcastSeat` asks for `broadcast`.
  `musterd stream start` mints a fresh seat on every start and stages it, so the first start after
  this ships replaces the public-grade secret; a seat passed in by hand as `MUSTERD_BROADCAST_SEAT`
  keeps whatever grade it was minted with.
- **No full-grade fallback on `/broadcast`.** Today the page falls back to `acquireObserver`, which
  mints `full`, when no seat was handed over (ADR 594 decision 3). `/broadcast` drops that fallback:
  with no handed seat it shows the refusal on the stage and loads nothing. `/live` is unchanged.
- **The page draws what it gets.** `/live` already renders DMs for a full reader, and `/broadcast`
  uses the same components, so no new visuals. Anything that reads wrong on stream is a follow-up.
- **Who builds what.** Inc 2 (server) goes to a server seat by handoff; it is not the designer's
  surface. Inc 1 (this spec and ADR 601) and inc 3 (CLI mint, page guard, docs) are miley's.

## Testing

- **Server, grade matrix.** Sender kind × recipient kind (human, agent, service, observer) × grade,
  for both the live fan-out and `GET /messages`: a human-pair DM is absent at `broadcast` and present
  at `full`; agent↔agent, agent↔human, human↔agent and confidential asks are present at
  `broadcast`; a missing or unknown grade behaves as `public`. Both SQLite and Postgres stores.
- **Server, masking.** A planted fake `mscr_…` and `sk-…` in a body, in a `meta` headline, in a
  status line, in a lane title and in report text comes out as `<redacted:…>` for a `broadcast`
  reader and unchanged for a `full` reader. A body with no secret is byte-identical.
- **Server, public status leak.** A human-to-human `status_update` no longer becomes the sender's
  roster `state` for a `public` reader.
- **Page.** `/broadcast` with no handed seat sends no `POST /members` and shows the refusal.
- **End to end (inc 3).** `musterd broadcast --out` against a throwaway daemon seeded with a
  human-to-human DM, an agent-to-human DM and a planted key: the agent-to-human DM is on screen, the
  other two are not, checked on extracted frames.

## Docs touched

ADR 601 (new); `docs/architecture/01-data-model.md` (`observer_scope` values) and `03-server.md`
(grades) with inc 2; `docs/architecture/08-web.md` and `docs/wiki/broadcast-stream.md` with inc 3.
ADR 136 and ADR 594 get dated Consequences notes pointing at ADR 601; their Decisions are not edited.
