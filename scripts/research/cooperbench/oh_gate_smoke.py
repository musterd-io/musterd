"""Smoke test for the OpenHands musterd arm: the real agent-server, in docker, with the arm's wiring.

The OpenHands counterpart of gate_smoke.py, run on the run machine (it needs docker, a published
`-oh` image and an LLM key). One scratch team (team.py) with two seats.
`OpenHandsMusterdRunner` runs one agent on the click task image, told to open a lane for
`smoke-a.txt`, create it, then create `smoke-b.txt`. Once the lane is open, the host admin sends agent1 a `steer` for the
interrupt slot to deliver.

Pass needs all four:
- `smoke-a.txt` is in the patch (the lane let the edit through);
- `smoke-b.txt` is not, and the daemon audited a `lane.gate` deny (the PreToolUse hook is armed);
- a `⚡ musterd` line reached the conversation (the interrupt slot delivers);
- the run made musterd tool calls (the MCP server loaded from the plugin), and none failed, including
  one made after `sleep 25`: the seat must outlive the adapter's first heartbeat (15 s).

The gate fails open on any error, so a run whose gate is quietly dead would otherwise look like a
valid musterd arm. Run this before any measured pair.

Usage, on the run machine:
  python3 /app/scripts/research/cooperbench/oh_gate_smoke.py
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from musterd_cooperbench import openhands as ohm  # noqa: E402
from musterd_cooperbench import team as t  # noqa: E402

# Not a 5.x model: the images' OpenHands doesn't know them, sends `temperature`, and the API refuses it.
MODEL = os.environ.get("SMOKE_MODEL", "anthropic/claude-haiku-4-5")
IMAGE = os.environ.get("SMOKE_IMAGE", "akhatua/cooperbench-pallets-click:task2068")
TASK = """You are testing a lane gate. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature a", scope ["smoke-a.txt"] and claim true.
2. Use the file editor to create smoke-a.txt containing `edited by a`.
3. Use the file editor to create smoke-b.txt containing `edited by b`.
4. Run `sleep 25` in the terminal, then call the musterd tool `team_status`.
If a step is refused, do not retry it or do it any other way (no terminal writes). Then finish, replying with one line per step saying whether it succeeded, quoting any refusal and any
line that starts with ⚡ musterd."""


def steer_after_lane_opens(host: t.Cli, timeout_s: float = 900) -> None:
    """Send the steer once the agent has opened its lane: one sent before the run starts is read by
    its first `team_inbox_check`, and the interrupt slot then has nothing new to deliver."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if "lane.opened" in host.run("audit"):
                host.run("send", "--to", "agent1", "--act", "steer", "smoke: an act for the interrupt slot to deliver")
                return
        except Exception:
            pass
        time.sleep(1)


def main() -> int:
    run_id = "ohsmoke" + str(int(time.time()))[-6:]
    agents = ["agent1", "agent2"]
    pair = t.REGISTRY.acquire(run_id, agents)
    host = t.Cli(pair.workdir, pair.port)
    log_dir = Path(tempfile.mkdtemp(prefix="cb-oh-smoke-"))
    try:
        threading.Thread(target=steer_after_lane_opens, args=(host,), daemon=True).start()
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
    (log_dir / "events.txt").write_text("\n\n".join(events))
    (log_dir / "patch.diff").write_text(result.patch)
    # A diff header, not a bare mention: anything else in the patch may name the files.
    a_edited = "+++ b/smoke-a.txt" in result.patch
    b_edited = "+++ b/smoke-b.txt" in result.patch
    mcp_errors = [e for e in events if "Error calling MCP tool" in e]
    ended = [line for line in audit.splitlines() if "presence.session_ended" in line]
    denies = [line for line in audit.splitlines() if "lane.gate" in line and "deny" in line]
    # The task text itself mentions "⚡ musterd"; only a delivered line carries the "[team]:" tag.
    interrupt_seen = any(re.search(r"⚡ musterd \[[a-z0-9-]+\]:", e) for e in events if e.startswith("MessageEvent"))
    print(f"status={result.status} error={result.error}")
    print(f"cost_usd={result.cost:.4f} steps={result.steps} logs={log_dir}")
    print(f"a_edited={a_edited} b_edited={b_edited} gate_denies={len(denies)} interrupt_seen={interrupt_seen}")
    print(f"mcp_errors={len(mcp_errors)} session_ended={len(ended)}")
    ok = result.error is None and a_edited and not b_edited and len(denies) > 0 and interrupt_seen
    ok = ok and not mcp_errors and not ended
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
