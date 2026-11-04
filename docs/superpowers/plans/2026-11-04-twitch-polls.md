# Twitch polls Implementation Plan

> **For agentic workers:** implement each increment in your own seat, in its lane: claim it first,
> one branch and one PR per lane. Don't use writing subagents (AGENTS.md hard rule 8). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human admin starts a poll while the stream is live. musterdbot posts it in Twitch chat,
viewers vote with `!vote N`, a live tally shows on the stream, and the result is posted, shown and
kept on the team.

**Architecture:** The hub daemon owns polls. A table holds them, and an open poll mints a
poll-scoped credential under the admin's passkey (ADR 662 `credential_mint`). `musterd broadcast`
fetches the open poll with its observer seat. It hands the chat module only the poll and that
credential. The chat module posts through musterdbot, counts votes by Twitch user id in memory, checks
Twitch's live state, and reports **integer counts only**. `/broadcast` draws the tally, and the daemon
writes a `meta.poll` record act when the poll closes.

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), SQLite/Postgres ladder migrations, Twitch
EventSub + Helix, React (`packages/web`), the musterd CLI, Expo (`packages/mobile`).

**Spec:** [`docs/superpowers/specs/2026-11-04-twitch-polls-design.md`](../specs/2026-11-04-twitch-polls-design.md)
(read it with this plan; see its dated Corrections).

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 0. Design doc and this plan | `01M6MA88VNZR21VD00RRYM98R1`, `01M6ME5ZKHCVQ4DTDMDA8DN3NR` | — |
| 1. ADR and protocol: poll shapes, counts, record, relay op | `01M6ME4SCE7T3TQ3S5K1SC9QXT` | 1 |
| 2. Daemon: table, routes, credential, sweep, record | `01M6ME50JKYJA32GR4HME301N5` | 2 |
| 3. Stream machine: musterdbot posts, counts, reports | `01M6ME58BT34PW5E8F4ZAME1RJ` | 3 |
| 4. /broadcast tally card | `01M6ME5BFQAVNXVMD884GXX5D6` | 4 |
| 5. /live: start, end, cancel; the record line | `01M6ME5EPX4PMZ99JPF6BAT91R` | 5 |
| 6. CLI `musterd poll` | `01M6ME5HMTC5QY9EYR3WCR1DXY` | 6 |
| 7. Phone: start a poll with Face ID | `01M6ME5N4RTEBE73YNKKBR716K` | 7 |
| 8. Go live: nick re-authorizes musterdbot, one real poll | `01M6ME5QRWSYCSYVR9E40KPPGG` | 8 |

Order: 1 → 2 → (3, 4, 5, 6, 7 in parallel) → 8. Increment 8 needs 3, 4 and 5. The CLI and phone can
land after go-live.

## Global Constraints

- Only a **human admin** may open a poll (`authAdmin`). An agent credential is refused, and so is a
  bearer with no enrolled passkey (`bearer_unenrolled` → refused for this act; spec Corrections).
- Opening needs **A2 passkey proof** for `credential_mint`. End and cancel mint nothing and need none.
- A poll opens **only while Twitch reports the channel live**. It closes as `interrupted` after **90 s**
  of Twitch reporting offline.
- **2–4 options**. Time limit **1–15 min, default 5**. **One open poll per team**.
- Vote command: `!vote N`, case-insensitive, N in 1…options. Bare digits are ignored. One counted vote
  per viewer per **2 s**. The latest vote per Twitch **user id** counts.
- **Nothing from chat reaches the daemon except integers** keyed by option index. The counts schema
  has no string field from chat.
- The chat module receives **only** `{ poll, pollToken }`. It never gets the observer seat token, the page,
  or any other team credential.
- musterdbot posts only the admin's text inside fixed templates. It never repeats viewer text. Twitch
  caps a chat message at 500 characters; split across messages when needed.
- Bot scopes: `user:read:chat`, `user:write:chat`, `user:bot`, on ADR 740's same bot account and secrets.
- The poll credential prefix is `mspoll_`. Store only its sha256 (AGENTS.md hard rule 5). It expires at close.

## Review Focus

1. **A stream restart mid-poll.** The reader restarts from the daemon's last counts and adds new votes.
   It must not reset the tally to zero or post the poll again. Test in task 3.
2. **The poll ends while the bot is mid-split-post** (a long question in several messages). The result
   line must still post once, after the poll's own lines. Test in task 3.
3. **Twitch rejects a chat post** (bot not authorized, rate-limited). The poll stays open and counts.
   The admin sees "musterdbot couldn't post" on `/live`, and nothing loops. Tests in tasks 2 and 3.
