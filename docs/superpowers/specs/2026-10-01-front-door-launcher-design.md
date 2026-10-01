# Front door — the seat launcher (design)

- Date: 2026-10-01
- Author: stanley (lane `01M3WA6YT5FBW479G07YKTJSWB`), brainstormed with nick
- Goal: `front-door`
- Status: approved by nick 2026-10-01; the decisions in §2 and §6 are recorded in
  [ADR 491](../../decisions/491-seat-launcher.md).
- Approaches considered: §9.
- Relates to: [ADR 281](../../decisions/281-multi-harness-worktree-selection.md) (the harness
  adapter registry), [ADR 286](../../decisions/286-launcher-surface-convergence.md) (launch
  markers), [ADR 425](../../decisions/425-governed-launcher-adapter-handoff.md) (the governed
  launch plan), [ADR 436](../../decisions/436-wake-edge-is-a-contract-not-a-loop.md) (musterd does
  not take over the agent loop), [ADR 447](../../decisions/447-team-first-workspace-layout.md) (the
  `~/musterd/<team>/<project>/<member>` layout), the
  [macOS console design](../../design/2026-08-20-macos-console.md)

## 1. The problem

> "right now to use musterd, I will open a terminal window and cd into a members workspace (e.g.
> musterd/revive/agents/stanley). so i have to remember what team I want, the name of the
> project/repo and what agent I want and also just typing this out in every new terminal window is
> cumbersome. I want to start by just creating a tool (CLI?), where I can open a terminal and type
> "musterd". it would then prompt be which team, which project/repo, which member. The interactive
> mode should be the default but there should also be a non interactive mode. also the flow should
> be extremely user/developer friendly. it should be extremely intuative, sleek, magical, fun,
> repsonsive." — nick, 2026-10-01

**Success:** in any new terminal, `musterd` puts nick in a recent seat with one keystroke and in
any other seat with a few. He never types a path and never runs `cd`.

What exists today (measured 2026-10-01):

- Bare `musterd` prints the help page.
- `packages/cli/src/bin.ts` statically imports all 65 command modules plus OpenTelemetry before it
  does anything. `musterd --version` took 1.4–2.4 s, against 0.16–0.7 s for `node -e 0`. The
  machine was at load average 44, so the absolute numbers are inflated; the ratio is the finding.
- Nothing launches an interactive harness. The host backends spawn headless wakes only
  (`host/backends/claudeCode.ts`), and `buildGovernedLaunchPlan` (ADR 425) has no callers.
- Every Workspace on this machine sits at `~/musterd/<team>/<project>/<member>` (ADR 447) and is
  indexed in `~/.musterd/config.json` under `bindings`.

## 2. Decisions from the brainstorm (nick, 2026-10-01)

| Question                                 | Choice                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| What happens after a seat is picked      | Launch that seat's harness in its Workspace, in this terminal                                           |
| The picker's shape                       | Recent seats with live state, fuzzy search over everything, and team → project → member drill-down     |
| What every level shows                   | What is on this machine versus only on the team, and which entry was used last (nick, mid-session)      |
| Fresh or resumed harness session         | Fresh by default; resume is one key away                                                                |
| Picking a seat that is already live      | Warn, then allow a second session (y/N)                                                                 |
| Non-interactive form                     | The bare seat name: `musterd stanley`, `musterd revive/agents/stanley`; existing commands win          |
| Existing seats only, or create them too  | Create them too: set up a team member's seat here, and `+ new seat`                                     |
| Implementation approach                  | Lean TypeScript in `@musterd/cli` (approach A; Ink and a native Go binary were rejected, §9)            |
| After the harness exits                  | One receipt line, then the shell comes back                                                             |

Three details changed while writing this spec, and nick's review covers them:

1. **Resume is `ctrl-r`, not `r`.** Type-to-search and a bare `r` collide: typing `ryder` would
   resume the highlighted seat. Letters always search; `ctrl-r` resumes; `esc` quits.
2. **The project level lists local folders only.** The Section 1 mockup showed a greyed
   `site ○ no checkout here`. That row cannot be shown honestly: the only off-machine source of
   project names is the lanes' `project` field, and it names repos differently from the folders
   (§4.3), so it would list this very repo a second time as "not here".
3. **"Set up here" offers agent members only.** Setting up another human's seat on your machine
   is not a launcher action.

## 3. The experience

### 3.1 Bare `musterd`

