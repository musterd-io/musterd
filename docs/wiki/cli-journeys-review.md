# CLI journeys review

The first-run, recovery and accessibility journeys of the `musterd` CLI, run end to end against a throwaway daemon on 2026-10-29 (lane `01M61VTA64`). Four findings became lanes, one has a named follow-up, and three paths are left for a human because only a human can walk them.

## How it was run

Source build of `main` plus [ADR 758](../decisions/758-write-commands-json.md), at 2026-10-29 10:56 local. The daemon ran with `musterd serve --port 4961` on its own `MUSTERD_DB` in a scratch folder. Each person ran the CLI through a wrapper that set `HOME`, `MUSTERD_CONFIG` and `MUSTERD_SERVER` to that person's own scratch paths. So no command touched `~/.musterd` or the live team. Two humans (`nick`, `ada`) and one agent (`scout`) were on a team named `jtest2`.

Re-run it: start a daemon on a spare port with its own `MUSTERD_DB`, then run every command with `HOME` pointed at an empty folder.

## Findings, most serious first

Each finding names the lane that carries it. F1 and F2 can hit a new user on their first day.

### F1 — `team create` on a new machine crashes after making the team (2026-10-29; falsify: with `HOME` an empty folder, `musterd team create x --member me` exits 0) <!-- claim: defect -->

`withConfigLock` in `packages/cli/src/config.ts` opens `~/.musterd/config.json.lock` before anything has created `~/.musterd`. The command fails with `✗ ENOENT: … config.json.lock` and exit 1. By then the daemon has already created the team. A retry answers `✗ team "x" already exists` with exit 9, and the person never sees the credential. The team is orphaned. `claim` on the same fresh home worked, because its path makes the directory. Lane `01M64D0JSY`.

### F2 — `send <name> "…"` broadcasts to the team (2026-10-29; falsify: `musterd send nick "hi" --act request_help` is refused or goes to nick) <!-- claim: defect -->

With no `--to`, `send` falls back to `@team` without saying so. The intended recipient's name becomes the first word of the body (`→ @team · nick hi, can you look at the plan?`). Writing the recipient first is the natural shape, and the result reaches everyone. Lane `01M64D0N77`.

### F3 — wrapped help lines lose their indent (2026-10-29; falsify: in `musterd help lane | cat`, every line under `show <id>` keeps its two-space indent) <!-- claim: defect -->

A help detail line that fits keeps its indent and padded columns. One that wraps is printed flush left with its padding collapsed, so `show <id> [--json] one lane in full…` loses its alignment. A sentence also breaks so that the single word `from` sits on a line of its own. `help team` shows the same thing. An example longer than the width prints as a bare `$` with the command on the next line (`help send`). Lane `01M64D0RKS`.

### F4 — `done --pr --sha` skips the evidence check `lane submit` runs (2026-10-29; falsify: `musterd done <id> --pr 1 --sha deadbeef` in a clone without that SHA records an unconfirmed `commit_landed` claim) <!-- claim: defect -->

`done` with a merge attestation is documented as the same act as `lane submit`. But it sends the PR and SHA without checking them in the clone (ADR 585) and without the change label (ADR 612). The SHA `deadbeef` was accepted and the lane went to `awaiting_acceptance`. Lane `01M64D0VC4`.

### F5 — `claim` tells a human that "the agent here" will occupy the seat (2026-10-29; falsify: `musterd claim <human> --key …` prints copy addressed to a person) <!-- claim: defect -->

`✓ ada — occupied on jtest2` is followed by `the agent here will occupy it on launch (or call team_join)`. ada is a human, so that line is about something that will not happen. Small, but it is the second thing a new person reads. Folded into lane `01M64D0N77` with the other copy in the messaging path.

### F6 — `--json` is global but not honoured everywhere (2026-10-29; falsify: every command in `commandTable.ts` either prints JSON or refuses `--json`) <!-- claim: defect -->

The lane writes and `done` were fixed by ADR 758. Other commands still take the flag and print prose on some paths. Follows-up: 01M64CN3VY

## What held up

- **The daemon going away.** `send`, `status`, `done` and `lane open --json` each printed one line naming the server and `musterd serve`, with exit 7. `send` also printed the unsent body back: "nothing was lost but the delivery". After a restart, everything came back without a re-claim.
- **Joining a team.** `team add ada --kind human` printed the exact `musterd claim …` line to pass on. ada ran it from a fresh home and was on the team in one step.
- **First agent.** `musterd agent scout` from a folder outside any repo made the folder, wired the MCP server for Claude Code, and named the next command.
- **Submit with nobody to accept.** The routing line said why no one was asked (`not_agent: ada`) and which command to run.
- **Narrow status.** `status` at 40 columns kept its sections and its empty-state copy.

## Not covered — needs a human

- **A real passkey.** The ceremony opens a browser and needs a person's authenticator. The tests mock it (`done.test.ts`); nobody walked it here.
- **Interactive `musterd init`** in a terminal. The picker and prompts need a TTY and someone to answer them.
- **Launching the first agent** (`musterd scout`). It starts a real harness session that bills against the person's account.
- **Warmth and feel.** Whether the copy feels right is a human's call. That is lane `01M61VV4TX`.

An interrupted write (the connection dropping after the daemon has the request) was not reproduced. `client.ts`'s exit 7 "outcome unknown" path is covered by unit tests only.
