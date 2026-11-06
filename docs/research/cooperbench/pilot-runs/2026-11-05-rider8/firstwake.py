"""R7d (rider 7 re-run B, ADR 809): each seat's FIRST wake's `reclaimable` share, from every
musterd-residency.json under a directory. Holds are in wake order per seat (report residency).
Usage: python3 firstwake.py <dir>  → JSON: per pair/seat first-wake reclaimable s, later-wake
reclaimable s, and the medians over seats."""
import json, statistics, sys
from pathlib import Path

root = Path(sys.argv[1])
rows, firsts, laters = [], [], []
for rep in sorted(root.rglob("musterd-residency.json")):
    r = json.load(open(rep))
    for s in r.get("by_seat", []):
        holds = s.get("holds", [])
        if not holds:
            continue
        first = holds[0].get("by_state", {}).get("reclaimable", 0) / 1000
        later = [h.get("by_state", {}).get("reclaimable", 0) / 1000 for h in holds[1:]]
        firsts.append(first); laters.extend(later)
        rows.append({"pair": rep.parent.name, "seat": s.get("seat"), "first_wake_reclaimable_s": round(first, 1),
                     "first_wake_waited_s": round((holds[0].get("waited_ms") or 0) / 1000, 1),
                     "later_wakes_reclaimable_s": [round(x, 1) for x in later]})
out = {"seats": len(firsts),
       "first_wake_reclaimable_median_s": round(statistics.median(firsts), 1) if firsts else None,
       "first_wake_reclaimable_s": [round(x, 1) for x in firsts],
       "later_wakes_reclaimable_median_s": round(statistics.median(laters), 1) if laters else None,
       "later_wakes": len(laters), "rows": rows}
print(json.dumps(out, indent=1))
