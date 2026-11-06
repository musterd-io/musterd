# Console sign-in — UI-copy spec for app.musterd.io

- Status: spec (comms, alfie), 2026-10-15. Slippy owns the layout.
  Fifty builds it on lane `01M3Z43QYB`. These strings are the copy, character for character.
  Confirmed 2026-10-17: the session marker in §6, and the heading and body in §7
  (lane `01M55YZ4VF1SK65P240SKRFT5X`).
- Lane: `01M51E51TZCAHQ0SWRF20BBYQD`. Asked by fifty, for nick, in place of sloane.
- Derives from: [ADR 620](../decisions/620-console-sign-in.md), [ADR 615](../decisions/615-console-skeleton.md),
  Cloud spec §4.1–§4.4, `docs/architecture/10-console.md`, `docs/design/brand.md` §4–§5.
  The 15-minute link life is ADR 620 decision 6 ("about 15 minutes"). The string says 15.
  If the built lifetime changes, change the string in the same commit.

The page proves who you are. It is your musterd account at `app.musterd.io`.
Membership, roles and seats stay on each team server (spec §4.2). The word
**account** is the glossary word. Visible copy says "you" and "account".

CLI sign-in (`musterd login`, spec §4.1) is a different surface. This file is the
web screens only.

## 1. Rules for every string

- Plain, second person, present tense. Sentence-case headings. `musterd` is lowercase.
- One idea per sentence. No hype words from brand.md §4.
- A button names the outcome. "Sign in", "Sign out", "Email me a link", "Back to sign-in".
- An error says what happened, then what to do. The cause is written in words. Colour may repeat it.
- The check-your-email page is the same for a new address and an address that already
  has an account (ADR 620 decision 6). Send the link for every well-formed address.
  The first successful redemption creates the account (ADR 620 decision 6).
- A GET on the link never signs anyone in and never uses the token up (decision 6).
  The confirmation button is a POST from the browser that asked.
- Sign out is a POST. It revokes the sign-in and clears the cookie (decision 7).
- Redemption pages carry no third-party content, `no-referrer` and `no-store` (decision 6).
- The account table has no display name (`packages/console/src/schema.ts`). Do not invent one.
  The account id stays off the page.
- Adding or removing a sign-in method is ADR 620 decision 4. This spec has no strings for it.
- A click from another browser uses the wrong-browser strings. This spec has no transfer flow.

## 2. Sign-in

`<title>` Sign in — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | default | Sign in | |
| Lede | default | Sign in to your musterd account. | The one line on what this is. |
| Button | GitHub | Continue with GitHub | Starts the GitHub transaction. Reading order: this, then Google, then email. |
| Button | Google | Continue with Google | Starts the Google transaction. |
| Field label | email | Email | The visible label is Email. A placeholder `you@example.com` may sit inside the field. |
| Button | email | Email me a link | Submits the address. The field is visible with the two provider buttons. |
| Privacy | default | musterd discards your GitHub or Google token after you sign in. A team never receives it. | ADR 620 decision 3. Under the three ways. |
| Banner | expired sign-in | Your sign-in expired. Sign in again. | Idle 14 days or absolute 30 days (decision 7). One string for both. Omit on a fresh visit. |

Empty address: `Enter an email address.`
A value that is not an address: `Enter a full email address.`
Put the error in text next to the field and move focus to it.

## 3. Check your email

`<title>` Check your email — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | sent | Check your email | |
| Body | sent | We sent a sign-in link to {address}. It works for 15 minutes, and only in this browser. | `{address}` is the address they typed, unchanged. |
| Link | sent | Use a different address | Returns to sign-in. Does not send a second link. |

This page is also the response when the send is refused for any reason other than
the rate limit in §7. The rate limit has its own string.

## 4. The email

From-name: `musterd`. The mailbox is the verified `musterd.io` sender from the ops
step. This spec does not pick the local part.

The email is text only, with no click tracking (ADR 620 decision 2). One link. The href is built from
the pinned issuer, never from the request Host (decision 6). The plain-text part
repeats the same sentences and puts the URL on its own line.

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Subject | sent | Sign in to musterd | |
| Preheader | sent | It works for 15 minutes, in the browser where you asked. | |
| Body | sent | Sign in to your musterd account. | |
| Body | sent | This link works for 15 minutes, and only in the browser where you asked for it. | |
| Link | sent | Sign in | The only link. |
| Footer | sent | Didn't ask for this? Ignore this email. | |

## 5. The link opens

Same browser, token still good. `<title>` Finish signing in — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | ready | Finish signing in | |
| Body | ready | This signs you in to your musterd account in this browser. | |
| Button | ready | Sign in | POST. Consumes the token and issues a new sign-in. |
| Button | ready | Cancel | Returns to sign-in. Does not consume the token. |

Another browser, or a browser that did not ask. `<title>` Open this in the browser where you started — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | wrong browser | Open this in the browser where you started | Decision 6's phrase, used as the heading. |
| Body | wrong browser | This link signs you in only in that browser. Go back to it and open the link from there. | No sign-in button. The GET has not used the token. |

## 6. Signed in