4. **Clock skew between the stream machine and the hub.** The deadline is the hub's. A count report
   after the hub's close is refused, and the record uses the last accepted counts. Test in task 2.
5. **A non-broadcast observer** (a public watch link) reads `GET /polls/open`. It gets the poll without
   `poll_token`. Test in task 2.

---

### Task 1: ADR and protocol shapes

**Files:**
- Create: `docs/decisions/NNN-twitch-polls.md` (NNN from `pnpm adr:next`; push the branch as a draft PR first, ADR 223)
- Modify: `docs/decisions/740-twitch-chat-who.md` (a dated Consequences note only; Decision stays frozen)
- Create: `packages/protocol/src/poll.wire.ts`, `packages/protocol/src/poll.ts`, `packages/protocol/src/poll.test.ts`
- Modify: `packages/protocol/src/envelope.ts` (the `meta.poll` rule beside `meta.question`, ~:290),
  `packages/protocol/src/authorityRelay.ts` (`poll.open` op in `AuthorityRelayRequestSchema` :67 and
  `AuthorityRelayResponseSchema` :133), `index.ts`, `wire.ts`, `SPEC.md` Appendix A, `docs/architecture/02-protocol.md`

**Interfaces:**
- Produces, in `poll.wire.ts` (plain TS, no zod, like `question.wire.ts`):
  - `POLL_LIMITS = { minOptions: 2, maxOptions: 4, minMinutes: 1, maxMinutes: 15, defaultMinutes: 5, offlineGraceMs: 90_000, voteGapMs: 2_000 }`
  - `type PollEnd = 'deadline' | 'ended' | 'cancelled' | 'interrupted'`
  - `interface PollSpec { question: string; options: string[]; minutes: number }`
  - `interface PollCounts { poll_id: string; counts: number[]; voters: number; live: boolean; post_failed: boolean }`
    (`post_failed` means musterdbot's last chat post was rejected; the only non-integer fields are these two booleans)
  - `interface PollRecord { id: string; question: string; options: string[]; counts: number[]; voters: number; end: PollEnd; winners: number[]; opened_by: string; opened_at: number; closed_at: number }`
    (`winners` is empty for no votes or cancelled, one index for a winner, several for a tie)
  - `winnersOf(counts: number[]): number[]`
- Produces, in `poll.ts` (zod): `PollSpecSchema`, `PollCountsSchema`, `PollRecordSchema`, `OpenPollSchema` (`PollSpec` plus `id, opened_at, closes_at, opened_by, counts, voters, post_failed, poll_token?`), `OpenPollReplySchema` (`{ live: boolean; poll: OpenPoll | null }`, the `GET /polls/open` body)

- [ ] **Step 1: Write the ADR.** Context: ADR 740's boundary. Decision:
  1. Chat-write on the same bot.
  2. The hub owns polls.
  3. `credential_mint` A2 to open, refusing `bearer_unenrolled`.
  4. The `mspoll_` credential is counts-only, for one poll, and expires at close.
  5. The boundary is per module.
  6. The restart double-count is accepted.
  7. Ask-the-team needs its own ADR.

  Then Consequences and Observability & Evaluation. Add the dated note in 740's Consequences.
- [ ] **Step 2: Write the failing tests** in `poll.test.ts`:
  - `PollSpecSchema` rejects 1 option, 5 options, 0 and 16 minutes, and an empty question. It accepts 2–4 options and 1–15 minutes, defaulting to 5.
  - `PollCountsSchema` rejects any non-integer, any negative, `counts.length` ≠ options, and an extra string field (`.strict()`).
  - `winnersOf([3,5,5])` → `[1,2]`, `winnersOf([0,0])` → `[]`, `winnersOf([1,4,2])` → `[1]`.
  - An envelope with `meta.poll` is accepted only on act `resolve` from the daemon. Mirror how `meta.question` is act-bound in `envelope.ts`.
  - `AuthorityRelayRequestSchema` parses `{ op: 'poll.open', spec, approval }`.
- [ ] **Step 3: Run** `pnpm --filter @musterd/protocol test -- poll`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** the shapes and schemas above, plus the `meta.poll` envelope rule and the relay op.
- [ ] **Step 5: Run** `pnpm --filter @musterd/protocol test`. Expected: PASS, coverage ≥95% lines.
- [ ] **Step 6: Commit** with `Refs ADR-NNN`, then open the PR (it was pushed as a draft in step 1).

### Task 2: Daemon

**Files:**
- Modify: `packages/server/src/db/ladder.ts`: append v141 (or next) `polls`:
  - `id`, `team_id`, `question`, `options_json`, `minutes`, `opened_by`, `opened_at`, `closes_at`
  - `counts_json`, `voters`, `token_sha256`
  - `last_live_at`, `offline_since`, `end` (null while open), `closed_at`
  - a unique partial index: one open poll per team
- Create: `packages/server/src/store/polls.ts`, `store/polls.test.ts`, `transport/polls-http.test.ts`
- Modify: `packages/server/src/transport/http.ts` (routes below), `packages/server/src/sync/authorityRelay.ts`
  (`poll.open` case; widen `requireRelayAuthority`'s act union to include `credential_mint`),
  `docs/architecture/01-data-model.md`, `03-server.md`

**Interfaces:**
- Consumes: task 1's schemas, `POLL_LIMITS` and `winnersOf`.
- Produces, in `store/polls.ts`:
  - `openPoll(db, teamId, by: string, spec: PollSpec, now: number): Promise<{ poll: OpenPoll; token: string }>`. Throws `poll_open` if one is open, and `not_live` if `lastLive(teamId)` is stale (> 90 s).
  - `reportCounts(db, teamId, pollId, token: string, c: PollCounts, now): Promise<'ok' | 'closed' | 'bad_token'>`
  - `closePoll(db, teamId, pollId, end: PollEnd, now): Promise<PollRecord>`
  - `sweepPolls(db, now): Promise<PollRecord[]>`: closes at `closes_at` (`deadline`) or after `offline_since` + 90 s (`interrupted`).
  - `openPollFor(db, teamId, viewer: { broadcast: boolean }, now): Promise<OpenPollReply>`. `live` is true while the last report said live within 90 s. `poll_token` is present only when `viewer.broadcast`.
- Routes, all under `/teams/:slug`:
  - `POST /polls`. Order: `authAdmin` → `authorityRelayIfJoiner(op 'poll.open')` → `guardAuthority(…, 'credential_mint', slug, { action: 'poll_open', spec })`, refusing `assurance === 'bearer_unenrolled'` with `forbidden "poll needs a passkey"` → `openPoll` → announce.
  - `POST /polls/:id/end` and `POST /polls/:id/cancel`. `authAdmin`, plus `holdAct`'s joiner forward pattern.
  - `GET /polls/open` → `OpenPollReply`. Any member that can read the team; `broadcast` is true only for an observer with `observer_scope: 'broadcast'`.
  - Before any poll exists, `live` comes from a counts-less liveness report: the stream machine posts `POST /stream/live { live: boolean }` every 30 s on its observer seat (leaseless, like `/stream/winddown`), so `/live` can enable Start.
  - `POST /polls/:id/counts`. Bearer `mspoll_…` only (not a member credential), `PollCountsSchema.strict()`, leaseless, like `/stream/winddown` :9293.
- On close, post one daemon-composed `resolve` with `meta.poll: PollRecord` (`routeEnvelope(…, daemonComposed=true)`, modelled on `announceHold` :1981).

- [ ] **Step 1: Write the failing store tests:**
  - opens one poll and refuses a second
  - refuses when not live
  - the token works once per poll and not for another poll id
  - counts after close → `closed`
  - the deadline closes with `deadline`
  - 90 s offline → `interrupted`
  - a tie → two winners
  - cancel → `winners: []`
- [ ] **Step 2: Write the failing route tests** in `polls-http.test.ts`:
  - an agent → 403
  - a non-admin human → 403
  - an admin with no enrolled key → 403 "poll needs a passkey"
  - an admin with proof → 201
  - a public observer's `GET /polls/open` has no `poll_token`, and the broadcast observer's does (Review Focus 5)
  - `counts` with a string field → 400
  - `counts` after the hub's deadline → 409 (Review Focus 4)
  - a joiner's `POST /polls` relays to the hub
- [ ] **Step 3: Run** `pnpm --filter @musterd/server test -- polls`. Expected: FAIL.
- [ ] **Step 4: Implement** the migration, store, routes, relay case, and a sweep tick in the daemon's existing interval (where holds and shifts are swept). The `last_live_at` / `offline_since` values come in with each counts report's `live`.
- [ ] **Step 5: Run** `pnpm --filter @musterd/server test`. Expected: PASS, ≥85%.
- [ ] **Step 6: Commit and PR.** This lane's risk tag routes it to a security review.

### Task 3: Stream machine

**Files:**
- Create: `packages/cli/src/broadcast/twitchPoll.ts`, `twitchPoll.test.ts`
- Modify: `packages/cli/src/broadcast/twitchChat.ts` (route `notification`s that `parseVote` accepts to the poll handler; `!who` unchanged), `packages/cli/src/commands/broadcast.ts` (~:2381: fetch `GET /polls/open` with `seat.token` every 5 s; on a new poll, start the poll handler with `{ poll, pollToken }`; stop it on close), `docs/wiki/broadcast-stream.md`, `docs/guides/hosted-broadcast.md`

**Interfaces:**
- Consumes: `OpenPoll`, `PollCounts`, `POLL_LIMITS`, `winnersOf`; `POST /polls/:id/counts`.
- Produces (and `musterd broadcast` posts `POST /stream/live` every 30 s from its own `live()` check, on the seat token, outside the chat module):
  - `parseVote(text: string, options: number): number | null`, a zero-based index
  - `makeTally(now?): { vote(userId: string, index: number): boolean; counts(): number[]; voters(): number; seed(counts: number[], voters: number): void }`
  - `pollLines(poll: OpenPoll, asker: string): string[]`, each line ≤ 500 characters
  - `resultLine(r: PollRecord): string`
  - `startPollHandler(deps: { poll: OpenPoll; pollToken: string; post(line: string): Promise<boolean>; live(): Promise<boolean>; report(c: PollCounts): Promise<'ok'|'closed'|'bad_token'>; log(line: string): void; now?: () => number }): { onChat(userId: string, text: string): void; close(r: PollRecord): Promise<void>; stop(): void }`

  `post` is Helix `POST /chat/messages` as the bot. `live` is Helix `GET /streams?user_id=<broadcaster>`.

Fixed copy (the spec's, verbatim):
- open: `👋 I'm musterd's Twitch bot. {asker} wants to ask you: {question}`, then `{n} · {option}` lines, then `Vote by typing !vote 1, !vote 2 … — {minutes} minutes.`
- close: `🗳️ Poll closed — {voters} votes. Winner: {n} · {option} ({pct}%). Thanks for voting!`
- also fixed sentences for tie, no votes, cancelled and interrupted.

- [ ] **Step 1: Write the failing tests:**
  - `parseVote('!VOTE 2', 3)` → 1; `parseVote('2', 3)` → null; `parseVote('!vote 4', 3)` → null
  - `makeTally`: a changed vote moves the count; a second vote inside 2 s is dropped; `seed([4,1],5)` then a new voter → `[5,1]` (Review Focus 1)
  - `pollLines` with a 480-character question splits, and each line is ≤ 500
  - `close` during a pending split post posts the result line exactly once, after the poll's lines (Review Focus 2)
  - `post` returning false keeps counting and logs once, no retry loop (Review Focus 3)
  - the handler is never passed and never reads `seat.token`: type-level, the deps object has no such key
- [ ] **Step 2: Run** `pnpm --filter @musterd/cli test -- twitchPoll`. Expected: FAIL.
- [ ] **Step 3: Implement.** Report counts every 5 s and once on close. `live` runs every 30 s, and its result rides each report.
- [ ] **Step 4: Run** `pnpm --filter @musterd/cli test -- twitchPoll twitchChat broadcast`. Expected: PASS.
- [ ] **Step 5: Commit and PR.**

### Task 4: /broadcast tally card (miley)

**Files:** Create `packages/web/src/live/PollCard.tsx`, `PollCard.css`, `PollCard.render.test.ts`,
`usePoll.ts` (poll `GET /polls/open` every 2 s, as `useWindDown` does); modify `packages/web/src/routes/broadcast.tsx` (mount inside `.bc__stage` beside `WindDownCard`); `docs/perf/budgets.json` (if a raise is needed: lazy chunk, logged, ADR 183)

**Interfaces:** Consumes `OpenPoll` and the last `PollRecord` (from the record act in `envelopes`). Produces `PollCard({ poll, record, now })`.

- [ ] **Step 1: Write the failing render test:**
  - renders the question, one bar per option with its percentage, `{m}:{ss} left`, `{n} votes · type !vote in chat`
  - the top option carries `is-lead`
  - for a record, the winner line, then nothing after 15 s
  - a tie names both options
  - it never renders a voter
- [ ] **Step 2: Implement.**
  - Warm stage style, from Broadcast.css tokens.
  - The lead bar is the mustard fill.
  - Bars ease by `--lc-dur-3`; reduced motion swaps instead.
  - A text equivalent via `aria-live="polite"`.
  - Lazy chunk.
- [ ] **Step 3: Verify** at 1920×1080 on `/broadcast` with a fixture poll (capture rule in the designer skill), then `pnpm build && pnpm perf:check`.
- [ ] **Step 4: Commit and PR.**

### Task 5: /live — start, end, cancel; the record line

**Files:** Create `packages/web/src/live/settings/PollPanel.tsx`, `PollPanel.test.ts`; modify `settings/SettingsOverlay.tsx` (inside the admin `team` tab), `authorityProof.ts` (`authorityProofForPoll(cfg, spec)`, beside `authorityProofForPolicy` :81), `client.ts` (`openPoll(cfg, spec, proof)`, `endPoll(cfg, id)`, `cancelPoll(cfg, id)`), and the stream's act line for a `meta.poll` resolve (`Poll closed: {question} → {winner}`)

- [ ] **Step 1: Write the failing tests:**
  - the panel shows Start disabled with "Polls open while you're live on Twitch" when the stream is down
  - it validates 2–4 options and 1–15 minutes
  - after open it shows the poll with End and Cancel
  - a daemon refusal "poll needs a passkey" reads "Add a passkey in Settings → You to start polls"
  - "musterdbot couldn't post" is shown when the open poll carries `post_failed` (Review Focus 3)
- [ ] **Step 2: Implement.** The proof comes from `authorityProofForPoll` and is sent as `approval` in the body. Live state and `post_failed` come from `GET /polls/open` (`OpenPollReply`, task 2).
- [ ] **Step 3: Run** `npx vitest run packages/web/src/live/settings/PollPanel.test.ts` (PASS), then the fast gates.
- [ ] **Step 4: Commit and PR.**

### Task 6: CLI `musterd poll`

**Files:** Create `packages/cli/src/commands/poll.ts`, `poll.test.ts`; modify `client.ts` (`openPoll`, `endPoll`, `cancelPoll`, `getOpenPoll`), `commandTable.ts`, `help/catalog.ts` (team group), `docs/architecture/04-cli.md`

**Interfaces:**
- Commands:
  - `musterd poll start "<question>" --option <text> (×2–4) [--minutes N]`
  - `musterd poll end`
  - `musterd poll cancel`
  - `musterd poll status`
- `POLL_FLAGS = ['option', 'minutes']`.
- The template is `hold.ts`: `resolve(parsed.flags)` → `http.openPoll`. On `authority refused (no_signature)`, `collectApproval(http, team, 'credential_mint', slug, { action: 'poll_open', spec })`, then resend (`setPolicySigned` :185's pattern).

- [ ] **Step 1: Write the failing tests:**
  - flags are rejected outside `POLL_FLAGS`
  - 1 `--option` → exit 2 with "a poll needs 2–4 options"
  - unsigned-first, then an approval URL is printed and the request resent
  - `status` prints the question, each option's count and time left
- [ ] **Step 2: Implement**, then run `pnpm --filter @musterd/cli test -- poll` and `pnpm cli-flags:check` (PASS).
- [ ] **Step 3: Commit and PR.**

### Task 7: Phone — start a poll with Face ID

**Files:** Modify `packages/protocol/src/appChannel.ts` (a `poll_open` kind in `AppCallbackSchema` :99, with `appPollOpenSigningBytes({ team, binding, spec, nonce, ts })`); create `packages/server/src/notify/appPoll.ts` and `appPoll.test.ts` (verify like `verifyAppQuickAction` in `appQuickAction.ts` :51, then call `openPoll` as the pairing's human, still refusing a non-admin); create `packages/mobile/src/app/poll.tsx` and `src/native/poll.ts`; modify `src/app/_layout.tsx` and `docs/architecture/09-mobile.md`

The ADR (task 1) must name this callback as the phone's A2 path for `credential_mint`: the Secure Enclave key behind Face ID (`PhoneKeys.sign`, `biometryCurrentSet`).

- [ ] **Step 1: Write the failing tests:**
  - server: a bad signature is refused; a non-admin pairing is refused; a valid one opens the poll
  - protocol: the signing bytes are stable
- [ ] **Step 2: Implement.** The screen follows the phone polish rules (compact cards, no headline), with Start behind Face ID, and End and Cancel.
- [ ] **Step 3: Run** the tests, the per-package tsc, then `npx vitest run packages/mobile`. Ship through an `ios-testflight` build on nick's accept.
- [ ] **Step 4: Commit and PR.**

### Task 8: Go live (human-gated)

- [ ] **Step 1:** Ask nick (`team_send` ask, blocking) to re-authorize musterdbot with `user:read:chat user:write:chat user:bot` and set the new `MUSTERD_TWITCH_CHAT_REFRESH_TOKEN` on the stream machine (ADR 740 Consequences).
- [ ] **Step 2:** On a real stream, run the spec's Verification list, with nick starting the poll.
- [ ] **Step 3:** Record what was seen (timings, any rejected post, the restart case) in `docs/wiki/broadcast-stream.md`, dated and falsifiable (`pnpm wiki:check`).
