# A second laptop joins the team and hosts half the seats

> **Audience:** the person whose one laptop hosts a whole musterd team and now has a second
> machine on the same tailnet. **Effort:** ~20 minutes at the second machine, two commands on the
> first, then a wait while the new machine replays the team's history. **Code:** none — the
> federation this uses shipped in ADRs 325 → 376, and `deploy/second-machine/bootstrap.sh` is the
> cloud-seat runbook (delta's `deploy/cloud-seat/`, retired 2026-10-21 — the record is `docs/perf/cloud-seat.md`; its successor is `deploy/cloud-agent` in hub mode, ADR 689) rewritten for a Mac you can sit at.
>
> This is lane `01M3YZ0AY0`'s guide. It is written **before the run** from the cloud-seat record;
> the **Findings** section at the end is what the run itself taught, dated, and wins over the
> steps above it wherever they disagree.

## Why

One 8 GB MacBook Air hosting twelve seats bogs down past four live sessions (2026-10-02: load
average 8.9 on 8 cores; one seat's `eslint` alone at 82 % CPU; Chrome and the sessions holding the
rest). The load is the sessions, their builds and their gates — not inference, which happens at
Anthropic / OpenAI / xAI. Moving half the seats to a second machine halves exactly that. A local
model on the other Air would not help: an 8 GB M3 runs a ~4 B-parameter model, which is not a seat.

## The topology

One team, one authority (ADR 039 → 325). Nothing about the first laptop changes:

| Machine                  | Runs                                                                                           | Reached by                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Hub** (the first Air)  | the daemon that holds the team, `/live`, the wake actuator for its own seats, every service    | its seats on loopback; the joiner over the tailnet (`tailscale serve` → 4849) |
| **Joiner** (the second)  | its **own** daemon (a replica, ADR 325), its own wake actuator and autorefresh, the seats it hosts | nothing — it dials out; its daemon stays loopback-bound                   |

What crosses the tailnet is the sync surface: messages, lane transitions, presence, residency and
policy events, pushed and pulled by cursor (ADRs 335, 353, 356, 393, 398). A seat on the joiner
claims a lane through the hub's CAS (ADR 355), is woken by the joiner's own actuator from the
events it folded (ADR 131), and shows on the hub's `/live` like any other seat. The human is
trusted on both machines (ADR 358); **an agent seat lives on exactly one** (ADR 358 §3), and moving
it is an admin `node unbind` on the hub followed by the seat's first act from the joiner.

Layout on the joiner mirrors the hub (ADR 447): `~/.musterd/runtime` is the build, the team home is
the roster clone at `~/musterd/<team>`, and each seat is a worktree beneath it. One cosmetic
difference: the hub's repo group is `agents/` (its history), the joiner's will be `musterd/` (the
remote's name) — nothing keys on the path across machines.

## The seat split (revive, decided 2026-10-02, landed 2026-10-03)

Chosen so the joiner needs only two harness sign-ins. The split as decided put dolly and big-body on
the joiner; on 2026-10-03 nick kept both on the hub, moved gptbot instead, and created one seat new
on the joiner rather than moving one. What landed:

| Joiner (Air 2)                                                         | Hub                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ryder, sloane, lazara (claude-code) · gptbot (codex) · dreamy (opencode, new) | izzo, miley, stanley, dolly (claude-code) · big-body (codex) · grokbot, wanderer (grok) · ghost (opencode) · the services; delta stays on Fly |

## Before the script — the person, at the joiner (~20 min)

1. **Tailscale**: install the app, sign in to the same account. A member device has full tailnet
   reach, so no ACL change is needed (the cloud seat's tag policy is for machines that are not
   yours). **Then turn on its CLI** — the Mac app does not put `tailscale` on PATH: menu-bar
   Tailscale → Settings → _Install CLI_. `tailscale status` in a new Terminal must list the hub.
2. **Toolchain**: Node 22 from the **nodejs.org macOS installer (.pkg)**, not Homebrew (see
   Findings — on a macOS without a bottle, `brew install node@22` compiles for an hour). pnpm from
   its standalone installer, which needs no sudo: `curl -fsSL https://get.pnpm.io/install.sh | sh -`.
   `brew install gh`. The service plists embed whichever `node` installs them, and a Node 20
   install crashloops the daemon.
3. **Sign-ins**: `gh auth login` · `claude` (Claude Code, your Max account) · `codex` (OpenAI).
   Grok / OpenCode only if a seat of that harness moves here.
4. **Stay awake**: System Settings → Battery → Options → _Prevent automatic sleeping on power
   adapter when the display is off_. A sleeping joiner's seats vanish from the roster.

## The script — `bootstrap.sh machine`

Two commands — the repo is private, so the download goes through `gh`, not a raw URL:

```sh
gh api repos/musterd-io/musterd/contents/deploy/second-machine/bootstrap.sh -H "Accept: application/vnd.github.raw" > ~/bootstrap.sh
bash ~/bootstrap.sh machine           # MUSTERD_HUB=nicks-laptop MUSTERD_TEAM=revive are the defaults
```

Every step is a no-op once done, so a failure is fixed and the script re-run. In order:

1. **Runtime** — clones `musterd-io/musterd` to `~/.musterd/runtime` on `main`, builds it,
   writes a `musterd` shim into pnpm's global bin dir. The joiner must run the hub's build: the sync wire format and the
   schema are per-build, and a peer on a newer build stops the fold (`sync_fold_newer_build`).
   Autorefresh (step 2) keeps it on `main` from then on, as on the hub.
2. **Services** — `musterd service install` (daemon, loopback), `--wake` (the actuator that wakes
   this machine's seats), `--auto --mode notice` (autorefresh). launchd, `RunAtLoad`.
3. **Team home** — clones the roster repo to `~/musterd/revive`, `team create revive --member nick`
   there (the joiner holds the team under the same slug before enrolling; this also mints your
   admin credential on this daemon), and declares the clone as the daemon's roster root. Without
   that the roster is two members and the fold **blocks** on the first hub event naming anyone
   else (cloud-seat finding 4).
4. **Enrol** — stops here the first time and tells you to mint the invite **on the hub**:

   ```sh
   # hub, as nick, from your own Workspace (admin-only; minted by the daemon the team was created on, ADR 376)
   cd ~/musterd/revive/agents/nick
   musterd node invite --label "air-2"            # → msinv_…  single use, 15 minutes
   # joiner
   MUSTERD_INVITE=msinv_… bash ~/bootstrap.sh machine
   ```

   Then the one hub-side step the joiner cannot do for itself — `team create` on the joiner
   minted events as you, and you are bound to the hub's node (ADR 360), so until you trust the
   new node every push from it is refused `403 bound_elsewhere` and queues:

   ```sh
   # hub, as nick
   musterd node list                              # the joiner reads `enrolled`, the hub `local`
   musterd node trust <the joiner's node id>      # ADR 358: a human on two machines
   ```

5. **Key** — mints this daemon's own team agent key. The hub's key never leaves the hub
   (cloud-seat findings 2 and 14): the wake endpoints check the bearer against the _local_ team
   row, and a joiner holding no seats invalidates nothing by rotating.

## The drain — what to expect before the joiner can act

A joiner folds the **whole** hub log before it can see a new act or wake a seat. On 2026-10-02
revive's log held 156,557 events. Until this lane, a pull took one page of 500 per 60 s tick —
**5.2 hours**. `sync/pull.ts` now drains within a tick: a page that came back full is followed by
the next immediately, and the minute is only the wait once a page is short (PR #1963). Expect
minutes, bounded by the fold, not the clock. Watch it:

```sh
tail -f ~/.musterd/daemon.log | grep -E 'sync_(drained|pulled|fold)'   # joiner
musterd status                                                          # the roster fills in as it folds
```

A `sync_fold_*` line that repeats every tick is a blocker, not slowness — read
`docs/perf/cloud-seat.md` ("the drain — three permanent wedges") before assuming it will clear.

## Moving a seat — `musterd move <name>`

One command (ADR 696). At the destination, from your own Workspace:

```sh
musterd move ryder                 # bring ryder to THIS machine
musterd move ryder --dry-run       # say what would happen, change nothing
```

Or from anywhere — including from the seat's own session — send it:

```sh
musterd move ryder --to macbook-air-2.lan   # a label from `musterd node list`, or a node id
```

When that machine's `musterd host` has polled in the last five minutes, the command waits up to
two minutes for the host to stand the Workspace up and re-enroll the wake with the same harness
and knobs (ADR 703, lane `01M5GDGC5Z`). It then says the host did so. It does not also print a
second command. A human seat still prints `musterd human <seat>`: the host holds no human
credential.

When no host there is live, or the host reports it could not, `--to` prints the finish to run on
the target. For a seat with a wake enrollment:

```sh
musterd move ryder --harness claude-code
musterd residency on --seat ryder --harness claude-code --cooldown 1m …   # in the Workspace it printed
```

The second line re-enrolls the wake. `--to` prints it because the enrollment the hub revoked
comes back to the machine that ran `--to`, not to the target. A seat that ran on its own key
(`--harness musterd`, ADR 588) needs `--key-env`, which is machine-local, so that step fails on
the host and the same finish is what you run. An older host that does not ask for move rows never
receives one; the finish is the path then too.

The hub re-binds the seat in one act, so there is no unbound window for the old machine's next push
to take it back (the race `docs/wiki/joiner-wedges.md` records for the old `node unbind` path). It
revokes the seat's wake enrollment on the old host and hands the harness and knobs to the
destination, which re-enrolls it. A live seat is first sent a steer to push and save, and the move
waits up to `--wait` (default 5m) for its `accept`; `--now` skips. Branches of its open lanes that
are not on origin are named — that work is still on the old machine.

At the destination the command provisions the Workspace through the reconcile engine (`musterd
agent`, ADR 491), wires the harness, pre-accepts Claude Code's folder trust so a **cold** wake does
not die on a prompt a headless session cannot answer (cloud-seat finding 8), and enrolls the wake.
A seat that ran on its own key (`--harness musterd`, ADR 588) prints the `residency on … --key-env`
line to run instead: the key's variable name is machine-local. The seat's `pnpm install` is yours to
start (`pnpm install` in its Workspace) before its first gates.

What does **not** move: the seat's resumable Claude Code / Codex session (ADR 210's registry is per
machine) — the seat starts a fresh session on the destination, with its musterd seat memory intact.
The old Workspace stays; leave it or `git worktree remove` it there.

`musterd node unbind <seat>` remains the admin's escape valve — for a seat whose machine is gone and
which nobody will bring back — and still has the race above, so prefer `move`.

## A seat born on the joiner — the same step; the roster commit is now part of it

`bootstrap.sh seat <name> <harness>` works for a name the team has never seen: `musterd agent` adds
the member when it is new. Skip the two hub lines it prints (there is nothing to unbind). The roster
is file-backed (ADR 058), so the hub learns a member only from a seat file in its own clone, and
until that file arrives the hub has no such seat — a `residency on` from the joiner lands on nothing
and is silently lost.

Since ADR 592, `musterd agent` adds, commits and pushes `.musterd/seats/<name>.toml` in the
joiner's roster clone itself and says so (`published .musterd/seats/<name>.toml …`), and the hub
pulls its roster when it meets a seat it does not know. The seat step checks the file reached the
remote before it enrols (lane `01M41NQ05V`); if the push failed it stops with the commands that
publish it, and you re-run the step:

```sh
# joiner — only if `bootstrap.sh seat dreamy opencode` stopped on an unpublished seat file
git -C ~/musterd/<team> add .musterd/seats/dreamy.toml \
  && git -C ~/musterd/<team> commit -m "roster: add dreamy" -- .musterd/seats/dreamy.toml \
  && git -C ~/musterd/<team> push
bash ~/bootstrap.sh seat dreamy opencode
# hub — only if the hub's roster still lacks the seat a minute later
cd ~/musterd/<team> && git pull --ff-only
```

Measured 2026-10-03: `added dreamy (agent) to revive` printed on Air 2 at 17:46Z; 40 minutes later
the hub still had no dreamy, with every push from Air 2 accepted (`sync_pushed`) — the member was
never in the log to push. The hub showed `○ dreamy agent` within seconds of the pull, and
`· wakeable` only after the second `residency on`. Falsify: a joiner's `musterd agent <new>` that
the hub roster shows without a roster commit.

Two more edges of the seat step, both met on 2026-10-03:

- **An uninstalled harness leaves a half-wired seat.** `seat dreamy opencode` on a machine without
  the OpenCode binary wrote the binding and the worktree, then `residency on` refused. After
  installing it, `musterd harness status` in the seat still read `mcp.musterd folder → needs wire`
  — the MCP config the wake needs. `musterd wire` there, then `residency on` from the admin's
  Workspace, then open it once. A live `musterd <seat>` session holding the folder makes the
  actuator log `wake deferred … a live local session holds <ws>`; that is correct, and the due act
  reaches the session's own inbox.
- **Switching a seat's harness later** (lazara was provisioned `codex`, wanted `claude-code`):
  `musterd harness configure --select claude-code,musterd --yes` and `musterd wire` in the seat, then
  `residency off` + `residency on --harness claude-code` from the admin's Workspace. The script
  pre-accepts Claude Code's folder trust only when the harness it was *given* is `claude-code`, so a
  switch needs that by hand (cloud-seat finding 8) or the first cold wake dies on the prompt. The
  harness id is `claude-code`; `claude` is refused.

## Starting a joiner over — `bootstrap.sh reset --yes`

For a joiner whose enrolment is wedged or abandoned. There is no repair in place, and each obvious
one makes it worse (all read from the code, 2026-10-02):

- **Deleting the poisoned rows locally** trades the `403 bound_elsewhere` wedge for a `409` livelock:
  the hub requires a dense `origin_seq` per node, and a hole is refused forever (ADR 331, 335).
- **`musterd node unbind <seat>` on the hub** lets the joiner's refused events in as hub history —
  re-routed acceptances included — and re-binds a hub-resident seat to the joiner.
- **`musterd node trust`** is for human seats; an agent seat's refusal is not clearable by it.
- **Re-enrolling the same machine** fails: the hub refuses a node id it already knows, revoked or
  not, and the id lives in the daemon DB (`local_node`).

So reset the machine: a fresh DB gets a fresh node id.

```sh
# hub, as nick — cut the old node off (its id is in the joiner's ~/.musterd/node.json)
musterd node revoke <old-node-id>
# joiner — re-download the script from main, then:
bash ~/bootstrap.sh reset --yes
```

`reset` updates the runtime to `main` and refuses to go on if the build predates the joiner reaper
guards (#1976, #1978: a fresh joiner would wedge again within minutes). It stops this machine's
three LaunchAgents, moves **everything under `~/.musterd` except `runtime/` and the log** into
`~/.musterd-reset-<stamp>/`, and removes the human Workspace worktree (a fresh checkout whose binding
is dead anyway). It keeps the build and the roster clone, and refuses if any other member Workspace
exists — a reset kills their credentials, so move those seats off first. It ends by printing the
rest: mint a new invite on the hub, `bash ~/bootstrap.sh machine` here, then `musterd node trust
<new id>` on the hub. The revoked node stays in `musterd node list` as `revoked` forever (ADR 328
§5), and nick's node set keeps the dead id; it is inert.

## Verify — the lane's done-means

1. **Cross-machine wake.** From the hub: `musterd send --act steer --to ryder 'wake check'`. A
   `steer` is a doorbell; a plain `message` is not (cloud-seat finding 13). Within one push tick +
   one actuator tick (≤ 90 s) the joiner's `~/.musterd/host.log` shows the spawn and the hub roster
   flips ryder to `working`.
2. **A lane crosses.** The joiner seat claims a lane (the hub arbitrates, ADR 355) and hands it to
   a hub seat; both boards agree.
3. **`/live` on the hub** shows the joiner's seats with their presence and acts.
4. **Load.** `uptime` on the hub with the same number of live seats as before the move — the
   number this lane exists for. Record both readings under Findings.
5. **Residency truth.** `musterd residency status` on the hub lists the moved seats on the
   joiner's host (ADR 393), not `mac.lan`.

Read on 2026-10-03, five seats on Air 2 (ryder, sloane, gptbot, lazara, dreamy):

1. **Wake** — gptbot's first act from Air 2 (an acceptance `ask`) reached a hub seat's inbox; a
   `steer` to dreamy became `wake due: dreamy [immediate]` on Air 2's actuator within one tick.
2. **Lane** — gptbot's lane `01M1MKYZCJ` was submitted from Air 2 and its acceptance ask routed to a
   hub seat; the lane closed on both boards.
3. **`/live`** — the hub roster shows each as `● <seat> … @ macbook-air-2.lan`.
4. **Load** — hub load average 8.9 the morning of 2026-10-02 with every seat resident; 2.4–2.7 at
   22:12 with ryder and sloane moved; 3.4 at 12:56 on 2026-10-03 with all five moved and the same
   eight seats present. Air 2's own `uptime` is not recorded here.
5. **Residency truth** — **cannot be read from `residency status`** on this team: the host column
   shows `mac.lan` for the Air 2 seats because Air 2's hostname is also `mac`. Use the presence
   line's `@ macbook-air-2.lan` (item 3), which carries the daemon's node, not its hostname.

## Known edges

- **Both Airs are 8 GB.** The joiner also runs a daemon (~90 MB), the actuator and autorefresh;
  five seats plus their builds is the honest ceiling there too.
- **The joiner's roster root has no CLI setter** (step 3 edits `config.json`). Candidate product
  fix: `musterd team adopt <dir>`, or `team export` accepting a home that already holds
  `team.toml` — the second machine of every file-backed team hits this.
- **A seat is reachable only while the joiner is awake** — see "Stay awake".
- **One hub.** The joiner cannot mint invites (ADR 376 §2). Promoting the joiner to hub is its
  own ceremony and ADR (ADR 376 §4).
- **Files do not cross on their own.** The sync surface carries the team's record, and git carries
  code; a dataset or artifact one machine holds and a seat on the other needs goes by the
  **courier** role (`.agents/skills/courier/SKILL.md` — `team_members {role:'courier'}` finds the
  holder; Taildrop is the first route). Not a gist, not a PR.

## Findings

Append; never rewrite. Dated, with what was measured and what was done about it.

- **2026-10-02 (before the run)** — the drain estimate: 156,557 hub events ÷ 500 per 60 s tick =
  5.2 h to the first wake. Fixed in `sync/pull.ts` (PR #1963) before enrolling: a tick drains.
  The measured first-drain time on the Air goes here.
- **2026-10-02 (the run)** — four setup gaps, each now in the steps above or the script:
  1. `brew install node@22` ran 30+ min on Air 2 (compiling — no bottle for that macOS build) and,
     interrupted, left a broken `node` on PATH (`Library not loaded … /opt/homebrew/…`). Fix:
     `brew uninstall --force --ignore-dependencies node@22 node`, then the nodejs.org `.pkg`.
  2. `npm install -g pnpm` failed with permission denied, even under sudo (a root-owned `~/.npm`
     from an earlier sudo). The standalone pnpm installer sidesteps both.
  3. The Tailscale Mac app ships no CLI on PATH; the script's preflight now says how to add it.
  4. pnpm 12 removed `pnpm link --global`, so the first run built everything and then died before
     enrolling. The script now writes a two-line shim instead of linking.
  Also: the repo went private on 2026-10-02, so the `raw.githubusercontent.com` download 404s
  unauthenticated — fetch through `gh api` (above).
- **2026-10-02 (the first wedge, then the audits)** — Air 2 enrolled, was trusted, and drained at
  ~1.4 s per 500-event page. Within a minute its reaper had re-routed eleven old acceptances **as**
  the reviewers wanderer, gptbot, ghost and kimi, who live on the hub; the hub refused the batch
  `403 bound_elsewhere` (`kind: lane` in `sync_push_cursor.refused_json`) and every later push
  queued behind it. A joiner sees a hub seat as "gone" only because it is not resident there. Fixed
  for that sweep in #1976. Three read-only audits (residence rules and recovery, the reaper and
  presence, every daemon loop) found the same class in three more places — incident claim-window
  routing (messages sent AS a reporter), the ADR 229 backstop (closes lanes the hub may have
  accepted since), departed-seat release — fixed together in #1978, test-first with a hub case and
  a joiner case per sweep. Open lanes for the rest: `audit_retention` deleting a joiner's unpushed
  churn rows after 5 days (a permanent `409`, 01M3ZBT9VY), `seeds_ingest` running on a joiner
  (01M3ZBTDJ5), and smaller leftovers (01M3ZBTJKD). The recovery is the reset above.
- **2026-10-02 (the pull failures)** — while draining, Air 2's pull logged `TypeError: fetch failed`
  about once per tick, each one ending the drain until the next minute; `tailscale ping` was a
  direct LAN path at 17 ms. The log line hid undici's `.cause`; #1978's `failureFields()` now prints
  it (`UND_ERR_SOCKET: other side closed`, a connect timeout, …). The cause is still unknown — read
  it on the next drain before changing anything.
- **2026-10-02 (more setup edges)** — `musterd service restart` refuses while a session is
  connected, and a joiner's only session is its own wake actuator, so the script passes `--force`.
  `musterd human` asks to confirm on a TTY when `team create` already minted the credential; behind
  `| tee` the question is invisible and the run hangs, so the script passes `--rotate`. The
  autorefresh service seat cannot be minted on a joiner (the roster already names it) and ticks
  unattributed; cosmetic. A revoked node id can never enrol again (above).
- **2026-10-03 (the seat moves)** — ryder and sloane moved the night before (hub→Air 2 message and a
  reply back as the check), gptbot, lazara and the new seat dreamy on this day; the split that landed
  is in the table above. New findings, each now in the steps above:
  1. A seat born on the joiner reaches the hub only through a roster commit; `residency on` before
     the hub's pull is lost (section above). Product fix: the `seat` step commits and pushes the
     file, or refuses to enrol a seat the hub does not yet have. _Fixed 2026-10-15 (lane
     `01M41NQ05V`): `musterd agent` publishes the file (ADR 592) and the step refuses to enrol
     until it has reached the remote._
  2. The hub's `musterd residency status` prints `! drift: "<seat>" is enrolled to mac.lan but
     missing from this machine's host registry` for every joiner seat. False positive — the seat is
     in the joiner's registry — and the suggested remedy would re-home it. The drift check should
     skip seats enrolled to another node. _Fixed 2026-10-15 (lane `01M41NQ05V`): the check skips
     a seat whose roster `residence` names a node other than the answering daemon's own._
  3. The host label in residency is the joiner's `hostname()`, which here collides with the hub's
     (`mac.lan` on both). ADR 393's host column cannot distinguish two Macs with the default name;
     the presence line's node label can. Same root as the `--label` edge in node-enrollment.md.
  4. Air 2's actuator logs `wake due … wake deferred: <seat> — seat not in this machine's host
     registry` for **every hub seat with a due act, every tick** (ghost, wanderer, miley all day).
     Correct (ADR 393) but it buries the one line about a seat that does live there. _Fixed
     2026-10-15 (lane `01M41NQ05V`): the actuator logs a seat's deferral once per reason; every
     deferral is still reported to the daemon._
  5. A new session on the joiner reads its inbox before the hub's act is pulled (60 s cadence); the
     act is there on the second read. Said once to each new seat: "check your inbox". _Closed
     2026-10-15 (lane `01M50N412S`): the ADR 552 hub doorbell (2026-10-08) pulls when its socket opens
     and on every `head` poke, so the act arrives in about a second. The 60 s tick only applies while
     the stream is down._
  6. `bash ~/bootstrap.sh seat lazara codex && musterd lazara` for an already-moved seat is a
     no-op that prints nothing, which reads as a hang. The step should say "already provisioned". _Fixed
     2026-10-15 (lane `01M50N412S`): a seat already in this machine's host registry, with the same
     harness and a bound Workspace, is reported "already provisioned", with how to open it. A partial
     earlier run has no entry and resumes._

