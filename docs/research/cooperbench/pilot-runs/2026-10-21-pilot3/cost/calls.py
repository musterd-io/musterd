# Per-API-call cost attribution (finding 019). Prices: claude-sonnet-4-5 list.
import json, glob, os, re, sys, collections
P = dict(inp=3, cw=3.75, cr=0.30, out=15)  # sonnet-4.5 $/Mtok

def calls(path):
    """Group stream events into API calls (by message.id); attach tool_uses and their results."""
    ev = [json.loads(l) for l in open(path)]
    byid, order, results = {}, [], {}
    for e in ev:
        if e.get('type') == 'assistant':
            m = e['message']; mid = m['id']
            if mid not in byid:
                byid[mid] = dict(usage=m.get('usage', {}), tools=[], text='', chars=0)
                order.append(mid)
            c = byid[mid]; c['usage'] = m.get('usage', c['usage'])
            for b in m.get('content', []):
                c['chars'] += len(json.dumps(b))
                if b['type'] == 'tool_use': c['tools'].append(b)
                elif b['type'] == 'text': c['text'] += b['text']
        elif e.get('type') == 'user':
            for b in (e['message'].get('content') or []):
                if isinstance(b, dict) and b.get('type') == 'tool_result':
                    cont = b.get('content')
                    if isinstance(cont, list): cont = ''.join(x.get('text', '') for x in cont if isinstance(x, dict))
                    results[b['tool_use_id']] = (str(cont), b.get('is_error', False))
    res = [x for x in ev if x.get('type') == 'result']
    out = []
    sess_out = res[-1]['usage']['output_tokens'] if res else 0
    tot_chars = sum(byid[m]['chars'] for m in order) or 1
    for mid in order:
        c = byid[mid]; u = c['usage']
        cost = (u.get('input_tokens', 0)*P['inp'] + u.get('cache_creation_input_tokens', 0)*P['cw'] +
                u.get('cache_read_input_tokens', 0)*P['cr'] + sess_out*c['chars']/tot_chars*P['out'])/1e6
        ctx = u.get('input_tokens', 0)+u.get('cache_creation_input_tokens', 0)+u.get('cache_read_input_tokens', 0)
        for t in c['tools']: t['_result'] = results.get(t['id'], ('', False))
        out.append(dict(cost=cost, ctx=ctx, tools=c['tools'], text=c['text']))
    total = res[-1]['total_cost_usd'] if res else None
    return out, total

def cat(t):
    n = t['name']; i = t.get('input', {}); r, err = t['_result']
    if n.startswith('mcp__musterd__'):
        return 'musterd:' + n[len('mcp__musterd__'):]
    if n == 'Bash':
        cmd = i.get('command', '')
        if re.search(r'\bsleep\b|until |while ', cmd): return 'wait:bash-sleep'
        if re.search(r'git (fetch|merge|pull|rebase|cherry-pick)|git remote', cmd): return 'git:partner'
        if re.search(r'git (push|commit|add)', cmd): return 'git:publish'
        if re.search(r'\bgit\b', cmd): return 'git:inspect'
        if re.search(r'pytest|go test|npm|cargo|tox|jest|vitest|python -m|make', cmd): return 'work:test'
        return 'work:bash'
    if n in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
        if err or 'denied' in r.lower() or 'held' in r.lower(): return 'gate:edit-refused'
        return 'work:edit'
    if n in ('Read', 'Grep', 'Glob', 'LS'): return 'work:read'
    if n in ('TaskCreate','TaskUpdate','TaskList','TaskGet','TodoWrite'): return 'meta:todo'
    if n in ('ScheduleWakeup','Monitor','CronCreate','TaskStop','TaskOutput'): return 'wait:' + n
    return 'other:' + n

def call_cat(c):
    if not c['tools']: return 'text-only'
    cs = [cat(t) for t in c['tools']]
    # one call, one category: priority order
    for p in ('gate:', 'wait:', 'musterd:', 'git:partner', 'git:', 'work:', 'meta:', 'other:'):
        for x in cs:
            if x.startswith(p): return x
    return cs[0]
