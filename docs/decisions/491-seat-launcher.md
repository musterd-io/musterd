# 491 — The seat launcher: bare `musterd` opens a seat picker and musterd becomes the harness's parent process

- Status: accepted
- Date: 2026-10-01
- Deciders: nick (directed the brainstorm and approved the spec), stanley (lane
  `01M3WA6YT5FBW479G07YKTJSWB`)
- Spec: `docs/superpowers/specs/2026-10-01-front-door-launcher-design.md`
- Goal: `front-door`
- Relates to: [ADR 281](281-multi-harness-worktree-selection.md) (the harness adapter registry and <!-- vocab:ok -->(slug predates ADR 296 vocabulary)
  the desired harness set), [ADR 286](286-launcher-surface-convergence.md) (the launch marker that
  names a Presence's Surface), [ADR 425](425-governed-launcher-adapter-handoff.md) (the governed
  launch plan), [ADR 436](436-wake-edge-is-a-contract-not-a-loop.md) (musterd does not take over
  the agent loop), [ADR 447](447-team-first-workspace-layout.md) (the
  `~/musterd/<team>/<project>/<member>` layout), [ADR 475](475-cloud-hosted-teams-postgres.md)
  (which already gives the word "Console" to `app.musterd.io`), [ADR 190](190-vitest-machine-state-isolation.md)
  (tests never touch `~/.musterd`)

## Context

To work as a seat today, nick opens a terminal, types `cd ~/musterd/revive/agents/stanley`, and
starts the harness by hand. He has to remember the team, the project folder and the member, and
type the path in every new terminal. Bare `musterd` prints the help page.

The pieces a launcher needs mostly exist. `~/.musterd/config.json` indexes every Workspace on the
machine under `bindings`; each Workspace's `.musterd/provisioned.json` holds its desired harnesses
(ADR 281) and `.musterd/binding.json` records its last harness session. The daemon roster says who
is present where, and the session enumerators ([ADR 166](166-session-liveness-by-enumeration.md))
say whether a harness session is live.
`musterd agent` already provisions a seat non-interactively. What does not exist is anything that
starts an interactive harness for a seat: the host backends spawn headless wakes only, and ADR 425's
governed launch plan has no callers.

Four measurements framed the design, all taken 2026-10-01 on a machine at load average 44, so the
ratios are the finding rather than the absolute times:

- `musterd --version` took 1.4–2.4 s against 0.16–0.7 s for `node -e 0`, because `bin.ts`
  statically imports all 53 command modules (65 import statements) and OpenTelemetry.
- A cold import of `@musterd/protocol` took about 740 ms, zod alone 89 ms.
- The session enumerators are synchronous and took 0.3–3 s per scan, blocking the event loop.
- One repo carries three names: the folder `agents`, the lanes' project `runtime` (from
  `git rev-parse --git-common-dir`), and the remote `musterd`.

## Problem

Getting into a seat should take one keystroke for a recent seat and a few for any other, with no
path to remember and no `cd`, interactively by default and by name in scripts. The launcher has to
feel instant on a CLI that today takes over a second to print its version, must not leak the
secrets in `binding.json`, and should not lock out the larger direction nick wants: musterd owning
the terminal around every harness.

## Decision

1. **Bare `musterd` on a TTY opens the seat picker.** It lists recent seats first, searches every
   seat as you type, and drills down team → project → member. Every level marks what is on this
   machine and what is only on the team, and which entry was used last. Piped or redirected, bare
   `musterd` prints the help page as before; `musterd help` is unchanged.
2. **A word that is not a command is a seat address.** `musterd <word>` resolves, in order: a
   command (commands always win); `-` (the seat launched last); an exact address
   (`team/project/member`, or `team@host/project/member` when two servers host same-named teams) or
   a member name unique on this machine. Several matches open the picker filtered to the word on a
   TTY and exit 2 with the candidates' addresses otherwise. No match keeps today's
   `unknown command` error, which also suggests the nearest seat name when one is close. Flags:
   `-r`/`--resume`, `--harness <id>`, `--path` (print the Workspace path and launch nothing), and
   `--force` (launch a live seat without a TTY, which is otherwise refused with exit 1).
