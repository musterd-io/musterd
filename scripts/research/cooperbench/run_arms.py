"""Run a CooperBench run's arms side by side under spend_guard (lane 01M5KHD19K).

Each run script used to hand-roll this loop, and none of them stopped on the account's API limit.
This starts every arm as its own process group, checks spend_guard.check() every --every seconds,
and on a stop kills every arm's whole process group, then runs --on-stop (for example, removing
leftover agent containers). Arms that finish on their own are then evaluated with --eval, a command
template where {name} is the arm's run name. A stopped run evaluates nothing. Its pairs stay on disk
for the readout, and the run is re-planned.

    python3 run_arms.py --logs /data/runs/logs --runs 'rider-*' --cap 24.95 --log run.log \\
      --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \\
      --eval 'cooperbench eval -n {name} --backend docker' \\
      --arm rider-musterd='cooperbench run -n rider-musterd -s riderset -a claude_code_musterd ...'

Exit 0 when every arm finished and was evaluated. 3 at the hard stop. 4 on the API limit. 1 if an
arm or an eval failed. The runner only starts, watches and stops arms, and changes nothing an agent
sees.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spend_guard  # noqa: E402

STOP_CODES = {"hard_stop": 3, "api_limit": 4}


def log(path: Path | None, msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}"
    print(line, flush=True)
    if path is not None:
        with path.open("a") as f:
            f.write(line + "\n")


GRACE = 10.0


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_group(proc: subprocess.Popen, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        proc.poll()  # reap the leader, or its zombie keeps the group alive
        if not group_alive(proc.pid):
            return True
        time.sleep(0.1)
    return False


def kill_group(proc: subprocess.Popen) -> None:
    # Signal the whole group even when the shell leader has already exited: an agent it started
    # can still be running and spending. Wait on the group, not the leader, so a child that
    # ignores SIGTERM still gets SIGKILL (big-body, lane 01M5KHD19K review).
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        proc.poll()
        return
    if wait_group(proc, GRACE):
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    wait_group(proc, 5.0)
    proc.wait()


def run(arms: dict[str, str], logs: Path, runs: str, cap: float, every: float,
        eval_cmd: str | None, on_stop: str | None, log_path: Path | None) -> int:
    procs = {}
    for name, cmd in arms.items():
        log(log_path, f"start {name}")
        procs[name] = subprocess.Popen(cmd, shell=True, start_new_session=True)
    stop = None
    while any(p.poll() is None for p in procs.values()):
        out = spend_guard.check(logs, runs, cap)
        if out["stop"]:
            stop = out["stop"]
            log(log_path, f"STOP {stop}: spent ${out['spent']} of ${cap}")
            for p in procs.values():
                kill_group(p)
            if on_stop:
                subprocess.run(on_stop, shell=True)
            break
        time.sleep(every)
    if stop:
        return STOP_CODES[stop]
    failed = False
    for name, p in procs.items():
        log(log_path, f"{name} run exit={p.returncode}")
        failed |= p.returncode != 0
        if eval_cmd:
            e = subprocess.run(eval_cmd.format(name=name), shell=True)
            log(log_path, f"{name} eval exit={e.returncode}")
            failed |= e.returncode != 0
    final = spend_guard.check(logs, runs, cap)
    log(log_path, f"all done, spent ${final['spent']}")
    # A limit reached during the last pairs still marks them errors for the readout. Say so.
    if final["stop"] == "api_limit":
        return STOP_CODES["api_limit"]
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--logs", type=Path, default=Path("/data/runs/logs"))
    ap.add_argument("--runs", required=True)
    ap.add_argument("--cap", type=float, required=True)
    ap.add_argument("--every", type=float, default=60.0)
    ap.add_argument("--arm", action="append", required=True, metavar="NAME=COMMAND")
    ap.add_argument("--eval", dest="eval_cmd")
    ap.add_argument("--on-stop")
    ap.add_argument("--log", type=Path)
    a = ap.parse_args(argv)
    arms = dict(x.split("=", 1) for x in a.arm)
    return run(arms, a.logs, a.runs, a.cap, a.every, a.eval_cmd, a.on_stop, a.log)


if __name__ == "__main__":
    raise SystemExit(main())
