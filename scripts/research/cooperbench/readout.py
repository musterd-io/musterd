"""Per-pair readout for a CooperBench run, as pilot 2's manifest pre-registers it.

Walks a run's log folder (CooperBench's `logs/<run>/`) and writes one JSON record per pair:

- the result and eval (pass, merge outcome, which patch passed, cost, steps);
- the files each agent's patch changes, and the ones both change;
- the **cause** of a failed pair, by the manifest's rules in order: setup, coordination, task;
- for a musterd pair, from its copied daemon database: lanes (owner, scope, named files), whether
  the two agents' lanes named a common file, acts by kind, `lane.gate` rows by outcome and by
  `hold` (ADR 691/693), and after each `held` refusal what the refused agent did next;
- from each agent's stream, shell commands that wrote to a file another seat held (the gate does
  not see Bash, README) — a heuristic, labelled as one.

Usage: python3 readout.py <logs/run-dir> [<more run dirs>] > readout.json
Reads only; run it on a copy if the run is still writing.
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

DIFF_FILE = re.compile(r"^diff --git a/(\S+) b/(\S+)", re.M)
# A shell command that writes a path: in-place edit, redirect, tee, a here-doc into it, a python write.
SHELL_WRITE = r"(sed\s+-i[^|;&]*|perl\s+-[a-z]*i[^|;&]*|>>?\s*|tee\s+(-a\s+)?|open\([^)]*['\"]w)"


def is_named_file(entry: str) -> bool:
    """ADR 691: a scope entry with no glob character names a file outright."""
    return not any(c in entry for c in "*?[")


def patch_files(text: str) -> list[str]:
    return sorted({b for _, b in DIFF_FILE.findall(text or "")})


def find_one(pair: Path, *names: str) -> Path | None:
    for name in names:
        hits = sorted(pair.glob(name))
        if hits:
            return hits[0]
    return None


def load_json(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def agent_patches(pair: Path, result: dict) -> dict[str, str]:
    """CooperBench names each patch after its agent's FEATURE: features [1, 4] → agent1.patch, agent4.patch."""
    out: dict[str, str] = {}
    features = result.get("features") or []
    for i, agent in enumerate(("agent1", "agent2")):
        feature = features[i] if i < len(features) else None
        path = pair / f"agent{feature}.patch" if feature is not None else None
        out[agent] = path.read_text(errors="replace") if path is not None and path.exists() else ""
    return out


def cause(result: dict, ev: dict, files: dict[str, list[str]]) -> str | None:
    """The manifest's rules, in order. None for a pass."""
    if ev.get("both_passed"):
        return None
    apply = ev.get("apply_status") or {}
    agents = result.get("agents") or {}
    if ev.get("error") or any(v not in ("applied", None, "") for v in apply.values()) or any(
        (a or {}).get("status") == "Error" or (a or {}).get("error") for a in agents.values()
    ):
        return "setup"
    merge = (ev.get("merge") or {}).get("status")
    common = set(files.get("agent1", [])) & set(files.get("agent2", []))
    if merge == "conflicts" and common:
        return "coordination"
    if any(not files.get(a) for a in ("agent1", "agent2")):
        return "coordination"
    if merge in ("identical", "clean"):
        return "task"
    return "coordination" if merge == "conflicts" else "task"


