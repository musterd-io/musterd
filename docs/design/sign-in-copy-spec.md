# Unified sign-in — UI-copy spec for every surface past the console page

- Status: spec (comms, sloane), 2026-11-06. Strings are exact: build them character for character
  or bounce them back here.
- Lane: `01M6S3BYBYBNGAX4KRH312P8CE`, goal `unified-sign-in`. Asked by miley for nick
  (request_help `01M6S29MVXV3FD1YQM054A6FCH`).
- Derives from: the design spec
  [`2026-11-06-unified-sign-in-design.md`](../superpowers/specs/2026-11-06-unified-sign-in-design.md)
  (approved by nick, merged in #3998), [ADR 620](../decisions/620-console-sign-in.md),
  [ADR 722](../decisions/722-hosted-live-browser-session.md), `docs/design/brand.md` §2, §4, §5.
- Builders: lanes `01M6S2TXHV` (1b, `/live`), `01M6S2VCHM` (3, `musterd login`), `01M6S2VPWR` (4, MCP
  authorize), `01M6S2VYE4` (5, team create), `01M6S2W39F` (6, where you're signed in), `01M6S2W720`
  (7, API keys), `01M6S2WB7D` (8, linking), `01M6S2WNHY` (9, a computer joins), `01M6S2WTKE` (10,
  phone).

The console's own sign-in page is [`console-signin-copy-spec.md`](./console-signin-copy-spec.md) and
stays there. This file covers every other place a person signs in, links, joins or ends a sign-in.

## 0. Where this spec overrides the design spec's words

The design spec named some things in builder's words. On every surface a person reads, these win:

| Design spec says | Copy says | Why |
| --- | --- | --- |
| End / End all (§7) | **Sign out** / **Sign out everywhere on {team}** for sessions; **Revoke** for an API key; **Remove from {team}** for a computer | People recognise "Sign out". "End all" never said it covers one team only. |
| *admin* key scope (§8) | **Owner** | brand.md §5: Owner is the human-facing word for a member holding `is_admin`. |
| a linked hub (§2, §11.3) | a **linked team**; "link this team to your musterd account" | brand.md §5 keeps the hub out of copy. A person knows their team. |
| a machine (§6) | a **computer** | What the person calls it. A Fly machine is "a computer in musterd Cloud". |
| "no secret is ever shown" (*What success is*) | true for signing in; an **API key** is shown once, by design | §7 below says so to the person, plainly. |

## 1. Rules for every string

- Everything in [`console-signin-copy-spec.md`](./console-signin-copy-spec.md) §1 holds here too.
- **The button is `Sign in with musterd`** on every surface that sends you to the console: `/live`,
  the MCP authorize page, the phone app, the CLI's browser prompt. Same words, same case.
- **The account has no display name** (`packages/console/src/schema.ts`, and the console spec forbids
  inventing one). A string that names who you are names the **member on the team**: `nick on
  revive`. Where no team is in play, it names the **sign-in method**: `your musterd account (GitHub)`.
- **No plumbing in copy:** never hub, daemon, node, JWKS, proof, token, or a credential prefix
  (`mscr_`, `msat_`, `msnode_`, `msinv_`). The CLI's `--verbose` and logs may name them.
- **Binding is permanent** (ADR 698 §3, write-once). Any string that binds a member to an account
  says so before the click, once.
- Terminal: success `✓` green, failure `✗` red, hints dim (brand.md §2). Under `NO_COLOR` or a pipe,
  the glyphs and words stay and the colour goes. No string relies on colour.

## 2. The first time something needs an account

Free local musterd needs no account (design §2). The prompt appears once, at the moment the person
reaches for something that does. Each prompt has the same three parts: what you reached for, what
signing in does, and what stays as it is.

| Trigger | Line 1 | Line 2 |
| --- | --- | --- |
| A team on musterd Cloud | `Teams on musterd Cloud need a musterd account.` | `Sign in once, and every device you use knows you.` |
| An agent in musterd Cloud | `Agents in musterd Cloud run on your musterd account.` | `Sign in once to start one. Your local team keeps working without an account.` |
| A paid feature on a local team | `{Feature} is on a paid plan, so it needs a musterd account.` | `Everything else on this team keeps working without one.` |

**CLI** (the command the person ran pauses on this):

```
Agents in musterd Cloud run on your musterd account.
Sign in once to start one. Your local team keeps working without an account.

Enter opens your browser · Esc skips
```

`Esc` prints dim `skipped — nothing changed` and exits **0**. Not a TTY: print lines 1–2, then dim
`sign in with: musterd login`, and exit **1**.

**`/live`**: a dialog. Heading is line 1, body is line 2, buttons `Sign in with musterd` and `Not now`.
`Not now` closes the dialog and changes nothing.

A teammate or a second computer on another network never triggers this prompt. Invites keep working
across networks with no account (nick, 2026-11-06, answering design open question 1, question
`01M6S3SEV9`).

## 3. `musterd login` (lane 3)

| State | Exact string | Notes |
| --- | --- | --- |
| help, one line | `Sign in to your musterd account on this computer. musterd Cloud needs it; your local teams don't.` | |
| opening the browser | `Opening your browser to sign in…` | Then waits. |
| browser can't open | `Open this link to sign in:` then the URL on its own line | Loopback PKCE URL. Not a secret. |
| device code | `On any device, open {verification_uri} and enter {user_code}.` | RFC 8628. `{user_code}` in bold. |
| waiting | dim `waiting for you to finish in the browser — Ctrl-C cancels` | |
| success | `✓ signed in to your musterd account ({method})` | `{method}` is GitHub, Google, Email or Passkey. |
| success, member linked | `✓ signed in — nick on revive is linked to your musterd account` | Link mode, §3.1. |
| already signed in | `already signed in to your musterd account ({method}) — musterd logout to switch` | dim, exit **0**. |
| cancelled | `✗ sign-in cancelled — nothing changed` | Ctrl-C, or the person declined in the browser. |
| expired | `✗ the sign-in took too long — run musterd login again` | Device code or loopback timed out. |
| console unreachable | `✗ couldn't reach musterd.io — check your connection and run musterd login again` | Local teams keep working; the line says nothing else. |
| logout | `✓ signed out of your musterd account on this computer` | |

### 3.1 Link mode, from a credential this computer already holds (design §11.2)

Before the browser opens:

```
This computer already signs in to revive as nick.
Signing in links nick to your musterd account. A member links to one account, for good.

Enter opens your browser · Esc skips
```

## 4. `/live` (lane 1b) and the MCP authorize page (lane 4)

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| `/live` | signed out | `Sign in with musterd` | The primary button. |
| `/live` | signed in, header | `{member} on {team}` | e.g. `nick on revive`. |
| `/live` | signed in, menu | `Sign out` | Ends this browser's sign-in only. |
| `/live` | session ended elsewhere | `You were signed out. Sign in again to keep going.` | On the 4401 return to signed-out. |
| `/live` | browser holds an unlinked member credential | `Link my musterd account` | Button, settings. |
| `/live` | link confirm | `This links {member} on {team} to your musterd account. A member links to one account, for good.` | Buttons `Link account` · `Cancel`. |
| `/live` | linked | `{member} is linked to your musterd account.` | |
| MCP authorize | default | `Sign in with musterd` | First, and the primary. |
| MCP authorize | guest path | `Have an invite code?` | Opens the code field. The field label is `Invite code`. |
| MCP authorize | heading | `Connect {client} to {team}` | `{client}` from the registration, e.g. Claude. |

The credential paste field on `/live` and the MCP page go (design §5); no string replaces them.

## 5. Creating a team on the console (lane 5)

Replaces the console spec §8 "created" table. The two secrets are no longer shown.

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | created | `Team created` | |
| Lede | created | `{slug} is yours. You are its first owner, as {name}.` | Unchanged. |
| Button | created | `Open {slug}` | Goes to `{host}/live`, already signed in. |
| Note | created | `Your agents join from your computer: run musterd login, then musterd join {slug}.` | |
| Link | created | `Back to your account` | Unchanged. |

## 6. Where you're signed in (lane 6)

On the console (every team, for the account) and on `/live` settings (this team, for the member).

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | default | `Where you're signed in` | |
| Lede, `/live` | default | `Every device and app signed in to {team} as {member}.` | |
| Lede, console | default | `Every device and app signed in with your musterd account, on every team.` | Rows add a `Team` column. |
| Columns | default | `Device` · `How` · `Last used` | Console adds `Team` second. |
| `How` | values | `Browser` · `Phone` · `Terminal` · `{client}` · `API key` · `Computer` | `{client}` is the MCP client's registered name: Claude, ChatGPT, Codex. |
| `Device` | this one | `This browser` / `This phone` | On the current row, in the device name's place. |
| `Last used` | values | `Active now` · the `/live` relative time | |
| Row action | Browser, Phone, Terminal, MCP client | `Sign out` | |
| Row action | API key | `Revoke` | Links to §7's row. |
| Row action | Computer | `Remove from {team}` | Confirm: `Agents on {device} stop until another computer runs them.` Buttons `Remove` · `Cancel`. |
| Bulk | default | `Sign out everywhere on {team}` | Confirm: `This signs out every device and app on {team}, this one too.` Buttons `Sign out everywhere` · `Cancel`. |
| Empty | only this device | `Only this browser is signed in.` | Phone: `Only this phone is signed in.` |
| Done | after a row action | `{device} is signed out.` / `{device} is removed from {team}.` | Polite live region. |

## 7. API keys (lane 7)

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | default | `API keys` | |
| Lede | default | `A key lets a script or a CI job act on {team}. You see it once, when you create it.` | |
| Button | default | `Create key` | |
| Field label | name | `Name` | Hint: `What it's for, like "deploy job"`. |
| Field label | access | `Access` | Radio, in this order. |
| Option | read | `Read only — see the board, inboxes and record` | Default. |
| Option | act as me | `Act as you — send, claim and accept as {member}` | |
| Option | owner | `Owner — change members and team settings` | Only offered to an owner. Held on design question 6 (big-body). |
| Field label | expiry | `Expires` | Default `In 90 days`; also `In 30 days`, `In 1 year`. |
| Hint | bot | `For a bot, create the key on the bot's seat, so the record shows the bot did it.` | Under the form. |
| Notice | created | `Copy this key now. You won't see it again.` | The key in a selectable field with `Copy`. Leaving the page drops it. |
| List columns | default | `Name` · `Access` · `Last used` · `Expires` | |
| Row action | default | `Revoke` | Confirm: `Scripts using {name} stop working now.` Buttons `Revoke` · `Cancel`. |
| Empty | none | `No API keys. Create one when a script needs to act on {team}.` | |
| Expired row | expired | `Expired {date}` | In `Expires`; the row stays until revoked. |

## 8. Linking a local team (lane 8)

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Prompt line 1 | before linking | `Linking lets you sign in to {team} with your musterd account, from anywhere.` | One team on this computer. |
| Prompt line 1 | several teams | `Linking lets you sign in to {team} and {n} other teams on this computer with your musterd account.` | One link covers every team the computer serves. |
| Prompt line 2 | before linking | **Held**: `A linked team checks with musterd.io every few minutes for sign-in keys. It sends {…}.` | Waits on what the pull sends (design §11.3). `PRIVACY.md` line 3 changes in the same PR. |
| Button / CLI | before linking | `Link {team}` | |
| Success | linked | `✓ {team} is linked to your musterd account` | |
| Offline | console unreachable | `{team} keeps working. New sign-ins with your musterd account wait until musterd.io is reachable.` | Shown on `/live` while it lasts. |

## 9. A computer joins a team (lane 9)

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| `musterd join` | success | `✓ this computer joined {team}` | Then dim: `start a seat with: musterd` |
| `musterd join` | needs an owner | `An owner of {team} approves this on /live. You'll see it here when they do.` | Waits. Ctrl-C leaves the request open. |
| `/live` | owner's card | `{member} wants to add {device} to {team}, to run {seats}.` | Buttons `Approve` · `Decline`. |
| `musterd join` | declined | `✗ {owner} declined adding this computer to {team}` | |
| `musterd join` | seat on another computer | `✗ {seat} already runs on {device}. Remove that computer from {team} on /live first.` | ADR 662. |
| `musterd join` | not signed in | `✗ sign in first: musterd login` | |

## 10. The phone app (lane 10)

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Button | signed out | `Sign in with musterd` | Opens the system browser sheet. |
| Heading | choose team | `Choose a team` | |
| Row | team | `{team}` and below it `as {member}` | |
| Empty | no teams | `Your musterd account isn't on a team yet. Ask a team's owner for an invite.` | |
| Notice | team on another network | `{team} isn't reachable from here. Open the app on the same network as {team}.` | Design §11.3: unreachable linked teams. |

## 11. Free local, account, paid (the site and the CLI)

The structure is set by [ADR 461](../decisions/461-pricing-and-business-model.md), accepted 2026-11-06.
No price, trial length or limit appears anywhere until that ADR sets it.

| Surface | Exact string |
| --- | --- |
| Line 1 | `musterd runs free on your own computers, with no account.` |
| Line 2 | `Sign in with a musterd account when you want a team on musterd Cloud, agents in musterd Cloud, or org features like SSO and signed audit export.` |
| Line 3 | `Paid plans: not yet.` Prices and the Cloud allowance come from design partners (ADR 461 §2, §5), and this line changes when they do. |

## 12. Held strings and who answers

| Held | Waits on |
| --- | --- |
| §7, the Owner key scope | big-body, design question 6 |
| §8 line 2, what a linked team sends | miley / big-body, design §11.3 |
| §11 line 3, prices and the Cloud allowance | design partners, ADR 461 §5 |
