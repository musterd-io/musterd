#!/usr/bin/env bash
# The chain, read from the team's own record (ADR 665 Observability). Run by a person on the
# machine that holds the daemon's database; agent seats do not read it (ADR 658). Prints the
# rows behind ADR 665's chain table for the last 30 days, in the order the table lists them.
#
#   docs/demo/pitch/chain.sh [path-to-musterd.db] [since-YYYY-MM-DD for the who-asked row]
set -euo pipefail
DB="${1:-$HOME/.musterd/musterd.db}"
SINCE="${2:-2026-10-16}" # the day ADR 629 (lane requested_by) landed; no backfill before it
W="(strftime('%s','now')-30*86400)*1000"

q() { sqlite3 -header -column "$DB" "$1"; echo; }

echo "## Who signed off: done lanes in the last 30 days, by merge verification and authorizer"
q "select coalesce(json_extract(merged_json,'\$.verification'),'(no merge)') verification,
          coalesce(json_extract(merged_json,'\$.authorized_by'),'-') authorized_by, count(*) lanes
   from lanes where state='done' and resolved_at > $W group by 1,2 order by 3 desc;"

echo "## Who accepted: lane_review verdicts in the last 30 days, as acts and as distinct lanes"
q "select d.act, count(*) verdict_acts, count(distinct json_extract(a.meta,'\$.lane_review.lane')) lanes
   from messages d join messages a on a.id=json_extract(d.meta,'\$.in_reply_to')
   where d.act in ('accept','decline') and json_extract(a.meta,'\$.lane_review') is not null
     and d.ts > $W group by 1;"

echo "## Who asked: lanes opened since $SINCE, by basis and the asker's kind"
q "select coalesce(json_extract(l.requested_json,'\$.basis'),'(none)') basis,
          coalesce(m.kind,'-') asker_kind, count(*) lanes
   from lanes l left join members m on m.name=json_extract(l.requested_json,'\$.by')
   where l.created_at > strftime('%s','$SINCE')*1000 group by 1,2 order by 3 desc;"

echo "## Refusals: declines and challenges in the last 30 days, by sender and recipient kind"
q "select m.act, coalesce(s.kind,'?') from_kind, coalesce(t.kind,'?') to_kind, count(*) acts
   from messages m left join members s on s.id=m.from_member left join members t on t.id=m.to_member
   where m.act in ('decline','challenge') and m.ts > $W group by 1,2,3 order by 4 desc;"

echo "## Asks to people in the last 30 days, and how many got an accept or decline"
q "select t.name, count(*) asks,
          sum(case when exists(select 1 from messages r where json_extract(r.meta,'\$.in_reply_to')=m.id
                               and r.act in ('accept','decline')) then 1 else 0 end) answered
   from messages m join members t on t.id=m.to_member
   where m.act='ask' and t.kind='human' and m.ts > $W group by t.name;"
