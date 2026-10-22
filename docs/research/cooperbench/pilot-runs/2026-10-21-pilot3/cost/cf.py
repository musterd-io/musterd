import glob, json, re, collections
from calls import *
import os
ROOT = os.environ.get('LOGS', '/data/runs/logs')  # CooperBench run logs: p3-musterd, p3-team, solo-core
P_CR=0.30/1e6; P_CW=3.75/1e6
WAITY={'musterd:team_inbox_check','wait:bash-sleep','musterd:lane_board','musterd:team_status'}
def coopcat(c):
    k=call_cat(c)
    if k.startswith('work:bash') and any('coop-' in t.get('input',{}).get('command','') for t in c['tools']): return 'coord:coop-cli'
    if k.startswith('other:mcp__cooperbench') or k in('other:SendMessage','other:ListAgents'): return 'coord:coop-cli'
    return k
def first_ctx(arm):
    v=[calls(f)[0][0]['ctx'] for f in glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl',recursive=True)]
    return sum(v)/len(v)
def prompt_chars(arm):
    v=[]
    for f in glob.glob(f'{ROOT}/{arm}/**/agent*_session.jsonl',recursive=True)+glob.glob(f'{ROOT}/{arm}/**/session.jsonl',recursive=True):
        for l in open(f):
            x=json.loads(l)
            if x.get('content'): v.append(len(x['content'])); break
    return sum(v)/max(len(v),1)
def episodes(ks):
    out=[]; i=0
    while i<len(ks):
        if ks[i] in WAITY:
            j=i; n=0
            while j<len(ks) and (ks[j] in WAITY or ks[j] in ('git:inspect','git:partner')):
                n+= ks[j] in WAITY; j+=1
            if n>=2: out.append((i,j))
            i=j
        else: i+=1
    return out
def arm_report(arm, SURF=0):
    fs=sorted(glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl',recursive=True))
    R=collections.Counter(); N=collections.Counter()
    for f in fs:
        cs,_=calls(f); ks=[coopcat(c) for c in cs]
        edits=[i for i,k in enumerate(ks) if k=='work:edit']; fe,le=(edits[0],edits[-1]) if edits else (0,0)
        eps=episodes(ks); inwait=set()
        for i,j in eps: inwait.update(range(i+1,j))   # keep first call of each episode = the one blocking wait
        for i,(c,k) in enumerate(zip(cs,ks)):
            ph='1 setup' if i<fe else ('3 tail' if i>le else '2 edit')
            R[ph]+=c['cost']; N[ph]+=1
            R['total']+=c['cost']; N['total']+=1
            if i in inwait: R['save:wait']+=c['cost']; N['save:wait']+=1
            else:
                R['save:surface']+= SURF*(P_CW if i==0 else P_CR)
    return R,N
SIG=re.compile(r'(?i)push|fetch|resolv|unblock|can now|you can (now )?edit|eta|how.s (it|your)|let me know when|waiting|blocked|hand(ed)? ?off|released|ready for|merged|complete|done|submitted|thanks|thank you')
PLAN=re.compile(r'(?i)working on|will (add|modify)|line[s]? \d|plan|i.ll (add|take|own)|scope')
def is_signal(c):
    ts=[t for t in c['tools'] if t['name'].endswith('team_send')]
    if not ts or len(ts)!=len(c['tools']): return False
    b=' '.join(t['input'].get('body','') for t in ts)
    return bool(SIG.search(b)) and not PLAN.search(b)
def counterfactual(arm, surf_cut, drop_wait, drop_signal):
    tot=0
    for f in glob.glob(f'{ROOT}/{arm}/**/*stream.jsonl',recursive=True):
        cs,_=calls(f); ks=[coopcat(c) for c in cs]; inwait=set()
        if drop_wait:
            for i,j in episodes(ks): inwait.update(range(i+1,j))
        for i,c in enumerate(cs):
            if i in inwait: continue
            if drop_signal and is_signal(c): continue
            tot+=c['cost']-surf_cut*(P_CW if i==0 else P_CR)
    return tot
