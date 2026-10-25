"""Why only some pushes became acts: per pair, the daemon's lane_push_* log lines, and each agent's
stream order of git push / lane state moves / hand-sent pushed messages / gate refusals."""
import glob, json, re, sys
from pathlib import Path
sys.path.insert(0, "/app/scripts/research/cooperbench")
from readout import stream_events
LOGS = sys.argv[1]; ARM = sys.argv[2]
GIT_PUSH = re.compile(r"\bgit\s+(?:-C\s+\S+\s+)*push\b")
PUSHED = re.compile(r"(?i)\bpush(ed)?\b|\bfetch\b|\bpull\b|branch .*(ready|up)|committed")
for f in sorted(glob.glob(f"{LOGS}/{ARM}/**/result.json", recursive=True)):
    pair = Path(f).parent
    print("=== ", "/".join(pair.parts[-3:]))
    for dl in list(pair.rglob("*daemon.log")):
        for line in dl.read_text(errors="replace").splitlines():
            if "lane_push" in line or "record-push" in line or "lanes/push" in line:
                print("  DAEMON", line[:260])
    for stream in sorted(pair.glob("agent*_stream.jsonl")):
        seat = stream.name.replace("_stream.jsonl", "")
        print("  --", seat)
        for kind, payload in stream_events(stream):
            if kind == "bash" and GIT_PUSH.search(payload):
                print("     PUSH   ", payload.replace("\n", " ")[:110])
            elif kind == "tool":
                name, args = payload
                short = name.replace("mcp__musterd__", "")
                if short in ("lane_resolve", "lane_submit", "lane_release", "lane_handoff", "lane_update", "lane_open", "lane_claim"):
                    print("     LANE   ", short, json.dumps({k: v for k, v in args.items() if k in ("id", "state", "scope", "to", "title")})[:120])
                elif short == "team_send" and PUSHED.search(args.get("body", "") or ""):
                    print("     SEND   ", (args.get("body") or "").replace("\n", " ")[:110])
            elif kind == "result" and ("is held by" in payload or "blocked once" in payload):
                print("     REFUSED", payload.replace("\n", " ")[:90])
            elif kind == "result" and "pushed \"" in payload and "[lane]" in payload:
                print("     PUSHACT-RECEIVED", payload.replace("\n", " ")[:110])
            elif kind == "result" and "is free." in payload and "[lane]" in payload:
                print("     FREED-RECEIVED", payload.replace("\n", " ")[:90])