3. **musterd is the parent process of every harness it launches.** It spawns the harness in the
   seat's Workspace with the terminal handed over (`stdio: 'inherit'`), ignores `SIGINT` and
   `SIGQUIT` while it runs, forwards `SIGTERM` and `SIGHUP`, and exits with the harness's code
   (`128 + n` for a harness killed by signal `n`), printing one receipt line to stderr. It adds
   nothing to the harness's environment: identity still arrives through the Workspace's MCP
   registration and its `MUSTERD_LAUNCH_SURFACE` marker (ADR 286). This owns the process, not the
   agent loop; ADR 436 stands.
4. **A harness session starts fresh unless resume is asked for.** `⌃R` in the picker or `-r` by
   name resumes through the harness's own resume: with the session id recorded in `binding.json`
   when its harness matches, otherwise with the harness's continue-most-recent form.
5. **Each harness declares its own interactive launch.** Every adapter in the ADR 281 registry
   gains a launch entry (fresh, resume with an id, resume without one); the launcher holds no
   per-harness switch. The native `musterd` harness is the headless `musterd host` loop and has no
   interactive entry. A human seat launches the member's login shell in the Workspace.
6. **A seat that is already live is launched again only after a warning.** Live means a Presence on
   the team's roster. The picker names where it is live (here or another node), with its harness and
   since when, and asks y/N; without a TTY it needs `--force`.
7. **One read model for every face.** A seat catalog built from `config.bindings` plus a scan of the
   ADR 447 layout, overlaid with the roster and recents, is what the picker shows and what
   `musterd seats [--json]` prints. It parses `binding.json` through `BindingSchema` and copies named
   non-secret fields only; no secret reaches the catalog or its output. Future faces, such as a
   macOS app, read this catalog rather than enumerating seats themselves.
8. **Recents and a catalog snapshot live in `~/.musterd/launcher.json`.** Machine-local and
   secret-free (the snapshot carries no harness session id), beside `config.json` so the
   `MUSTERD_CONFIG` override isolates it in tests (ADR 190), parsed through a zod schema on read and
   validated before every write. A corrupt file is set aside and rebuilt empty; it never blocks a
   launch. "Last used" is the newer of this file and the session start recorded in `binding.json`.
9. **The launcher stays fast by construction.** `bin.ts` loads commands lazily. The first screen
   paints from the snapshot, parsed with zod alone; the catalog scan, which needs the protocol
   schemas, and the roster reads run after it, each time-boxed, and patch rows in place. The
   launcher entry's static import closure may not include `@musterd/protocol`, `@opentelemetry/*`,
   `@clack/*`, `ws`, `client.ts`, `config.ts` or any `commands/*` module, and a test enforces it.
   Nothing synchronous and slow runs on the picker's thread, so the launcher does not use the session
   enumerators. The target is a first paint under 150 ms on an idle machine, reported by a bench
   script rather than asserted in CI.
10. **Creating a seat reuses `musterd agent` and fixes it.** "Set up here" (an agent member with no
    Workspace on this machine) and `+ new seat` take the `musterd agent` path, which also gains three
    fixes: it writes `provisioned.json`; it wires harnesses through the reconcile engine instead of
    the single-harness `harness.configure`, whose empty environment strips the
    `MUSTERD_LAUNCH_SURFACE` marker from the repo-shared Claude Code entry (ADR 286); and a failure
    after the credential is minted revokes that credential. It acts as you, from your own human
    seat's Workspace in the same team and project, because the CLI writes only as a folder-bound
    identity (ADR 036, ADR 442); without one, the launcher says how to make it. A new Workspace is a
    `git worktree` of that checkout, started from the remote's default branch, not from whatever
    branch the checkout has open. A project with no checkout on this machine cannot be set up from
    the launcher.
11. **The glossary gains two words.** **Launcher**: the seat picker and the code that starts a seat's
    harness in its Workspace; not the harness registration that marks a Presence's Surface
    (ADR 286). **Metaharness**: musterd owning the process and terminal around any harness, which
    today means launching and supervising it; never the agent loop, which stays with the harness
    (ADR 436).

## Alternatives rejected

- **Ink (React for terminals).** A richer component model for a multi-pane terminal interface,
  but a new runtime dependency and React on every launch against a 150 ms budget.
