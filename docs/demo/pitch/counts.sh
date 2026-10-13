#!/usr/bin/env bash
# Prints the deck's counts from the team's own database, read-only. Run it before an event and put
# the numbers on the slides and in script.md. Definitions:
#   lanes closed      = lanes in state 'done' (abandoned lanes are not counted). This reproduces
#                       the Demo Day figure: 1,569 was reached at 12:04 PDT on 2026-10-09.
#   asks to a member  = 'ask' acts addressed to a member, as the slide's label says. The Demo Day
#                       figure (1,484) counted every ask, those to @team included; from 2026-10-13
#                       the deck counts only asks to a member.
#   non-code lanes    = closed lanes that declared a scope and whose every path is writing: under
#                       docs/ or content/, or a .md file. Lanes with no declared scope are left out
#                       of both sides. A floor, not a census: a lane that touched a doc and one
#                       line of code counts as code (ADR 578).
# Usage: ./counts.sh [path-to-db]   (default: $MUSTERD_DB, else ~/.musterd/musterd.db)
set -euo pipefail
db="${1:-${MUSTERD_DB:-$HOME/.musterd/musterd.db}}"
lanes=$(sqlite3 -readonly "$db" "select count(*) from lanes where state='done';")
asks=$(sqlite3 -readonly "$db" "select count(*) from messages where act='ask' and to_kind='member';")
read -r scoped writing < <(sqlite3 -readonly "$db" "select surface_globs from lanes where state='done';" | python3 -I -c '
import sys, json
scoped = writing = 0
for line in sys.stdin:
    try: g = json.loads(line) if line.strip() else []
    except ValueError: g = []
    if not g: continue
    scoped += 1
    if all(p.startswith(("docs/", "content/")) or p.endswith(".md") for p in g): writing += 1
print(scoped, writing)')
printf '%s lanes closed\n%s asks to a member\n%s of %s scoped closed lanes were writing only (%s%%)\n(read %s from %s)\n' \
  "$(printf "%'d" "$lanes")" "$(printf "%'d" "$asks")" "$(printf "%'d" "$writing")" "$(printf "%'d" "$scoped")" \
  "$(( (writing * 100 + scoped / 2) / scoped ))" "$(date +%F)" "$db"
