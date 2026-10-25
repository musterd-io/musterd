# CooperBench: the musterd arm

**Lane:** `01M5AQE75K` (goal `cooperbench`). **Pilot:** lane `01M5AQEG23`. **OpenHands arm:** lane `01M5B2SJG6`.
**CooperBench:** github.com/cooperbench/CooperBench, MIT, pinned to commit `63b9d44`.
**Code:** `scripts/research/cooperbench/` (the adapters) and `deploy/cooperbench/` (the run machine).

This page makes no claim about results. Lane 2 does, pre-registered: [pilot manifest](./pilot-manifest.md),
scored as [finding 015](../015-cooperbench-pilot.md) (2026-10-21: 2/10, no claim).

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
  **Retired 2026-10-21 (finding 019 fixes A+B, ADR 705/707):** the MCP server now joins at session
  start (before any tool call, after a probe grace), and `team_inbox_check {wait, until_lane}` is
  the blocking wait, so the arm no longer sets `ENABLE_TOOL_SEARCH=false` and the instructions name
  the one-call wait instead of polling. Always-loaded surface, measured 2026-10-21 on this build
  with `measureToolSurface` (tools/list JSON, bytes/4): all 31 tools 21,713 B ≈ 5,428 tokens; the
  four hot tools that load up front 3,002 B ≈ 751 tokens, plus the server instructions — against
  pilot 3's 39.6k first-call context (a runtime ruler, not this one; the residual is the ~4k
  finding 019 assumed). Falsifier: a first-call context on the claim run materially above the
  team arm's, with tool search on, puts the 16k back on the table. The gate/hold smokes and one smoke pair still owe a run on the next
  run-machine start — the local attempt on 2026-10-21 could not start its scratch daemon in the
  seat's sandbox, so no PASS is claimed here; the claim run's pre-flight (below) is where they run.

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

- **The Claude Code musterd arm never reached the shared git remote (found 2026-10-21, lane
  `01M5G6AGDY`).** Its containers use `--network=host`, where the git server's container name
  `cooperbench-git` does not resolve. The OpenHands arms rewrote the URL to the server's bridge IP;
  this arm did not, so every musterd agent's `git fetch` / `git push` to `team` failed in pilot 1 and
  pilot 2, and a failed setup was only logged as a warning. Both arms now take the URL from
  `team.host_reachable_git_url`, and the adapter runs `git ls-remote --heads team` after setup: a
  remote the agent cannot reach is an **error**, re-run once, never a score. Findings 015 and 016
  carry dated corrections.

## Verified so far

