# A second laptop joins the team and hosts half the seats

> **Audience:** the person whose one laptop hosts a whole musterd team and now has a second
> machine on the same tailnet. **Effort:** ~20 minutes at the second machine, two commands on the
> first, then a wait while the new machine replays the team's history. **Code:** none — the
> federation this uses shipped in ADRs 325 → 376, and `deploy/second-machine/bootstrap.sh` is the
> cloud-seat runbook (`deploy/cloud-seat/`) rewritten for a Mac you can sit at.
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

## The seat split (revive, decided 2026-10-02)

Chosen so the joiner needs only two harness sign-ins:

| Joiner                                                       | Hub                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| ryder, sloane, dolly (claude-code) · big-body, lazara (codex) | izzo, miley, stanley (claude-code) · gptbot (codex) · grokbot, wanderer (grok) · ghost (opencode) · the services; delta stays on Fly |

## Before the script — the person, at the joiner (~20 min)

1. **Tailscale**: install the app, sign in to the same account. A member device has full tailnet
   reach, so no ACL change is needed (the cloud seat's tag policy is for machines that are not
   yours).
2. **Toolchain**: `brew install node@22 pnpm gh` · `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
   (put it in your shell rc — the service plists embed whichever `node` installs them, and a Node
   20 install crashloops the daemon) · `pnpm setup` and reopen the shell.
3. **Sign-ins**: `gh auth login` · `claude` (Claude Code, your Max account) · `codex` (OpenAI).
   Grok / OpenCode only if a seat of that harness moves here.
4. **Stay awake**: System Settings → Battery → Options → _Prevent automatic sleeping on power
   adapter when the display is off_. A sleeping joiner's seats vanish from the roster.

## The script — `bootstrap.sh machine`

```sh
curl -fsSLo ~/bootstrap.sh https://raw.githubusercontent.com/SandRiseStudio/musterd/main/deploy/second-machine/bootstrap.sh
bash ~/bootstrap.sh machine           # MUSTERD_HUB=nicks-laptop MUSTERD_TEAM=revive are the defaults
```

Every step is a no-op once done, so a failure is fixed and the script re-run. In order:

1. **Runtime** — clones `SandRiseStudio/musterd` to `~/.musterd/runtime` on `main`, builds it,
   links `musterd` onto PATH. The joiner must run the hub's build: the sync wire format and the
   schema are per-build, and a peer on a newer build stops the fold (`sync_fold_newer_build`).
   Autorefresh (step 2) keeps it on `main` from then on, as on the hub.
2. **Services** — `musterd service install` (daemon, loopback), `--wake` (the actuator that wakes
   this machine's seats), `--auto --mode notice` (autorefresh). launchd, `RunAtLoad`.
3. **Team home** — clones the roster repo to `~/musterd/revive`, `team create revive --as nick`
   there (the joiner holds the team under the same slug before enrolling; this also mints your
   admin credential on this daemon), and declares the clone as the daemon's roster root. Without
   that the roster is two members and the fold **blocks** on the first hub event naming anyone
   else (cloud-seat finding 4).
4. **Enrol** — stops here the first time and tells you to mint the invite **on the hub**:

   ```sh
   # hub, from ~/musterd/revive (the invite is minted by the daemon the team was created on, ADR 376)
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

## Moving a seat — `bootstrap.sh seat <name> <harness>`

Per seat, in this order (the order is the whole point: the seat's first act from the joiner is
what binds it there, and a seat still bound to the hub is refused):

```sh
# hub, as nick — stop waking it here, then release its residence
musterd residency off --seat ryder
musterd node unbind ryder

# joiner
bash ~/bootstrap.sh seat ryder claude-code
musterd ryder                                   # open it once through the front door (ADR 491)
```

The seat step provisions the worktree and wires the harness through the reconcile engine
(`musterd agent`, ADR 491), pre-accepts Claude Code's folder trust so a **cold** wake does not die
on a prompt a headless session cannot answer (cloud-seat finding 8), re-lands the doorbell hook,
`wire`s the actuator's credential, and enrols the seat for wake with `--flow auto`. A Codex seat
needs none of the trust step since ADR 495. The seat's `pnpm install` runs in the background;
its first gates wait on it.

What does **not** move: the seat's resumable Claude Code / Codex session (ADR 210's registry is
per machine) — the seat starts a fresh session on the joiner, with its musterd seat memory intact.
The hub's worktree for the seat goes stale; leave it or `git worktree remove` it from
`~/.musterd/runtime`.

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

## Known edges

- **Both Airs are 8 GB.** The joiner also runs a daemon (~90 MB), the actuator and autorefresh;
  five seats plus their builds is the honest ceiling there too.
- **The joiner's roster root has no CLI setter** (step 3 edits `config.json`). Candidate product
  fix: `musterd team adopt <dir>`, or `team export` accepting a home that already holds
  `team.toml` — the second machine of every file-backed team hits this.
- **A seat is reachable only while the joiner is awake** — see "Stay awake".
- **One hub.** The joiner cannot mint invites (ADR 376 §2). Promoting the joiner to hub is its
  own ceremony and ADR (ADR 376 §4).

## Findings

Append; never rewrite. Dated, with what was measured and what was done about it.

- **2026-10-02 (before the run)** — the drain estimate: 156,557 hub events ÷ 500 per 60 s tick =
  5.2 h to the first wake. Fixed in `sync/pull.ts` (PR #1963) before enrolling: a tick drains.
  The measured first-drain time on the Air goes here.
