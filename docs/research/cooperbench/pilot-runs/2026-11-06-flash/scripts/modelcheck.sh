#!/usr/bin/env bash
source /etc/profile.d/cooperbench.sh
id smoke >/dev/null 2>&1 || useradd -m smoke
out=/data/runs/modelcheck.txt; : > "$out"
for m in claude-opus-5-5 claude-sonnet-5-5 claude-sonnet-4-5; do
  t=$(runuser -u smoke -- env HOME=/home/smoke ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude -p "reply with the single word ok" --model "$m" --output-format json 2>&1)
  echo "$t" | python3 -c "import json,sys
t=sys.stdin.read()
try:
  o=json.loads(t); u=o.get('usage') or {}
  print('$m', 'result=', o.get('result'), 'cost=', o.get('total_cost_usd'), 'in=', u.get('input_tokens'), 'cache_create=', u.get('cache_creation_input_tokens'), 'cache_read=', u.get('cache_read_input_tokens'), 'out=', u.get('output_tokens'), 'models=', list((o.get('modelUsage') or {}).keys()))
except Exception: print('$m', 'raw:', t[:300])" >> "$out"
done
echo done >> "$out"
