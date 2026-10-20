"""One fresh musterd team per CooperBench task pair, on the host.

CooperBench's coop runner starts one thread per agent in the same process and gives both the same
``run_id`` (``config["run_id"]``). The first thread to arrive stands up a daemon on a free port with
its own database, creates a team, adds one agent seat per CooperBench agent, turns the ADR 150 lane
gate on, and mints each seat a key. Every thread then reads its own seat from the shared record. The
last thread out stops the daemon, so a task pair never sees another pair's acts or lanes.

Everything here talks to musterd through its CLI, as a user would; nothing imports musterd code.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# The ADR 150 contended-surface class that makes every path in the repo gated: an edit is allowed
# only inside a lane the editing seat owns. Agents declare their own lanes (nick, 2026-10-19), so
# no scope is ever seeded from the task's reference patch.
ENFORCE_SURFACE_GLOB = "**"

# The daemon stays on loopback: musterd refuses a plaintext non-loopback bind (ADR 040), and that
# guard is right. The musterd arm's containers run with `--network=host` instead (Linux docker on the
# run VM), so a container's 127.0.0.1 is the VM's own loopback. Network mode does not change what the
# agent can do in the repo, and the plain coop arm's containers are left as CooperBench builds them.
CONTAINER_NETWORK_ARGS = ["--network=host"]


@dataclass
class Seat:
    name: str
    key: str


@dataclass
class PairTeam:
    """The musterd side of one task pair. ``seats`` maps CooperBench agent id to its seat."""

    run_id: str
    team: str
    port: int
    workdir: Path
    seats: dict[str, Seat] = field(default_factory=dict)
    process: subprocess.Popen | None = None

    @property
    def host_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def container_url(self) -> str:
        return self.host_url


def musterd_bin() -> list[str]:
    """The musterd CLI to drive: ``MUSTERD_BIN`` (e.g. ``node /app/packages/cli/dist/bin.js``) or ``musterd``."""
    raw = os.environ.get("MUSTERD_BIN", "musterd")
    return raw.split()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def team_slug(run_id: str) -> str:
    """A team slug musterd accepts ([a-z0-9-], 1..32) from CooperBench's 8-hex run id."""
    cleaned = "".join(c for c in run_id.lower() if c.isalnum())[:20] or "pair"
    return f"cb-{cleaned}"


class Cli:
    """The musterd CLI against one isolated config, database and server — never the machine's own."""

    def __init__(self, workdir: Path, port: int):
        self.workdir = workdir
        self.env = {
            **os.environ,
            "MUSTERD_CONFIG": str(workdir / "config.json"),
            "MUSTERD_DB": str(workdir / "musterd.db"),
            "MUSTERD_PORT": str(port),
            "MUSTERD_SERVER": f"http://127.0.0.1:{port}",
        }

    def run(self, *args: str, timeout: int = 60) -> str:
        proc = subprocess.run(
            [*musterd_bin(), *args],
            cwd=self.workdir,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"musterd {' '.join(args[:3])} failed ({proc.returncode}): {proc.stderr[-800:]}")
        return proc.stdout

    def serve(self, log_path: Path) -> subprocess.Popen:
        log = log_path.open("ab")
        return subprocess.Popen(
            [*musterd_bin(), "serve", "--host", "127.0.0.1", "--port", self.env["MUSTERD_PORT"]],
            cwd=self.workdir,
            env=self.env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )


def wait_healthy(url: str, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception as e:  # noqa: BLE001 — retried until the deadline
            last = e
        time.sleep(0.25)
    raise RuntimeError(f"musterd daemon at {url} never became healthy: {last}")


def stand_up(run_id: str, agents: list[str]) -> PairTeam:
    """Start a daemon, create the team, add one seat per agent, gate edits, mint each seat a key."""
    workdir = Path(tempfile.mkdtemp(prefix=f"cb-musterd-{run_id}-"))
    port = free_port()
    pair = PairTeam(run_id=run_id, team=team_slug(run_id), port=port, workdir=workdir)
    cli = Cli(workdir, port)
    pair.process = cli.serve(workdir / "daemon.log")
    try:
        wait_healthy(pair.host_url)
        cli.run("team", "create", pair.team)
        cli.run("team", "policy", "--enforce-surface", ENFORCE_SURFACE_GLOB, "--enforce-posture", "block")
        for agent_id in agents:
            cli.run("team", "add", agent_id, "--kind", "agent")
            minted = json.loads(cli.run("team", "bootstrap", "mint", "--seat", agent_id, "--json"))
            key = minted.get("agent_key") or minted.get("key")
            if not isinstance(key, str) or not key:
                raise RuntimeError(f"bootstrap mint for {agent_id} returned no key")
            pair.seats[agent_id] = Seat(name=agent_id, key=key)
    except Exception:
        tear_down(pair)
        raise
    return pair


def tear_down(pair: PairTeam, keep_logs_in: Path | None = None) -> None:
    if pair.process is not None and pair.process.poll() is None:
        pair.process.terminate()
        try:
            pair.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pair.process.kill()
    if keep_logs_in is not None:
        keep_logs_in.mkdir(parents=True, exist_ok=True)
        for name in ("daemon.log", "musterd.db"):
            src = pair.workdir / name
            if src.exists():
                shutil.copy2(src, keep_logs_in / f"musterd-{name}")
    shutil.rmtree(pair.workdir, ignore_errors=True)


class Registry:
    """One PairTeam per run_id, shared by the agent threads of that run, reference-counted."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pairs: dict[str, PairTeam] = {}
        self._users: dict[str, int] = {}

    def acquire(self, run_id: str, agents: list[str]) -> PairTeam:
        with self._lock:
            pair = self._pairs.get(run_id)
            if pair is None:
                pair = stand_up(run_id, agents)
                self._pairs[run_id] = pair
            self._users[run_id] = self._users.get(run_id, 0) + 1
            return pair

    def release(self, run_id: str, keep_logs_in: Path | None = None) -> None:
        with self._lock:
            self._users[run_id] = self._users.get(run_id, 1) - 1
            if self._users[run_id] > 0:
                return
            pair = self._pairs.pop(run_id, None)
            self._users.pop(run_id, None)
        if pair is not None:
            tear_down(pair, keep_logs_in=keep_logs_in)


REGISTRY = Registry()
