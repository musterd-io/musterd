# Unified sign-in — one account, every surface, no pasted secrets

- Date: 2026-11-06
- Lane: `01M6RZG7RE0S9X4KZJJR2NMJXG` (goal `cloud`)
- Asked by: nick (stated, 2026-11-06, answering question `01M6RZC9KT`)
- With: big-body (security read), sloane (the words a person sees)
- Approved: nick, 2026-11-06. Goal `unified-sign-in`; increment 1 plan: `docs/superpowers/plans/2026-11-06-unified-sign-in-1.md`
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
  the same permissions. A revoke or removal anywhere holds everywhere, within the bounds §11.4
  states: about 20 minutes on a connected server, at most 1 h 15 min on a linked hub that
  has lost the console.
- **No secret is ever shown or pasted in order to sign in**, on any surface. The one secret a
  person ever sees is an API key they asked for (§8), shown once. *(Corrected 2026-11-06 after
  sloane's read: the first wording contradicted §8.)*

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
feature, a cloud agent, or a Cloud team. A teammate on another network does **not** need it:
invites keep working accountless (nick, 2026-11-06). After
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
| **Phone app** | **Sign in with musterd** in the system browser sheet (`ASWebAuthenticationSession`), then pick a team. No `/live` and no QR needed. | An app session for the member — enough to read the team and talk. The phone's Secure Enclave **approval** keys are enrolled the way they are today (§12), never by this session | Per-session revoke; key revoke as ADR 802 |
| **CLI** | `musterd login` — a browser opens, you sign in, done; device code (RFC 8628) when there is no browser. Lane `01M3Z42SKR` already scopes it. | A **per-device** credential for the member, in chmod-600 config — not the permanent `mscr_` | Listed and revocable per device |
| **MCP clients** (Claude, ChatGPT, Codex) | Add the connector → the authorize page offers **Sign in with musterd** first. The invite code stays for guests; **the `mscr_` paste box goes** (`oauth.ts:399`). | `msat_` / `msrt_` (exists) | 1 h / 30 d rotating (exists) |
| **HTTP API, scripts, CI** | An **API key** (§8) | The key | Expiry + revoke |

**Passkeys:** a passkey on `app.musterd.io` is a way to **sign in to the account**; it has one
relying-party id, so signing in does not die when a hub moves (the ADR 808 incident). It is **not**
an approval key. Hub passkeys and phone keys (ADR 662/728/767/769/802) keep signing high-authority
acts on every team, linked or not (§12).

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
  `/live`. **New key** → pick a team, what it may do (*read* or *act as me*), and an expiry
  (90 days by default, required). Shown once; the list shows when each was last used, with
  **Revoke**. **No admin key** (big-body, 2026-11-06): an admin act needs a person in a session,
  and a high-authority act needs its approval key, whatever the key says. Automation that needs
  more gets an explicitly scoped, expiring, audited grant — a later lane, not a key scope.
- **A script that acts as a bot gets a bot seat's key**, not the person's — so the audit can tell
  "nick did this" from "deploy-bot did this".
- **One key format**, checked the same way on the HTTP API, the CLI and MCP. A new prefix (named in
  the ADR); stored as `sha256` only (hard rule 5).
- Paid tiers can later limit count, scopes, and require expiry (org policy).

### 9. Recovery

- **Lost a device:** end its session from any other surface (§7). Nothing else changes.
- **Lost a sign-in method:** sign in with another method on the account, or the email link.
- **Lost everything on a linked or hosted team:** account recovery on the console gets you **signed
  in** again — reading and talking on every team. It does **not** restore approval keys: a new
  passkey or phone key is enrolled by today's rules (an existing key, an admin's vouch, or the
  hub's recovery code — ADR 769/808). Account recovery can be as weak as an email link, so it
  must never reset stronger authority (big-body, 2026-11-06).
- **Unlinked self-hosted:** as today — the hub operator's loopback recovery (ADR 808 inc D) and an
  admin re-mint (ADR 580). Linking the hub is the way out of that.

### 10. What this changes in ADR 461 (pricing, still proposed)

nick, 2026-11-06: free local always exists, pared down; **some local features may be paid**; Cloud
teams, cloud agents and musterd Cloud are **mostly paid, maybe with a free trial**; hybrid is
normal. ADR 461 instead says self-hosted is entirely free and uncapped, and Cloud is free for two
humans. This design does not decide prices. It records that:

- the account is the billing unit's home (ADR 461 §2's per-human charge attaches to the account
  of each human member of a paid team; "seat" is not the billing word — sloane, 2026-11-06);
