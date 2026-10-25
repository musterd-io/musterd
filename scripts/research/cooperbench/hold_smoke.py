"""Smoke test for ADR 691's file hold and ADR 693's lapse, with two real headless Claude Code seats.

One scratch team (team.py), two seats, each in its own clone of one scratch repo. Lane paths are
repo-relative, so both seats name the same file. Each step is its own headless session in the arm's
exact wiring (gate_smoke.py's), so a session ending is a real departure:

1. agent1 claims a lane naming src/a.py, edits it, and exits.
2. agent2, at once (agent1 is still inside its reclaim grace), claims a lane naming the same file
   and tries to edit it. The gate must refuse: agent1 holds it.
3. After LAPSE_WAIT_S, agent2 tries the same edit again. agent1 has left, so the hold has lapsed
   and the gate must let the edit through with the advisory.

Pass: agent1's clone carries its line, agent2's carries its second line but not its first, the daemon
audited a `held by` deny and a `has lapsed` warn, and no session saw the deaf warning. This checks
that the run image carries both ADRs before any measured pair: without 691 step 2 is allowed, without
693 step 3 is refused.

The host-side Claude processes use default permissions, only the smoke's file and musterd tools,
and a filtered per-seat environment. They do not inherit the CooperBench VM's other credentials.

Usage: as gate_smoke.py, PREFIX=<prefix> python3 scripts/research/cooperbench/hold_smoke.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from musterd_cooperbench import config as cfg  # noqa: E402
from musterd_cooperbench import team as t  # noqa: E402

PREFIX = Path(os.environ["PREFIX"])
SEAT_BIN = str(PREFIX / "bin" / "musterd")
MODEL = os.environ.get("SMOKE_MODEL", "claude-haiku-5-5")
# Reclaim grace and presence timeout are 45 s each by default (ADR 693 §5); wait past both.
LAPSE_WAIT_S = int(os.environ.get("LAPSE_WAIT_S", "110"))

HOLDER = """You are testing a file hold. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature a", scope ["src/a.py"] and claim true.
2. Read src/a.py with the Read tool, then use the Write tool to write src/a.py with exactly two lines: `x = 1` then `# agent1`.
Then reply with one line per step saying whether it succeeded."""

SECOND = """You are testing a file hold. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature b", scope ["src/a.py"] and claim true.
2. Read src/a.py with the Read tool, then use the Write tool to write src/a.py with exactly two lines: `x = 1` then `# agent2 first`. If it is refused, do not retry and do not edit the file any other way.
Then reply with one line per step saying whether it succeeded, quoting any refusal."""

AGAIN = """You are testing a file hold. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`.
2. Read src/a.py with the Read tool, then use the Write tool to write src/a.py with exactly two lines: `x = 1` then `# agent2 again`. If it is refused, do not retry and do not edit the file any other way.
Then reply with one line per step saying whether it succeeded, quoting any refusal or warning."""


def redact(s: str) -> str:
    return re.sub(r"(ms[a-z]{2}_)[A-Za-z0-9_-]+", r"\1…", s)


def session(repo: Path, wiring: dict, prompt: str) -> tuple[str, float | None, bool]:
    proc = subprocess.run(
        cfg.claude_smoke_argv(
            prompt,
            model=MODEL,
            settings=wiring["settings"],
            mcp_config=wiring["mcp"],
        ),
        cwd=repo,
        env=cfg.claude_smoke_env(
            os.environ,
            wiring["env"],
            home=Path(wiring["env"]["MUSTERD_CONFIG"]).parent,
            prefix=PREFIX,
        ),
        capture_output=True,
        text=True,
        timeout=600,
    )
    try:
        out = json.loads(proc.stdout)
        reply, cost = out.get("result", ""), out.get("total_cost_usd")
    except json.JSONDecodeError:
        reply, cost = proc.stdout[-800:] + proc.stderr[-800:], None
    deaf = "interrupt line is deaf" in proc.stdout or "session lease is dead" in reply.lower()
    return reply, cost, deaf


def main() -> int:
    pair = t.stand_up("hold" + str(int(time.time()))[-6:], ["agent1", "agent2"])
    host = t.Cli(pair.workdir, pair.port)
    base = Path(tempfile.mkdtemp(prefix="cb-hold-"))
    origin = base / "origin"
    # Both clones are named `repo`, as both containers' checkouts are /workspace/repo: the lane's
    # project is the repo folder's name (resolveProject), and lanes contend only within a project.
    repos = {seat: base / seat / "repo" for seat in ("agent1", "agent2")}
    try:
        subprocess.run(["git", "init", "-q", str(origin)], check=True)
        (origin / "src").mkdir()
        (origin / "src" / "a.py").write_text("x = 1\n")
        subprocess.run(["git", "-C", str(origin), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(origin), "-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "base"],
            check=True,
        )
        for repo in repos.values():
            subprocess.run(["git", "clone", "-q", str(origin), str(repo)], check=True)
            (repo / ".git" / "info" / "exclude").write_text(cfg.GIT_EXCLUDE)
        # The real file, not the bin symlink (gate_smoke.py, lane 01M5BA0Q8N).
        mcp_entry = (PREFIX / "bin" / "musterd-mcp").resolve()
        wiring: dict[str, dict] = {}
        for seat in ("agent1", "agent2"):
            env = cfg.seat_env(pair, seat, home=base / f"{seat}-home")
            env["PATH"] = f"{PREFIX / 'bin'}:{os.environ['PATH']}"
            cfg.admit_seat(host, pair, seat, cwd=repos[seat], env={**os.environ, **env}, musterd=SEAT_BIN)
            mcp = base / f"{seat}-mcp.json"
            settings = base / f"{seat}-settings.json"
            mcp.write_text(
                json.dumps(
                    cfg.mcp_config(
                        cfg.claude_smoke_mcp_env(env),
                        command="node",
                        args=[str(mcp_entry)],
                    )
                )
            )
            settings.write_text(json.dumps(cfg.claude_settings()))
            wiring[seat] = {"env": env, "mcp": mcp, "settings": settings, "repo": repos[seat]}

        costs: list[float | None] = []
        deaf_any = False
        steps = [("agent1", HOLDER, 0), ("agent2", SECOND, 0), ("agent2", AGAIN, LAPSE_WAIT_S)]
        for seat, prompt, wait in steps:
            if wait:
                print(f"waiting {wait}s for agent1's hold to lapse")
                time.sleep(wait)
            reply, cost, deaf = session(wiring[seat]["repo"], wiring[seat], prompt)
            costs.append(cost)
            deaf_any = deaf_any or deaf
            print(f"{seat}:", redact(reply)[:600])

        text1 = (repos["agent1"] / "src" / "a.py").read_text()
        text2 = (repos["agent2"] / "src" / "a.py").read_text()
        # The lane.gate row records which hold decided an edit (lane 01M5FR8Y26).
        parsed = json.loads(host.run("audit", "--json", "--limit", "200"))
        rows = parsed if isinstance(parsed, list) else parsed.get("audit", [])
        gate = [r for r in rows if r.get("action") == "lane.gate"]
        details = [r["detail"] if isinstance(r["detail"], dict) else json.loads(r["detail"] or "{}") for r in gate]
        held_deny = any(r.get("result") == "deny" and d.get("hold") == "held" and d.get("holder") == "agent1" for r, d in zip(gate, details))
        lapsed_warn = any(d.get("hold") == "lapsed" and d.get("holder") == "agent1" for d in details)
        print("gate rows:", *[f"{r.get('actor')} {r.get('result')} {d.get('outcome')} hold={d.get('hold')}" for r, d in zip(gate, details)], sep="\n  ")
        checks = {
            "agent1_edited": "# agent1" in text1,
            "agent2_first_refused": "# agent2 first" not in text2,
            "agent2_again_allowed": "# agent2 again" in text2,
            "held_deny_audited": held_deny,
            "lapsed_warn_audited": lapsed_warn,
            "no_deaf_warning": not deaf_any,
        }
        total = sum(c for c in costs if c is not None)
        print(" ".join(f"{k}={v}" for k, v in checks.items()), f"cost_usd={total:.4f}")
        ok = all(checks.values())
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        t.tear_down(pair)


if __name__ == "__main__":
    raise SystemExit(main())
