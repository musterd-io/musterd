# Hub relocation — design

- Date: 2026-11-03
- Lane: `01M67EF763`, goal `cloud-agents`
- Brainstormed with nick; written by fifty. Parts marked **fifty's call** are mine; the rest is what
  nick said.

## Why

revive's hub, the daemon that holds the team's authority (ADR 325, ADR 376), runs on nick's
laptop. When the laptop sleeps, travels or restarts, the hub is gone. Joiners cannot claim, fold or
take policy, and seats on the joiner box (`musterd-joiner-1`) wait. The seats-on-shift work
(ADR 790–795) let nick drive seats from `/live` and the phone. What is left before the team can
stop depending on the laptop is moving the hub itself.

ADR 376 decision 4 named this as its own ceremony and did not decide it: re-point every joiner, hand
the canonical log over with its `hub_seq` intact, and re-bind where seats live.

## What it is

**Move revive's hub from the laptop to `musterd-joiner-1`, so that nobody using the team can tell
anything changed** (nick: "work the same way regardless of where the hub is running").

After the move:

- nick still opens `/live` at `localhost:4849` on the laptop. The laptop's daemon becomes an
  ordinary joiner, a full replica; every machine's seats talk to their own local daemon, as joiner
  seats already do.
- Seats keep their names, lanes, history, memory and credentials. Nobody re-claims, re-pairs or
  learns a new command.
- The phone stays paired with no re-scan.
- The laptop closing its lid is a non-event for everyone else.

### Where seats live afterwards (nick)

- **Stay on the laptop:** fifty, miley, cider, ghost (as seats of the laptop's joiner daemon).
- **Move to the box:** every other seat now resident on the laptop, each with `musterd move`
  (ADR 696). Measured 2026-11-03 from `residency.host`: the laptop answers to two host labels,
  `Nicks-Laptop.local` and `mac.lan`. Enrolled there today: alfie, big-body, dolly, wanderer, grokbot,
  izzo (move); ghost, miley (stay). fifty and cider are interactive seats with no enrollment (stay).
  The list is re-read on the day. Seats already on the box (ryder, sloane, lazara, slippy, TJ,
  gptbot, wallow, dreamy, mason, resident) stay. delta-2 is on its own Fly machine and is not part
  of this move.
- **fifty's call:** the two host labels become one (`mac.lan`) for the seats that stay, so the
  laptop is one joiner node with one label.

## Goals, non-goals, anti-goals

**Goals**

- The hub runs on an always-on box; the laptop is a joiner.
- Every act, lane, audit row, credential, pairing, seat memory and trace that exists before the move
  exists after it, with the same ids and the same `hub_seq` order.
- Users see the same URLs, the same seats and the same phone pairing.
- A pause of at most 30 minutes during the switch (nick). In it, wakes may stop and `/live` may be
  read-only.

**Non-goals**

- Hosted teams on musterd Cloud (the `cloud` goal). This moves one self-hosted hub to another
  machine.
- A floating hub that moves itself, or automatic failover. This is one deliberate move.
- Changing what a joiner can do while the hub is reachable.

**Anti-goals (a failure even if it works)**

- **Anything lost** (nick: what would make him wince is "if anything is lost"). A move that drops
  one act, audit row, credential or memory note has failed, whatever else works.
- A half-moved team: two hubs, or no hub, or joiners pointed at different hubs.
- A move that needs nick to re-pair the phone, re-claim a seat or re-enroll a machine.
- A move that puts nick's personal logins on a rented machine.

## How the authority moves

**fifty's call: the new hub starts as a byte copy of the laptop's database, not as a promotion of the
box's replica.** The box's replica was folded from the sync stream and has never held every table:
seat memory writers, local presence and node-local rows are not all replicated. Only a copy of the
authority's own file carries everything. The sequence:

1. **Before.** nick accepts the switch as an ask on `/live` (the ADR 734 pattern for deploys). The
   switch is scheduled **outside** revive's working hours (working hours are 11:00–15:00 Pacific;
   the switch never runs inside them), so no seat is on shift. fifty runs the ceremony from the
   laptop's terminal.
