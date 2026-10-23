"""Micro-test for the held-file refusal text (lane 01M5K4J42E, finding 022, #3219).

After a held-file refusal, does an agent wait on the holder's lane in one call, or message the
holder? Finding 022 saw all 29 held refusals in the claim run followed by a message, under a refusal
text that said "ask them" first. #3219 makes the text lead with the one-call wait. This measures the
first coordination move after the refusal, on whichever text the daemon in PREFIX carries, in
TRIALS fresh scratch teams. It is a stand-in for a full benchmark run, not a benchmark.

Each trial is two headless Claude Code seats in gate_smoke.py's exact wiring:
1. agent1 (HOLDER_MODEL, cheap) claims a lane naming src/a.py and edits it. Presence is raised for
   the scratch daemon so agent1's hold stands for the whole trial (no ADR 693 lapse).
2. agent2 (MODEL, the bench's) gets the bench's own musterd instruction (prompt.build_instruction)
   and a small task in the same file. Its first edit is refused. The trial reads agent2's stream and
   records its first musterd coordination call after that refusal.

Usage: PREFIX=<prefix> TRIALS=8 python3 scripts/research/cooperbench/refusal_follow.py > out.json
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# The scratch daemon reads these at start: a holder that exits stays present for the whole trial.
os.environ.setdefault("MUSTERD_PRESENCE_TIMEOUT_MS", "900000")
os.environ.setdefault("MUSTERD_RECLAIM_GRACE_MS", "900000")

sys.path.insert(0, str(Path(__file__).parent))
from musterd_cooperbench import config as cfg  # noqa: E402
from musterd_cooperbench import prompt as pr  # noqa: E402
from musterd_cooperbench import team as t  # noqa: E402

PREFIX = Path(os.environ["PREFIX"])
SEAT_BIN = str(PREFIX / "bin" / "musterd")
MODEL = os.environ.get("MODEL", "claude-sonnet-4-5")
HOLDER_MODEL = os.environ.get("HOLDER_MODEL", "claude-haiku-4-5")
TRIALS = int(os.environ.get("TRIALS", "8"))
MAX_TURNS = os.environ.get("MAX_TURNS", "12")

HOLDER = """You are testing a file hold. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature a: add a()", scope ["src/a.py"] and claim true.
2. Use the Write tool to write src/a.py with exactly three lines: `x = 1`, a blank line, `def a(): return 1`.
Then reply with one line per step saying whether it succeeded."""

TASK = """## Feature: add `b()`

In `src/a.py`, add a function `b()` that returns `2`. Do not change anything else.
Your teammate agent1 is adding `a()` to the same file."""


def run(repo: Path, wiring: dict, prompt: str, model: str, stream: bool) -> tuple[str, float]:
    fmt = ["--output-format", "stream-json", "--verbose"] if stream else ["--output-format", "json"]
    proc = subprocess.run(
        [
            "claude", "-p", prompt, "--model", model, *fmt, "--max-turns", MAX_TURNS,
            "--permission-mode", "bypassPermissions",
            "--setting-sources", "local", "--settings", str(wiring["settings"]),
            "--strict-mcp-config", "--mcp-config", str(wiring["mcp"]),
        ],
        cwd=repo, env={**os.environ, **wiring["env"]}, capture_output=True, text=True, timeout=240,
    )
    cost = 0.0
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict) and (ev.get("type") == "result" or "total_cost_usd" in ev):
            cost = float(ev.get("total_cost_usd") or 0)
    return proc.stdout, cost


def watch(repo: Path, wiring: dict, prompt: str, limit_s: int = 300) -> tuple[str, float]:
    """agent2's session, read as it streams and stopped once its first move after the refusal is in.

    Waiting is the behaviour being tested, and the hold never lapses here, so a session left to run
    would wait out its turns. Stopping at the first move keeps the stream and the spend to what is measured.
    """
    proc = subprocess.Popen(
        [
            "claude", "-p", prompt, "--model", MODEL, "--output-format", "stream-json", "--verbose",
            "--max-turns", MAX_TURNS, "--permission-mode", "bypassPermissions",
            "--setting-sources", "local", "--settings", str(wiring["settings"]),
            "--strict-mcp-config", "--mcp-config", str(wiring["mcp"]),
        ],
        cwd=repo, env={**os.environ, **wiring["env"]}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    lines: list[str] = []
    deadline = time.monotonic() + limit_s
    assert proc.stdout is not None
    for line in proc.stdout:
        lines.append(line)
        if "tool_use" in line and first_move("".join(lines))["move"] not in ("never refused", "refused, then no coordination call"):
            break
        if time.monotonic() > deadline:
            break
    proc.kill()
    proc.wait()
    text = "".join(lines)
    return text, usage_cost(text)


def usage_cost(stream_text: str) -> float:
    """Cost of a stream cut short: the result line if it got that far, else priced from per-call usage."""
    for line in stream_text.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict) and ev.get("type") == "result":
            return float(ev.get("total_cost_usd") or 0)
    seen: dict[str, dict] = {}
    for line in stream_text.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        m = ev.get("message") if isinstance(ev, dict) else None
        if isinstance(m, dict) and m.get("id") and m.get("usage"):
            seen[m["id"]] = m["usage"]
    # claude-sonnet-4-5 list $/Mtok, as finding 019's calls.py.
    return sum(
        (u.get("input_tokens", 0) * 3 + u.get("cache_creation_input_tokens", 0) * 3.75
         + u.get("cache_read_input_tokens", 0) * 0.30 + u.get("output_tokens", 0) * 15) / 1e6
        for u in seen.values()
    )


def first_move(stream_text: str) -> dict:
    """agent2's first musterd coordination call after its first refused edit."""
    refused = False
    pending: dict[str, str] = {}
    for line in stream_text.splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = ev.get("message") or {}
        for b in msg.get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                pending[b["id"]] = b["name"]
                if refused and b["name"].startswith("mcp__musterd__") and b["name"] not in (
                    "mcp__musterd__lane_board", "mcp__musterd__team_status", "mcp__musterd__lane_open",
                ):
                    i = b.get("input") or {}
                    if b["name"].endswith("team_inbox_check"):
                        kind = "wait_until_lane" if i.get("until_lane") else ("wait" if i.get("wait") else "inbox_plain")
                    elif b["name"].endswith("team_send"):
                        kind = "message:" + str(i.get("act", "message"))
                    else:
                        kind = b["name"][len("mcp__musterd__"):]
                    return {"move": kind, "input": {k: str(v)[:120] for k, v in i.items()}}
            if b.get("type") == "tool_result" and not refused:
                name = pending.get(b.get("tool_use_id"), "")
                text = json.dumps(b.get("content"))
                if name in ("Write", "Edit", "MultiEdit") and "held by agent1" in text:
                    refused = True
    return {"move": "refused, then no coordination call" if refused else "never refused"}