`<title>` Your account — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | signed in | Your account | |
| Lede | signed in | You are signed in. | |
| Label | methods | Sign-in methods | |
| Row | GitHub identity | GitHub | One row per identity on the account. Show the provider name alone. Leave off any login name, and leave off any email GitHub or Google returned. |
| Row | Google identity | Google | |
| Row | email identity | Email · {address} | `{address}` is that identity's address. |
| Marker | current session | Signed in with this | On the one row for the method and identity this session used. The words carry the meaning. A mark may sit beside them. The row has no date. |
| Button | signed in | Sign out | POST. Then the sign-in page, with no banner. |

## 7. Errors

Each error page has one heading, one body, and the button `Back to sign-in`.
The heading is the first sentence and ends on the last word, the same way
Sign in and Check your email do. The body is the rest of that row.
`<title>` is the heading plus ` — musterd`.

| State | Heading | Body | Notes |
| --- | --- | --- | --- |
| Link expired or already used | This link is no longer valid | It works once, for 15 minutes. Ask for a new one. | One page covers both causes, so the page does not say which. |
| GitHub refused | GitHub didn't complete sign-in | You can try again. | The provider's own error text stays off the page. |
| Google refused | Google didn't complete sign-in | You can try again. | Same. |
| Account disabled | This account is disabled | You can't sign in with it. | Shown only after a redemption or a provider callback resolved to a disabled account. The check-your-email page stays the sent strings. ADR 620 names no support address, so the page shows none. |
| Too many attempts | Too many attempts | Try again in a little while. | A pause on this request (decision 9). ADR 620 names no window, so the string names none. The account is unchanged. Do not say locked or disabled. |
| Hand-back link not valid | This sign-in link isn't valid | Go back to your team and choose Sign in with musterd again. | `/handback` with a query this console did not build for a team it serves (ADR 722 §1). Nothing was signed. |
| Unknown failure | Something went wrong | Quote this if you ask for help: {request_id} | `{request_id}` is the server-generated id (decision 10), as selectable text. This is the unknown-cause state. A known cause uses its own row. |

## 8. Create a team

On the signed-in page (§6), between the sign-in methods and the Sign out button, when the console
can create teams (lane `01M3Z44MTV`, 2026-11-02).

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Label | form | Create a team | |
| Field label | team name | Team name | `[a-z0-9-]`, 1–32. Lowercased as typed. |
| Field note | team name | Lowercase letters, digits and dashes. Your team lives at {slug}.{suffix}. | `{slug}` is what they typed, or `name` before they type. |
| Field error | bad team name | Use 1 to 32 lowercase letters, digits or dashes. | |
| Field error | taken | That team name is taken. | The team server said so. What they typed stays in the fields. |
| Field label | display | Shown as | Optional, up to 80 characters. |
| Field note | display | Optional. The name people see. | |
| Field label | seat | Your seat | Their member name on the team. |
| Field note | seat | Your name on the team. You will be its first owner. | |
| Field error | bad seat | Use 1 to 32 letters, digits, dots, dashes or underscores. | |
| Button | form | Create team | POST. |
| Notice | too many | That is enough teams for this hour. Try again later. | Five an account an hour. |
| Notice | unreachable | The team server could not be reached. Nothing was created. Try again in a minute. | |
| Notice | refused | The team server refused ({reason}). Nothing was created. | `{reason}` is the server's error code, or its status. |

`<title>` Team created — musterd — after a create. *(Revised 2026-11-06, unified sign-in lane 5: the
way in is one button that signs you in; the two secrets fold away under a disclosure until
`musterd login` and `musterd join` replace them — nick, question 01M6SBB3C7. sloane's
`sign-in-copy-spec.md` §5 is the target once those ship.)*

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | created | Team created | |
| Lede | created | {slug} is yours. You are its first owner, as {name}. | |
| Button | created | Open {slug} | Primary. Goes to `{host}/live/signin/start`, which signs you in through the console hand-back. |
| Disclosure | created | For your terminal and agents | Closed by default. |
| Notice | inside | Shown once and never again. Copy what you need now. | A reload is `/account`. |
| Label | credential | Your credential | The `mscr_` value your terminal presents. |
| Label | key | Agent key | The `mskey_` value agents present to claim a seat. |
| Note | inside | Agents present the agent key to claim a seat; your terminal presents your credential. Keep both out of chat and out of git. | |
| Link | created | Back to your account | |

## 9. Signing in to a team

The team hand-back (ADR 722 §1, ADR 818, lane `01M6RZ8K12`, 2026-11-06): a hosted team's
**Sign in with musterd** comes here, and the page sends the person straight back. They see it for
a moment, or — with script off — press the button. Strings drafted by miley; sloane reviews.

`<title>` Signing you in — musterd

| Surface | State | Exact string | Notes |
| --- | --- | --- | --- |
| Heading | handing back | Signing you in to {team} | `{team}` is the team slug. |
| Lede | handing back | One moment — taking you back to your team. | |
| Button | handing back | Continue | The same POST the script makes. |

With no console session, the page is the sign-in page (§2) unchanged; after signing in, the person
lands back here.

