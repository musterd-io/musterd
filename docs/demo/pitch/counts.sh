#!/usr/bin/env bash
# Prints slide 7's two counts from the team's own database, read-only. Run it before an event and
# put the numbers on the slide and in script.md. Definitions:
#   lanes closed      = lanes in state 'done' (abandoned lanes are not counted). This reproduces
#                       the Demo Day figure: 1,569 was reached at 12:04 PDT on 2026-10-09.
#   asks to a member  = 'ask' acts addressed to a member, as the slide's label says. The Demo Day
#                       figure (1,484) counted every ask, those to @team included; from 2026-10-13
#                       the deck counts only asks to a member.
# Usage: ./counts.sh [path-to-db]   (default: $MUSTERD_DB, else ~/.musterd/musterd.db)
set -euo pipefail
db="${1:-${MUSTERD_DB:-$HOME/.musterd/musterd.db}}"
lanes=$(sqlite3 -readonly "$db" "select count(*) from lanes where state='done';")
asks=$(sqlite3 -readonly "$db" "select count(*) from messages where act='ask' and to_kind='member';")
printf '%s lanes closed\n%s asks to a member\n(read %s from %s)\n' \
  "$(printf "%'d" "$lanes")" "$(printf "%'d" "$asks")" "$(date +%F)" "$db"