On a TTY, bare `musterd` opens the picker on recent seats. Rows paint from disk at once; the live
column fills in as answers arrive.

```
● ● ○ musterd                                   revive · 17 seats here

  recent
› stanley   revive/agents   claude   ○ idle   ★ last used · 2h
  miley     revive/agents   claude   ● live   here · tty s008 · since 3:37 PM
  gptbot    revive/agents   codex    ○ idle   1d

  ⏎ launch · ⌃R resume · type to search · → browse · esc quit
```

Piped or redirected, bare `musterd` prints the help page, as it does today.

### 3.2 The levels

`→` from the recent view opens the teams. Every level marks what is on this machine (`● here`)
versus only on the team, and stars the entry used last. Typing at any level searches every seat
at once (`rev sta` finds `revive/agents/stanley`), grouped into "on this machine" and "on the team ·
not here", ranked by match quality and then by last use.

```
musterd › teams                         musterd › revive › agents
› revive  ● here  16 seats  ★             on this machine
  dawn    ● here   0 seats              › stanley  claude  ○ idle  ★ 2h
  acme    ○ no Workspace here             miley    claude  ● live  here · s008
                                          gptbot   codex   ○ idle  1d
musterd › revive › projects               nick     human   ○       3d
› agents  ● here  16 seats  ★  musterd    on the team · not here
                                          slate    codex   ● live on mini-2   ⏎ set up here
                                          + new seat
```

- **Teams:** every team this machine holds an identity for. One with no Workspace here is greyed
  and cannot be entered in v1.
- **Projects:** the folders under the team (ADR 447). When the git remote's name differs from the
  folder, it is shown dimmed (`agents … musterd`).
- **Members:** seats with a Workspace in this project on this machine, then the team's agent
  members with none here, then `+ new seat`.

### 3.3 Keys

| Key                    | Does                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `↑` `↓` (`⌃P` `⌃N`)    | Move                                                                         |
| `⏎`                    | Launch a fresh harness session; on a team or project row, enter that level   |
| `⌃R`                   | Resume the seat's last harness session                                       |
| `tab`                  | Next harness, when the seat has several (the row shows which one is chosen)  |
| `→` / `←`              | Into a level / back out                                                      |
| letters, digits, space | Search                                                                       |
| `esc`                  | Clear the search; with no search, go up a level; at the top, quit            |
| `⌃C`                   | Quit (exit 130)                                                              |
| `?`                    | Show the keys                                                                |

### 3.4 What a launch does

- **An agent seat:** the harness starts in the seat's Workspace, in this terminal, and orients
  itself the way it does today (session-start hooks, seat memory, inbox).
- **A human seat** (such as `nick`): your login shell starts in the Workspace.
- **A seat that is already live:** the picker asks first.
  `miley is live here in tty s008 since 3:37 PM. Open a second session in the same folder? (y/N)`,
  or `… is live on mini-2 …` for a Presence on another node.
- **A team member with no Workspace here:** `⏎ set up here` shows where the Workspace will go and
  which harness it gets (`tab` to change), then creates it (§4.7) and launches.
- **`+ new seat`:** asks for a name and harnesses (detected ones preselected), then does the same.
- **A seat whose harness is not installed:** the row is greyed with an install hint; `tab` moves
  to another harness when the seat has one.

### 3.5 When the harness exits

The terminal comes back to your shell with one receipt line, and `musterd` exits with the
harness's exit code:

```
✓ stanley · claude · 42m · exit 0 · musterd - to go back
```

### 3.6 Without the picker

| Command                                              | Does                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `musterd stanley`                                    | Launch fresh; a member name that is unique on this machine is enough    |
| `musterd revive/agents/stanley`                      | The full address, for when a name is ambiguous or shadowed by a command |
| `musterd stanley -r` · `--resume`                    | Resume the last harness session                                          |
| `musterd stanley --harness codex`                    | Pick the harness                                                         |
| `musterd stanley --path`                             | Print the Workspace path and launch nothing (`cd $(musterd stanley --path)`) |
| `musterd -` · `musterd - -r`                         | The last seat again · resume it                                          |
| `musterd stanley --force`                            | Launch even though the seat is live (non-interactive only)               |
| `musterd seats` · `musterd seats --json`             | Every seat on this machine and every team-only member, as the picker sees them |
| `musterd agent <name> …`                             | Create a seat non-interactively (exists today; `+ new seat` reuses it)   |

`musterd <word>` resolves in this order:

1. `<word>` is a command → the command. Commands always win, so a new command can shadow a seat
   name, never the reverse. The full address always reaches the seat.
2. `-` → the seat launched last.
3. An exact address, or a member name unique on this machine → launch.
4. Several matches → on a TTY, the picker opens filtered to `<word>`; otherwise exit 2 and list
   the candidates' full addresses.
5. No match → today's `unknown command` error, with the nearest command and, when close, the
   nearest seat name.

Without a TTY, a live seat is refused (exit 1) unless `--force` is passed.

## 4. Architecture

### 4.1 Units

All new code lives in `packages/cli/src/launcher/` except the two entry changes.

| Unit                                    | Job                                                                                                                         | Depends on               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `bin.ts` (changed)                      | A command table of lazy imports replaces the 65 static ones. Bare `musterd` on a TTY imports only `launcher/`. The `default:` arm tries `resolve` before `unknown command`. | —                        |
| `launcher/catalog.ts`                   | Builds the seat catalog from disk (§4.2). Pure, given a filesystem and env seam.                                             | disk                     |
| `launcher/live.ts`                      | The live layer: roster Presences, team-only members, local liveness and tty, transcript times. Each source is time-boxed.    | daemon, disk, `ps`       |
| `launcher/recents.ts`                   | Reads and writes `~/.musterd/launcher.json` (§4.5).                                                                          | disk                     |
| `launcher/resolve.ts`                   | Turns `stanley`, `revive/agents/stanley` or `-` into one seat, or an ambiguity or no-match result (§3.6).                    | catalog, recents         |
| `launcher/fuzzy.ts`                     | Scores a query against seat addresses and harness names; ties break on last use.                                            | —                        |
| `launcher/plan.ts`                      | (seat, harness, fresh or resume) → `{bin, args, cwd, env}`, from the harness's own launch entry (§4.4).                      | adapter registry         |
| `launcher/supervise.ts`                 | Runs the plan with the terminal handed over, then writes recents and prints the receipt (§4.6).                              | the harness process      |
| `launcher/picker/state.ts`              | Pure state machine: (state, key or live update) → state.                                                                     | —                        |
| `launcher/picker/view.ts`               | Pure renderer: state → screen text. Snapshot-tested.                                                                         | `render/theme.ts`        |
| `launcher/picker/tty.ts`                | The only code that touches the terminal: raw mode, keypress events, repaint, restore.                                        | `node:readline`          |
| `launcher/create.ts`                    | "Set up here" and `+ new seat` (§4.7).                                                                                       | existing provisioning    |
| `commands/seats.ts`                     | `musterd seats [--json]`.                                                                                                    | catalog, live            |

The flow:

1. `musterd` on a TTY imports `launcher/` only.
2. `catalog` reads disk and the picker paints (budget: 150 ms).
3. `live` queries run in parallel; each answer patches rows in place.
4. You pick a seat. A live seat asks y/N; a seat with no Workspace here goes through `create`.
5. `plan` builds the command, the picker restores the terminal, and `supervise` runs the harness.
6. The harness exits; `supervise` writes recents, prints the receipt and exits with the harness's
   code.

### 4.2 Where each fact comes from

| Fact                  | Source                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seats on this machine | `config.bindings` plus a scan of `~/musterd/*/*/*/.musterd/binding.json`, deduplicated by real path. An index entry whose folder is gone is skipped and counted. |
| A seat's harnesses    | `provisioned.json` → `desired` (ADR 281). The default is the harness used last, then the first in registry order.                                       |
| Last used (at paint)  | The newer of `launcher.json` and `binding.json` → `session.started_at` / `ended_at`.                                                                     |
| Last used (live)      | Also the newest transcript, from the harness session enumerators (ADR 166), so a seat launched by hand still sorts correctly.                            |
| Live                  | Roster Presences (any Surface, any node, via `http.roster`), plus local liveness (a transcript written in the last 10 minutes, ADR 166) and `ps` for the tty. |
| Team-only members     | The roster's agent members minus the seats with a Workspace in this project here.                                                                       |
| Teams                 | The identities in `config.json`. A team with no Workspace here is listed greyed.                                                                        |
| Projects              | The folders under each team's directory (ADR 447), with the git remote's name when it differs (§4.3).                                                   |

### 4.3 One repo, three names