2. **Quiesce and drain.** Halt waking (no new leases); let running wakes finish or time out. Every
   joiner, the box included, pushes until its outbox is empty, and the hub folds everything. **Drain
   is a hard precondition (fifty's call):** if a joiner cannot drain inside the window, the switch
   aborts here, before anything is copied, and nothing has changed. Zero loss wins over the 30
   minutes (nick: "if anything is lost" is the failure). Then the laptop daemon stops.
3. **Snapshot.** Copy `musterd.db` (WAL checkpointed) and the hub's structural trace rows, with
   checksums, to a dated backup on the laptop. This is the rollback point. **Trace content does not
   move (fifty's call, ADR 453 §3, ADR 184):** each machine keeps its own `trace.db` content; only
   the structural rows the hub received move, so fifty's, miley's, cider's and ghost's content stays
   on the laptop and the box's content stays on the box.
4. **Inventory.** On both machines, count every table's rows and record a content digest per
   table, plus the `sync_log` head (`hub_seq`), each origin's highest `origin_seq`, and the seat and
   credential lists. Write both reports to the backup.
5. **Copy.** The snapshot goes to the box over the tailnet. The box's own replica database is set
   aside (kept, not deleted, for 30 days) and the copy takes its place. The box's daemon starts as
   the hub. **Box-only rows are not dropped (fifty's call):** the inventory lists every table of the
   box's replica whose rows are not in the hub's copy. Rows that are ephemeral by design (live
   presence, leases, the sync cursor) are rebuilt; any other box-only row is carried into the new
   hub, and the ADR names each such table and how it is carried. A box-only row with no rule is a
   mismatch.
6. **Verify.** Run the inventory on the new hub. Every laptop row must be present unchanged, and
   every carried box row present. **Any mismatch stops the switch:** the box goes back to its
   replica, the laptop restarts as hub from its untouched file, and nick is told what differed (on
   `/live` and the phone, once the laptop hub is back).
7. **Re-point.** The laptop enrolls as a joiner of the new hub. Every other joiner's `node.json`
   `hub_url` is re-pointed to it. Residence is re-bound: the seats that stay on the laptop are
   bound to the laptop's node, and the box's seats to the box's node. Then the seats nick named
   move with `musterd move`.
8. **Resume.** Waking resumes. A check reads the board, the roster, a seat's memory and a phone
   delivery through each surface (`/live`, CLI, MCP, the phone) and reports to the team.

Steps 2–8 are the paused window; the target is 30 minutes. During it `/live` is down (the laptop
daemon is stopped), not read-only. fifty reports progress on the terminal and posts the outcome to
the team once a hub is up.

**Left to the builder:** how the node identities are kept straight. The copied file's `local_node`
is the laptop's node. Whether the box takes that identity or keeps its own, and how the laptop's
origin sequence carries on as a joiner, is decided in this increment's ADR, provided that no
`(origin_node, origin_seq)` is ever reused and the `hub_seq` order is unchanged.

## What moves to the box, and under what credential

Move only what the hub needs to act for the team, each under the narrowest credential, and keep
nick's personal logins on the laptop. Reviewed by big-body, 2026-11-03 (a static design and source
read, no live host inspected; its points are folded in below and marked).

| Item | Moves? | Condition |
| --- | --- | --- |
| App-channel key (`~/.musterd/app-channel.key`) | yes | See below: it is the daemon's identity to every paired phone. |
| Away-relay team credential | yes | Only after its scope is checked (below). |
| PR watch GitHub access | yes | A new fine-grained token: pull requests and checks read, `musterd-io/musterd` only. nick's personal `gh` login stays on the laptop. |
| Roster repo writes | yes | A deploy key on the roster repo, with branch protection on its default branch (below). |
| The box's existing sponsor-scoped host key | already there | Unchanged: the box already runs `musterd host` for its seats. |
| Member credentials (`mskey_`, `msgr_`, `mscr_`), a team-wide agent key | **no** (big-body) | The hub never holds a person's credential or a team-wide key. |
| KMS and console credentials | **no** (big-body) | The control plane stays with nick; normal hub operation does not need them. |
| wrangler, nick's passkeys and device keys, EAS/Apple, hcloud, cloud console recovery | **no** | Personal, or the operator's. |

**The app-channel key (big-body: likely, medium confidence).** It holds the daemon's Ed25519
signing key and its HPKE receive key. A stolen copy lets someone impersonate the daemon to every
phone paired to it and decrypt phone-to-daemon traffic they can capture. It does not let them act on
the team server. The phone's pin stops a man-in-the-middle; it does not contain key theft. So the
box becomes part of the phones' trust boundary, and a compromise of the box is a compromise of every
phone pairing. Before the key is copied:

- its directory is owner-only and the file is 0600;
- backups of the box do not widen who can read it;
- **a rotate-and-re-pair procedure exists and has been run once on a test pairing**, so a stolen key
  can be revoked. This is a precondition for the switch.

**The relay credential (big-body).** Before copying, read what its operator-map entry authorizes. If
the relay supports a per-team or per-hub credential, mint a new one for the box instead of copying
the laptop's. Keep it out of anything an agent can read (environment, logs). Test once that revoking
it closes or refuses a live socket.

**Roster writes (big-body; fifty's call on the remedy).** A deploy key with write access is
repo-wide write, not limited to a path or branch. big-body prefers a short-lived GitHub App
installation token. **fifty's call:** keep a deploy key for this move, because the roster repo
(`SandRiseStudio/musterd-revive`) holds only roster files. Turn on branch protection for its
default branch, and list the key on the revocation list. A GitHub App token broker is a later
improvement, not a precondition.

**The box itself (big-body).**

- SSH by key only, with logins limited to named users; cloud console and recovery credentials stay
  with nick, never on the box.
- The daemon listens on the tailnet only. The listener's bind address and the host firewall are
  confirmed from the deployed configuration, not assumed.
- Tailnet ACLs allow the box only to named operators and the peer nodes it needs (the laptop's
  joiner, delta-2's machine).
- A revocation list names every credential that lives on the box and how to revoke each in one step.

The residual risk, stated plainly (big-body): a compromise of the box exposes the app-channel keys
and every credential staged there. The conditions above bound and revoke it; they do not remove it.

## Jobs that run only on the laptop's hub today

Each is placed on purpose, never lost by accident:

| Job | After the move |
| --- | --- |
| Roster watch (reads `~/musterd/revive`) | on the box, with a clone of the roster repo |
| PR watch (`gh`) | on the box, with the narrow token above |
| Away relay (phone) | on the box, with the moved key and credential |
| Guardian, sweep, stream watch, telemetry sink | on the box (they watch the hub) |
| Auto-refresher | already runs on each machine; unchanged |
| `/live` build publisher | each daemon serves its own `/live`; the laptop's publisher stays for the laptop's `/live` |
| Site deploys (musterd.io), cloud backup and drill jobs | stay on the laptop; they are not the hub's |

## Constraints

- No new runtime dependency.
- An ADR for the relocation, and an ADR or amendment for any protocol or schema change it needs
  (hard rule 1). ADR 376's two refusals stay in force outside the ceremony.
- The switch is gated by nick's accept on `/live`, never a pasted command
  (machine-local note: deploys go through an ask).
- The box's size (Hetzner cx33) must carry the moved seats. A capacity check comes before the
  move, not after.

## Rollback

- Until step 7 completes, rollback is: stop the box's hub, restore the box's replica, restart the
  laptop daemon on its untouched file. Nothing was written to the laptop's file.
- **After step 7, roll forward (fifty's call).** Once joiners point at the new hub and new acts
  land there, a problem is fixed on the new hub, not by restoring the laptop's file (that would lose
  those acts). Going back to the laptop as hub is the same ceremony run in reverse, laptop as
  target, with the same drain, inventory and verify.
- The step 3 snapshot and the box's set-aside replica stay for 30 days.

## One daemon per key

**fifty's call:** after verify, the laptop's copy of `app-channel.key` and the relay credential are
removed, and the laptop daemon's pairing page and relay socket stay off; pairing is the hub's. Two
daemons holding one key, or two relay sockets for one binding, could cross deliveries.

## Left to the builder

- The node-identity mechanics in step 7, within the rule above.
- The exact inventory query (per-table counts and digests) and where its report lands.
- Whether quiesce reuses the ADR 501 halt per seat or a team-wide pause.
- How the re-point reaches each joiner (a pushed instruction, or a command run on each machine).

## Security preconditions for the switch

big-body's review is folded in above. These must be true before nick is asked to accept the switch:

1. The app-channel rotate-and-re-pair procedure has been run once on a test pairing.
2. The relay credential's scope is read, and a box credential is minted or the copy is justified.
3. The PR-watch token and the roster deploy key exist, with branch protection on the roster repo.
4. The box's listener bind, firewall and tailnet ACLs are confirmed from its configuration.
5. The revocation list is written.
