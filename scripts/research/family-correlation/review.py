"""Blind one-shot reviews of each item by each model, through OpenRouter.

    OPENROUTER_API_KEY=... python3 review.py --dataset <cooperbench>/dataset --run <dir> --stage pilot|main
        --models models.json --cap-usd 200

Reads <dir>/items.jsonl (from `items.py draw`) and appends one row per (item, model) to
<dir>/reviews.jsonl. Resumable: a pair already reviewed is skipped; a scored review is never re-run.
An API error or timeout is retried once (manifest, Errors). Spend is the sum of OpenRouter's
`usage.cost` over every row in reviews.jsonl, both stages, and the run stops before a call once it
reaches --cap-usd.

The prompt and sampling are the manifest's, verbatim; change them there first, never only here.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import patchlib  # noqa: E402

URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_TOKENS = 2000
PROMPT = (
    "You are reviewing a code change before it is merged. Below are the task the change implements and "
    "the diff. Each added or unchanged line is prefixed with its line number in the new file; use that "
    "number. The change may contain no defect. Report only defects: behaviour that is wrong for the "
    "task, not style. Answer with JSON only, in the form "
    '`{"findings": [{"file": "<path>", "line": <new-file line>, "summary": "<one sentence>"}]}`. Return '
    '`{"findings": []}` if you find no defect.\n\n'
    "TASK: {task}\n\n"
    "DIFF: {diff}"
)


def item_patch(run: Path, dataset: Path, item: dict) -> str:
    if item["class"] == "control":
        return (dataset / item["feature"] / "feature.patch").read_text()
    return (run / "candidates" / f"{item['id']}.patch").read_text()


def render_prompt(run: Path, dataset: Path, item: dict) -> str:
    task = (dataset / item["feature"] / "feature.md").read_text().strip()
    files = [f for f in patchlib.parse(item_patch(run, dataset, item)) if not patchlib.is_test_path(f.path)]
    return PROMPT.replace("{task}", task).replace("{diff}", patchlib.numbered(files))


def parse_findings(text: str) -> list[dict] | None:
    """The findings list from a reply, or None when the reply is not the JSON shape asked for."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else ""
        s = s.rsplit("```", 1)[0]
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        start, end = s.find("{"), s.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            obj = json.loads(s[start : end + 1])
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict) or not isinstance(obj.get("findings"), list):
        return None
    out = []
    for f in obj["findings"]:
        if not isinstance(f, dict):
            continue
        try:
            line = int(f.get("line"))
        except (TypeError, ValueError):
            line = None
        out.append({"file": str(f.get("file", "")), "line": line, "summary": str(f.get("summary", ""))})
    return out


def call(model: dict, prompt: str, key: str) -> dict:
    body = {
        "model": model["openrouter"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": MAX_TOKENS,
        "usage": {"include": True},
    }
    if model.get("temperature_ok", True):
        body["temperature"] = 0
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, required=True)
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("--stage", choices=["pilot", "main"], required=True)
    ap.add_argument("--models", type=Path, required=True, help="JSON list of {name, family, openrouter, temperature_ok}")
    ap.add_argument("--cap-usd", type=float, required=True)
    a = ap.parse_args()
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("OPENROUTER_API_KEY is not set")

    models = json.loads(a.models.read_text())
    items = sorted(
        (json.loads(l) for l in open(a.run / "items.jsonl") if l.strip()),
        key=lambda i: i["order"],
    )
    items = [i for i in items if i["stage"] == a.stage]
    out_path = a.run / "reviews.jsonl"
    rows = [json.loads(l) for l in open(out_path)] if out_path.exists() else []
    done = {(r["item"], r["model"]) for r in rows}
    spent = sum(r.get("cost_usd") or 0 for r in rows)
    print(f"{a.stage}: {len(items)} items x {len(models)} models; ${spent:.2f} spent so far", flush=True)

    for it in items:
        prompt = render_prompt(a.run, a.dataset, it)
        for m in models:
            if (it["item"], m["name"]) in done:
                continue
            if spent >= a.cap_usd:
                raise SystemExit(f"hard stop: ${spent:.2f} spent, cap ${a.cap_usd:.2f}")
            row = {"item": it["item"], "stage": a.stage, "model": m["name"], "family": m["family"]}
            for attempt in (1, 2):
                try:
                    t0 = time.time()
                    resp = call(m, prompt, key)
                    text = resp["choices"][0]["message"].get("content") or ""
                    usage = resp.get("usage") or {}
                    row.update({
                        "served_model": resp.get("model"),
                        "temperature": 0 if m.get("temperature_ok", True) else "provider default",
                        "reply": text,
                        "findings": parse_findings(text),
                        "cost_usd": usage.get("cost"),
                        "tokens_in": usage.get("prompt_tokens"),
                        "tokens_out": usage.get("completion_tokens"),
                        "seconds": round(time.time() - t0, 1),
                        "error": None,
                    })
                    break
                except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
                    row.update({"error": f"attempt {attempt}: {e}", "findings": None, "cost_usd": 0})
            spent += row.get("cost_usd") or 0
            with open(out_path, "a") as f:
                f.write(json.dumps(row) + "\n")
            ok = "ok" if row["findings"] is not None else ("ERROR" if row["error"] else "bad-json")
            print(f"{it['item']}\t{m['name']}\t{ok}\t${spent:.2f}", flush=True)
    print(f"{a.stage} done; ${spent:.2f} spent", flush=True)


if __name__ == "__main__":
    main()
