import sys, os, glob, json, re, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '2026-10-21-pilot3', 'cost'))
os.environ['LOGS'] = sys.argv[1]
import cf
from calls import calls
ROOT = sys.argv[1]
KINDS = [
  ('pushed/fetch', r'(?i)\bpush(ed)?\b|\bfetch\b|\bpull\b|branch .*(ready|up)|committed'),
  ('lane done / you can edit', r'(?i)resolv|released|you can (now )?(edit|proceed|modify|go)|all yours|free to|unblock|done with'),
  ('waiting / ETA', r'(?i)\beta\b|how.s (it|your)|let me know when|waiting|blocked|any update|status\?'),
  ('merged/complete/submitted', r'(?i)merged|complete|submitted|finished|implemented'),
  ('thanks/ack', r'(?i)thanks|thank you|sounds good|got it|ack|great|perfect|confirmed'),
]
def kind(body):
    for k, rx in KINDS:
        if re.search(rx, body): return k
    return 'other'
out = {}
for arm in sys.argv[2:]:
    n = collections.Counter(); usd = collections.Counter(); kinds = collections.Counter(); kusd = collections.Counter(); ex = collections.defaultdict(list)
    tot = 0
    for f in sorted(glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl', recursive=True)):
        cs, _ = calls(f)
        for c in cs:
            tot += c['cost']
            ts = [t for t in c['tools'] if t['name'].endswith('team_send')]
            if not ts: continue
            n['send_calls'] += 1; usd['send_calls'] += c['cost']
            n['sends'] += len(ts)
            if cf.is_signal(c):
                n['signal'] += 1; usd['signal'] += c['cost']
                b = ' '.join(t['input'].get('body', '') for t in ts)
                k = kind(b); kinds[k] += 1; kusd[k] += c['cost']
                if len(ex[k]) < 4: ex[k].append(b[:160])
            for t in ts:
                n['act:' + str(t['input'].get('act', 'message'))] += 1
    out[arm] = dict(total=round(tot, 2), counts=dict(n), usd={k: round(v, 2) for k, v in usd.items()},
                    signal_kinds={k: [kinds[k], round(kusd[k], 2)] for k in kinds}, examples=ex,
                    cf_as_run=round(cf.counterfactual(arm, 0, 0, 0), 2), cf_drop_wait=round(cf.counterfactual(arm, 0, 1, 0), 2),
                    cf_drop_signal=round(cf.counterfactual(arm, 0, 0, 1), 2))
json.dump(out, sys.stdout, indent=1)
