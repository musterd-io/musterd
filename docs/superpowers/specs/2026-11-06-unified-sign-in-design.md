# Unified sign-in — one account, every surface, no pasted secrets

- Date: 2026-11-06
- Lane: `01M6RZG7RE0S9X4KZJJR2NMJXG` (goal `cloud`)
- Asked by: nick (stated, 2026-11-06, answering question `01M6RZC9KT`)
- With: big-body (security read), sloane (the words a person sees)
- Blocks: `01M6RZ8K12` (console `/handback`), which waits on the identity-proof decision below

## Why

nick, 2026-11-06: *"I guess we haven't looked at auth/login that much when it comes to users on
live, cloud console, or the app. We need a unified approach across all platforms (including mcp,
cli, api etc)."* And: *"all login should be extremely intuitive and straightforward with no
friction. We should think about oauth login, social login, credentials, api keys, subscriptions."*

The trigger was small. A console account made with GitHub stores no email
(`console/src/providers.ts:148`), ADR 698 refuses an identity statement without one
(`server/src/cloud/consoleToken.ts:242`), so the person who owns revive cannot sign in to a hosted
`/live`. Under it is a larger fact: musterd has **eighteen separate ways a human proves who they
are** (inventory in the appendix), and they share no account. One person is a console account, a
team member, a passkey per origin, a phone key pair and a key per machine, joined only where Cloud
happened to bind `members.account_id`.

## What success is

- **Signing in on any surface is one click or one tap**, and a new device costs at most one browser
  hop, once.
