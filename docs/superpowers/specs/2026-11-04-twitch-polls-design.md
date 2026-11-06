# Twitch polls: a human admin asks the stream, viewers vote, the team keeps the result

- Date: 2026-11-04
- Lane: `01M6MA88VNZR21VD00RRYM98R1` (this spec). The build gets its own lanes in the plan.
- Asked by: nick, in a brainstorm with miley on 2026-11-04.
- Builds on: [ADR 740](../../decisions/740-twitch-chat-who.md) (`!who`). This design needs an ADR
  that amends 740's boundary. See "The boundary" below.

## Intent

nick wants viewers of the musterd stream to *interact with the team*, not just watch it. This is the
first of three ideas he raised, in this order:

1. **Polls** (this document). A human admin asks the stream a question with fixed options, viewers
   vote in Twitch chat, and the result is shown and kept.
2. **Ask the team** (later, its own design). A viewer asks what the team or one member is doing, and
   the member answers in its own words, under guardrails.
3. **Viewers create their own agent** (later, its own design, after Cloud agents). This is the largest
   and riskiest of the three.

Polls come first because the viewer's words never reach an agent. Viewers only *choose between options
a human admin wrote*. That is the safest way to let chat steer the team on stream, and it ships the
musterdbot plumbing the other two will reuse.

What nick said success looks like: an admin starts a poll, it appears in chat with context that says
what the bot is and that "nick wants to ask viewers …", viewers type their answer, the votes are carried
forward as results, and when time is up the option with the most votes wins and is displayed. Later,
more automation can build on the result; that is out of scope here.

## Goals

- A **human admin** (only: not agents, not non-admin humans) creates a poll from `/live` (signed in),
  the musterd phone app, or the CLI.
- A poll can be created **only while the broadcast stream is actually live** on Twitch.
- Configurable: the question, 2–4 options, a time limit. The vote rules are fixed (below).
- The bot posts the poll in Twitch chat: who asks ("nick asks: …"), the options as `Option N - text`,
  how to vote, and how long the poll runs. _(2026-11-05, after the first live run: the "I'm musterd's
  Twitch bot" greeting and the `N · text | …` list were dropped — three lines read badly in the chat
  column, and nick asked for the `Option N - text` shape.)_
