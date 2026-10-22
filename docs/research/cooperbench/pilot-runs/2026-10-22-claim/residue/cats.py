import sys, os, glob, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '2026-10-21-pilot3', 'cost'))
os.environ['LOGS'] = sys.argv[1]
import cf
from calls import calls
def grp(k):
    if k.startswith('work:'): return 'work (read/edit/test/bash)'
    if k.startswith('git:'): return 'git'
    if k in ('musterd:team_send', 'coord:coop-cli'): return 'messages'
    if k.startswith('musterd:') or k.startswith('wait:') or k.startswith('gate:'): return 'musterd other / wait / gate'
    if k == 'text-only': return 'text-only'
    return 'other'
for arm in sys.argv[2:]:
    R = collections.Counter(); N = collections.Counter(); steps = []
    for f in glob.glob(f'{sys.argv[1]}/{arm}/**/*stream.jsonl', recursive=True):
        cs, _ = calls(f); steps.append(len(cs))
        for c in cs: g = grp(cf.coopcat(c)); R[g] += c['cost']; N[g] += 1
    tot = sum(R.values())
    print(f'== {arm} total ${tot:.2f} calls {sum(N.values())} median calls/agent {sorted(steps)[len(steps)//2]}')
    for g in sorted(R, key=lambda g: -R[g]): print(f'   {g:32s} {N[g]:4d} calls ${R[g]:6.2f} {100*R[g]/tot:4.0f}%')
