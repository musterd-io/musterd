# Seat memory isolation: who can read a seat's note

> **Status: exploratory design, 2026-10-17** (lane `01M3WJYDRN`, lazara, for nick). It freezes once
> its decisions land in ADRs; the work then lives on the `security` Goal with its lanes. It came out
> of the Multiplayer AI demo prep, from Rishi's "memory bubble" question. nick fixed the threat model
> on 2026-10-01: **both, tiered.** On a laptop the risk is accidental: an agent stumbles on another
> seat's note and it pollutes its context. On a hosted seat the risk is hostile: an agent tries to
> read another seat's note, or to act as that seat.

## What a seat's note is

A seat's note is its working memory: `team_memory_save` / `team_memory_read`, at most 8 KiB, one
per seat. It belongs to the seat, not to whoever occupies it
([ADR 093](../decisions/093-persistent-seat-memory.md) §4). ADR 093 promised "no cross-seat read
path — team admins included". This doc checks that promise against the code. It also records
every path the note actually takes, and decides what each tier needs.

## Who may read what (nick, 2026-10-17)

**Humans can see everything except another human's personal stuff.** For a seat's note that
means three rules:

- **An agent seat's note:** the seat itself and **any human** on the team can read it. No other
  agent can.
- **A human seat's note:** only that human can read it. Not another human, not an admin, not an
  agent.
- **Writing a note:** only the seat itself can.

This replaces ADR 093 §4's "no cross-seat read path, team admins included" for agent seats, and
keeps it for human seats. The risk nick named for agents is **pollution**: one agent reads, or
overwrites, another agent's note, and the next session acts on it.

## What is true today (verified 2026-10-17, origin/main `1a2a1206`)

The 2026-10-01 brief listed four paths. All four still exist. Two more turned up.

| # | Path | Who can use it | Laptop | Hosted |
| - | ---- | -------------- | ------ | ------ |
| 1 | **Memory API.** `PUT/GET/DELETE /memory` (`http.ts:9177-9240`) resolves the seat from the credential alone, with no member name in the URL. The wake-context and dream packets carry the **caller's own** body; claim/occupy carry headline-only envelopes. No route returns another seat's body. | Only the seat itself | safe | safe |
| 2 | **`GET /audit`.** Every save writes `continuity.memory_saved` with `{headline, body}` (`store/memory.ts:124-129`, ADR 366 decision 2). `/audit`, `musterd audit` and the web audit page print it unredacted. These rows are never pruned (`retention.ts:32`). | Human admins only. Since bf131e6f (2026-10-05) and ADR 580 (2026-10-13), no agent can pass the admin gate. | open to humans | open to humans |
| 3 | **The database file.** `~/.musterd/musterd.db` is mode 0600, but it is owned by whoever runs the daemon. Every laptop agent runs as that same user, so any shell can `sqlite3` it and read `seat_memory` **and** the audit bodies. | Any process running as the daemon's OS user | **open** | open, unless the seat runs as a separate user |
| 4 | **Another seat's credential.** Each workspace's `.musterd/binding.json` (0600) holds `msac_` + `msls_`. The lease is a 5-minute bearer token, bound to nothing but possession (ADR 337; `members.ts:484-664`). A copied pair reads `/memory` as that seat without displacing it and without leaving a trace. Running `musterd` from that seat's folder does the same. | Any process running as the same OS user | **open** | open, unless the seat runs as a separate user |
| 5 | **Replication.** The audit row **is** the replicated event. The hub keeps it in `sync_log`, never pruned (ADR 478). `GET /sync/pull` hands every team event to every enrolled machine (`log.ts:355-367`). Each puller folds it into its own `seat_memory` **and** its own audit table (`fold.ts:565-598, 1155-1200`). Residence (ADR 366 decision 7) only limits who can **write** a note. | Every enrolled machine, and therefore that machine's admin and its same-user processes | open | open |
| 6 | **Taking over the seat.** A legitimate re-seat or an admin-approved grant inherits the note (ADR 093 §4, ADR 146). | Whoever is allowed to occupy the seat | by design | by design |

At rest, the body is plain text in all three places: `seat_memory`, `audit.detail` and `sync_log`.
Cloud uses Postgres row-level security per `team_id`, which separates teams but not seats.

**Isolation by seat kind today.** Only the Fly cloud seat (delta, ADR 390) runs as its own OS user
(uid 1001, `setpriv` in its entrypoint). Resident BYOK seats (ADR 588) and sponsor-hosted agents
(ADR 463) run as the host user. The resident engine's jail (`host/engines/jail.ts`) keeps musterd's
own read and write tools inside the workspace. But code the seat runs (`pnpm test`) runs unconfined
(jail.ts:20-24). The OS sandbox for that is lane `01M4VYT6JW`.