This Workspace's repo is `agents` as a folder, `runtime` as the lanes' `project` (derived from
`git rev-parse --git-common-dir`, which points at `~/.musterd/runtime/.git`), and `musterd` as
the remote. The picker uses the folder name, because the folder is what the seat address and the
path contain, and shows the remote name dimmed beside it. Settling the project as one team-level
fact is an input to the next brainstorm (§8), not part of v1.

### 4.4 Launch entries per harness

Each harness adapter in the ADR 281 registry gains a launch entry, so the launcher holds no
per-harness switch and a new harness joins by declaring its own. The forms below were checked
against each CLI's `--help` on 2026-10-01. Binaries resolve through the existing resolvers
(`claudeBin.ts`, `codexBin.ts`, `grokBin.ts`, `opencodeBin.ts`) plus one for `cursor-agent`.

| Harness id         | Fresh                          | Resume, with a recorded session id | Resume, without one          |
| ------------------ | ------------------------------ | ---------------------------------- | ---------------------------- |
| `claude-code`      | `claude`                       | `claude --resume <id>`             | `claude --continue`          |
| `codex`            | `codex`                        | `codex resume <id>`                | `codex resume --last`        |
| `cursor`           | `cursor-agent`                 | `cursor-agent --resume <id>`       | `cursor-agent --continue`    |
| `opencode`         | `opencode`                     | `opencode --session <id>`          | `opencode --continue`        |
| `grok`             | `grok`                         | `grok --resume <id>`               | `grok --continue`            |
| `musterd` (native) | none: it is the headless `musterd host` loop; the row reads "runs under musterd host" | — | — |
| a human seat       | `$SHELL -l`                    | —                                  | —                            |

A recorded id is used only when `binding.json` → `session.harness` matches the chosen harness.

### 4.5 The recents file

`~/.musterd/launcher.json`, located through `machineStatePath` with a `MUSTERD_LAUNCHER` override so
tests never touch the real one (ADR 190):

```json
{
  "version": 1,
  "last": "revive/agents/stanley",
  "seats": {
    "revive/agents/stanley": {
      "path": "/Users/nick/musterd/revive/agents/stanley",
      "harness": "claude-code",
      "mode": "fresh",
      "launched_at": 1790877858628,
      "ended_at": 1790880378628,
      "exit": 0
    }
  }
}
```

It is parsed through a zod schema on read and validated before every write, the ADR 286 §3 rule
applied to a new local file. A corrupt file is renamed aside and rebuilt empty; it never blocks a
launch. It holds no secret.

### 4.6 The supervisor

- `spawn(bin, args, {cwd, env: process.env, stdio: 'inherit'})`. The launcher adds nothing to the
  environment: the seat's identity reaches the harness through the Workspace's MCP registration,
  which already carries `MUSTERD_LAUNCH_SURFACE` (ADR 286).
- While the harness runs, musterd ignores `SIGINT` and `SIGQUIT`, which the terminal also delivers
  to the harness, and forwards `SIGTERM` and `SIGHUP` to it. Harnesses run raw-mode interfaces, so
  `⌃C` and `⌃Z` mostly arrive as keystrokes, not signals.
- A human seat's shell takes job control as usual. The receipt still prints after it exits.
- Exit code: the harness's own; a harness killed by signal `n` gives `128 + n`.
- The receipt goes to stderr, so stdout carries nothing but `--path` and `--json` output.
- Cost while the harness runs: one idle Node process, about 35 MB (bare Node measured 35 MB idle on
  2026-10-01) and no CPU.

### 4.7 Creating a seat

`create.ts` reuses the path `musterd agent` takes today: `addMember` (tolerating an existing
member), then `provisionSeat` (claim credential, standing grant, `binding.json`, permissions floor,
`workspace.json`), then `provisionWorkspace`. It fixes two gaps that `musterd agent` has today, and
`musterd agent` gets the same fixes:

1. It writes `provisioned.json`, the desired harness set from ADR 281. Today only `musterd init`,
   `harness configure`, the reconcile engine and uninstall write it.
2. It wires harnesses through the reconcile engine instead of the single-harness
   `harness.configure`.

The new Workspace is a `git worktree` of a checkout of the same project already on this machine,
started from the remote's default branch after a fetch (`origin/HEAD`), not from whatever branch
that sibling has checked out. With no remote, it starts from the sibling's `HEAD`. A project with
no checkout on this machine cannot be set up in v1. Any failure uses provisioning's existing
rollback, reports the step that failed, and launches nothing.

### 4.8 Invariants

- No `@musterd/protocol` schema changes and no new runtime dependency. The picker is drawn with
  `node:readline` keypress events on the existing `render/` theme.