- **Every surface signs you in from cold.** `/live`, the console, the phone app, the CLI, MCP
  clients and the HTTP API each stand alone. None needs another surface first: no paired phone, no
  passkey on that origin, no CLI run, no second admin. (nick: *"if I can sign into live for a
  specific team and specific user with proper credentials regardless of state of other surfaces"*.)
- **Every surface recognises the same you**: the same account, the same member of the same team,
  the same permissions. A revoke or removal anywhere holds everywhere.
- **No secret is ever shown to be copied or pasted** by a person, on any surface.

## Anti-goals (a failure even if it works)

nick: *"if it was too complicated / too many redirects or consent flows, and no syncs across
surfaces"*.

- A chain of redirects or consent screens. Each hop is a cost; the budget is in "What success is".
- A surface that requires another surface (today: the phone needs `/live` plus a passkey; a first
  passkey needs a second admin; a new browser on self-hosted needs a terminal).
- A sign-in that knows nothing about the others: three sessions for one person that disagree about
  who they are or whether they are still allowed in.

## Non-goals

- Billing itself (Cloud increment 7, lane `01M3TTZJGX`). This design only makes the account the
  thing billing attaches to.
- SSO/SAML for the org tier. The account model leaves room for it (an org's IdP becomes one more
  sign-in method); building it is later.
- Agent identity. Agents never sign in; they hold seats lent by a machine (below). ADR 439/440 seat
  credentials are unchanged except where a machine's sign-in replaces a pasted key.

## The model

### 1. Two kinds of thing prove themselves

- **A person proves themselves with their musterd account.** The account lives on the console
  (`app.musterd.io`). Its sign-in methods are GitHub, Google, email link, and — new — a **passkey
  on `app.musterd.io`**. One account, any number of methods, all equal (ADR 620's binding rules
  stand: methods link by explicit action, never by matching email).
- **A machine proves itself with a key it holds** — a laptop, a Fly seat machine, a hub. A machine
  is trusted because an account vouched for it once.
- **Agents never sign in.** An agent runs in a seat a trusted machine holds (ADR 662: one machine
  per hosted seat).

### 2. Free local needs no account

There will always be a free, pared-down local musterd (nick). Installed and run on one machine, it
works with **no account and no connection to musterd.io**, as today: the loopback one-click
identity of ADR 557/580 and the CLI's chmod-600 config. The no-phone-home test for self-hosted
(lane `01M3Z42SKR`) stays a gate.

**Sign in to musterd** is asked for once, at the first moment something needs it — a paid local
feature, a cloud agent, a Cloud team, or (open question 1) a teammate on another network. After
that the local hub is **linked**: it trusts the console's keys for this account, and every local
surface knows you as that account.

### 3. The account is the identity; team membership hangs off it

- A **member** is still per team (the ontology does not change: a Member is an identity in a team,
  ADR hard rule 7). A member is **bound** to at most one account (`members.account_id`, ADR 698
  §3, write-once).
- Binding happens by the person signing in to musterd from an invite, from a team they created, or
  by linking a member they already are (ADR 722's three modes, unchanged).
- A member with no account (free local, or a self-hosted teammate who never linked) keeps working
  as today. Nothing forces a bind.
- Billing, a trial, plan limits and later SSO attach to the account, never to a member or a
  machine. A person on three teams is one paying person.

### 4. One identity proof, issued by the console

The console signs **one kind of identity proof** for every surface: the ADR 698 statement
(ES256, ≤ 60 s, one audience, single-use `jti`), with one change:

- **It carries `use: "identity"`, and `email` becomes optional.** The server checks `use` where it
  checked for `email` (whose only job was to tell a statement from an admin token). The console
  includes an email only when it holds a provider-verified one. No new personal data is collected.
  *(My call, recommended to nick in question `01M6RZC9KT`; needs big-body's read and a new ADR,
  since ADR 698's Decision is frozen.)*

Every "Sign in with musterd" on every surface ends in this proof reaching the team's server, which
turns it into **that surface's own session**. The proof is consumed; the session is what lives.

### 5. Each surface: how you sign in, what you hold

Every surface gets its own session, so each stands alone; all of them resolve to the same member
and account, and all are listed together (§7).

| Surface | Sign in | What it holds | Lifetime / revoke |
| --- | --- | --- | --- |
| **`/live` (hosted)** | **Sign in with musterd** → console (signs you in if needed) → back. ADR 722 as designed; the console `/handback` is lane `01M6RZ8K12`. | `mbs_` cookie on the team origin, traded for a 15-min `msat_` in memory | 14 d / 3 d idle; per-session revoke (exists) |
| **`/live` (self-hosted, linked)** | Same button; the hub trusts the console because it was linked (§2). | Same `mbs_` / `msat_` (the routes stop answering 404 on a linked hub) | Same |
| **`/live` (self-hosted, unlinked)** | Loopback one-click (ADR 557/580) on the hub's own machine; an **invite link** from anywhere else. **The paste field goes.** | localStorage credential, as today | As today |
| **Console** | GitHub / Google / email link / passkey | Console session cookie (ADR 620) | 14 d idle / 30 d; logout |
| **Phone app** | **Sign in with musterd** in the system browser sheet (`ASWebAuthenticationSession`), then pick a team. No `/live` and no QR needed. | An app session for the member, plus the Secure Enclave keys it already makes, **enrolled by that session** instead of by a QR pairing | Per-session revoke; key revoke as ADR 802 |
| **CLI** | `musterd login` — a browser opens, you sign in, done; device code (RFC 8628) when there is no browser. Lane `01M3Z42SKR` already scopes it. | A **per-device** credential for the member, in chmod-600 config — not the permanent `mscr_` | Listed and revocable per device |
| **MCP clients** (Claude, ChatGPT, Codex) | Add the connector → the authorize page offers **Sign in with musterd** first. The invite code stays for guests; **the `mscr_` paste box goes** (`oauth.ts:399`). | `msat_` / `msrt_` (exists) | 1 h / 30 d rotating (exists) |
| **HTTP API, scripts, CI** | An **API key** (§8) | The key | Expiry + revoke |

**Passkeys** move to the account: a passkey on `app.musterd.io` has one relying-party id, so it
does not die when a hub moves (the ADR 808 incident). Hub-local passkeys (ADR 728/767/769) stay
for unlinked self-hosted teams and for the high-authority signatures ADR 662 requires — whether an
account passkey can produce those signatures is open question 3.

### 6. Machines and the hybrid cases

nick: seats can be local while the hub and team are in Cloud, or the hub can be local while seats
run in Cloud, and both must work across machines and networks.

- **A machine joins the same way everywhere:** `musterd login` on it (one browser sign-in), then
  `musterd join <team>`. The account vouches for the machine to the team's hub, wherever the hub
  is; the hub issues the machine its node identity (`msnode_`, ADR 328/358). This replaces the
  second-machine chain of a single-use `msinv_` plus a trust act from a machine already bound.
- **Hub in Cloud, seats local:** the laptop does the above against the Cloud hub.
- **Hub local, seats in Cloud:** the local hub, once linked, starts Cloud seat machines (ADR 816);
  each gets its identity from the hub, billed to the account that linked it.
- **The hub's location changes nothing about the handshake.** A linked laptop hub and the Cloud hub
  accept the same proof.
- A headless machine with no browser uses device code, or an API key scoped to joining one team.

### 7. One list of where you are signed in

Every session on every surface — browsers, phones, CLIs, MCP clients, API keys, machines — appears
in one list, shown on the console for the account and on `/live` for the member. Each row: the
surface, the device or client name, when it was last used, and **End**. Ending one ends only that
one; **End all** ends every session for the member on that team. Removing a member from a team ends
all of theirs there. Credential rotate (ADR 722 §4) keeps working as the big hammer.

### 8. API keys

My call (nick: *"not sure"*):

- **Created where you already are:** account settings on the console, or the member's settings on
  `/live`. **New key** → pick a team, what it may do (*read*, *act as me*, *admin*), and an expiry
  (90 days by default). Shown once; the list shows when each was last used, with **Revoke**.
- **A script that acts as a bot gets a bot seat's key**, not the person's — so the audit can tell
  "nick did this" from "deploy-bot did this".
- **One key format**, checked the same way on the HTTP API, the CLI and MCP. A new prefix (named in
  the ADR); stored as `sha256` only (hard rule 5).
- Paid tiers can later limit count, scopes, and require expiry (org policy).

### 9. Recovery

- **Lost a device:** end its session from any other surface (§7). Nothing else changes.
- **Lost a sign-in method:** sign in with another method on the account, or the email link.
- **Lost everything on a linked or hosted team:** account recovery on the console gets you back,
  and through the account, every team. No admin re-mint, no second admin.
- **Unlinked self-hosted:** as today — the hub operator's loopback recovery (ADR 808 inc D) and an
  admin re-mint (ADR 580). Linking the hub is the way out of that.

### 10. What this changes in ADR 461 (pricing, still proposed)

nick, 2026-11-06: free local always exists, pared down; **some local features may be paid**; Cloud
teams, cloud agents and musterd Cloud are **mostly paid, maybe with a free trial**; hybrid is
normal. ADR 461 instead says self-hosted is entirely free and uncapped, and Cloud is free for two
humans. This design does not decide prices. It records that:

- the account is the billing unit's home (ADR 461 §2's "human seat" becomes "account with a seat on
  a paid team");
- a paid **local** feature needs the account, which is why free local stays account-free and the
  first paid step asks for sign-in;
- ADR 461 should be revised (or superseded) by a pricing ADR before billing is built. Owner: sloane
  with nick.

## How the eighteen paths fold in

| # | Today | After |
| --- | --- | --- |
| 1 | `mscr_` minted at team create / member add | Kept for unlinked self-hosted and agents' human owners; **never shown on a page**. The console's "copy these now" page (`console/src/pages.ts:258-266`) goes: the creator is signed in, and agents join by machine sign-in (§6). |
| 2 | Paste a credential into `/live` | **Retired.** |
| 3 | CLI→browser `#s=` handoff | Kept (loopback, self-hosted). |
| 4 | Loopback one-click (ADR 557/580) | Kept (unlinked self-hosted). |
| 5 | Watch links (ADR 616) | Unchanged — audiences, not members. |
| 6 | Auto-observer | Unchanged. |
| 7 | Console account sign-in | Kept; **adds an account passkey**. |
| 8 | Console admin token (ADR 685) | Unchanged (machine-to-team admin calls). |
| 9 | Identity statement (ADR 698) | **The** identity proof; `use` claim, optional email (§4). |
| 10 | Hosted `/live` session (ADR 722) | Kept; also on linked self-hosted hubs. |
| 11 | MCP OAuth (ADR 446…) | Kept; authorize page leads with **Sign in with musterd**; `mscr_` box goes. |
| 12 | Team invite | Kept; on a hosted/linked team it ends in an account bind. |
| 13 | Hub passkey enrollment | Kept for unlinked self-hosted + ADR 662 signatures (open question 3). |
| 14 | Admin vouch for a first passkey (ADR 769) | Not needed on a linked team (the account is the proof); kept unlinked. |
| 15 | Hub recovery code | Kept (unlinked). |
| 16 | Phone pairing by QR | **Folded into phone sign-in**; QR stays as the unlinked path. |
| 17 | Second machine (`msinv_` + trust act) | **Replaced** by `musterd login` + `join` on linked/hosted teams. |
| 18 | Note key | Unchanged (automatic). |

## Open questions for nick

1. **Does a free local team that reaches across networks** (a teammate on another network, a second
   laptop elsewhere) need an account? Yes makes "the account" the line where hybrid starts and
   probably where paid starts; no keeps today's invites and `msinv_` working accountless across
   networks.
2. **Trial shape** — time-boxed, or a free allowance (seats, agent-hours)? It does not change this
   design's flows, only where "upgrade" appears; sloane's pricing ADR.

## For big-body (security)

3. Can an **account passkey** (RP `app.musterd.io`) stand in for the hub-held device keys that sign
   ADR 662 high-authority acts, via a console-verified assertion — or do linked teams keep a hub
   passkey for those?
4. The `use: "identity"` claim replacing the email check (§4): confirm no admin-token/statement
   confusion, and that one console key signing both stays acceptable.
5. A **linked self-hosted hub** trusting the console's JWKS: the blast radius of a console
   compromise on self-hosted teams that linked, and whether linking should pin per-account rather
   than trust the console for every account.
6. API key scopes (*read*, *act as me*, *admin*): is *admin* by key acceptable at all, or admin acts
   only from a person in a session?

## For sloane (the words)

- The one-line prompt at the first moment an account is needed (§2), per trigger.
- The button label, everywhere: **Sign in with musterd**.
- The "where you're signed in" list (§7), and the API key page (§8).
- How free local / account / paid is explained on the site and in the CLI.

## Left to the builder

- The increments and their order (the plan follows this spec). A natural first one: the
  `use`-claim ADR + console `/handback` + `/live` button, which unblocks hosted `/live` for nick.
- The per-device CLI credential's prefix and storage; the API key prefix (both via the protocol
  ADR).
- The phone app's sign-in sheet details and how it enrolls the Enclave keys.
- Copy, within sloane's lines; visuals, within the brand.

## Appendix — the inventory (2026-11-06)

Taken by a read-only sweep of `packages/` and `docs/decisions/` on `origin/main` at `102e1b95`.
Three findings were checked by hand: the console team-created page shows `mscr_` and `mskey_`
(`console/src/pages.ts:263-264`), the MCP authorize page has a `mscr_` box (`server/src/transport/oauth.ts:399`),
and `/live` never calls `/live/signin/start` (no match in `web/src`).

1. `mscr_` human credential — CLI config / console page; no expiry; admin rotate (ADR 069/077, 174, 580).
2. Paste into `/live` — localStorage (ADR 170, 222).
3. CLI→browser `#s=` handoff, 60 s nonce, loopback only (ADR 170, 174).
4. Loopback one-click identity (ADR 557, 580).
5. Watch links `#w=`, observer seats (ADR 136, 616).
6. Auto-observer, human-admin-minted (ADR 063, 580).
7. Console sign-in: GitHub, Google, email link; session cookie (ADR 615, 620). GitHub keeps no email.
8. Console admin token, 60 s ES256 (ADR 685).
9. Identity statement (ADR 698) — verifier only; nothing issues one.
10. Hosted `/live` session `mbs_`→`msat_` (ADR 722) — server only; no console or `/live` half.
11. Remote MCP OAuth, DCR/CIMD, `msat_`/`msrt_` (ADR 446, 452, 457, 458, 470, 743).
12. Team invite link / room code (ADR 450, 621) — joiners get no `mscr_`.
13. Hub passkey enrollment (ADR 662, 728, 767, 808, 812).
14. Admin vouch for a first passkey (ADR 769).
15. Hub recovery code, loopback (ADR 808 inc D).
16. Phone pairing by QR + passkey confirm (ADR 676, 690, 727, 759, 761, 788, 802).
17. Second machine: `msinv_`→`msnode_` + trust act (ADR 328, 358, 728).
18. Note key per machine (ADR 657).