- **A native Go binary with Bubble Tea.** About 5 ms to start and it could `exec` into the harness,
  but it adds a second language and toolchain, and its data would either duplicate seat discovery
  or come from the slow Node CLI.
- **A zsh function with fzf.** Instant, but shell-specific, unable to create seats, and with no path
  to a metaharness.
- **An explicit verb (`musterd open stanley`).** Collision-proof, but nick chose the bare name;
  commands winning plus the full address covers the collision case.
- **Resume by default.** Feels continuous, but transcripts grow long and stale contexts mislead;
  orientation from seat memory and the inbox is the continuity mechanism
  ([ADR 430](430-wake-context-packet-v2.md)).
- **Jump to the tab where a live seat runs, or hide live seats.** nick chose a warning that still
  allows a second session.
- **"Console" for the macOS app.** ADR 475 already gives "Console" to `app.musterd.io`; reusing it
  would give one word two meanings. The macOS app is named when work on it starts.

## Consequences

- Bare `musterd` on a terminal no longer prints help. Anyone who relied on that types
  `musterd help`; piped and redirected output is unchanged.
- A new command can shadow a seat with the same name. The full address always reaches the seat, so
  nothing becomes unreachable.
- Each launched harness has an idle Node parent of about 35 MB for its whole run.
- Two harness sessions on one seat become possible by explicit choice. Telling both sessions about
  each other is lane `01M3TB3EY9502QJBHJ154XTM01` (open); the launcher's prompt is the first
  warning.
- Lazy command loading changes how every command is imported, so every command starts faster, and
  the CLI end-to-end suite has to stay green across that change.
- The picker shows a project by its folder name, with the remote's name dimmed when different.
  Making the project a team-level fact with one name and a repo URL would let the launcher set up a
  project with no checkout here; that needs a decision of its own and is not taken here.
- New screens get frames in `docs/design/figma-brief-terminal.md`, as CLI output must match them.
- The work lands in four lanes under goal `front-door`, chained by `depends_on`: fast entry
  `01M3WA77DFGCEV344M9WTFX6NG`, launch by name `01M3WA7J4YRC21TCGGW9PSDK9E`, the picker
  `01M3WA7W55F50XC6TFV33K21PR`, and creating seats `01M3WA85HQRSA7V08FEQQ489HM`.
- **2026-10-01 — increment 1 measured** (PR #1931). `pnpm bench:cli-start`, 15 runs per probe,
  before and after in one session at load average 7–11: `musterd --version` median 317 ms → 61 ms,
  `musterd help` 327 ms → 91 ms, against a `node -e 0` floor of about 49 ms (lane
  `01M3WA77DFGCEV344M9WTFX6NG`).
- **2026-10-01 — increment 3 measured.** `pnpm bench:cli-start` first-paint median 118 ms (p90 136 ms)
  at load average about 5, against a `node -e 0` floor of 77 ms in the same run and the 150 ms target
  (lane `01M3WA7W55F50XC6TFV33K21PR`).

## Observability & Evaluation

- **Traces:** none in this decision. OpenTelemetry is kept off the launcher's path on purpose
  (Decision 9). The local evidence is `~/.musterd/launcher.json` and the receipt line, and neither
  holds a secret.
- **Eval:** three automated checks run in CI.
  - *Secrets.* A test runs every catalog, snapshot and `--json` output through
    `containsMusterdCredential`, which knows every registered credential prefix. Any hit fails the
    build.
  - *Import closure.* The import-graph test fails the build when the launcher entry's static
    closure reaches `@musterd/protocol`, `@opentelemetry/*`, `@clack/*`, `ws`, `client.ts`,
    `config.ts` or `commands/*`.
  - *Terminal frames.* Snapshot tests hold every picker screen to its frame in
    `docs/design/figma-brief-terminal.md`.
- **Experiment:** two measured claims, each with a falsifier.
  - *Adoption.* For the seven days after the picker's lane (`01M3WA7W55F50XC6TFV33K21PR`) closes,
    nick reaches seats through `musterd` only. Falsifier: three or more times in that week he types
    a Workspace path or `cd` to reach a seat. If that happens, the picker's shape is reopened.
  - *Speed.* The bench reports first paint on an idle machine once the picker lands. Falsifier: a
    median above 150 ms. If that happens, approach C (a native front end over
    `musterd seats --json`) is reconsidered.
