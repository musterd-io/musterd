"""Run `render.py` under a watchdog (figure render speed lane, 2026-10-21).

    python3 packages/web/art/office/render_watch.py -- --figure --out <assets> --scale 2 --ky 0.31

EEVEE on this laptop can hang on a GPU read (a 2026-10-21 figure render sat in
`MTLStorageBuf::read` at 0% CPU for good, 70% of the way through). Blender prints a line for every
render it saves, so a quiet spell means it is stuck: this kills it and starts it again. The
figure render keeps every finished call in its store, so a restart re-renders one call, not the
run. Runs with the system python — it only starts Blender.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

BLENDER = os.environ.get("BLENDER", "/Applications/Blender.app/Contents/MacOS/Blender")
RENDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render.py")
QUIET_S = float(os.environ.get("RENDER_QUIET_S", "180"))  # one render is ~1 s; three minutes is stuck
MAX_RESTARTS = 20


def run_once(args: list[str]) -> int | None:
    """Exit code, or None when the watchdog killed it for going quiet."""
    # Unbuffered: a print held in Blender's buffer reads as silence, and the watchdog would kill a run
    # that is only slow (cwebp at -z 9 takes ~40 s a sheet) — which it did, twenty times, 2026-10-22.
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen([BLENDER, "-b", "--python", RENDER, "--", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
    last = [time.monotonic()]

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            last[0] = time.monotonic()
            sys.stdout.write(line)
            sys.stdout.flush()

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    while proc.poll() is None:
        time.sleep(5)
        if time.monotonic() - last[0] > QUIET_S:
            print(f"render_watch: no output for {QUIET_S:.0f}s — killing Blender and starting again", flush=True)
            proc.kill()
            proc.wait()
            return None
    t.join(timeout=5)
    return proc.returncode


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    for attempt in range(MAX_RESTARTS + 1):
        code = run_once(args)
        if code is not None:
            raise SystemExit(code)  # finished, or failed the way a restart would fail again
        print(f"render_watch: attempt {attempt + 1} went quiet; restarting", flush=True)
    raise SystemExit(f"render_watch: gave up after {MAX_RESTARTS} restarts")


if __name__ == "__main__":
    main()
