#!/usr/bin/env python3
"""ADR 741 read: what musterd ToolSearch detours cost a Claude Code seat, from local transcripts.

Reads every `~/.claude/projects/*musterd*/*.jsonl` (Claude Code's own session transcripts; nothing
leaves the machine) and reports, for assistant turns whose ToolSearch query names a musterd tool:

  calls            how many, per session (median), and which tools the queries named
  $/turn           the turn's own usage at list price (input, cache read, cache write, output)
  detour           wall-clock from the ToolSearch turn to the next assistant message
  set              how many calls a hot set would have removed (every tool in the query hot)
  net              $ of removed turns minus the hot set's schema tokens standing in every turn
                   before the session would have loaded them anyway (or every turn, if never),
                   at cache-read price — the honest cost of loading up front

    python3 toolsearch.py --since 2026-10-14 [--until ...] [--hot lane_open,...] [--tokens lane_open=498,...]

The ADR's baseline (2026-10-14..2026-10-26, before #3376) and its week-after read both come from
this script. Prices are Opus-class list rates per million tokens; change PRICES to re-price. The
schema token counts default to the 2026-10-26 `measureToolSurface` numbers (bytes/4).
"""
import argparse, collections, glob, json, os, re, statistics, sys
from datetime import datetime

PRICES = {  # $/M tokens: input, cache read, cache write, output
    'opus': (15, 1.5, 18.75, 75), 'fable': (15, 1.5, 18.75, 75), 'mythos': (15, 1.5, 18.75, 75),
    'sonnet': (3, 0.3, 3.75, 15), 'haiku': (1, 0.1, 1.25, 5),
}
HOT_BEFORE = {'team_join', 'team_inbox_check', 'team_send', 'team_status'}  # lane 01M4S53E79
ADDED = {  # ADR 741, tokens = bytes/4 of the tools/list entry, 2026-10-26
    'lane_open': 498, 'lane_claim': 112, 'lane_update': 687, 'lane_submit': 227, 'lane_resolve': 278,
    'lane_board': 169, 'team_next': 57, 'team_memory_read': 89, 'team_memory_save': 229,
}
TOOL = re.compile(r'((?:lane|team)_[a-z_]+)')


def price(model):
    m = (model or '').lower()
    for k, p in PRICES.items():
        if k in m:
            return p
    return PRICES['sonnet']


def turn_cost(msg):
    u = msg.get('usage') or {}
    p = price(msg.get('model'))
    return (u.get('input_tokens', 0) * p[0] + u.get('cache_read_input_tokens', 0) * p[1]
            + u.get('cache_creation_input_tokens', 0) * p[2] + u.get('output_tokens', 0) * p[3]) / 1e6


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', default='9999')
    ap.add_argument('--hot', default=','.join(sorted(ADDED)), help='tools to price as hot beside the four')
    ap.add_argument('--tokens', default='', help='override schema tokens: name=n,name=n')
    ap.add_argument('--glob', default=os.path.expanduser('~/.claude/projects/*musterd*/*.jsonl'))
    a = ap.parse_args()
    tokens = dict(ADDED)
    for kv in filter(None, a.tokens.split(',')):
        k, v = kv.split('=')
        tokens[k] = int(v)
    hot = set(filter(None, a.hot.split(',')))
    for h in hot:
        if h not in tokens:
            sys.exit(f'{h}: no schema token count; pass --tokens {h}=<n>')

    named = collections.Counter(); per_session = []; costs = []; detours = []; ctx = []
    saved = extra = 0.0; sessions = 0
    for f in glob.glob(a.glob):
        turns = 0; loaded = {}; model = None; n = 0; pending = None; s_saved = 0.0
        for line in open(f):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get('type') != 'assistant':
                continue
            t = o.get('timestamp', '')
            if not (a.since <= t[:10] <= a.until):
                continue
            msg = o.get('message', {}); turns += 1; model = msg.get('model') or model
            if pending is not None:
                d = (ts(t) - ts(pending)).total_seconds()
                if 0 < d < 300:
                    detours.append(d)
                pending = None
            for c in msg.get('content', []) or []:
                if c.get('type') != 'tool_use' or c.get('name') != 'ToolSearch':
                    continue
                q = set(TOOL.findall(c.get('input', {}).get('query', '')))
                if not q:
                    continue
                n += 1; pending = t; named.update(q); costs.append(turn_cost(msg))
                u = msg.get('usage') or {}
                ctx.append(u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0))
                for x in q:
                    loaded.setdefault(x, turns)
                if q <= (hot | HOT_BEFORE):
                    s_saved += turn_cost(msg)
        if turns == 0:
            continue
        sessions += 1
        p = price(model)
        extra += sum(tokens[x] * loaded.get(x, turns) * p[1] / 1e6 for x in hot)
        saved += s_saved
        if n:
            per_session.append(n)

    print(f'sessions {sessions}, with a musterd ToolSearch {len(per_session)}, calls {sum(per_session)}'
          f' (median {statistics.median(per_session) if per_session else 0}/session)')
    if costs:
        print(f'$/turn median {statistics.median(costs):.3f} mean {statistics.mean(costs):.3f} total {sum(costs):.2f};'
              f' context at the call median {statistics.median(ctx):.0f} tokens')
    if detours:
        srt = sorted(detours)
        print(f'detour median {statistics.median(detours):.1f}s p75 {srt[3 * len(srt) // 4]:.1f}s mean {statistics.mean(detours):.1f}s')
    print(f'hot set {sorted(hot)}: removes ${saved:.2f} of turns, costs ${extra:.2f} standing, net ${saved - extra:.2f}')
    print('tools named:', ', '.join(f'{k} {v}' for k, v in named.most_common(20)))


if __name__ == '__main__':
    main()