def db_readout(db_path: Path) -> dict:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    lanes = []
    for r in con.execute("SELECT * FROM lanes ORDER BY created_at"):
        scope = json.loads(r["surface_globs"] or "[]")
        lanes.append(
            {
                "id": r["id"],
                "title": r["title"],
                "owner": r["owner_seat"],
                "state": r["state"],
                "scope": scope,
                "named": [s for s in scope if is_named_file(s)],
                "claimed_at": r["claimed_at"],
            }
        )
    names = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM members")}
    msgs = [
        {"ts": r["ts"], "from": names.get(r["from_member"]), "to": names.get(r["to_member"]), "act": r["act"]}
        for r in con.execute("SELECT ts, from_member, to_member, act FROM messages ORDER BY ts")
    ]
    audit = []
    for r in con.execute("SELECT ts, actor, action, result, detail FROM audit ORDER BY ts"):
        try:
            detail = json.loads(r["detail"] or "{}")
        except json.JSONDecodeError:
            detail = {}
        audit.append({"ts": r["ts"], "actor": r["actor"], "action": r["action"], "result": r["result"], "detail": detail})
    con.close()

    owners: dict[str, set[str]] = {}
    for lane in lanes:
        for f in lane["named"]:
            owners.setdefault(f, set()).add(lane["owner"] or "")
    named_common = sorted(f for f, who in owners.items() if len(who - {""}) > 1)

    gate = [a for a in audit if a["action"] == "lane.gate"]
    holds = Counter(a["detail"].get("hold") for a in gate if a["detail"].get("hold"))
    after_refusal = []
    for g in gate:
        if g["detail"].get("hold") != "held" or g["result"] != "deny":
            continue
        who, at = g["actor"], g["ts"]
        nxt = "nothing before the run ended"
        for event in sorted(
            [("act", m["ts"], m) for m in msgs if m["from"] == who and m["ts"] > at]
            + [("audit", a["ts"], a) for a in audit if a["actor"] == who and a["ts"] > at],
            key=lambda e: e[1],
        ):
            kind, _, e = event
            if kind == "act" and e["act"] in ("handoff", "request_help", "ask"):
                nxt = f"sent {e['act']} to {e['to']}"
                break
            if kind == "audit" and e["action"] in ("lane.updated", "lane.released", "lane.handed_off"):
                nxt = e["action"].replace("lane.", "lane ")
                break
            if kind == "audit" and e["action"] == "lane.gate":
                nxt = f"tried another edit ({e['detail'].get('hold') or e['detail'].get('outcome')})"
                break
            if kind == "act" and e["act"] == "message":
                nxt = f"sent a message to {e['to']}"
                break
        after_refusal.append({"seat": who, "holder": g["detail"].get("holder"), "next": nxt})

    return {
        "lanes": lanes,
        "named_common_files": named_common,
        "acts": dict(Counter(m["act"] for m in msgs)),
        "acts_directed": sum(1 for m in msgs if m["to"]),
        "gate": dict(Counter(f"{a['result']}:{a['detail'].get('outcome')}" for a in gate)),
        "holds": dict(holds),
        "after_held_refusal": after_refusal,
    }


def shell_writes(pair: Path, held: list[str]) -> list[dict]:
    """Heuristic: Bash commands in an agent's stream that write to a file some lane held."""
    if not held:
        return []
    found = []
    for stream in sorted(pair.glob("agent*_stream.jsonl")):
        agent = stream.name.split("_")[0]
        for line in stream.read_text(errors="replace").splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            for block in (ev.get("message") or {}).get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "tool_use" or block.get("name") != "Bash":
                    continue
                cmd = (block.get("input") or {}).get("command", "")
                for f in held:
                    if re.search(SHELL_WRITE + r"[^\n]*" + re.escape(f), cmd):
                        found.append({"agent": agent, "file": f, "command": cmd[:200]})
    return found


def pair_record(pair: Path) -> dict:
    result = load_json(find_one(pair, "result.json", "*.result.json"))
    ev = load_json(find_one(pair, "eval.json", "*.eval.json", "eval_result.json"))
    patches = agent_patches(pair, result)
    files = {a: patch_files(t) for a, t in patches.items()}
    rec = {
        "pair": str(pair),
        "task": f"{result.get('repo')}/{result.get('task_id')}",
        "features": result.get("features"),
        "arm": result.get("agent_framework"),
        "setting": result.get("setting"),
        "passed": bool(ev.get("both_passed")),
        "merge": (ev.get("merge") or {}).get("status"),
        "strategy": (ev.get("merge") or {}).get("strategy"),
        "apply": ev.get("apply_status"),
        "f1": {k: (ev.get("feature1") or {}).get(k) for k in ("passed", "tests_passed", "tests_failed")},
        "f2": {k: (ev.get("feature2") or {}).get(k) for k in ("passed", "tests_passed", "tests_failed")},
        "cost": result.get("total_cost"),
        "steps": result.get("total_steps"),
        "agent_status": {a: (v or {}).get("status") for a, v in (result.get("agents") or {}).items()},
        "patch_files": files,
        "common_files": sorted(set(files.get("agent1", [])) & set(files.get("agent2", []))),
        "eval_error": ev.get("error"),
    }
    rec["cause"] = cause(result, ev, files)
    db = find_one(pair, "musterd-musterd.db")
    if db is not None:
        rec["musterd"] = db_readout(db)
        held = sorted({f for lane in rec["musterd"]["lanes"] for f in lane["named"]})
        rec["musterd"]["shell_writes_to_named_files_heuristic"] = shell_writes(pair, held)
    return rec


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    records = []
    for run in map(Path, argv):
        for res in sorted(run.rglob("result.json")) + sorted(run.rglob("*.result.json")):
            records.append(pair_record(res.parent))
    by_arm: dict[str, Counter] = {}
    for r in records:
        c = by_arm.setdefault(r["arm"] or "?", Counter())
        c["pairs"] += 1
        c["passed"] += r["passed"]
        c[f"cause:{r['cause']}"] += r["cause"] is not None
    json.dump(
        {"arms": {a: dict(c) for a, c in by_arm.items()}, "pairs": records},
        sys.stdout,
        indent=1,
        default=str,
    )
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
