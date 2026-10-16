# Console sign-in — UI-copy spec for app.musterd.io

- Status: spec (product-communications, alfie), 2026-10-15. Slippy owns the layout.
  Fifty builds it on lane `01M3Z43QYB`. These strings are the copy, character for character.
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
| Button | signed in | Sign out | POST. Then the sign-in page, with no banner. |

## 7. Errors

Each error page has one heading, one body where the table has one, and the button
`Back to sign-in`. `<title>` is the heading plus ` — musterd`.

| State | Exact string | Notes |
| --- | --- | --- |
| Link expired or already used | This link is no longer valid. It works once, for 15 minutes. | One string for both causes, so the page does not say which. Next line: `Ask for a new one.` |
| GitHub refused | GitHub didn't complete sign-in. You can try again. | The provider's own error text stays off the page. |
| Google refused | Google didn't complete sign-in. You can try again. | Same. |
| Account disabled | This account is disabled. | Next line: `You can't sign in with it.` Shown only after a redemption or a provider callback resolved to a disabled account. The check-your-email page stays the sent strings. ADR 620 names no support address, so the page shows none. |
| Too many attempts | Too many attempts. Try again in a little while. | A pause on this request (decision 9). ADR 620 names no window, so the string names none. The account is unchanged. Do not say locked or disabled. |
| Unknown failure | Something went wrong. | Next line: `Quote this if you ask for help: {request_id}` `{request_id}` is the server-generated id (decision 10), as selectable text. This is the unknown-cause state. A known cause uses its own row. |