- Secrets never enter the catalog. It parses `binding.json` through `BindingSchema` and copies
  named non-secret fields only. A test greps every catalog and `--json` output for `mskey_`,
  `msgr_`, `mscr_` and `msla_`.
- Launching an existing seat writes nothing in its Workspace. Only `~/.musterd/launcher.json`
  changes.
- A seat's address is `team/project/member`. When two servers host a team with the same name, the
  rows show the server and the address takes it as `team@host/project/member`, for example
  `revive@musterd.io/agents/stanley`.

## 5. Speed, failures, tests

### 5.1 Speed budget

- **First paint under 150 ms** on an idle machine. Enforced deterministically by an import-graph
  test: the launcher entry's static import closure may not include `@opentelemetry/*`,
  `@clack/*` or any `commands/*` module. The live layer, and with it the HTTP client, is imported
  after the first paint, so it sits outside that closure. A bench script reports the measured time;
  a timing assertion would be flaky in CI.
- **The known risk is zod.** The catalog parses `binding.json` and `provisioned.json` through the
  protocol schemas, so zod is on the paint path. Increment 1 measures that import. If it breaks the
  budget, the catalog imports the two schema modules directly rather than the protocol package's
  root. It never falls back to an unvalidated parse.
- **Under 16 ms from keypress to repaint.**
- **Every live source is time-boxed** (about 300 ms for the daemon). A late answer still patches
  its row; a failed one shows `?` and never blocks the screen or a launch.

### 5.2 Failures

| Situation                                                      | What you see                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Daemon down                                                    | Local seats paint; the header says `offline · live state unavailable`; launching still works      |
| Harness not installed                                          | Row greyed `claude not installed`, with an install hint; `tab` to another harness if the seat has one |
| Broken seat (missing or invalid binding, retired launch marker) | `needs repair` and the exact command (`musterd harness configure`); nothing is repaired automatically |
| Index entry whose folder is gone                               | Skipped; the footer says `2 stale · musterd init --prune-bindings`                                 |
| Ambiguous name or typo                                         | Without a TTY, exit 2 with the candidates; on a TTY, the picker opens filtered; near a command, it suggests the command |
| Live seat, no TTY                                              | Refused with exit 1 unless `--force`                                                               |
| Seat creation fails partway                                    | Provisioning's existing rollback; the error names the failed step; nothing launches                |
| `⌃C` or a crash inside the picker                              | The terminal is always restored (raw mode off, cursor shown) by an exit handler; exit 130          |
| Narrow terminal, `NO_COLOR`, `TERM=dumb`                       | Columns drop off (path first, then harness); plain output with no color                           |

### 5.3 Tests

- **Pure units:** the catalog built from fixture folder trees with an isolated `~/.musterd`
  (ADR 190); resolution (collisions, `-`, command shadowing, typos); fuzzy ranking; the launch
  entry table per harness; recents read, write, and corrupt-file recovery.
- **Picker:** key sequences driven through `state.ts`; snapshot tests of `view.ts` for each
  screen. The new screens get frames in `docs/design/figma-brief-terminal.md`, because CLI output
  must match those frames.
- **Supervisor:** a real spawn of a fake harness script, checking exit codes, signal exits, that
  `⌃C` reaches the child and not musterd, and the receipt line.
- **End to end through `bin.js`:** `musterd seats --json`, `musterd <seat> --path`, the ambiguity
  and live-seat exit codes, and that piped bare `musterd` still prints help.
- **Secrets:** the grep test in §4.8.
- **Speed:** the import-graph test in §5.1.
- **Dogfood:** nick uses `musterd` as his only way into a seat for a week. Every time he still
  types a path or `cd`, that is a bug against this goal.

## 6. Groundwork for the harness and the metaharness

These decisions cost almost nothing in v1 and keep the later options open.

1. **Names for the layers.** Launcher and Metaharness go into the glossary with ADR 491.
   - **Launcher:** what v1 builds. To the user it is just `musterd`.
   - **Metaharness:** musterd owning the process and the terminal around any harness. Today that
     is launching and supervising. Later it can mean owning the terminal itself: a status line, an
     inbox badge, several seats in one window, injected steer and wake, recorded sessions for the
     research corpus.
   - **Harness:** owns the agent loop, and stays Claude Code, Codex, Cursor, OpenCode, Grok.
     ADR 436 decided musterd does not take over the loop and set a date to revisit it. The
     native harness (ADR 251) is the existing exception.
   - **The macOS app** from the 2026-08-20 design: one more view over the same layers. "Replace
     Terminal" means that app plus the metaharness. It stays unnamed for now. The spec first called
     it the console, but [ADR 475](../../decisions/475-cloud-hosted-teams-postgres.md) already
     gives **Console** to `app.musterd.io`, and one word gets one meaning. It is named when work on
     it starts.