- `gate_smoke.py`, a real headless Claude Code with the arm's exact wiring (`claude-haiku-5-5`): it
  claimed a lane for `src/a.py` and edited it; its edit to `src/b.py` was refused ("'**' is a
  declared contended surface you have not claimed a lane for"); the daemon audited one `lane.gate`
  deny. PASS on this Mac with no Docker (2026-10-19, $0.007), PASS on the Fly run machine (2026-10-20,
  $0.005), and PASS with no deaf warning after the first-call fix (2026-10-20, $0.012). **On Claude
  Code 2.1.307 it could not pass as then written** (finding 025 pre-flight, 2026-10-24): Edit and Write
  refuse a file the session has not read, and the smoke gave the model no Read tool, so neither edit
  reached the gate (three FAILs, `gate_denies=0`). The smokes now allow `Read(src/**)` and read before
  they edit (lane 01M5R2G1Q3); the gate wiring is unchanged, and a Read-allowed copy passed on that
  build ($0.0035). The arm's settings also carry ADR 730's PostToolUse push hook (matcher `Bash`),
  pinned to `claudeCode.ts` like the other two.
- `tests/`: 39 tests on the hook drift, the prompts' shape, both adapters' flows, and the OpenHands shims, against
  a fake container and host.
- **One task end to end in both arms** (done-when 4), on the run machine, `pallets_click` task 2068,
  features 1 and 2, `claude-sonnet-4-5`, `--setting coop` without `--git`, on 2026-10-20:

  | Arm | Patches | Coordination | Eval | Cost |
  | --- | --- | --- | --- | --- |
  | `claude_code` (coop) | both applied | 0 messages recorded | merge conflicts, so no tests ran | $1.14 |
  | `claude_code_musterd` (run 3, musterd `985bb9bc`) | both applied (real `git diff`) | 2 lanes, 10 messages, 5 gated edits allowed, 0 refused | merge conflicts, so no tests ran | $1.27 |

  Runs 1 and 2 of the musterd arm don't count. Their findings are above: no MCP server, and Bash
  gated. This is a check that both arms run and score, not a result. Lane 2 makes result claims.

## The OpenHands arms (lane `01M5B2SJG6`)

The paper's own harness is OpenHands, so the comparison is also run there:
`openhands_sdk_docker` (the plain coop arm) and `openhands_sdk_musterd`
(`musterd_cooperbench/openhands.py`). Both call CooperBench's `OpenHandsSDKRunner.run` at `63b9d44`.

| | `openhands_sdk_docker` | `openhands_sdk_musterd` |
| --- | --- | --- |
| Sandbox | the published `-oh` image, in docker on the run machine | the same |
| Agent, tools, condenser, patch extraction, cost | CooperBench's (OpenHands SDK v1.10, vendored) | the same, minus the inert `send_message`/`receive_message` |
| Messaging | `send_message` over Redis | the musterd MCP tools, on a fresh team per pair |
| Hearing a partner mid-run | Redis inbox injected as a user message before every step | `musterd inbox --interrupt-check` injected in the same slot |
| File ownership | none | the ADR 150 gate as an OpenHands PreToolUse hook on `file_editor` writes |
| System prompt | CooperBench's collaboration section | the musterd section in the same slot, written to its shape (`test_openhands.py`) |

**Why not Modal.** CooperBench's OpenHands adapter starts each agent in a Modal cloud sandbox. The
daemon only listens on loopback (ADR 040), so a Modal sandbox can't reach it without a public TLS
endpoint per pair carrying seat credentials. Both arms run the same `-oh` image in local docker
instead, so the swap is the same for both (nick, 2026-10-20). The image's agent-server listens on
`127.0.0.1` on its own port, on the host network.

**OpenHands does have a PreToolUse hook.** The lane brief assumed it didn't. SDK v1.10 runs
Claude-Code-style command hooks, but only inside the agent-server; the client's `RemoteConversation`
runs session hooks alone. So the arm ships musterd to the agent-server as an OpenHands **plugin**
(`hooks/hooks.json` and `.mcp.json`), which the server loads with the conversation. No daemon-side
gate and no patch to OpenHands' tool layer was needed. The hook runs `oh-gate.mjs`, which only
translates: OpenHands' event in, musterd's own `gate check` run, musterd's verdict back out as
`{"decision": "deny"}`. A `view` is a read and isn't sent, because the gate matches on a path
whatever the tool. Terminal calls are ungated, as in the Claude Code arm.

**The interrupt slot is a patch, as the plain arm's is.** OpenHands' PostToolUse hooks can't add
text to the conversation. The plain arm hears its partner because CooperBench's fork polls Redis
before every step. The musterd arm adds musterd's interrupt check to that same function
(`musterd_oh_inbox.py`, loaded by a `.pth` file only when `MUSTERD_OH_INTERRUPT=1`), so both arms
hear their partner at the same moment (nick, 2026-10-20). Like the Claude Code hook, the line is
re-raised each step until the agent reads its inbox.

**What a run must show.** A musterd run with no musterd tool call is an error, not a score, as in
the Claude Code arm. `oh_gate_smoke.py` runs the real arm on one container and passes only if the
lane let one edit through, the gate refused one and the daemon audited it, a `⚡ musterd` line reached
the conversation, and the agent made musterd calls. Run it before any measured pair.

**What the first smoke runs found (2026-10-20, on the run machine, musterd `6fee95a5`).** It took
five runs to PASS, and each failure was a real one:

- **No Claude 5.x model in the OpenHands arms.** The images' OpenHands doesn't know `claude-*-5-*`,
  so it sends `temperature`, and the API refuses it ("`temperature` is deprecated for this model") on
  the first call. The smoke runs `claude-haiku-4-5`, and the pair runs use `claude-sonnet-4-5`, which
  OpenHands already handles.
- **The interrupt slot was deaf the whole run.** The plugin's MCP server started without a cwd, so
  it never found the seat's binding in the repo, and its live lease never reached the binding that
  `inbox --interrupt-check` reads. It now starts from `/workspace/repo`. The check at step 0 still
  runs before the MCP server joins. That one "deaf" line goes to the agent-server's log, not the
  conversation, because the Claude Code arm never sees it either. Only a `⚡` line is injected.
- **The smoke itself had three false readings.** The task text mentioned "⚡ musterd", which matched
  as a delivered line. A bare file-name match counted edits that never happened. A steer sent before
  the run was read by the agent's first `team_inbox_check`, leaving the interrupt slot nothing to
  deliver. The smoke now requires the `[team]:` tag and a diff header, and it sends the steer once
  the lane is open. It also saves `events.txt` and `patch.diff`.

**The first pair (2026-10-20, `claude-sonnet-4-5`) measured nothing, and found three more.**
`oh-coop` cost $4.69: agent1 hit the cost limit, and agent2 died on the API's "The final block in
an assistant message cannot be `thinking`". `oh-musterd` cost $2.03, and both agents submitted.
CooperBench's eval then failed both with "Failed to write patch1.patch". Fixed since:

- **The seat died 15 s in.** In docker the agent-server was PID 1, so the MCP server it spawned had
  ppid 1, which the adapter's session ladder (ADR 164) reads as "harness exited". It released the seat
  at its first heartbeat, and every musterd call after the first failed with an empty error. So did
  every gate check (fail open, unaudited) and every interrupt check. Neither agent opened a lane or
  sent an act, and the arm's "no musterd call" check passed on the one call that landed. The smoke
  had passed only because Haiku made all its musterd calls inside those 15 s. Containers now run
  with `--init`, as Modal's do. The smoke now sleeps 25 s before a last musterd call, and fails on
  any MCP error or `presence.session_ended`.
- **The agent-server's state was in the patch.** It writes `workspace/conversations/…` and
  `workspace/bash_events/…` under its cwd, which was the image's WORKDIR, the repo. `git add -A`
  took them, and the patches reached 0.5 to 1.1 MB, past what the eval passes to `bash -c`. The
  server now runs from `/`, as Modal's `workdir="/"`. The two runs were re-scored with those files
  stripped (originals kept as `*.patch.orig`): `oh-coop` merged clean, because agent2's patch was
  empty, with feature 1 failing and feature 2 passing; `oh-musterd` had merge conflicts.
- **Extended thinking is off in both OpenHands arms.** OpenHands turns it on for Anthropic models by
  default (a 200k budget), and on a long run it replays an assistant message that ends in a thinking
  block. This departs from CooperBench's own `openhands_sdk` arm, but applies to both arms alike.

PASS again after these (run 6, $0.045): the seat lived through `sleep 25`, and `team_status` after it
answered "3 members · 2 present". PASS (run 5, `claude-haiku-4-5`, $0.02): the lane let `smoke-a.txt` through, the hook refused
`smoke-b.txt` ("'**' is a declared contended surface you have not claimed a lane for") and the
daemon audited the deny, and the steer arrived mid-run as `⚡ musterd [team]: steer from me …`. That
also shows the image's agent-server loads plugins. The `-oh` images install `openhands-agent-server`
unpinned, so a rebuilt image is checked again by the same smoke. With `--git`, the runner's docker
git server is reached by its bridge IP, because host-network containers can't resolve its container
name.

**One pair end to end in both arms (done-when 4b), 2026-10-20**, on the run machine with musterd
`f4d92bc4` and `claude-sonnet-4-5`, `pallets_click` task 2068, features 1 and 2, `--setting coop`
without `--git`:

| Arm | Agents | Coordination | Eval | Cost |
| --- | --- | --- | --- | --- |
| `openhands_sdk_docker` (`oh-coop2`) | agent2 submitted; agent1 stuck after 59 steps, empty patch | Redis messages (not counted) | merged clean; feature 1 failed, feature 2 passed | $2.01 |
| `openhands_sdk_musterd` (`oh-musterd2`) | agent1 submitted; agent2 stuck after 67 steps, empty patch | 2 lanes, 11 messages, 4 gated edits allowed, 1 refused | merged clean; feature 1 passed, feature 2 failed | $1.65 |

The musterd pair found the overlap within a minute ("I see our changes overlap"), agreed an order
("You go first with the renaming … I'll wait for you to finish"), and agent1 announced "Done!" two
minutes later. By then agent2 was gone. It had polled `team_inbox_check` five times in a row with
nothing in between, and OpenHands' stuck detector ended the conversation ("Remote conversation got
stuck"). The plain arm lost agent1 the same way, polling `receive_message`. Both arms hit it, so the
pair is a check that both run and score, not a result.

Follows-up: lane 01M5AQEG23 decides how a waiting agent survives OpenHands' stuck detector (in both arms) before any measured pair.

## The task images' local `main` is not the task base (lane `01M5E8CHBT`, 2026-10-21)

Every CooperBench task image checks the repository out at the task base as a detached HEAD and
keeps the upstream repository's `main` branch beside it, at a later commit (`openai_tiktoken:task0`:
HEAD `4560a88`, `main` `08a5f3b`; the same shape in `pallets_jinja:task1621` and `typst:task6554`).
CooperBench's `build_git_setup_command` pushes the base to the shared remote as `team/main` and the
git block tells the agent "Base reference: `team/main`", but the stale local `main` stays. In the
first pilot two of twenty agents wrote `git diff main -- <file> > patch.txt`: a diff against the
wrong commit, which failed to apply on the base (`apply_status: failed`), so those two pairs were
decided by a branch name. The other eighteen used a commit sha or `team/main` and were fine.

