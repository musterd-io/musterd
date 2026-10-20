"""Smoke test for the OpenHands musterd arm: the real agent-server, in docker, with the arm's wiring.

The OpenHands counterpart of gate_smoke.py, run on the run machine (it needs docker, a published
`-oh` image and an LLM key). One scratch team (team.py) with two seats. Before the agent starts, the
host admin sends agent1 a `steer`, so the interrupt slot has something to deliver. Then
`OpenHandsMusterdRunner` runs one agent on the click task image, told to open a lane for
`smoke/a.txt`, create it, then create `smoke/b.txt`.

Pass needs all four:
- `smoke/a.txt` is in the patch (the lane let the edit through);
- `smoke/b.txt` is not, and the daemon audited a `lane.gate` deny (the PreToolUse hook is armed);
- a `⚡ musterd` line reached the conversation (the interrupt slot delivers);
- the run made musterd tool calls (the MCP server loaded from the plugin).

The gate fails open on any error, so a run whose gate is quietly dead would otherwise look like a
valid musterd arm. Run this before any measured pair.

Usage, on the run machine:
  python3 /app/scripts/research/cooperbench/oh_gate_smoke.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from musterd_cooperbench import openhands as ohm  # noqa: E402
from musterd_cooperbench import team as t  # noqa: E402

MODEL = os.environ.get("SMOKE_MODEL", "anthropic/claude-haiku-5-5")
IMAGE = os.environ.get("SMOKE_IMAGE", "akhatua/cooperbench-pallets-click:task2068")
TASK = """You are testing a lane gate. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature a", scope ["smoke/a.txt"] and claim true.
2. Use the file editor to create smoke/a.txt containing `edited by a`.
3. Use the file editor to create smoke/b.txt containing `edited by b`.
Then finish, replying with one line per step saying whether it succeeded, quoting any refusal and any
line that starts with ⚡ musterd."""


def main() -> int:
    run_id = "ohsmoke" + str(int(time.time()))[-6:]
    agents = ["agent1", "agent2"]
    pair = t.REGISTRY.acquire(run_id, agents)
    host = t.Cli(pair.workdir, pair.port)
    log_dir = Path(tempfile.mkdtemp(prefix="cb-oh-smoke-"))
    try:
        host.run("send", "--to", "agent1", "--act", "steer", "smoke: an act for the interrupt slot to deliver")
        runner = ohm.OpenHandsMusterdRunner(max_iterations=30, timeout=1800, cost_limit=1.0)
        result = runner.run(
            TASK,
            IMAGE,
            agent_id="agent1",
            agents=agents,
            model_name=MODEL,
            config={"run_id": run_id},
            log_dir=str(log_dir),
        )
        audit = host.run("audit")
    finally:
        t.REGISTRY.release(run_id, keep_logs_in=log_dir)

    events = [str(m.get("event", "")) for m in result.messages]
    a_edited = "smoke/a.txt" in result.patch
    b_edited = "smoke/b.txt" in result.patch
    denies = [line for line in audit.splitlines() if "lane.gate" in line and "deny" in line]
    interrupt_seen = any("⚡ musterd" in e for e in events if e.startswith("MessageEvent"))
    print(f"status={result.status} error={result.error}")
    print(f"cost_usd={result.cost:.4f} steps={result.steps} logs={log_dir}")
    print(f"a_edited={a_edited} b_edited={b_edited} gate_denies={len(denies)} interrupt_seen={interrupt_seen}")
    ok = result.error is None and a_edited and not b_edited and len(denies) > 0 and interrupt_seen
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
