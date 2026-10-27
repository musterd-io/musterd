# 723 — Allowance readings on the member card

- Status: accepted
- Date: 2026-10-23

## Context

`@musterd/allowance` is a loopback page (`what's left`, `127.0.0.1:4877`) that reads provider windows on the machine where the sign-in lives. `/live` is a different process. A page on `/live` cannot read that port, and a token must not cross to the daemon, the roster, the HTML, or a log.

Nick asked for the percents on `/live`, compact, on 2026-10-23. Slippy drew the line: 28px, the tightest window as words plus a 2px bar of what is left, warn ink under 15% left, other windows of that account muted on the same line, quiet type when the read is older than two minutes, no new color and no motion. Dollars and character counts stay in the title. The line is absent on `/broadcast`, when the column is collapsed, and when there is no snapshot.

A team has more than one human, on one machine or several, and a human can hold more than one subscription for the same provider. One column-wide row cannot say whose account the percent is. The line sits on the member card, under the name, and a second subscription is a second line.

## Problem

The roster has no place to say which subscription a seat is signed into, and the allowance page has no path that posts percents without the token.

## Decision

Readings are keyed by provider and a one-way account key: `sha256(provider + NUL + material)` truncated to 16 hex characters. The same key from two machines is one reading. The newest `readAt` wins for the label and the windows. An older post does not replace those windows. It still records the holder and, on this machine, the node.

The material is a public id when the provider's file has one (`accountUuid`, `accountId`, or `organizationUuid` on Claude; `email`, `cachedEmail`, `userId`, or `authId` on Cursor; Codex `tokens.account_id`). The id matches `^[A-Za-z0-9._:@-]{8,80}$`, is not a `sk-` or `sk_` token, and is not a three-part JWT. Claude with no public id hashes `refresh:` plus the refresh token. Two machines collapse only when they hold that same refresh token. The access token is not hashed: it rotates and would split one account. Cursor with no public id, and Claude with only an environment access token and no credentials body, use a machine key `machine:<os user>@<hostname>:<provider>`, so two OS users on one host stay apart and two machines stay apart. ElevenLabs has no public id in the subscription body. The join key is a hash of `key:` plus the API key, so one subscription collapses across machines. The raw key does not leave the process. _(Amended 2026-10-26: Muse hashes `id:` plus the auth file's email when that email is a public id, else the machine key. The access token is not hashed. See the amendment below.)_

`POST /teams/:slug/allowance` accepts `{ accounts: [...] }`. Each account is the provider, the 16-hex key, a label, `readAt`, and one to eight windows (`name`, `left` from 0 to 1, `resetsAt`, `kind` of `percent` or `amount`). An amount window also carries `used`, `limit`, and `unit`. The body is strict: a token field is a 400. A bearer selects the holder (`mscr_` is the human; an agent key still needs its session lease). A local post with no bearer is accepted with no holder and records node `''` (this daemon). Any other post with no bearer is 401. The store is in memory, per team, lost on restart, and not replicated. A post updates the accounts it includes and leaves a provider that failed this read on its last good windows.

A holder who posts a different account of the same provider is removed from the previous key. When that key has no holders left, node `''` is removed too, and a key with no holders and no nodes is dropped. An anonymous local post removes node `''` only from other same-provider keys that also have no holder. Two holders on this machine can both carry node `''`.

The roster field `allowance` is `{ readAt, accounts: [{ provider, label, readAt, windows }] }`. The account key is not on it. It is omitted when the member has no accounts, and omitted for a broadcast reader. A public reader still receives it, so an unsigned local `/live` can show the line. A human sees every reading that names them, including while offline, and an unauthenticated reading on a node where they are the only human present. Two humans on that node see neither that unauthenticated reading. An agent sees Claude or OpenAI only, _(Amended 2026-10-26: or Muse, when the live presence's model is Muse. See the amendment below.)_ and only when the live presence's model is that provider and exactly one reading matches the presence node or the presence driver. Two Claude accounts on one node are not guessed; the driver's own account is used when exactly one of the matches names that driver. Cursor and ElevenLabs stay on humans. A service seat has no line. A `readAt` older than two minutes stays on the roster; the card quiets the type.

The line is on the member card, under the name, 28px, one per account. The words are the tightest window of that account (least left, soonest reset on a tie): "Claude Max 38% left" for a percent window, the label alone for an amount window. The bar is the share that is left. Other windows of that account are muted suffixes. The title holds one sentence per window. No new color and no motion. A failed read leaves the line out. _(Amended 2026-10-27: on `/live` the line left the card for one chip per human in the top bar, and agents are not painted. See [ADR 744](744-allowance-in-the-live-header.md).)_

`@musterd/allowance` does not import `@musterd/protocol`. It posts plain JSON. It discovers the team from `MUSTERD_TEAM`, else `workspace.json` (`team` and `server` only), else the single team in `~/.musterd/config.json` `bindings`. Several teams and no workspace file means no post. `MUSTERD_SERVER`, or the workspace server, or `http://127.0.0.1:4849`, is the target. A server that is not loopback is posted only when `MUSTERD_CREDENTIAL` is set. The package version in this change is 0.1.2. Publishing it is a separate cut.

## Consequences

The daemon that received the post is the one whose `/live` shows the line. Two machines show one percent when both allowance processes post to that daemon. A restart drops the readings until the next page load. The shared daemon serves this route after the change is on `main` and that daemon's own refresh restarts it.

Amended 2026-10-26, [ADR 739](739-muse-allowance-window.md). An agent whose live model matches Muse as a word sees a Muse reading on the same rule Claude uses: the presence node or the presence driver matches exactly one reading. `musterd` does not match. Cursor and ElevenLabs stay on humans. The Muse account key is `id:` plus the auth file's email when that email is a public id, else the machine key. The access token is not hashed. A daemon that does not know provider `muse` rejects the whole post, including the other accounts in that body, until it is running this enum.

Noted 2026-10-27, [ADR 744](744-allowance-in-the-live-header.md). `/live` no longer paints this line on the member card, and paints no agent's reading. Each human's accounts are one chip in the top bar, with a card listing every account. The roster field and attribution above are unchanged.

## Observability & Evaluation

Traces: none emitted. The reading is not an Act and it is not an audit row. It lives in daemon memory and leaves on the roster as `allowance` for a team or public reader. A broadcast reader omits the field.

Eval: the dataset is the attribution cases in `allowanceReadings.test.ts` (the same account key collapses, two accounts do not, a broadcast reader omits the field). The baseline is that before this change the roster has no `allowance` field. ADR 739 adds the Muse cases to that file: a `muse-wonder` presence sees the Muse reading, and a model named `musterd` does not.

Experiment: none. A person with two Claude subscriptions sees two lines; that is checked by eye on `/live` after a post.