**What ADR 341 already says.** ADR 341 decision 2 already makes it a release gate that every agent
Member runs under a distinct OS user before any real-user release. ADR 200 §4.1 names that as the
barrier that works. The barrier itself is deferred until there is a prototype. This doc does not
reopen that decision. It is the hosted tier of this design.

## Per-harness reach

The 2026-10-01 candidate P3A was "musterd writes per-seat harness sandbox settings; the harness
enforces them". The question it raised was whether that holds across every harness.
**It does not.**

| Harness | Can it deny a read outside the workspace? | Does that cover the shell? | Can it be bypassed? |
| ------- | ------------------------------------------ | -------------------------- | ------------------- |
| Claude Code | Yes: `permissions.deny` `Read(...)` for the file tools, and sandbox `denyRead` (Seatbelt/bubblewrap) for Bash. | Only with both layers: a `Read` deny does not reach Bash, and `denyRead` does not reach the Read tool. MCP servers and hooks run outside the sandbox. | Yes: `--dangerously-skip-permissions`, `dangerouslyDisableSandbox` (unless `allowUnsandboxedCommands:false`), and the agent editing its own `.claude/settings.local.json` |
| Codex | Yes: a permission `profile` with `filesystem."<path>" = "deny"` | Yes, it is OS-enforced | Yes: `danger-full-access`, and `--sandbox` overrides the `profile` |
| Cursor / cursor-agent | Partly: a `Read(glob)` deny on the file tools; the terminal sandbox is machine-global | No; `cat` through the terminal reads it | Yes: auto-run, `--yolo` |
| OpenCode | Partly: `permission` patterns | No; there is no OS sandbox | n/a |
| Grok, Muse | Not established | Not established | Muse: `--yolo` |
| Native resident engine | Yes, musterd's own jail | Yes for musterd's tools; no for code the seat runs | No unjailed mode |

What musterd writes **today** points the other way. The ADR 261 Claude Code floor allows unscoped
`Read` and `Bash(cat *)`, and its `deny` list is empty by construction. So a Claude Code seat reads
`~/.musterd` and its siblings' `binding.json` without being asked.

**The constraint the 2026-10-01 plan missed.** Agents run `musterd` from their shell, and the CLI
reads its own `.musterd/binding.json` and `~/.musterd/config.json`. A sandbox `denyRead` on all of
`~/.musterd`, or on every `binding.json`, would break the agent's own CLI. An OS-level deny can
only name files the CLI never opens: `musterd.db*` and `trace.db*`. Agent-side commands reach the
daemon over HTTP. Only the human commands `store`, `reset` and `service` open the database. The
other seats' bindings can be denied only at the file-tool layer.

## The decision per tier

### Laptop tier: accidental

**Goal.** No musterd surface hands one seat another seat's note. An agent's file tools are pointed
away from musterd's files. Nothing claims to stop a determined process running as the same user.

1. **Apply the read rule when the note is read.** For a **human** seat's note, `GET /audit`,
   `musterd audit` and the web audit page show only `{headline_len, body_len, saved_at}` to anyone
   but that human. **Agent** seats' notes stay readable to humans there, and humans also get a
   direct, human-only read of any agent seat's note, so they don't have to dig through audit
   rows. The stored event keeps the body, because the audit row is the replicated event (path 5),
   and replication is what carries the note to the seat's second machine (ADR 366). Redacting on
   write would break continuity. The headline is redacted along with the body: it is content.
2. **Deny rules where a harness can enforce them.** At provisioning, musterd adds:
   - **Claude Code:** `permissions.deny` `Read(~/.musterd/**)` and `Read(<roster home>/**/.musterd/**)`
     for the file tools, plus sandbox `denyRead` on `~/.musterd/musterd.db*` and `trace.db*`.
   - **Codex:** a permission `profile` that denies `~/.musterd/musterd.db*` and `trace.db*`.
   - **Everyone else:** `04-cli.md` records the harness as **file-tool only** or **none**, so the
     gap is written down, not implied. This narrows path 3 for two harnesses, and path 4 for the
     file tools only. At this tier that is enough: the risk is stumbling, not breaking in.
3. **Refuse a seat mismatch.** The CLI acts as the seat whose folder it runs in. So an agent
   launched as seat A that runs `musterd` inside seat B's folder reads and writes **B's** note.
   That is the most likely accident on a laptop. When the session's own seat is known (the
   harness launch env, or the presence this process holds) and differs from the folder's seat,
   memory reads and writes are refused, with a message naming both seats. This closes the
   accidental half of path 4.
