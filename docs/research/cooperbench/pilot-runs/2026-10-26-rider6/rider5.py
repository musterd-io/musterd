"""Rider 5 (riders.md; ADR 731), derived from rider4.json's per-pair fields and the agents' streams:

- R5b: recorded pushes that fired at least one push act — distinct (holder, head) in `push_acts`, over
  `git_push_count`. _(Amended 2026-10-26, after the readout, on big-body's acceptance review of finding
  027: `git_push_count` is rider 4's count of `git push` commands, and a command that records nothing —
  a push after the pusher's lane ended — is not a recorded push. The script now also counts the daemon's
  `lane_push_recorded` lines per pair as `recorded_pushes` and reports `R5b_fraction_recorded` beside
  the as-run `R5b_fraction`; nothing else changed, and the finding names which denominator it reads.)_
- R5c: announced pushers who then sent a hand pushed / fetch message anyway — holders in `push_acts`
  with a `hand_pushed_sends` entry whose `push_acts_so_far >= 1`, over the distinct announced holders.
- `refusals`: held refusals in the streams ("is held by"), and how many carried the pushed head
  ("Their branch … is on …", ADR 731 §3).
- `pusher_lines`: the ADR 731 §2 hook line ("musterd: your push of …") as it appears in each agent's
  stream, so the readout can say whether the pusher ever saw it.

    python3 rider5.py /data/runs/logs r5-musterd rider4.json > rider5.json

Written before the readout (rider5-manifest.md §Reads). No model calls: it only reads what is on disk.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

LOGS = Path(sys.argv[1])
ARM = sys.argv[2]
R4 = json.load(open(sys.argv[3]))[ARM]

HELD = "is held by"
RECORDED = '"msg":"lane_push_recorded"'
HEAD_NOTE = "Their branch "
PUSHER_LINE = "musterd: your push of"


def stream_texts(pair: Path):
    """Every string payload in an agent's stream-json, flattened; refusal text and hook context both
    arrive as text inside tool results / user turns, and a substring count is all the rider needs."""
    out = {}
    for stream in sorted(pair.glob("agent*_stream.jsonl")):
        seat = stream.name.replace("_stream.jsonl", "")
        texts = []

        def walk(x):
            if isinstance(x, str):
                texts.append(x)
            elif isinstance(x, dict):
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)

        for line in stream.read_text(errors="replace").splitlines():
            try:
                walk(json.loads(line))
            except json.JSONDecodeError:
                texts.append(line)
        out[seat] = texts
    return out


def recorded_pushes(pair: Path) -> int:
    """The daemon's lane_push_recorded lines for this pair (ADR 730 §1: one per push that reported)."""
    return sum(
        1 for dl in pair.rglob("*daemon.log") for line in dl.read_text(errors="replace").splitlines() if RECORDED in line
    )


def pair_record(p: dict):
    pair = LOGS / p["pair"]
    acts = p.get("push_acts", [])
    announced = {(a["holder"], a["head"]) for a in acts}
    holders = {a["holder"] for a in acts}
    repeaters = sorted(
        h for h in holders if any(s.get("push_acts_so_far", 0) >= 1 for s in p.get("hand_pushed_sends", {}).get(h, []))
    )
    texts = stream_texts(pair)
    refusals = {s: sum(1 for t in v if HELD in t and "blocked" in t) for s, v in texts.items()}
    with_head = {s: sum(1 for t in v if HELD in t and "blocked" in t and HEAD_NOTE in t) for s, v in texts.items()}
    pusher_lines = {s: sum(1 for t in v if PUSHER_LINE in t) for s, v in texts.items()}
    return {
        "pair": p["pair"],
        "git_pushes": p.get("git_push_count", 0),
        "recorded_pushes": recorded_pushes(pair),
        "announced_pushes": len(announced),
        "announced_holders": sorted(holders),
        "holders_repeating_by_hand": repeaters,
        "receiver_next": [a.get("receiver_next") for a in acts],
        "refusals": sum(refusals.values()),
        "refusals_with_pushed_head": sum(with_head.values()),
        "pusher_lines_seen": pusher_lines,
    }


def main():
    pairs = [pair_record(p) for p in R4["pairs"]]
    pushes = sum(p["git_pushes"] for p in pairs)
    recorded = sum(p["recorded_pushes"] for p in pairs)
    announced = sum(p["announced_pushes"] for p in pairs)
    holders = sum(len(p["announced_holders"]) for p in pairs)
    repeaters = sum(len(p["holders_repeating_by_hand"]) for p in pairs)
    out = {
        ARM: {
            "pairs": pairs,
            "totals": {
                "git_pushes": pushes,
                "recorded_pushes": recorded,
                "announced_pushes": announced,
                "R5b_fraction": round(announced / pushes, 3) if pushes else None,
                "R5b_fraction_recorded": round(announced / recorded, 3) if recorded else None,
                "announced_holders": holders,
                "holders_repeating_by_hand": repeaters,
                "R5c_fraction": round(repeaters / holders, 3) if holders else None,
                "refusals": sum(p["refusals"] for p in pairs),
                "refusals_with_pushed_head": sum(p["refusals_with_pushed_head"] for p in pairs),
                "pusher_lines_seen": sum(sum(p["pusher_lines_seen"].values()) for p in pairs),
                "receiver_next": {
                    k: sum(1 for p in pairs for n in p["receiver_next"] if n == k)
                    for k in sorted({n for p in pairs for n in p["receiver_next"]}, key=str)
                },
            },
        }
    }
    json.dump(out, sys.stdout, indent=1, default=str)
    print()


if __name__ == "__main__":
    main()
