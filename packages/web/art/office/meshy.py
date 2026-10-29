"""Generate one office prop with Meshy (ADR 755): an untextured text-to-3D preview, saved as
`meshes/<name>.glb` with a sidecar `meshes/<name>.json` recording the prompt, the settings, the task id,
the date and the credits spent — the sidecar is what a reviewer reads, not the bytes.

    python3 meshy.py <name> "<prompt>" [polycount]

The key is read from ~/.config/musterd/meshy.key at request time and never printed or written. Plain
Python, no dependencies: this is an art tool, like Blender, and nothing here ships at runtime."""

from __future__ import annotations

import datetime
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.meshy.ai/openapi/v2/text-to-3d"


def call(key: str, method: str, url: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main() -> None:
    name, prompt = sys.argv[1], sys.argv[2]
    polycount = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
    key = open(os.path.expanduser("~/.config/musterd/meshy.key")).read().strip()
    settings = {"mode": "preview", "ai_model": "meshy-t2.5", "model_type": "smart-topology",
                "target_polycount": polycount, "origin_at": "bottom", "target_formats": ["glb"]}
    task = call(key, "POST", API, {"prompt": prompt, **settings})["result"]
    t0 = time.time()
    while True:
        t = call(key, "GET", f"{API}/{task}")
        if t["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
            break
        time.sleep(10)
    if t["status"] != "SUCCEEDED":
        sys.exit(f"{name}: {t['status']} {t.get('task_error')}")
    out = os.path.join(HERE, "meshes", name)
    urllib.request.urlretrieve(t["model_urls"]["glb"], out + ".glb")
    side = {"prompt": prompt, "settings": settings, "task": task, "date": datetime.date.today().isoformat(),
            "credits": t.get("consumed_credits"), "seconds": int(time.time() - t0), "bytes": os.path.getsize(out + ".glb")}
    with open(out + ".json", "w") as f:
        f.write(json.dumps(side, indent=2) + "\n")
    print(name, side["credits"], "credits", side["bytes"], "bytes", side["seconds"], "s")


if __name__ == "__main__":
    main()