def trial(n: int) -> dict:
    pair = t.stand_up("rf" + str(int(time.time()))[-6:] + str(n), ["agent1", "agent2"])
    host = t.Cli(pair.workdir, pair.port)
    base = Path(tempfile.mkdtemp(prefix="cb-rf-"))
    origin = base / "origin"
    repos = {seat: base / seat / "repo" for seat in ("agent1", "agent2")}
    try:
        subprocess.run(["git", "init", "-q", str(origin)], check=True)
        (origin / "src").mkdir()
        (origin / "src" / "a.py").write_text("x = 1\n")
        subprocess.run(["git", "-C", str(origin), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(origin), "-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "base"], check=True)
        mcp_entry = (PREFIX / "bin" / "musterd-mcp").resolve()
        wiring: dict[str, dict] = {}
        for seat in ("agent1", "agent2"):
            subprocess.run(["git", "clone", "-q", str(origin), str(repos[seat])], check=True)
            (repos[seat] / ".git" / "info" / "exclude").write_text(cfg.GIT_EXCLUDE)
            env = cfg.seat_env(pair, seat, home=base / f"{seat}-home")
            env["PATH"] = f"{PREFIX / 'bin'}:{os.environ['PATH']}"
            cfg.admit_seat(host, pair, seat, cwd=repos[seat], env={**os.environ, **env}, musterd=SEAT_BIN)
            mcp, settings = base / f"{seat}-mcp.json", base / f"{seat}-settings.json"
            mcp.write_text(json.dumps(cfg.mcp_config(env, command="node", args=[str(mcp_entry)])))
            settings.write_text(json.dumps(cfg.claude_settings()))
            wiring[seat] = {"env": env, "mcp": mcp, "settings": settings}
        _, c1 = run(repos["agent1"], wiring["agent1"], HOLDER, HOLDER_MODEL, stream=False)
        instruction = pr.build_instruction(TASK, agents=["agent1", "agent2"], agent_id="agent2", git_enabled=False)
        out, c2 = watch(repos["agent2"], wiring["agent2"], instruction)
        return {"trial": n, **first_move(out), "cost_usd": round(c1 + c2, 4)}
    finally:
        t.tear_down(pair)


def main() -> int:
    results = []
    for n in range(TRIALS):
        try:
            r = trial(n)
        except Exception as e:  # noqa: BLE001 — a failed trial is recorded, not retried
            r = {"trial": n, "move": "error", "error": str(e)[:300]}
        print(json.dumps(r), file=sys.stderr)
        results.append(r)
    moves: dict[str, int] = {}
    for r in results:
        k = r["move"].split(":")[0] if r["move"].startswith("message") else r["move"]
        moves[k] = moves.get(k, 0) + 1
    print(json.dumps({"model": MODEL, "musterd_ref": os.environ.get("MUSTERD_REF"), "moves": moves,
                      "cost_usd": round(sum(r.get("cost_usd", 0) for r in results), 4), "trials": results}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
