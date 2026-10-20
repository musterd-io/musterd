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
| File ownership | none | each agent opens and claims its own lane; musterd's PreToolUse gate refuses an edit outside it (ADR 150) |
| Instruction | task, submission block, coop block, optional git block | the same, with a musterd block in the coop block's place, written to the coop block's shape (`test_prompt.py`) |
| Container network | docker bridge | `--network=host` (below) |

**Lane scopes come from the agents, never from the task.** The only place a task lists the files a
feature touches is `feature.patch`, the reference solution. Seeding lanes from it would hand the
musterd arm the answer's file list, which the coop arm never sees (nick, 2026-10-19).

**Hooks and MCP are musterd's own.** The two hook commands are copied verbatim from
`packages/cli/src/onboard/harnesses/claudeCode.ts`, and `test_config.py` fails if they drift. The
agent containers install this checkout's CLI and MCP server from tarballs (`pack.sh`), so a run
measures the musterd it names in `dist/build.json`.

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
- **The MCP server joins lazily.** Until its first `team_*` call, the hooks carry the dead lease left
  over from admission, and the interrupt hook tells the agent its session is dead. The arm sets
  `MUSTERD_AUTOJOIN=1`.

## Verified so far

- `gate_smoke.py`, a real headless Claude Code on the host with the arm's exact wiring and no Docker
  (2026-10-19, `claude-haiku-5-5`, $0.007): it claimed a lane for `src/a.py` and edited it; its edit
  to `src/b.py` was refused ("'**' is a declared contended surface you have not claimed a lane
  for"); the daemon audited one `lane.gate` deny.
- `tests/`: 12 tests on the hook drift, the prompt's shape, and the adapter's container flow against
  a fake container and host.
- **Not yet verified:** the arm inside a task container on the run machine, and one task end to end
  in both arms. Those need the machine below.

## Running it

One-time, from the repo root, by a human with flyctl logged in:

```bash
deploy/cooperbench/create.sh --org <fly-org>   # app, 50 GB volume, key (asked for with no echo), deploy
```

To rotate the key later, run `deploy/cooperbench/set-key.sh`.

Each session:

```bash
fly machine start --app musterd-cooperbench
fly ssh console --app musterd-cooperbench
# on the machine:
cd /data/runs
PREFIX=/opt/musterd-seat python3 /app/scripts/research/cooperbench/gate_smoke.py         # must print PASS first
cooperbench run -n smoke-coop    -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code         --setting coop
cooperbench run -n smoke-musterd -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop
cooperbench eval -n smoke-coop --backend docker && cooperbench eval -n smoke-musterd --backend docker
exit
fly machine stop --app musterd-cooperbench
```

Each daemon's log and database are copied next to the agent's logs when its pair finishes, so the
team's acts and lanes are part of the run's record.