2. **Three layers, built once.**
   - **Data:** the catalog and live layer, exposed as `musterd seats --json`. It replaces the
     `musterd sessions --json` the macOS app design planned, so there is one command, not two.
   - **Launch:** the launch plan and the supervisor are the only code that knows how to start a
     harness. The wake backends and ADR 425's governed launch can move onto it.
   - **Faces:** the picker today; the macOS app, deep links and `/live` later. No face holds
     discovery or launch logic.
3. **musterd is the parent process of every harness it launches.** In v1 that buys the receipt
   and recents. It is also where the metaharness grows: the same process can take over the
   terminal later without changing how anyone launches a seat.
4. **Seats have one address,** `team/project/member`, which can later become a
   `musterd://revive/agents/stanley` link that opens a seat from `/live`, Slack or a notification.
5. **Speed is tested,** so the front door does not quietly get slow again.
6. **The project becomes a team fact with one name and a repo URL.** That is what makes setting up
   a project with no checkout here, a second machine, or a Cloud team a single keystroke. It needs
   its own ADR and is an input to the next brainstorm (§8).

## 7. Increments

Every increment is a lane under the `front-door` goal, chained by `depends_on`.

| Increment | Lane                         | Delivers                                                                                                            |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Design    | `01M3WA6YT5FBW479G07YKTJSWB` | This spec, ADR 491 (bare `musterd` opens the picker on a TTY, seat names as a fallback, musterd as the parent process, the recents file, Launcher and Metaharness in the glossary), and the implementation plan |
| 1         | `01M3WA77DFGCEV344M9WTFX6NG` | Fast entry: lazy command loading and the import-graph test. Every command starts faster.                            |
| 2         | `01M3WA7J4YRC21TCGGW9PSDK9E` | Launch by name: catalog, recents, resolve, launch entries, supervisor, receipt; `musterd <seat>`, `musterd -`, `musterd seats` |
| 3         | `01M3WA7W55F50XC6TFV33K21PR` | The picker: search, drill-down with here and last-used marks, the live layer, the live-seat prompt                 |
| 4         | `01M3WA85HQRSA7V08FEQQ489HM` | Create from the picker: set up here, `+ new seat`, and the two `musterd agent` fixes                               |

## 8. Inputs to the what's-next brainstorm (not decided)

- **The metaharness proper:** musterd owns each launched harness's terminal. It needs a
  pseudo-terminal, which means `node-pty` (a native dependency, so an ADR) or a small native
  helper.
- **The macOS app:** lane `01M03AEZ1BVFB7T3FQPVWHNWF9` (open, unowned), and its name. It would
  read `musterd seats --json` and use the launch layer.
- **The project as a team fact** (§6.6).
- **Seat links** (§6.4).
- **Two live sessions on one seat:** lane `01M3TB3EY9502QJBHJ154XTM01` (open) tells both
  sessions. The launcher's y/N prompt is the first warning.
- **ADR 436's dated revisit** of musterd taking over the loop: lane `01M3TB1GPMMH2VKFJ2V97CSP9P`,
  2026-10-21.

## 9. Approaches considered

- **A. Lean TypeScript in `@musterd/cli` (chosen).** One codebase. It reuses the enumerators, the
  provisioning code and protocol parsing at the boundary, and needs no new dependency. Lazy loading
  makes every command faster. musterd stays the parent process, which is the metaharness seam.
- **B. TypeScript with Ink (React for terminals).** A richer component model for a future
  multi-pane terminal interface. Rejected: a new dependency and React on every launch, against a
  150 ms budget, and the heavy interface is the macOS app's job.
- **C. A native Go binary with Bubble Tea.** About 5 ms to start, the best terminal UI toolkit,
  and it could `exec` straight into the harness. Rejected: a second language and toolchain in the
  monorepo, and its data would either duplicate the discovery logic or come from the slow Node CLI,
  which undoes the speed.
- **A zsh function with fzf.** Instant, but shell-specific, unable to create seats, and no path to
  a metaharness.
