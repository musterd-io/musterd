"""Rider 7 readout (docs/research/cooperbench/rider7-manifest.md), written before the run.

For each pair of a musterd act-lane run, reads the daemon's own wake report the pair's team dumped at
teardown (`musterd-residency.json`, from `musterd report residency --json`: ADR 749 `waited_ms`,
ADR 753 `holds`, ADR 252 priced wakes) and the pair's first-call cost from `readout.json`, and writes:

- `wakes`: wake leases over the run (R7a's second term; the first is mtools.py's wait-mode line);
- `first_call_usd`, `wake_usd`, `cost_usd_total`: R7b, the first call plus every priced wake;
- `waited_median_s`, `waited_n`: R7c, over every wake that carries a `waited_ms`;
- beside them: wakes per pair, resumed vs compacted vs fresh, each wake's wait split by gate state, pairs with
  an unpriced wake (a wake that spawned and died unreported is paid but unknown — reported, never
  silently zero).

    python3 rider7.py <logs/run-dir> readout.json > rider7.json

Reads only. No model calls.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def first_call_cost(readout: dict, pair_dir: Path) -> float | None:
    for rec in readout.get("pairs", []):
        if str(rec.get("pair", "")).rstrip("/").endswith(str(pair_dir).rstrip("/").split("/", 3)[-1]):
            cost = rec.get("cost")
            return float(cost) if isinstance(cost, (int, float)) else None
    return None


def read_pair(pair_dir: Path, readout: dict) -> dict | None:
    report = load(pair_dir / "musterd-residency.json")
    if not report or "by_seat" not in report:
        return None
    seats = []
    waited: list[int] = []
    wake_usd = 0.0
    wakes = 0
    unpriced = 0
    for s in report.get("by_seat", []):
        n = int(s.get("wakes") or 0)
        wakes += n
        wake_usd += float(s.get("cost_usd_total") or 0.0)
        priced = sum(int(d.get("priced") or 0) for d in s.get("by_day", []))
        unpriced += max(0, n - priced)
        ws = [int(w) for w in s.get("waited_ms", []) if isinstance(w, (int, float))]
        waited.extend(ws)
        seats.append(
            {
                "seat": s.get("seat"),
                "wakes": n,
                "cost_usd": round(float(s.get("cost_usd_total") or 0.0), 4),
                "waited_s": [round(w / 1000, 1) for w in ws],
                "holds": [
                    {
                        "act_ts": h.get("act_ts"),
                        "waited_s": round((h.get("waited_ms") or 0) / 1000, 1),
                        "by_state": {k: round(v / 1000, 1) for k, v in (h.get("by_state") or {}).items()},
                    }
                    for h in s.get("holds", [])
                ],
            }
        )
    first = first_call_cost(readout, pair_dir)
    return {
        "pair": str(pair_dir),
        "wakes": wakes,
        "resumed": report.get("resumed"),
        "compacted": report.get("compacted"),
        "failed": report.get("failed"),
        "deferred": report.get("deferred"),
        "exhausted": report.get("exhausted"),
        "unpriced_wakes": unpriced,
        "first_call_usd": first,
        "wake_usd": round(wake_usd, 4),
        "waited_ms": waited,
        "seats": seats,
    }


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    logs, readout = Path(sys.argv[1]), load(Path(sys.argv[2]))
    pairs = []
    for report in sorted(logs.rglob("musterd-residency.json")):
        rec = read_pair(report.parent, readout)
        if rec is not None:
            pairs.append(rec)
    waited = [w for p in pairs for w in p["waited_ms"]]
    first = [p["first_call_usd"] for p in pairs if p["first_call_usd"] is not None]
    wake_usd = sum(p["wake_usd"] for p in pairs)
    out = {
        "pairs_read": len(pairs),
        "wakes": sum(p["wakes"] for p in pairs),
        "resumed": sum(int(p["resumed"] or 0) for p in pairs),
        "compacted": sum(int(p.get("compacted") or 0) for p in pairs),
        "failed": sum(int(p["failed"] or 0) for p in pairs),
        "unpriced_wakes": sum(p["unpriced_wakes"] for p in pairs),
        "first_call_usd": round(sum(first), 2),
        "first_call_priced_pairs": len(first),
        "wake_usd": round(wake_usd, 2),
        "cost_usd_total": round(sum(first) + wake_usd, 2),
        "waited_n": len(waited),
        "waited_median_s": round(statistics.median(waited) / 1000, 1) if waited else None,
        "rule": "R7a: wait-mode team_inbox_check calls (mtools.py) + wakes, <= 55 acted / >= 75 did not; "
        "R7b: cost_usd_total <= 15 / >= 18; R7c: waited_median_s <= 120 / >= 900, and 'did not' voids R7a and R7b",
        "pairs": pairs,
    }
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
