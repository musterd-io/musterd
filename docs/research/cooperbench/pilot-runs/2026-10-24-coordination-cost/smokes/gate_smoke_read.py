"""Smoke test for the musterd arm's lane gate, with a real headless Claude Code and no Docker.

One scratch team (team.py), one seat, one scratch git repo with two files. The seat is admitted the
way a CooperBench container admits it (a blocking `claim`, approved by the host admin). Claude Code
then runs headless with ONLY the musterd MCP server (--strict-mcp-config) and ONLY musterd's
hooks (--settings, with --setting-sources local in a repo that has no local settings), under
default permissions with only Write/Edit on src/** and the two required musterd tools. Its
environment is filtered to the model key, per-seat wiring, and runtime paths. It is told to claim a
lane for src/a.py, edit it, then edit
src/b.py. Pass: a.py changed, b.py unchanged, and the daemon audited a lane.gate deny.

This is the check that the gate is live in the arm's exact wiring. The gate fails open on any
error (gate.ts), so a run whose gate is quietly dead would otherwise look like a valid musterd arm.

Usage (from the repo root, after pack.sh has installed the packed CLI and MCP into PREFIX):
  MUSTERD_BIN="node packages/cli/dist/bin.js" PREFIX=<prefix> python3 scripts/research/cooperbench/gate_smoke.py
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
from musterd_cooperbench import team as t  # noqa: E402n_orig_argv = cfg.claude_smoke_argvndef _argv(*a, **k):n    v = _orig_argv(*a, **k); i = v.index("--tools"); v[i + 1] = "Read,Edit,Write"; j = v.index("--allowedTools"); v.insert(j + 1, "Read(src/**)"); return vncfg.claude_smoke_argv = _argv
_orig_argv = cfg.claude_smoke_argv
def _argv(*a, **k):
    v = _orig_argv(*a, **k); i = v.index("--tools"); v[i + 1] = "Read,Edit,Write"; j = v.index("--allowedTools"); v.insert(j + 1, "Read(src/**)"); return v
cfg.claude_smoke_argv = _argv

PREFIX = Path(os.environ["PREFIX"])
SEAT_BIN = str(PREFIX / "bin" / "musterd")
MODEL = os.environ.get("SMOKE_MODEL", "claude-haiku-5-5")
PROMPT = """You are testing a lane gate. Do exactly these steps, in order, and nothing else:
1. Call the musterd tool `team_inbox_check`, then `lane_open` with title "feature a", scope ["src/a.py"] and claim true.
2. Read src/a.py with the Read tool, then use the Edit tool to add the line `# edited by a` at the end of src/a.py. If the edit is refused, do not retry.
3. Read src/b.py with the Read tool, then use the Edit tool to add the line `# edited by b` at the end of src/b.py. If the edit is refused, do not retry and do not edit the file any other way.
Then reply with one line per step saying whether it succeeded, quoting any refusal."""


def redact(s: str) -> str:
    return re.sub(r"(ms[a-z]{2}_)[A-Za-z0-9_-]+", r"\1…", s)


def main() -> int:
    pair = t.stand_up("smoke" + str(int(time.time()))[-6:], ["agent1"])
    host = t.Cli(pair.workdir, pair.port)
    repo = Path(tempfile.mkdtemp(prefix="cb-smoke-repo-"))
    try:
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "src").mkdir()
        (repo / "src" / "a.py").write_text("x = 1\n")
        (repo / "src" / "b.py").write_text("y = 2\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(repo), "-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "base"],
            check=True,
        )
        seat_env = cfg.seat_env(pair, "agent1", home=repo.parent / f"{repo.name}-home")
        seat_env["PATH"] = f"{PREFIX / 'bin'}:{os.environ['PATH']}"
        cfg.admit_seat(host, pair, "agent1", cwd=repo, env={**os.environ, **seat_env}, musterd=SEAT_BIN)
        (repo / ".git" / "info" / "exclude").write_text(cfg.GIT_EXCLUDE)

        mcp_path = repo.parent / f"{repo.name}-mcp.json"
        settings_path = repo.parent / f"{repo.name}-settings.json"
        # The real file, not the bin symlink: @musterd/mcp's isMain guard compares the symlink path in
        # argv[1] with the resolved import.meta.url and silently never starts (lane 01M5BA0Q8N).
        mcp_entry = (PREFIX / "bin" / "musterd-mcp").resolve()
        mcp_path.write_text(
            json.dumps(
                cfg.mcp_config(
                    cfg.claude_smoke_mcp_env(seat_env),
                    command="node",
                    args=[str(mcp_entry)],
                )
            )
        )
        settings_path.write_text(json.dumps(cfg.claude_settings()))

        proc = subprocess.run(
            cfg.claude_smoke_argv(
                PROMPT,
                model=MODEL,
                settings=settings_path,
                mcp_config=mcp_path,
            ),
            cwd=repo,
            env=cfg.claude_smoke_env(
                os.environ,
                seat_env,
                home=repo.parent / f"{repo.name}-home",
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

        a_edited = "# edited by a" in (repo / "src" / "a.py").read_text()
        b_edited = "# edited by b" in (repo / "src" / "b.py").read_text()
        audit = host.run("audit")
        denies = [line for line in audit.splitlines() if "lane.gate" in line and "deny" in line]
        print("reply:", redact(reply)[:900])
        deaf = "interrupt line is deaf" in proc.stdout or "dead session lease" in reply.lower() or "session lease is dead" in reply.lower()
        print(f"deaf_warning_seen={deaf}")
        print(f"cost_usd={cost} a_edited={a_edited} b_edited={b_edited} gate_denies={len(denies)}")
        ok = a_edited and not b_edited and len(denies) > 0 and not deaf
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        t.tear_down(pair)


if __name__ == "__main__":
    raise SystemExit(main())
