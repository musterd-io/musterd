#!/usr/bin/env python3
"""Split CooperBench arm cost by what each model call was for (finding 036, lane 01M6S2NF8R).

Reads Claude Code `agent*_stream.jsonl` / `solo` stream transcripts under a run's logs folder
(layout: <logs>/<run>/<setting>/<repo>/<task>/<pair>/*_stream.jsonl) and prices every API call
from its own `usage` block. Two accountings:

- **issued**: a call's whole price goes to the tool(s) it issued (split evenly across parallel
  tool_use blocks); a call issuing no tool is `final`.
- **carried**: the tokens a tool's *result* adds to context, times the number of later calls in
  that session that re-read it at the cache-read price — what keeping that output around costs.

No model spend; pure log arithmetic. Prices are claude-opus-5-5 as Claude Code 2.1.307 bills it
($/MTok, fitted exactly to the flash run's 248 result.json costs: cache read is 0.05x input).
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys

PRICE = {"in": 4.0, "out": 20.0, "cache_read": 0.2, "cache_write_5m": 5.0, "cache_write_1h": 8.0}

INTEGRATE = re.compile(r"\bgit\s+(fetch|pull|merge|rebase|push|cherry-pick|am|remote)\b")
GIT_LOOK = re.compile(r"\bgit\s+(status|log|diff|show|branch|rev-parse|ls-files|stash|checkout|switch|add|commit|reset)\b")
TEST = re.compile(r"\b(pytest|py\.test|unittest|tox|nox|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test|jest|vitest|mocha|make\s+test|ctest|mvn\s+test|gradle\s+test|cargo\s+build|cargo\s+check|go\s+build|go\s+vet)\b")
WAIT = re.compile(r"\b(sleep|musterd\s+(inbox|wait))\b")
EDIT = re.compile(r"(sed\s+-i|\bpatch\b|git\s+apply|open\([^)]*['\"]w|\.write\(|write_text|cat\s*>|tee\s)")
READ = re.compile(r"^\s*(cd\s+\S+\s*(&&|;)\s*)?(grep|rg|sed\s+-n|cat|head|tail|ls|find|wc|nl|awk|tree|python3?\s+-c\s+['\"]import)\b")


def classify(name: str, inp: dict) -> str:
    if name.startswith("mcp__musterd__"):
        return "musterd:" + name[len("mcp__musterd__"):]
    if name.startswith("mcp__"):
        return "mcp:other"
    if name in ("Read", "Grep", "Glob", "LS"):
        return "read"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "edit"
    if name in ("TodoWrite", "ToolSearch", "Task", "Agent", "Monitor", "ScheduleWakeup"):
        return "meta:" + name
    if name == "Bash":
        cmd = str(inp.get("command", ""))
        if WAIT.search(cmd):
            return "wait"
        if INTEGRATE.search(cmd):
            return "git:integrate"
        if TEST.search(cmd):
            return "test"
        if EDIT.search(cmd):
            return "edit"
        if GIT_LOOK.search(cmd):
            return "git:inspect"
        if READ.search(cmd):
            return "read"
        return "bash:other"
    return "tool:" + name


def call_price(u: dict) -> float:
    cc = u.get("cache_creation") or {}
    w1h = cc.get("ephemeral_1h_input_tokens") or 0
    w5m = cc.get("ephemeral_5m_input_tokens")
    if w5m is None:
        w5m = (u.get("cache_creation_input_tokens") or 0) - w1h
    return (
        (u.get("input_tokens") or 0) * PRICE["in"]
        + (u.get("output_tokens") or 0) * PRICE["out"]
        + (u.get("cache_read_input_tokens") or 0) * PRICE["cache_read"]
        + w5m * PRICE["cache_write_5m"]
        + w1h * PRICE["cache_write_1h"]
    ) / 1e6


def result_tokens(content) -> int:
    if isinstance(content, str):
        return len(content) // 4
    n = 0
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            n += len(c.get("text", "")) // 4
    return n


def read_session(path: str):
    """Return (calls, reported_cost). A call = one API message id: its usage and its tool_uses."""
    calls: dict[str, dict] = {}
    order: list[str] = []
    tool_of: dict[str, tuple[str, str]] = {}  # tool_use_id -> (msg id, category)
    results: list[tuple[str, int]] = []  # (msg id of the call that issued it, tokens)
    reported = 0.0
    for line in open(path, encoding="utf-8"):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = d.get("type")
        if t == "assistant":
            m = d.get("message") or {}
            mid = m.get("id")
            if mid not in calls:
                calls[mid] = {"usage": {}, "tools": []}
                order.append(mid)
            if m.get("usage"):
                calls[mid]["usage"] = m["usage"]
            for b in m.get("content") or []:
                if b.get("type") == "tool_use":
                    cat = classify(b.get("name", ""), b.get("input") or {})
                    calls[mid]["tools"].append(cat)
                    tool_of[b.get("id")] = (mid, cat)
        elif t == "user":
            for b in (d.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    mid_cat = tool_of.get(b.get("tool_use_id"))
                    if mid_cat:
                        results.append((mid_cat, result_tokens(b.get("content"))))
        elif t == "result":
            reported += d.get("total_cost_usd") or 0.0
    return calls, order, results, reported


def agent_truth(stream_path: str) -> dict | None:
    """This session's own entry in the pair's result.json (CooperBench's ground truth)."""
    rp = os.path.join(os.path.dirname(stream_path), "result.json")
    if not os.path.exists(rp):
        return None
    r = json.load(open(rp))
    name = os.path.basename(stream_path).split("_stream")[0]
    return (r.get("agents") or {}).get(name) or r.get("agent")


def rescale_output(calls: dict, order: list[str], true_out: int) -> None:
    """Stream messages carry a partial output count; spread the session's true output total
    across its calls in proportion to those partial counts (+1 so no call gets zero)."""
    seen = [(calls[m]["usage"].get("output_tokens") or 0) + 1 for m in order]
    tot = sum(seen)
    for m, w in zip(order, seen):
        calls[m]["usage"] = dict(calls[m]["usage"], output_tokens=true_out * w / tot)


def split(paths: list[str]):
    issued = collections.Counter()
    carried = collections.Counter()
    ncalls = collections.Counter()
    base_ctx = []
    total_priced = 0.0
    total_reported = 0.0
    n_calls = 0
    for p in paths:
        calls, order, results, reported = read_session(p)
        truth = agent_truth(p)
        if truth:
            rescale_output(calls, order, truth.get("output_tokens") or 0)
            reported = truth.get("cost") or reported
        total_reported += reported
        idx = {mid: i for i, mid in enumerate(order)}
        if order:
            u0 = calls[order[0]]["usage"]
            base_ctx.append((u0.get("cache_read_input_tokens") or 0) + (u0.get("cache_creation_input_tokens") or 0) + (u0.get("input_tokens") or 0))
        for mid in order:
            c = calls[mid]
            pr = call_price(c["usage"])
            total_priced += pr
            n_calls += 1
            tools = c["tools"] or ["final"]
            for cat in tools:
                issued[cat] += pr / len(tools)
                ncalls[cat] += 1 / len(tools)
        for (mid, cat), tok in results:
            later = len(order) - idx[mid] - 1
            carried[cat] += tok * later * PRICE["cache_read"] / 1e6
    return {
        "sessions": len(paths),
        "calls": n_calls,
        "priced": total_priced,
        "reported": total_reported,
        "base_context_tokens_median": sorted(base_ctx)[len(base_ctx) // 2] if base_ctx else 0,
        "issued": dict(issued),
        "calls_by": dict(ncalls),
        "carried": dict(carried),
    }


def group(cat: str) -> str:
    if cat.startswith("musterd:"):
        return "coordinate (musterd tools)"
    return {
        "git:integrate": "integrate (git fetch/merge/push)",
        "git:inspect": "git inspect/commit",
        "wait": "wait",
        "test": "test/build",
        "read": "read/search",
        "edit": "edit",
        "final": "final answer",
    }.get(cat, "other")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("logs", help="folder holding <run>/ subfolders")
    ap.add_argument("runs", nargs="+", help="run names, e.g. flash2-solo; join several with +")
    ap.add_argument("--json", help="write the full split here")
    a = ap.parse_args()
    out = {}
    for spec in a.runs:
        paths = []
        for run in spec.split("+"):
            paths += glob.glob(os.path.join(a.logs, run, "**", "*_stream.jsonl"), recursive=True)
        pairs = {os.path.dirname(p) for p in paths}
        r = split(sorted(paths))
        r["pairs"] = len(pairs)
        out[spec] = r
        print(f"\n== {spec}: {r['pairs']} pairs, {r['sessions']} sessions, {r['calls']} calls "
              f"({r['calls'] / max(r['pairs'], 1):.1f}/pair); priced ${r['priced']:.2f}, reported ${r['reported']:.2f}; "
              f"first-call context median {r['base_context_tokens_median']:,} tok")
        g_iss, g_car, g_n = collections.Counter(), collections.Counter(), collections.Counter()
        for k, v in r["issued"].items():
            g_iss[group(k)] += v
            g_n[group(k)] += r["calls_by"][k]
        for k, v in r["carried"].items():
            g_car[group(k)] += v
        print(f"   {'category':34} {'calls/pair':>10} {'issued $':>9} {'share':>6} {'carried $':>10}")
        for k, v in g_iss.most_common():
            print(f"   {k:34} {g_n[k] / r['pairs']:10.1f} {v:9.2f} {v / r['priced']:6.0%} {g_car.get(k, 0):10.2f}")
        mus = {k: v for k, v in r["issued"].items() if k.startswith("musterd:")}
        if mus:
            print("   musterd tools (issued $, calls/pair): " + ", ".join(
                f"{k[8:]} {v:.2f}/{r['calls_by'][k] / r['pairs']:.1f}" for k, v in sorted(mus.items(), key=lambda x: -x[1])))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=1, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
