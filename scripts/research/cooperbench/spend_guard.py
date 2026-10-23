"""One guard for a CooperBench run's spend (lane 01M5KHD19K): the hard stop and the account's API limit.

Each run script used to carry its own inline spend counter, and none of them noticed the account's
API usage limit. Pilot 2 lost 11 pairs and finding 023 four that way, still paying for the turns
before each died. A run script calls this once a minute while its arms run and stops them on a
non-zero exit:

    python3 spend_guard.py --logs /data/runs/logs --runs 'coord-*' --cap 34.95

- **spent**: model cost over every finished pair's `result.json` in the matching runs (smoke and
  error re-runs included, as every manifest counts them). The hard stop is checked against it.
- **api_limit**: any agent stream in the matching runs, finished or still running, carries the API's
  usage-limit refusal. Pairs started after that point would die too, so the run stops and the dead
  pairs are re-run once the limit allows, as errors.

Prints one JSON line. Exit 0: carry on. 3: the hard stop is reached. 4: the API limit was hit.
The guard reads only, and the run script does the stopping. Neither changes what an agent sees.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

API_LIMIT = "reached your specified API usage limits"  # as readout.py


def check(logs: Path, runs: str, cap: float) -> dict:
    spent = 0.0
    for f in logs.glob(f"{runs}/**/result.json"):
        try:
            spent += float(json.loads(f.read_text()).get("total_cost") or 0)
        except (OSError, ValueError, AttributeError):
            continue
    limited = any(
        API_LIMIT in s.read_text(errors="replace") for s in logs.glob(f"{runs}/**/agent*_stream.jsonl")
    )
    stop = "api_limit" if limited else ("hard_stop" if spent >= cap else None)
    return {"spent": round(spent, 2), "cap": cap, "api_limit": limited, "stop": stop}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--logs", type=Path, default=Path("/data/runs/logs"))
    ap.add_argument("--runs", required=True, help="glob of run names under --logs, e.g. 'coord-*'")
    ap.add_argument("--cap", type=float, required=True, help="the manifest's hard stop, in dollars")
    a = ap.parse_args(argv)
    out = check(a.logs, a.runs, a.cap)
    print(json.dumps(out))
    return {"api_limit": 4, "hard_stop": 3}.get(out["stop"] or "", 0)


if __name__ == "__main__":
    raise SystemExit(main())
