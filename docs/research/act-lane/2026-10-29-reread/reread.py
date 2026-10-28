"""The act-lane re-read (docs/research/act-lane-manifest.md, "Re-read" amendment, ADR 753), written
2026-10-28 before its window opens. One pass over one `musterd report residency --json` output; no
model calls, no host log.

    musterd report residency --json > report.json
    python3 -I reread.py --since 2026-10-29T00:00Z --until 2026-11-04T00:00Z \
        --act-lane izzo,miley,grokbot report.json

Reads each seat's `holds` (ADR 753): one entry per directed act whose first wake lease fell in the
report's 7-day window, with the act's ts, its wait (first lease minus act ts, ADR 749) and that wait
split by the gate the seat was in. An act counts when its ts is in [since, until). Reports, per the
amendment:

- R8a: the act-lane seats' median FREE wait — the wait minus the time the seat was `present`,
  `snoozed`, `reclaimable` or `lease_live` (held by its own session or an in-flight wake, not by the
  lane). n < 5 is inconclusive. If more than half of the act-lane seats' waited time is `unobserved`
  (no gate row in force), the gate record did not cover the window and R8a is INVALID, not a verdict.
- R7a: the raw median wait, act-lane seats vs every other seat, as finding 029.
- R7b: act-lane priced dollars per seat per UTC day in the window (`by_day`), and the $10 kill rule.
- Beside: each act-lane seat's share of waited time per gate state.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
import sys
from collections import defaultdict

NOT_THE_LANE = ("present", "snoozed", "reclaimable", "lease_live")


def iso_ms(s: str) -> int:
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def by_seat(report: dict) -> list[dict]:
    """The report nests by_seat under its wake block; find it wherever it is."""
    stack = [report]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            if isinstance(o.get("by_seat"), list) and o["by_seat"] and "seat" in o["by_seat"][0]:
                return o["by_seat"]
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)
    return []


def med(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--act-lane", required=True)
    a = ap.parse_args()
    since, until = iso_ms(a.since), iso_ms(a.until)
    act_lane = set(a.act_lane.split(","))
    rows = by_seat(json.load(open(a.report)))

    free: list[float] = []
    raw_act: list[float] = []
    raw_other: list[float] = []
    shares: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    waits_detail = []
    for r in rows:
        seat = r["seat"]
        for h in r.get("holds") or []:
            if not since <= h["act_ts"] < until:
                continue
            w = h["waited_ms"] / 1000
            if seat not in act_lane:
                raw_other.append(w)
                continue
            raw_act.append(w)
            held = sum(h["by_state"].get(s, 0) for s in NOT_THE_LANE) / 1000
            free.append(max(0.0, w - held))
            for s, ms in h["by_state"].items():
                shares[seat][s] += ms / 1000
            waits_detail.append({"seat": seat, "act_ts": h["act_ts"], "waited_s": w,
                                 "free_s": round(max(0.0, w - held), 1), "by_state": h["by_state"]})

    days: dict[str, dict[str, float]] = {}
    breaches = []
    for r in rows:
        if r["seat"] not in act_lane:
            continue
        for d in r.get("by_day") or []:
            ts = iso_ms(d["day"] + "T00:00Z")
            if since <= ts < until:
                days.setdefault(r["seat"], {})[d["day"]] = round(d["cost_usd_total"], 2)
                if d["cost_usd_total"] > 10:
                    breaches.append(f'{r["seat"]} {d["day"]} ${d["cost_usd_total"]:.2f}')

    r8a = med(free)
    total = sum(sum(d.values()) for d in shares.values())
    unobserved = sum(d.get("unobserved", 0.0) for d in shares.values())
    unobserved_share = round(unobserved / total, 3) if total else None
    verdict = ("invalid (gate record covers under half the waited time)"
               if unobserved_share is not None and unobserved_share > 0.5 else
               "inconclusive (n < 5)" if len(free) < 5 else
               "acted" if r8a <= 120 else "did not act" if r8a >= 900 else "part of it")
    out = {
        "window": {"since": a.since, "until": a.until, "act_lane": sorted(act_lane)},
        "R8a": {"n": len(free), "median_free_wait_s": r8a, "unobserved_share": unobserved_share,
                "verdict": verdict,
                "rule": "<= 120 s acted; >= 900 s did not; n < 5 inconclusive; unobserved > 50% invalid"},
        "R7a": {"act_lane_n": len(raw_act), "act_lane_median_waited_s": med(raw_act),
                "others_n": len(raw_other), "others_median_waited_s": med(raw_other)},
        "R7b": {"usd_per_seat_day": days, "kill_rule_breaches": breaches},
        "beside": {"share_of_waited_time": {
            s: {k: round(v / sum(d.values()), 3) for k, v in sorted(d.items(), key=lambda x: -x[1])}
            for s, d in shares.items()}},
        "waits": sorted(waits_detail, key=lambda w: w["act_ts"]),
    }
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
