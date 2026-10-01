#!/usr/bin/env bash
# The audience vote's go-command: declare the winning goal and open ONE huddle on it. The team splits
# the goal into lanes itself — nothing here opens or hands out a lane. Run it as nick, from nick's
# Workspace, at the live demo (docs/demo.md §8, 5:10).
#
#   ./go.sh voices|eyes|hire|dreaming     # do it
#   ./go.sh voices --dry-run              # print the commands, change nothing
#   SEATS="izzo miley ghost ryder wanderer lazara" ./go.sh eyes
#
# A huddle names at most four seats (MAX_ELIGIBLE, ADR 254), and only a named seat is convened —
# woken if it is offline (ADR 386); a @team huddle wakes nobody. So the first four SEATS are named on
# the open, and each of the rest gets a directed steer in the huddle's thread, which wakes it the same
# way (a steer is interrupt-class, ADR 103). One room, every seat summoned. Convening needs
# `musterd residency policy --convene-huddles on` and each seat enrolled with `--flow auto`.
#
# The five staged lane specs per option live in options.md, the huddle's anchor: a starting point
# for the room, not an assignment.
set -euo pipefail

option="${1:-}"
dry=0
[[ "${2:-}" == "--dry-run" ]] && dry=1
read -r -a seats <<< "${SEATS:-izzo miley ghost ryder wanderer lazara}"
anchor="docs/demo/multiplayer-ai-2026-10-01/options.md"

run() {
  if (( dry )); then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

case "$option" in
  voices)
    goal_id=voices
    goal_title="Voices — the team talks out loud, and you can talk back"
    ;;
  eyes)
    goal_id=eyes
    goal_title="Eyes — members can look at the office floor"
    ;;
  hire)
    goal_id=hire
    goal_title="Hire — the team grows itself: find the gap, post the job, interview candidate models"
    ;;
  dreaming)
    goal_id=dreaming
    goal_title="Dreaming — idle agents re-read the day overnight and wake up wiser"
    ;;
  *)
    echo "usage: $0 voices|eyes|hire|dreaming [--dry-run]" >&2
    exit 2
    ;;
esac

if (( ${#seats[@]} < 2 )); then
  echo "need at least two seats in SEATS, got ${#seats[@]}" >&2
  exit 2
fi
named=("${seats[@]:0:4}")
rest=("${seats[@]:4}")
to=$(IFS=,; echo "${named[*]}")

# The winner's five staged lane specs ride in the huddle body itself, read from the options.md beside
# this script, so a seat whose checkout is behind main still sees them (the anchor path alone would
# resolve to whatever options.md that seat's worktree has).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
specs=$(awk -v g="$goal_id" '
  BEGIN{IGNORECASE=1}
  /^## /{on = ($0 ~ "^## " g " |^## " g "$|^## " toupper(substr(g,1,1)) substr(g,2) " ")}
  on' "$here/options.md" | sed -e 's/[[:space:]]*$//' | grep -v '^$' || true)
why="The room at Multiplayer AI voted for ${goal_title%% —*} (goal ${goal_id}). Split it into lanes yourselves: ${anchor} has five staged specs for it — a starting point, not an assignment, and they are copied below. Open or claim a lane each under goal ${goal_id} and say your plan IN THIS ROOM: every turn is a reply in this thread (team_send with thread = this act's id, or musterd huddle say <this act's id>), never a direct message. Then start building your lane now and keep going until you are told to stop: commit as you go, and post a status_update at each step so the room can see it. Ask nick if the brief is unclear.

${specs}"
nudge() {
  echo "You're in the ${goal_id} huddle ($1): read it with \`musterd huddle show $1\`, then help split ${goal_id} into lanes there. Every turn goes in that room: \`musterd huddle say $1 \"…\"\` or team_send with thread $1, never a direct message."
}

if (( ! dry )); then
  who=$(musterd whoami 2>/dev/null | head -1)
  if [[ "$who" != *nick* ]]; then
    echo "run this as nick, from nick's Workspace (musterd whoami says: $who)" >&2
    exit 1
  fi
fi

run musterd goal declare "$goal_title" --goal-id "$goal_id" \
  --story "The room at Multiplayer AI picked this on 2026-10-01." || true

if (( dry )); then
  run musterd huddle open --topic "goal:$goal_id" --anchor "$anchor" --to "$to" --turns 40 "$why"
  for s in ${rest[@]+"${rest[@]}"}; do
    run musterd send --act steer --to "$s" --thread "<huddle-id>" "$(nudge '<huddle-id>')"
  done
  exit 0
fi

out=$(musterd huddle open --topic "goal:$goal_id" --anchor "$anchor" --to "$to" --turns 40 "$why")
id=$(grep -oE '01[0-9A-HJKMNP-TV-Z]{24}' <<< "$out" | head -1)
if [[ -z "$id" ]]; then
  echo "could not read the huddle id from: $out" >&2
  exit 1
fi
echo "→ huddle $id open on goal $goal_id — named: $to"
for s in ${rest[@]+"${rest[@]}"}; do
  musterd send --act steer --to "$s" --thread "$id" "$(nudge "$id")"
  echo "→ steered $s into $id"
done