- Viewers vote in chat (`!vote N`).
- A **live tally shows on the stream** while the poll runs (nick, 2026-11-04: "yes the tally should
  show"). It shows each option's share, the vote count and the time left.
- When time is up, the bot posts the winner in chat, the stream shows it, and the result is **recorded
  on the team** (visible on `/live` and in the team's history).

## Non-goals (this design)

- Acting on the result automatically (opening or claiming a lane from the winner). nick: "then
  eventually we do some more automation with it". The record is shaped so that can come later.
- Viewers asking members questions, and viewers creating agents (ideas 2 and 3).
- Polls on any platform other than Twitch.
- Viewers proposing options.

## Anti-goals (a failure even if it works)

- **A viewer reaches an agent.** nick's worst case: "a viewer tricking an agent to hack or do something
  malicious". Under this design no viewer text ever reaches a seat, the board or the daemon. Only
  integer vote counts for a known poll do (see "The boundary").
- **The bot repeats viewer text.** It never echoes a message, a name or a vote back to chat or the
  stream. It posts only text an admin wrote and fixed templates.
- **A poll runs off stream.** No poll may be created or kept open while the stream is down.
- **Anyone but a human admin starts one.** An agent seat, an observer or a non-admin human is refused
  at the daemon, not merely hidden in the UI.

## Decided (nick, 2026-11-04)

- Who creates: **human admins only**.
- Where: `/live` signed in, the musterd phone app, or the CLI.
- When: only while the broadcast is live.
- What chat shows: a bot message with context ("this is the musterd twitch bot, nick wants to ask
  viewers …") and the options; then the winner when it closes.
- The tally shows on the stream.
- The result is logged and carried forward as poll results.
- **Starting a poll needs the admin's passkey** (nick, 2026-11-04: "yes"). Opening a poll mints its
  poll-scoped credential, which is `credential_mint` under ADR 662, so it takes A2 passkey proof: Face ID
  in the app, a passkey prompt on `/live` and in the CLI. This is also what tells a human admin apart from
  an agent working in that admin's folder, which resolves as the admin. Ending or cancelling a poll early
  mints nothing and needs no passkey.

## miley's calls (nick may overturn any)

- **The bot is a separate Twitch account, `musterdbot`, a moderator of the channel.** It is not nick's
  account. Viewers see it is a bot, its token is chat-only and revocable on its own, and as a mod it gets
  Twitch's higher chat rate limits. ADR 740 already reads chat on a bot account's token. This adds the
  chat-write scope (`user:write:chat`, with `user:bot`) to it.
- **Options: 2–4.** Fewer than 2 is not a poll. More than 4 does not fit a tally a stream viewer can read
  at a glance.
- **Time limit: 1–15 minutes, default 5.**
- **Voting: `!vote N`**, case-insensitive, N from 1 to the option count. Anything else is ignored
  silently, the same as ADR 740's allowlist. Bare `2` is rejected: ordinary chat is full of digits.
- **One vote per Twitch account. A viewer may change their vote until the poll closes;** their latest
  vote counts. A vote is counted by Twitch user id, never by display name.
- **One poll at a time** per team.
- **An admin can end a poll early** (it closes with the votes so far) **or cancel it** (no winner; the
  record says cancelled).
- **A tie is a tie.** The bot and the stream say so and name the tied options. There is no automatic
  tiebreak.
- **If the stream drops**, the poll closes as **interrupted**, keeping its counts. It is not reopened when
  the stream comes back.
- **Zero votes** closes as "no votes", with no winner.
- **The vote rate limit**: at most one counted vote per viewer per 2 s. Over the limit, the vote is
  dropped, not queued.
- **Same bot account as `!who`.** musterdbot is ADR 740's bot, re-authorized with the added scopes:
  one token and one EventSub session. A revoke stops both, which is the intent. **nick must
  re-authorize it once** before polls can be verified end to end. The plan schedules that as its own
  blocked step.
- **The hub owns the poll.** A team's one-poll-at-a-time rule, its record and its admin check live on
  the hub daemon. An admin on another machine creates a poll the way team policy is set today: their
  daemon forwards it to the hub (`/policy`'s pattern). `/broadcast` reads the hub, so it sees the open
  poll either way.
- **"Live" means Twitch says the channel is live**: a Helix `streams` check on the bot's token, made
  by the stream machine and reported with the counts. That is what a viewer sees. Our own capture can
  be running while it isn't reaching Twitch, so that state is not the gate. (`twitchLiveness` runs in a
  visitor's browser, so the daemon can't use it.)
- **Restarts are not drops.** The stream restarts itself routinely (ADRs 293, 551, 553). A poll closes
  as **interrupted** only after Twitch has reported the channel offline for **90 s straight**. Per-viewer
  votes live only in the stream machine's memory, because no viewer id may reach the daemon. So after a
  restart the reader starts from the daemon's last counts and counts new `!vote`s on top. A viewer who
  changes their vote across a restart is counted twice. This is accepted and said in the ADR: a
  restart mid-poll is rare, and the alternative is sending viewer ids to the team.
- **The chat boundary is per module, not per process.** The `musterd broadcast` process already holds
  the observer seat token. The chat reader module is handed **only the poll-scoped credential**, never
  the seat token or the page. The counts it reports are integers in a schema with no string field
  from chat. The ADR restates 740's claim at that level, honestly: the chat code holds no team
  credential except a counts-only, one-poll, expiring one. A separate process was considered and
  rejected as cost without a gain the schema doesn't already give.

## The boundary (what makes this safe, and why it needs an ADR)

ADR 740 says chat can change only what the stream shows: the reader holds no team credential and opens
no connection to the daemon, and its token cannot post. Polls cross that line in two places. This
design crosses them as narrowly as it can.

1. **Team → chat (the question).** The daemon holds the poll. The `/broadcast` page already reads the
   team, so it sees the open poll as part of what it renders. `musterd broadcast` on the stream machine
   reads the open poll from the page over CDP, the same way it reads `window.__office.stats()` today.
   It then posts the poll through musterdbot. The posted text is the admin's question and options inside
   fixed templates. The stream machine never posts anything else.
2. **Chat → team (the votes).** Only **counts** cross: `{ poll id, option index → count }`. The stream
   machine tallies votes itself, keyed by Twitch user id. Periodically, and once at close, it sends the
   counts to the daemon on a **poll-scoped write credential**. The daemon mints that credential when the
   poll opens and hands it to the stream machine (exactly how is the builder's call; see below). It can
   do one thing: report counts for that one poll id. It expires when the poll closes. The daemon rejects
   a count above the number of distinct voters the stream machine reports, a poll id that is not open,
   or an option index out of range. No viewer name, message text or user id ever reaches the daemon.

The build comes with a new ADR, plus a dated note in ADR 740's Consequences pointing to it (740's
Decision stays frozen; `docs/wiki/amending-an-adr.md`). The new ADR records the chat-write scope, the
poll-scoped credential and the counts-only rule, and it says why ask-the-team will need its own ADR:
that one lets viewer words reach a seat.

## How it looks (the brainstorm mockups, kept in `.superpowers/brainstorm/`)

1. **Create** (`/live` signed in, the app, the CLI). A form or prompt for the question, options and time
   limit, and a Start button. It shows "Live on Twitch" when the stream is up. When it is down, it says
   so and Start is disabled.
2. **Chat, on open**:
   `musterdbot: 🗳️ nick asks: What should team revive work on next?` then one line:
   `Option 1 - …, Option 2 - …, Option 3 - …. Vote by typing !vote 1, !vote 2 or !vote 3 — 5 minutes.`
   _(wording as of 2026-11-05; `!vote1` without the space counts too.)_
   Twitch caps a chat message at 500 characters, so a long poll posts in more than one message.
3. **On the stream, while it runs**: a compact card in the stream's warm style. It shows the question,
   each option with a bar and its percentage, the time left, the vote count and "type !vote in chat".
   The top option's bar wears the mustard fill. It updates as counts arrive; it never shows a voter.
4. **Close**: `musterdbot: 🗳️ Poll closed — 48 votes. Winner: Option 2 - Viewers ask the team questions (52%).
   Thanks for voting!` The stream card shows the winner for a short while, then leaves. A tie, no votes,
   cancelled and interrupted each get their own fixed sentence.
5. **The record**: on `/live`, the poll and its result appear in the team's history, as a settled act
   with the question, options, counts, winner (or tie / none) and how it ended.

## What's left to the builder

- The record's shape on the wire: a new act or `meta` on an existing one. This is a protocol change, so
  it needs its own ADR. Shape it so a later "open a lane from the winner" can hang off it.
- How the poll-scoped credential reaches the stream machine. One possibility: the daemon includes it in
  the open poll the page reads, visible only to the broadcast's own session, never to a public
  observer. Another: the stream machine fetches it with its existing machine identity. Whatever is
  chosen, it must stay out of public `/broadcast` HTML, logs and the stream picture, and only the chat
  reader module receives it (see "The chat boundary is per module").
- The tally card's exact layout and motion (miley owns it as the designer; hand the spec over in the
  plan).
- Where poll creation lives on `/live` (likely the admin settings or a broadcast control) and in the app.
- Retrying a chat post Twitch rejects, and what the admin sees if musterdbot is not authorized.

## Verification (what "done" looks like)

- An admin starts a poll while the stream is live, and it appears in chat with the context line within a
  few seconds.
- Votes from three test accounts move the stream tally. A changed vote moves it too. A fourth message
  that is not `!vote N` changes nothing.
- On close, the chat winner line, the stream card and the `/live` record all agree on counts and winner.
- Refused cleanly: an agent seat, a non-admin human, the stream being down, and a second poll while one
  is open.
- The daemon never receives viewer text. A test asserts the counts endpoint's input schema has no string
  field from chat.
- The poll-scoped credential cannot write to another poll and stops working after close.

## Corrections

- _(2026-11-04, miley, from the code map behind the plan)_ **Hub forwarding is the authority relay, not
  `/policy`.** `POST /policy` is hub-local and a joiner refuses it (`hub_local_required`). An admin on
  another machine opens a poll through the ADR 728 authority relay (`authorityRelayIfJoiner`, a new
  `poll.open` op), which already carries A2 proof. End and cancel use the holds forward (`holdAct`).
- _(2026-11-04, miley)_ **An admin with no enrolled passkey is refused.** `requireAuthority` passes a
  human with no enrolled key as `bearer_unenrolled`. Opening a poll refuses that assurance, so nick's
  "yes" to a passkey holds even before he enrolls more devices.
- _(2026-11-04, miley)_ **The phone needs a new app-channel kind.** The app today signs only offers the
  daemon pushes and quick actions. Starting a poll from the phone is a new `poll_open` callback,
  signed with the Face ID key. It is the plan's last build increment.
- _(2026-11-04, miley)_ **The stream machine reports Twitch's live state on its own** (`POST /stream/live`
  on its observer seat, every 30 s), so `/live` can enable Start before any poll exists.

