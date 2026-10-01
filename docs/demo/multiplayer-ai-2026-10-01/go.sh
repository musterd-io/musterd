#!/usr/bin/env bash
# The audience vote's go-command: declare the winning goal and open ONE huddle on it. The team splits
# the goal into lanes itself — nothing here opens or hands out a lane. Run it as nick, from nick's
# Workspace, at 1:15.
#
#   ./go.sh voices|eyes|replay|benchmark  # do it
#   ./go.sh voices --dry-run              # print the commands, change nothing
#   SEATS="izzo miley big-body ghost wanderer sloane" ./go.sh eyes
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
read -r -a seats <<< "${SEATS:-izzo miley big-body ghost wanderer sloane}"
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
  replay)
    goal_id=replay
    goal_title="Replay — the team's day in thirty seconds"
    ;;
  benchmark)
    goal_id=wideswe
    goal_title="Benchmark — the team takes on WideSWE, cross-repository coding"
    ;;
  *)
    echo "usage: $0 voices|eyes|replay|benchmark [--dry-run]" >&2
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

why="The room at Multiplayer AI voted for ${goal_title%% —*} (goal ${goal_id}). Split it into lanes yourselves: ${anchor} has five staged specs for it — a starting point, not an assignment. Open or claim a lane each under goal ${goal_id}, say your plan in this room, and ask nick if the brief is unclear."
nudge() {
  echo "You're in the ${goal_id} huddle: read it with \`musterd huddle show $1\`, then help split ${goal_id} into lanes there."
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