- a paid **local** feature needs the account, which is why free local stays account-free and the
  first paid step asks for sign-in;
- ADR 461 should be revised (or superseded) by a pricing ADR before billing is built. Owner: sloane
  with nick (lane `01M6S2X5F9`).
- nick, 2026-11-06 (question `01M6S3SEV9`, via sloane): **invites keep working across networks with
  no account.** The account line is Cloud plus the paid features. **Trial:** a free allowance on
  Cloud, then paid.

### 11. Calls made after the builder check (miley; big-body to confirm)

A builder reading this cold asked five things this spec had not settled. None is nick's to decide;
each changes what gets built, so each is settled here as **my call**.

1. **The console keeps an account session per device; team servers keep team sessions.** The
   console already holds a session per browser (ADR 620). The CLI (`musterd login`) and the phone
   get the same kind of **account device session** from the console, held in chmod-600 config or
   the Keychain. To reach a team, that device session asks the console for a fresh identity proof
   (§4) for that team's audience, and the team server turns it into its own session. So the console
   issues exactly two things — account sessions, and 60-second proofs — and never a team
   credential. API keys (§8) are minted **by the team server**, even when the page that asks is the
   console (the console sends a proof and the request; the team answers with the key once).
2. **Binding a member who has no account yet, without a paste:**
   - **CLI:** `musterd login` on a machine whose config already holds that member's `mscr_` starts
     ADR 722's *link* mode with that bearer itself. One browser sign-in binds it. (nick on revive
     is exactly this case.)
   - **`/live` in a browser that already holds the member's credential** (localStorage, as today):
     a **Link my musterd account** button does the same.
   - **Team creator:** bound at creation (already shipped, lane `01M6F37KSW`).
   - **Anyone else:** an admin sends them a fresh invite, which binds on use. No admin rebind
     (ADR 698's deferred unbinding stays deferred).
3. **Linking a self-hosted hub** registers it with the console: the hub's public URL (if it has one)
   and the audience string it pins; the console answers with a **link id** for that hub. The hub
   **pulls** the console's keys and its revocation list (item 4) on a timer. The console **never calls in**, so a hub behind NAT links fine. The console's
   team list for an account is what was registered or bound; a hub that is not publicly reachable
   is listed with no URL (the phone and `join` reach it the way they do today: on its network or
   through its federation). **Offline, a linked hub fails closed for account sessions, with a bound**
   (big-body, 2026-11-06): once its revocation list is more than **1 hour** old, it stops minting
   `msat_` for any session that came from an account sign-in, and refuses new account sign-ins,
   until it reaches the console again. A revoked account therefore loses a stale hub within
   1 h 15 min at most (the hour plus one 15-minute token). Local credentials (`mscr_`, the hub
   operator's loopback) keep working offline: a hub never locks its own operator out.
4. **How far a revoke reaches.** Ending a session (§7) is per surface, per team, as written. **An
   account-level event** — the account suspended or deleted, or a sign-in method removed and its
   sessions ended — is published on the console's revocation list. Every team server and linked hub
   pulls it on a 5-minute timer and ends that account's sessions on it. Two bounds, stated
   separately (big-body, 2026-11-06):

   - **Connected** (the server reaches the console): a revoke is seen within one poll (5 min). The
     account's `msat_` already minted live out their 15 minutes; the server refuses every new mint
     and closes the account's open sockets on the pull. Worst case about **20 min**.
   - **Stale** (a linked hub that cannot reach the console): §11.3's fail-closed rule stops new
     mints once its last successful pull is over 1 h old. Worst case: the revoke lands just after
     that pull, so the hub mints for up to 1 h and the last token lives 15 min — **1 h 15 min**.
   - Assumptions: "age" is measured on the hub's own monotonic clock from the last successful
     pull, not from a console timestamp, so console–hub clock skew does not move either bound; the
     list response is `no-store`, so no HTTP cache sits between the pull and the console.

   **What the pull sends** (sloane, for PRIVACY.md; big-body to confirm): the keys are a plain GET of
   the public JWKS and send nothing. The revocation pull is one GET carrying the hub's **link id**
   and nothing else — no team name, member, act, lane or count. The console answers only with
   revocations for accounts **bound on that hub** (it learns a binding when the hub's callback
   binds an account, which already goes through a console-signed proof for that audience). An
   unlinked hub makes neither request (the no-phone-home test). PRIVACY.md's "does not phone home"
   line becomes: *an unlinked hub never contacts musterd.io; a linked hub fetches musterd.io's
   public keys and its own revocation list every 5 minutes, sending only its link id.*
5. **Who may vouch for a machine.** The **server** enforces this, not the client. A member may join
   a machine that holds **only their own seats**
   (their human seat and the agents they own). The join is an act on the team, visible on `/live`.
   A seat owned by someone else, or an admin capability, needs an admin's approval on `/live`. ADR
   662's one-machine-per-hosted-seat rule holds: joining a second machine to a hosted seat is
   refused, not silently doubled.

### 12. Signing in is not approving (big-body's security read, 2026-11-06)

The account answers **who you are**, for sessions that read and talk. It never answers **may you
approve**:

- No console session, account sign-in or account recovery enrols a standing hub passkey or phone
  key, or stands in for an ADR 662 signature. Enrolment keeps today's rules on every team.
- If an account passkey is ever to sign an approval, it needs its own design: a fresh,
  replay-resistant assertion bound to one action and one team, verified at the hub, keeping the
  recovery and approval rules. Not in this goal.
- **Cross-use, as it stands today (ADR 818):** an identity statement carries `use: "identity"` and
  the identity verifier requires it; the admin token carries **no** `use`, and the admin verifier
  refuses any token whose `use` is `"identity"`. Both verifiers enforce audience, lifetime and
  single-use `jti`. Neither checks `iss`: the issuer is pinned by the JWKS URL the server is
  configured with, so only the console's keys verify — but that is not an `iss` check.
- **A separately scoped change** (lane `01M6S4PMZP`) adds defence in depth: an explicit `iss`
  check against the configured expected issuer on both verifiers, and a mandatory purpose on the
  admin token (`use: "admin"`), with a compatibility window and tests that old admin tokens
  (no `use`) are accepted only until it closes. New token kinds after that each carry their own
  `use`, and every verifier refuses every other kind.
- JWKS trust authenticates the issuer, not membership: binding stays explicit and team-scoped
  (§3), never by email. A compromised console can impersonate any account it can sign for; the
  hub's own approval keys are what still stand in that case.
- Device sessions (§11.1) are device-bound, stored in the OS keychain or chmod-600, expire and
  rotate, and are revocable. The CLI's link from a stored `mscr_` (§11.2) is one proof bound to the
  member, the account and the one transaction, used once, with no credential in a URL or log.
- The phone sign-in (lane `01M6S2WTKE`) and account recovery each need a written threat model in
  their lane before they build.

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
| 14 | Admin vouch for a first passkey (ADR 769) | Kept on every team: the account signs you in, it does not vouch for an approval key (§12). |
| 15 | Hub recovery code | Kept (unlinked). |
| 16 | Phone pairing by QR | **Kept** for the phone's approval keys, on every team (§12). Phone sign-in (lane `01M6S2WTKE`) adds a read/talk session alongside it; it does not replace pairing. |
| 17 | Second machine (`msinv_` + trust act) | **Replaced** by `musterd login` + `join` on linked/hosted teams. |
| 18 | Note key | Unchanged (automatic). |

## Questions nick answered (2026-11-06)

1. **Does a free local team that reaches across networks need an account?** No — invites and
   `msinv_` keep working accountless across networks. The account is asked for by Cloud and by paid
   features only (§2's "first moment" list drops "a teammate on another network").
2. **Trial shape:** a free allowance on Cloud, then paid. Detail is the pricing ADR's (lane
   `01M6S2X5F9`).

## Display name without an email

(sloane's question 2.) An account with no email is shown on the console by its sign-in method —
*your GitHub account* — never by an id. On a team, a person is always shown by their member name.
A display name an account sets itself is later work; this design adds none.

## For big-body (security)

*(Answered 2026-11-06 — big-body's read is §12; the questions are kept for the record.)*

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
7. The five calls in §11, in particular the account device session (§11.1), the CLI starting link
   mode from a stored `mscr_` (§11.2), the 5-minute revocation pull (§11.4) and the machine-vouch
   rule (§11.5).

## For sloane (the words)

Superseded by sloane's copy spec, `docs/design/sign-in-copy-spec.md` (lane `01M6S3BYBY`), which
lanes 1b and 3–10 take their strings from verbatim. The list below is what it covers.

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
