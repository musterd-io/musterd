"""Pilot 3 cost attribution (finding 019). Usage: LOGS=/data/runs/logs python3 report.py > readout.json"""
import json
from cf import *

out = {'arms': {}, 'counterfactual_musterd': {}}
for arm, surf in [('p3-musterd', 16000), ('p3-team', 0), ('solo-core', 0)]:
    R, N = arm_report(arm, surf)
    cats = collections.defaultdict(lambda: [0, 0.0])
    for f in glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl', recursive=True):
        for c in calls(f)[0]:
            k = coopcat(c); cats[k][0] += 1; cats[k][1] += c['cost']
    out['arms'][arm] = {
        'first_call_context_tokens': round(first_ctx(arm)),
        'phases': {k: {'calls': N[k], 'usd': round(R[k], 2)} for k in R},
        'categories': {k: {'calls': n, 'usd': round(d, 2)} for k, (n, d) in sorted(cats.items(), key=lambda x: -x[1][1])},
    }
for name, s, w, g in [('as_run', 0, 0, 0), ('A_surface_16k_to_4k', 12000, 0, 0), ('B_blocking_wait', 0, 1, 0),
                      ('C_drop_state_signal_sends', 0, 0, 1), ('A+B', 12000, 1, 0), ('A+B+C', 12000, 1, 1),
                      ('A0+B+C_surface_to_0', 16000, 1, 1)]:
    out['counterfactual_musterd'][name] = round(counterfactual('p3-musterd', s, w, g), 2)
print(json.dumps(out, indent=1))
