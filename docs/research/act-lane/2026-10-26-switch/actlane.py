"""The act-lane read (docs/research/act-lane-manifest.md, ADR 735), written 2026-10-26 before any
result was read. One pass over one or more host logs; no model calls, no daemon access.

    python3 actlane.py --since 2026-10-26T19:33Z --until 2026-10-28T19:35Z \
        --act-lane izzo,miley,grokbot --fix-at 2026-10-26T20:10Z host.log [other-host.log ...]

Reads the lines ADR 735 §3 added (`wake due: <seat> [<lane>] — <act> from <sender>, waited <t> (lease
<ulid>)`) and the ADR 252 cost lines (`wake cost recorded for <seat>: $<n> (lease <ulid>)`). A wake's
time is its lease ULID's timestamp; a lease seen in several logs (one host defers, another wakes) is one
wake. Reports, per the manifest:

- R7a: median `waited` on act-lane seats' wakes vs the launch-lane seats' over the same window.
  Wakes before `--fix-at` (the #3358 backlog fix reaching the daemons) on act-lane seats whose act was
  received before the seat's switch are BACKLOG: reported separately, never in R7a.
- R7b: wakes per act-lane seat per day, and $ per wake (median) where a cost line exists; the kill rule
  ($10 in one day) is checked per seat per day.
- Beside the rules: act-lane wakes on a plain `message`, failed wakes, launch-lane $ per wake.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import sys
from collections import defaultdict

ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
DUE = re.compile(r"wake due: (\S+) \[(\w+)\] — (\S+) from (\S+?)(?:, waited (\S+))? \(lease (\w+)\)")
COST = re.compile(r"wake cost recorded for (\S+): \$([0-9.]+|—) \(lease (\w+)\)")
FAILED = re.compile(r"wake FAILED for (\S+)")


def ulid_ms(u: str) -> int:
    n = 0
    for ch in u[:10]:
        n = n * 32 + ALPH.index(ch)
    return n


def parse_waited(s: str | None) -> float | None:
    if not s:
        return None
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", s)
    if not m:
        return None
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def iso_ms(s: str) -> int:
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--since", required=True)
    ap.add_argument("--until", required=True)
    ap.add_argument("--act-lane", required=True, help="comma-separated seats on lane: act")
    ap.add_argument("--fix-at", required=True, help="when #3358 reached the daemons (ISO)")
    ap.add_argument("--switch-at", default=None, help="per-seat switch times seat=ISO,...; default --since")
    a = ap.parse_args()
    since, until, fix_at = iso_ms(a.since), iso_ms(a.until), iso_ms(a.fix_at)
    act_lane = set(a.act_lane.split(","))
    switch = {s: since for s in act_lane}
    if a.switch_at:
        for kv in a.switch_at.split(","):
            k, v = kv.split("=")
            switch[k] = iso_ms(v)

    wakes: dict[str, dict] = {}
    costs: dict[str, float | None] = {}
    failed = defaultdict(int)
    for path in a.logs:
        for line in open(path, errors="replace"):
            m = DUE.search(line)
            if m:
                seat, lane, act, sender, waited, lease = m.groups()
                ts = ulid_ms(lease)
                if since <= ts <= until and lease not in wakes:
                    wakes[lease] = {"seat": seat, "lane": lane, "act": act, "sender": sender,
                                    "waited_s": parse_waited(waited), "ts": ts}
                continue
            m = COST.search(line)
            if m:
                seat, usd, lease = m.groups()
                costs[lease] = None if usd == "—" else float(usd)
                continue
            m = FAILED.search(line)
            if m:
                failed[m.group(1)] += 1

    for lease, w in wakes.items():
        w["usd"] = costs.get(lease)
        act_received = w["ts"] - int((w["waited_s"] or 0) * 1000)
        w["backlog"] = w["seat"] in act_lane and w["ts"] < fix_at and act_received < switch.get(w["seat"], since)

    def med(xs):
        xs = [x for x in xs if x is not None]
        return round(statistics.median(xs), 1) if xs else None

    act = [w for w in wakes.values() if w["seat"] in act_lane and not w["backlog"]]
    backlog = [w for w in wakes.values() if w["backlog"]]
    launch = [w for w in wakes.values() if w["seat"] not in act_lane]
    days = defaultdict(lambda: defaultdict(float))
    counts = defaultdict(lambda: defaultdict(int))
    for w in act:
        day = dt.datetime.fromtimestamp(w["ts"] / 1000, dt.timezone.utc).date().isoformat()
        counts[w["seat"]][day] += 1
        days[w["seat"]][day] += w["usd"] or 0.0
    out = {
        "window": {"since": a.since, "until": a.until, "fix_at": a.fix_at, "act_lane": sorted(act_lane)},
        "R7a": {
            "act_lane_wakes": len(act),
            "act_lane_median_waited_s": med([w["waited_s"] for w in act]),
            "launch_lane_wakes": len(launch),
            "launch_lane_median_waited_s": med([w["waited_s"] for w in launch]),
            "rule": "<= 120 s acted; >= 900 s did not; between: part of it",
        },
        "R7b": {
            "wakes_per_seat_day": {s: dict(d) for s, d in counts.items()},
            "usd_per_seat_day": {s: {d: round(v, 2) for d, v in dd.items()} for s, dd in days.items()},
            "kill_rule_breaches": [f"{s} {d} ${v:.2f}" for s, dd in days.items() for d, v in dd.items() if v > 10],
            "act_lane_usd_per_wake_median": med([w["usd"] for w in act]),
            "act_lane_priced_wakes": sum(1 for w in act if w["usd"] is not None),
        },
        "beside": {
            "backlog_wakes_before_fix": len(backlog),
            "backlog_detail": [{k: w[k] for k in ("seat", "act", "sender", "waited_s", "usd")} for w in backlog],
            "act_lane_wakes_on_plain_message": sum(1 for w in act if w["act"] == "message"),
            "act_lane_wakes_by_act": dict(sorted(defaultdict(int, {w["act"]: sum(1 for x in act if x["act"] == w["act"]) for w in act}).items())),
            "failed_wake_lines": dict(failed),
            "launch_lane_usd_per_wake_median": med([w["usd"] for w in launch]),
        },
        "wakes": sorted(wakes.values(), key=lambda w: w["ts"]),
    }
    json.dump(out, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