4. **Stamp who wrote the note, and warn on read.** Today a save records only the seat
   (`continuity.memory_saved` actor). Each save also records the presence and session that made
   it. When the last writer is not one of this seat's own sessions, `team_memory_read`, the
   session-start summary and the wake packet say so plainly ("your note was last written by a
   session that wasn't yours"), and mark the note suspect instead of trusted. Pollution through a
   copied credential (path 4) cannot be stopped on a laptop, but it stops being silent. ADR 522's
   checks on read already limit what a polluted claim in a note can do.
5. **Not doing on a laptop: a daemon service user (P2).** A `_musterd` user would close path 3
   against every harness. But it needs root at `service install`. It also reshapes autorefresh, the
   guardian and the plist, and it still leaves path 4 open, because the bindings stay readable as
   the human. That cost buys hostile-grade protection on a tier whose threat model is accidental.
   It belongs on the hosted tier.

### Hosted tier: hostile

**Goal.** On a host musterd provisions, a seat cannot read another seat's note, or act as another
seat, through musterd or through the file system.

1. **One OS user per seat, and the daemon under its own user.** This builds ADR 341 decision 2's
   barrier, starting where musterd already owns the host: the cloud seat image (delta's pattern,
   generalised), and the ADR 463 agent machine once it has more than one seat. Each seat user
   owns its workspace and its `binding.json`, mode 0600, so a sibling seat cannot read them. The
   database belongs to the daemon user, and seats reach it only through the API. This closes
   paths 3 and 4.
2. **Code a seat runs is confined** by the OS sandbox lane `01M4VYT6JW`: workspace only, with
   network access only to the gateway. Without it, a resident seat's `pnpm test` is just another
   process running as the host user.
3. **Replication: agent notes stay readable, human notes are encrypted.** An enrolled machine
   holds every seat's note (path 5). For agent notes that matches the read rule: humans may read
   them anyway, and the hosted seat users cannot reach the database. A human seat's note is
   encrypted to that human's own machines (next section), so the hub, the other machines and
   Cloud only hold ciphertext.

### Per-seat encryption, for human seats only

Under the read rule, only a human's note needs encryption. Agent notes don't.

- **Keys.** Each machine a human trusts (ADR 358) has its own X25519 keypair. The private half
  stays on that machine, mode 0600 under the human's own user. The server gets only the public
  half.
- **Save.** The human's CLI or MCP adapter encrypts the note locally, once for each of that human's
  machines (several recipients, like `age`), using Node's built-in `crypto`. No new dependency.
  The server, the hub's `sync_log`, peers and Cloud hold ciphertext plus `size` and `saved_at`.
  The audit row carries the same ciphertext, so `/audit` cannot show it to anyone.
- **Read.** Only the human's own machines can decrypt, so `team_memory_read` decrypts locally.
  The note still follows the human to a second laptop, which is what ADR 366 is for.
- **Machines.** When a new machine is trusted, an existing machine re-encrypts the current note to
  include it. A removed machine drops out of future saves, but a note it already received stays
  readable on it. Say that out loud.
- **Losing every machine loses the note.** It is working memory, at most 8 KiB, so that is
  acceptable. Old ciphertext in the audit rows becomes unreadable along with it.
- **What it does not buy.** On a laptop the human's own agents run as the human's user, so they
  can read the private key just as they read the database today. That is the hosted tier's
  problem. Agent seats are untouched, so the server still builds their wake packets from plain
  text (ADR 430 unaffected).

### The test that proves it (P4)

The canary is one agent seat trying every path against another seat's note: to **read** it, and
to **overwrite** it. It fails if any read returns the body, or if any write lands without the
owner's next read flagging it. A second case checks the human rule: one human cannot read another
human's note. The API half (paths 1 and 2, and path 4 with a fresh credential) runs as a
server test in `gates`. The OS half (paths 3 and 4 on disk) runs on the hosted image, and on a
laptop to **document** that it succeeds there. That success is the honest form of the laptop
claim. If the canary passes on the hosted image, the hosted sentence below is allowed. If it
fails, the sentence is withdrawn.

## What nick can say

- **Today:** "No musterd tool hands one agent another's notes. Anything running as you on your
  machine can read your musterd files, and right now that includes your agents."
- **Laptop tier, after its lanes:** "No musterd tool hands one agent another agent's notes, and if
  something else overwrites a seat's note, the seat is told the next time it reads it. Your
  personal notes are encrypted to your own machines. It's a courtesy wall, not a security
  boundary: anything running as you can still read your musterd files."
- **Hosted tier, after its lanes and a passing canary:** "On a hosted seat, each agent runs as its
  own user with its own credential. It can't read or overwrite another seat's notes. Your team's
  humans can read your agents' notes. Nobody but you can read yours."

## Positioning tension (flagged, not resolved)

ADR 320 says musterd is not a sandbox, and says so publicly. The laptop tier keeps that line:
musterd configures, and the harness enforces. The hosted tier crosses it, because musterd creates
OS users and owns the sandbox around code a seat runs. It is defensible only because on those
hosts musterd already provisions the machine (ADR 390, ADR 463). ADR 320 needs a dated amendment
to say so, or the hosted sentence contradicts the positioning page.

## ADRs to write

1. **Who reads a note** (server). The seat itself and any human, for an agent seat; only that
   human, for a human seat. Applied on every read: `/audit` and its renders, plus a new
   human-only read of an agent seat's note. The stored event is unchanged. Supersedes ADR 093 §4 in
   part and amends ADR 366 decision 2's consequence, not the replication itself.
2. **Laptop-tier deny rules and the per-harness capability matrix** (CLI). Which harnesses get which
   denies, written on top of the ADR 261 floor (deny beats allow). The matrix lives in `04-cli.md`.
3. **The hosted tier: one OS user per seat, and the daemon under its own user, on hosts musterd
   provisions.** This builds ADR 341 decision 2 for that scope, with a dated amendment to ADR 320.
4. **A note knows who wrote it** (server, CLI, MCP). The seat-mismatch refusal, plus the writer
   stamp and the suspect-note warning on read.
5. **A human's note is encrypted to that human's machines** (CLI, MCP, server stores ciphertext).
   Lives next to ADR 200 credential custody and ADR 358 machine trust.

Dated notes, not ADRs:

- ADR 366: residence limits writes, not reads. Every enrolled machine holds every note (its line 92
  overstates it).
- `memory-and-rules.md` line 33 says "no history", but the audit rows are a history.
- `http.ts:6945` has a stale comment: the wake packet does carry the caller's own body (ADR 430).

## Lanes (ADR 487: every increment opens its lane)

On the `security` Goal, in order:

1. **Who reads a note** (ADR 1 + server + CLI/web renders + the dated notes above). First.
2. **Seat mismatch refused** (part of ADR 4, CLI + MCP). Independent.
3. **Writer stamp and suspect-note warning** (part of ADR 4, server + CLI + MCP + wake packet).
4. **Canary, API half** (server test in `gates`): reads, overwrites and the human rule. Pairs with
   lanes 1 to 3.
5. **Laptop deny rules** (ADR 2 + the Claude Code and Codex writers + the `04-cli.md` matrix). Verify
   that no agent-side `musterd` command opens `musterd.db` before denying it.
6. **Human notes encrypted to their machines** (ADR 5). After lane 1.
7. **Hosted tier spec + ADR 3**: brainstorm first, with the ADR 341 prototype as its first
   increment. Depends on lane `01M4VYT6JW` (the OS sandbox) for code a seat runs.
8. **Canary, OS half** on the hosted image. Depends on lane 7.

## Decisions (nick, 2026-10-17)

- **Read rule:** humans see everything except another human's personal stuff (above).
- **Human-note encryption (lane 6):** after lanes 1 to 4, before launch.
- **Public sentence:** nick will say the laptop tier's "courtesy wall" sentence.
- **Agent notes are not encrypted.** Encryption only helps against someone who has the ciphertext
  but not the key. On a laptop, a polluting agent runs as the same user, so it has the key too. On
  the hosted tier, separate OS users already keep a seat out of the database. The read rule makes
  every human a reader, so every human's machines would need to be recipients, re-encrypted
  whenever a human joins. The server also builds wake packets from the body (ADR 430), so it would
  have to move to the client. What encryption would buy is narrower: the hub, Cloud and their
  backups would hold ciphertext. The existing lane `01M3Z43BQE` (per-team encryption of captured
  trace content, after Cloud v1) is the right place to extend at-rest encryption to agent notes,
  if Cloud needs it.

## Lanes opened 2026-10-17 (`security` Goal)

| # | Lane | Depends on |
| - | ---- | ---------- |
| 1 | `01M561XY7H` Who reads a note | none |
| 2 | `01M561Y23A` Seat mismatch refused | none |
| 3 | `01M561Y8QF` A note knows who wrote it | 2 |
| 4 | `01M561YJYQ` Canary, API half | 1, 2, 3 |
| 5 | `01M561YQN3` Laptop deny rules | none |
| 6 | `01M561YWP0` Human notes encrypted to their machines | 1, 2, 3, 4 (nick: before launch) |
| 7 | `01M561Z0W3` Hosted tier spec + ADR | `01M4VYT6JW` (OS sandbox) |
| 8 | `01M561ZCDS` Canary, OS half | 7 |