`musterd_cooperbench/pin_main.py` adds one step to that same setup command, `git branch -f main
HEAD`, so `main` and `team/main` both name the base. It replaces the symbol CooperBench's own
adapters import, and the package is imported for every run on the machine
(`COOPERBENCH_EXTERNAL_AGENTS`), so the plain coop arm, the team arm and the musterd arm run the
identical setup. A harness fix that reached one arm only would be a thumb on the scale; this one
reaches all three or none. `tests/test_pin_main.py` pins that. It belongs upstream as an image or
harness fix and is kept here until a pinned CooperBench carries it.

## Notes for the pilot (lane `01M5AQEG23`)

- **A waiting OpenHands agent is killed as stuck.** Agreeing an order is good coordination, but the
  agent that agrees to wait has no way to wait in OpenHands. Repeating one call, or emitting empty
  messages, trips the SDK's stuck detector, and its feature ships empty. Both OpenHands arms lost one
  agent this way in the 2026-10-20 pair. Before measuring, either tell both arms' agents how to wait
  (for example, `sleep` in the terminal between checks), or relax the detector in both arms alike.

- **Lanes don't make ownership exclusive.** In run 3 both agents claimed lanes over the same two
  files. The gate requires the editing seat to own a covering lane, not to own it alone, so
  overlapping claims only warn. The agents saw the overlap, said so to each other, and edited anyway.
  This is the question dogfood run 8 asks ("does one-owner-per-task stop the collision or just
  report it?"), and here it only reported it. Decide before the pilot whether the arm keeps musterd's
  shipped semantics or adds exclusive claims. Adding them would be its own decision, not a harness
  setting.
- **The agents misread the scoring.** agent1 concluded that "we're evaluated separately, so no need
  to merge". CooperBench scores each pair on both features' tests, and without `--git` neither agent
  can bring in the other's work. The pilot should run every arm with `--git`, as CooperBench's own
  `team` comparisons do. Otherwise any two features that touch one file are close to a guaranteed
  conflict, whatever the coordination layer.

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
ln -sfn /opt/cooperbench/dataset dataset                                            # `cooperbench run` reads ./dataset
PREFIX=/opt/musterd-seat python3 /app/scripts/research/cooperbench/gate_smoke.py   # must print PASS first
PREFIX=/opt/musterd-seat python3 /app/scripts/research/cooperbench/hold_smoke.py   # ADR 691/693: held, then lapsed (~2 min)
cooperbench run -n smoke-coop    -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code         --setting coop
cooperbench run -n smoke-musterd -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop
cooperbench eval -n smoke-coop --backend docker && cooperbench eval -n smoke-musterd --backend docker
# the OpenHands arms
python3 /app/scripts/research/cooperbench/oh_gate_smoke.py                          # must print PASS first
cooperbench run -n oh-coop    -r pallets_click_task -t 2068 -f 1,2 -m anthropic/claude-sonnet-4-5 -a openhands_sdk_docker  --setting coop
cooperbench run -n oh-musterd -r pallets_click_task -t 2068 -f 1,2 -m anthropic/claude-sonnet-4-5 -a openhands_sdk_musterd --setting coop
exit
fly machine stop --app musterd-cooperbench
```

Each daemon's log and database are copied next to the agent's logs when its pair finishes, so the
team's acts and lanes are part of the run's record.

### Reproducing finding 023

Everything the collision claim rests on is pinned in the repo:

| What | Where |
| --- | --- |
| CooperBench | commit `63b9d44` (`COOPERBENCH_COMMIT`, `deploy/cooperbench/Dockerfile`) |
| Claude Code | 2.1.307 for host and containers (`CLAUDE_CODE_VERSION`, same Dockerfile) |
| musterd | image `7e795fcb` (both runs); deploy from that commit with `MUSTERD_REF` set to it |
| Model | `claude-sonnet-4-5`, concurrency 3, `--git` |
| The ten tasks | `claim20.json`'s `new` list, drawn by `scripts/research/cooperbench/claim_pairs.py` with `random.Random(20261022)`; `claimnew` is rebuilt from it by `coord.sh` |
| musterd arm | `pilot-runs/2026-10-22-claim/claim.sh`, second half (`claim-musterd-new`) |
| team and coop arms | `pilot-runs/2026-10-23-coordination/coord.sh` |
| Scoring and labels | `cooperbench eval --backend docker`, then `readout.py` over the run folders |
| The verdict and its robustness | `coordination-manifest.md`, then `pilot-runs/2026-10-23-coordination/robustness.py` |

Re-running costs about $19 for musterd and $29 for team plus coop at 2026-10 prices. Agents
are not deterministic, so a re-run reproduces the method, not the exact pairs. The claim is the
count, and a re-run that disagrees is a finding of its own.

### Before any measured spend (lane `01M5KHD19K`)

Each line below has cost a run money once. None of them changes what an agent sees or how a pair is
scored.

- **The account's API limit covers the hard stop.** A human confirms it, because the key cannot report
  its own remaining limit. Pilot 2 lost 11 pairs and finding 023 four when the limit hit mid-run.
- **Arms run under `run_arms.py`**, not a hand-rolled loop. It starts each arm as its own process
  group, checks `spend_guard.py` every minute with the manifest's run glob and hard stop, and on a
  stop kills every arm's whole process group and runs `--on-stop` (remove leftover agent containers).
  The kill signals the group even when an arm's shell has already exited, and sends SIGKILL to
  whatever is still alive 10 seconds after SIGTERM. It exits 3 at the hard
  stop and 4 on the API limit, and evaluates only arms that finished. Pairs the limit killed are
  errors, re-run once when it allows. `tests/test_run_arms.py` shows a stop killing every arm,
  including a child that ignores SIGTERM after its shell has exited. Runs
  before 2026-10-23 used their own loops (`pilot-runs/*/…sh`), which are kept as they ran.

  ```bash
  python3 /app/scripts/research/cooperbench/run_arms.py --runs 'rider-*' --cap 24.95 \
    --log /data/runs/rider/run.log \
    --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
    --eval 'cooperbench eval -n {name} --backend docker' \
    --arm rider-musterd='cooperbench run -n rider-musterd -s riderset -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval'
  ```
- **Host smokes run as an unprivileged user** (`runuser -u smoke -- env HOME=/home/smoke …`). Claude Code
  refuses `--dangerously-skip-permissions` as root. CooperBench's containers set `IS_SANDBOX=1`, but
  the host does not. The ADR 697 hold check is `pilot-runs/2026-10-21-pilot3/hold_smoke_697.py` until
  `hold_smoke.py` is updated (big-body's lane `01M5G2PCFW`).
- **Images are pulled before the arms start**, with `docker pull`, not `cooperbench prepare` (that only
  downloads the dataset). Check `docker system df` against the volume: the claim run's 20 task images
  are 83 GB, against a 79 GB volume, so a run that big goes in halves (`pilot-runs/2026-10-22-claim/claim.sh`).
- **Claude Code is pinned** in the image (`CLAUDE_CODE_VERSION`, 2.1.307), so every arm and every day
  runs the same version.
- **The readout reads riders.** `readout.py` records `error_reason: api_usage_limit` and, for musterd
  pairs, `held_refusal_moves`. Any rider in [`riders.md`](./riders.md) that the run's data reaches is
  reported in its finding.

`readout.py`, `spend_guard.py` and `run_arms.py` have tests that need no CooperBench install:
`python3 tests/test_readout.py`, `python3 tests/test_spend_guard.py` and `python3 tests/test_run_arms.py`,
or `pytest` on the same three files.
