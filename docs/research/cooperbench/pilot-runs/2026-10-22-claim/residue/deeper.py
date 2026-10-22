import sys, os, glob, json, re, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '2026-10-21-pilot3', 'cost'))
os.environ['LOGS'] = sys.argv[1]
import cf
from calls import calls
ROOT = sys.argv[1]
for arm in sys.argv[2:]:
    sendk = collections.Counter(); sendusd = collections.Counter()
    epcomp = collections.Counter(); epusd = collections.Counter(); waitsecs = []; eps_n = 0; ep_lens = []
    for f in sorted(glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl', recursive=True)):
        cs, _ = calls(f); ks = [cf.coopcat(c) for c in cs]
        for c in cs:
            ts = [t for t in c['tools'] if t['name'].endswith('team_send')]
            if not ts: continue
            b = ' '.join(t['input'].get('body', '') for t in ts); act = ts[0]['input'].get('act', 'message')
            if cf.is_signal(c): k = 'state signal'
            elif cf.PLAN.search(b): k = 'plan/scope'
            elif act == 'status_update': k = 'status_update (other)'
            elif act in ('request_help', 'handoff', 'accept', 'ask'): k = act
            else: k = 'message (other)'
            sendk[k] += 1; sendusd[k] += c['cost']
        for i, j in cf.episodes(ks):
            eps_n += 1; ep_lens.append(j - i)
            for x in range(i + 1, j):
                c = cs[x]; sub = ks[x]
                if sub == 'musterd:team_inbox_check':
                    w = any(t['input'].get('wait') for t in c['tools'] if t['name'].endswith('team_inbox_check'))
                    sub = 'inbox WAIT' if w else 'inbox plain'
                epcomp[sub] += 1; epusd[sub] += c['cost']
            for x in range(i, j):
                for t in cs[x]['tools']:
                    if t['name'].endswith('team_inbox_check') and t['input'].get('wait'): waitsecs.append(t['input']['wait'])
    print('==', arm)
    print(' sends by kind', {k: [sendk[k], round(sendusd[k], 2)] for k in sorted(sendk, key=lambda k: -sendusd[k])})
    print(' wait episodes', eps_n, 'median len', sorted(ep_lens)[len(ep_lens)//2] if ep_lens else 0)
    print(' calls after the first in an episode', {k: [epcomp[k], round(epusd[k], 2)] for k in sorted(epcomp, key=lambda k: -epusd[k])})
    print(' wait args', collections.Counter(waitsecs).most_common(6))
