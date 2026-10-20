# CooperBench: the musterd arm

**Lane:** `01M5AQE75K` (goal `cooperbench`). **Pilot:** lane `01M5AQEG23`. **OpenHands arm:** lane `01M5B2SJG6`.
**CooperBench:** github.com/cooperbench/CooperBench, MIT, pinned to commit `63b9d44`.
**Code:** `scripts/research/cooperbench/` (the adapter) and `deploy/cooperbench/` (the run machine).

This page makes no claim about results. Lane 2 does, pre-registered.

## What CooperBench measures

A **feature pair** is the unit. Two features from one repository are given to two agents, one each,
in separate containers. A pair passes when both features' test suites pass on what the agents
submit. The headline is the gap between one agent doing both features (`solo`) and two agents doing
one each (`coop`): the paper reports two-agent success about half of solo. The repo now also
benchmarks frameworks on a fixed 10-pair `core` subset in its own `team` setting (a lead and
members, a task list, a scratchpad, an MCP server), and ablates that harness
(`docs/BENCHMARK_RESULTS.md`, `docs/team_harness_ablation_data/` at `63b9d44`).

## The arm

`claude_code_musterd` is CooperBench's `coop` setting on its `claude_code` adapter, with exactly one
thing swapped: the coordination layer.

| | CooperBench `coop` (claude_code) | The musterd arm |
| --- | --- | --- |
| Agent | Claude Code, installed by CooperBench's `setup.sh` | the same |
| Task image, repo, git remote, submission (`patch.txt`), cost parsing | CooperBench's | the same code, called, not copied |
| Messaging | `coop-send` / `coop-recv` shell commands over Redis | the musterd MCP tools (`team_send`, `team_inbox_check`), on a fresh team per pair |
| Hearing a partner mid-run | only when the agent runs `coop-recv` | musterd's PostToolUse interrupt hook, as on any musterd seat |
| File ownership | none | each agent opens and claims its own lane; musterd's PreToolUse gate refuses an edit through the file tools outside it (ADR 150). Bash is ungated (below). |
| Instruction | task, submission block, coop block, optional git block | the same, with a musterd block in the coop block's place, written to the coop block's shape (`test_prompt.py`) |
| Container network | docker bridge | `--network=host` (below) |

**Lane scopes come from the agents, never from the task.** The only place a task lists the files a
feature touches is `feature.patch`, the reference solution. Seeding lanes from it would hand the
musterd arm the answer's file list, which the coop arm never sees (nick, 2026-10-19).

