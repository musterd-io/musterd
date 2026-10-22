import sys, os, glob, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '2026-10-21-pilot3', 'cost'))
os.environ['LOGS'] = sys.argv[1]
import cf
from calls import calls
for arm in sys.argv[2:]:
    R = collections.Counter(); N = collections.Counter(); refused = collections.Counter()
    for f in glob.glob(f'{sys.argv[1]}/{arm}/**/*stream.jsonl', recursive=True):
        for c in calls(f)[0]:
            k = cf.coopcat(c)
            if k.startswith(('musterd:', 'wait:', 'gate:', 'other:')) and k != 'musterd:team_send':
                if k == 'musterd:team_inbox_check':
                    k += ' (wait)' if any(t['input'].get('wait') for t in c['tools'] if t['name'].endswith('team_inbox_check')) else ' (plain)'
                R[k] += c['cost']; N[k] += 1
    print('==', arm)
    for k in sorted(R, key=lambda k: -R[k])[:14]: print(f'   {k:40s} {N[k]:4d} ${R[k]:5.2f}')