**Hooks and MCP are musterd's own.** The two hook commands are copied verbatim from
`packages/cli/src/onboard/harnesses/claudeCode.ts`, and `test_config.py` fails if they drift. The
agent containers install this checkout's CLI and MCP server from tarballs (`pack.sh`), and each pair's
log records the commit they were built from (`musterd-ref.txt`, from the image's `MUSTERD_REF`).

## How a seat gets onto its team

Per pair, on the run machine (`team.py`):
1. a daemon on a free loopback port with its own database;
2. `team create`, `team add <agent> --kind agent` for each agent, and `team policy --enforce-surface
   '**' --enforce-posture block`, which gates every path;
3. `team bootstrap mint --seat <agent>` for a seat-scoped key (`use: claim_seat`).

In each container (`adapter.py`):
1. it installs the tarballs with `npm install -g --ignore-scripts`;
2. it runs a blocking `musterd claim <agent> --team … --key …`, which the host approves as team admin
   (`requests decide --approve --once`), and the claim session receives the seat credential;
3. it adds `.musterd/` to `.git/info/exclude`, so the binding can never reach the scored patch;
4. it runs Claude Code with `--strict-mcp-config --mcp-config` (the musterd MCP server alone) and
   `--settings` (the two hooks plus CooperBench's own env).

## What building it found

- **The daemon refuses a plaintext non-loopback bind** (ADR 040), and that guard is right. So the
  daemon stays on loopback, and the arm's containers use `--network=host` on the run machine. Network
  mode doesn't change what the agent can do in its repo.
- **The lane gate fails open on any error, and a dead session is an error.** A bootstrap key only
  claims; every other call needs the seat credential and a live session lease. If the MCP server
  isn't holding the session, every edit is silently allowed. A run that never checks would measure a
  musterd arm whose gate does nothing. `gate_smoke.py` is that check, and the pilot must run it on the
  machine before any measured pair.
- **`@musterd/mcp` never started through an npm bin symlink.** It exited 0 without answering, so
  Claude Code showed `CONNECTION_CLOSED`. Fixed in #2974 (lane `01M5BA7C3H`). Until that lands on the
  run machine's build, the arm launches the MCP's real file with `node`.
- **The seat is deaf, and the gate open, until the agent's first musterd call.** The MCP server joins
  on its first MCP tool call, by design, so a health probe never claims the seat. Claude Code defers
  MCP tool schemas behind `ToolSearch`, which makes `ToolSearch` the agent's first call. Until a
  musterd call lands, the hooks carry the dead lease admission left behind: the interrupt hook tells
  the agent "the interrupt line is deaf" on each built-in tool call, and the gate fails open, so an
  edit in that window would go ungated. `MUSTERD_AUTOJOIN=1` alone doesn't help, because autojoin
  also waits for the first MCP call. The arm sets `ENABLE_TOOL_SEARCH=false`, so the musterd tools
  are loaded upfront, and the instruction's first step is `team_inbox_check`, a real seat's first
  move. `gate_smoke.py` now fails if the warning appears. The coop arm has no MCP tools, so turning
  tool search off changes nothing there except that the musterd arm's context holds the musterd tool
  schemas from the start.

- **The first end-to-end run (2026-10-20) scored a musterd arm that wasn't one.** The adapter
  hard-coded the MCP entry at `/usr/local/lib/node_modules`, but the task image's Node, installed
  from Debian packages by CooperBench's `setup.sh`, keeps global modules under `/usr/lib`. The
  musterd MCP server failed to start, the agents had no musterd tools, and the gate failed open on
  every edit (87 `401` responses in the daemon log). The pair still ran and scored, failing on merge
  conflicts like the coop arm. The entry is now resolved with `npm root -g`, and **a run whose
  musterd MCP server isn't `connected` at session start is an error, not a score**.

- **Gating Bash with `**` refused every shell command.** The second e2e run (2026-10-20) was the
  first with musterd working: both agents opened lanes, introduced themselves, found the conflict and
  coordinated over about 20 acts, two of them `request_help`. But the gate matches a Bash call by its
  whole command string, and `**` matches any string, so `git diff` and `git status` were refused 12
  times. The agents wrote `patch.txt` by hand with fake blob hashes, and neither patch applied. The arm
  now gates the file-editing tools (`Edit|Write|MultiEdit|NotebookEdit`) and leaves Bash ungated. An
  edit made through Bash (`sed -i`, `cat >`) is not lane-checked, so the arm's lane ownership covers
  edits through the file tools only.

## Verified so far

- `gate_smoke.py`, a real headless Claude Code with the arm's exact wiring (`claude-haiku-5-5`): it
  claimed a lane for `src/a.py` and edited it; its edit to `src/b.py` was refused ("'**' is a
  declared contended surface you have not claimed a lane for"); the daemon audited one `lane.gate`
  deny. PASS on this Mac with no Docker (2026-10-19, $0.007), PASS on the Fly run machine (2026-10-20,
  $0.005), and PASS with no deaf warning after the first-call fix (2026-10-20, $0.012).
- `tests/`: 12 tests on the hook drift, the prompt's shape, and the adapter's container flow against
  a fake container and host.
- **Not yet verified:** the arm inside a task container on the run machine, and one task end to end
  in both arms.

## Running it

One-time, from the repo root, by a human with flyctl logged in:

```bash
deploy/cooperbench/create.sh --org <fly-org>   # app, 50 GB volume, key (asked for with no echo), deploy (one machine)
```

To rotate the key later, run `deploy/cooperbench/set-key.sh`.

Each session:

```bash
fly machine start --app musterd-cooperbench
fly ssh console --app musterd-cooperbench
# on the machine:
cd /data/runs
PREFIX=/opt/musterd-seat python3 /app/scripts/research/cooperbench/gate_smoke.py   # must print PASS first
cooperbench run -n smoke-coop    -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code         --setting coop
cooperbench run -n smoke-musterd -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop
cooperbench eval -n smoke-coop --backend docker && cooperbench eval -n smoke-musterd --backend docker
exit
fly machine stop --app musterd-cooperbench
```

Each daemon's log and database are copied next to the agent's logs when its pair finishes, so the
team's acts and lanes are part of the run's record.
