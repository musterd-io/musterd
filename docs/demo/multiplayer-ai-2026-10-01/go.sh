#!/usr/bin/env bash
# The audience vote's go-command: declare the winning goal, open its five lanes, and hand each
# to a member who can wake. Run it as nick, from nick's team home, at 1:15.
#
#   ./go.sh voices|eyes|replay|benchmark  # do it
#   ./go.sh voices --dry-run              # print the commands, change nothing
#   SEATS="ryder gptbot grokbot ghost delta" ./go.sh eyes
#
# The lane text is the same as options.md; change both together.
set -euo pipefail

option="${1:-}"
dry=0
[[ "${2:-}" == "--dry-run" ]] && dry=1
read -r -a seats <<< "${SEATS:-ryder gptbot grokbot ghost delta}"
project="${MUSTERD_PROJECT:-runtime}"
note="The room at Multiplayer AI voted for this, 2026-10-01. Claim it, post your plan as a status_update, and ask nick if the brief is unclear."

run() {
  if (( dry )); then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

case "$option" in
  voices)
    goal_id=voices
    goal_title="Voices — the team talks out loud, and you can talk back"
    titles=(
      "Voices: pick the voice provider (ElevenLabs, Cartesia or OpenAI realtime) and where synthesis runs"
      "Voices: a daemon endpoint that speaks an act, through one vendor adapter"
      "Voices: a voice for every member, derived from its identity"
      "Voices: playback on /live — one at a time, asks first, mute, room tone ducks"
      "Voices: talk back — push-to-talk on /live becomes the reply to the open ask"
    )
    scopes=(
      "docs/decisions/**"
      "packages/server/src/voice/speak.ts,packages/server/src/voice/adapters/**"
      "packages/web/src/live/voiceIdentity.ts"
      "packages/web/src/live/voice/**"
      "packages/web/src/live/PushToTalk.tsx,packages/server/src/voice/transcribe.ts"
    )
    details=(
      "An ADR chooses one of ElevenLabs, Cartesia or OpenAI realtime on latency, quality and cost measured on ten real acts. Synthesis runs on the daemon so the key never reaches a browser. The browser's own speech voice is the no-key fallback."
      "/live can ask the daemon for an act's audio and gets a stream back, through one vendor adapter ported from the Exploring Next podcast's rotation (~/SandRise/workers/podcast-generator)."
      "Each agent has a stable voice derived from its identity, the way its hue is. A human is silent unless they opt in."
      "Acts are spoken as they land, one at a time. An ask goes to the front of the queue. One toggle mutes it. The room tone ducks under speech."
      "Holding a key on /live records the human, transcribes it, and sends it as the reply to the open ask."
    )
    ;;
  eyes)
    goal_id=eyes
    goal_title="Eyes — members can look at the office floor"
    titles=(
      "Eyes: what a member may see, and what a look costs"
      "Eyes: render a still of the office on request"
      "Eyes: a team_look tool that hands the frame to the member's own model"
      "Eyes: the same scene in words, for models without vision"
      "Eyes: a first thing worth seeing — a teammate who has gone quiet"
    )
    scopes=(
      "docs/decisions/**"
      "packages/server/src/eyes/render.ts"
      "packages/mcp/src/tools/look.ts"
      "packages/server/src/projection/scene.ts"
      "packages/server/src/eyes/notice.ts"
    )
    details=(
      "An ADR sets what a frame may show (own team only), a price and rate limit per look in the style of wake pricing, and where frames are kept."
      "The daemon returns a PNG of the office as /broadcast draws it, headless, in under two seconds."
      "A member calls team_look and its model receives the frame as an image. musterd runs no vision model of its own."
      "For a model without vision, team_look returns who is where, whose lamp is on and for how long, and what is on the asks rail."
      "A member that looks notices a teammate whose lamp has been on for an hour with no act, and asks them if they are stuck."
    )
    ;;
  replay)
    goal_id=replay
    goal_title="Replay — the team's day in thirty seconds"
    titles=(
      "Replay: an engine that plays the record back through the office"
      "Replay: a scrubber and speed control on /live"
      "Replay: captions for claims, handoffs, asks and acceptances"
      "Replay: export a time-lapse as GIF or MP4"
      "Replay: fireworks when a lane is accepted"
    )
    scopes=(
      "packages/web/src/live/replay/engine.ts"
      "packages/web/src/live/replay/Scrubber.tsx"
      "packages/web/src/live/replay/moments.ts"
      "scripts/replay/**"
      "packages/web/src/live/office-scene/fireworks.ts"
    )
    details=(
      "Any window of the record plays back through the office at 1x to 1000x, members moving and lamps lighting as they did. Nothing new is stored."
      "/live has a timeline you can drag and a speed control. 'Now' returns to live."
      "Claims, handoffs, asks and acceptances get a caption as they pass, so a stranger can follow the day."
      "One command writes a GIF or MP4 of a chosen window, sized for a launch post."
      "An accepted lane sets off a short celebration on the floor, live and in replay (the open Fireworks seed)."
    )
    ;;
  benchmark)
    goal_id=wideswe
    goal_title="Benchmark — the team takes on WideSWE, cross-repository coding"
    titles=(
      "WideSWE: pre-register the run — tasks, hypothesis, falsifier, cost ceiling"
      "WideSWE: get the dataset and evaluator running here; one task scores end to end"
      "WideSWE: one command turns a task into a goal with a lane per repository"
      "WideSWE: the baseline — independent per-repo agents, no musterd"
      "WideSWE: the team run on revive, and the write-up, win or lose"
    )
    scopes=(
      "docs/research/wideswe/**"
      "scripts/wideswe/setup/**"
      "scripts/wideswe/runner/**"
      "scripts/wideswe/baseline/**"
      "docs/wiki/wideswe.md"
    )
    details=(
      "Paper: arXiv 2609.33382 (via the Exploring Next feed, 2026-09-30). Before anything runs: choose five to ten tasks; state the hypothesis that a team with a lane per repository resolves more than independent per-repo agents; name the falsifier and the cost ceiling."
      "The WideSWE dataset and evaluator run on this machine, and one task scores end to end."
      "One command turns a WideSWE task into a goal with one lane per repository, each lane's project set to its repo."
      "The chosen tasks run with independent agents, one per repository, no musterd. Scores and token cost recorded."
      "The same tasks run on revive. The result goes in docs/wiki/wideswe.md, win or lose, with the baseline beside it and the cost of each. Compare with independent agents, never with one agent alone."
    )
    ;;
  *)
    echo "usage: $0 voices|eyes|replay|benchmark [--dry-run]" >&2
    exit 2
    ;;
esac

if (( ${#seats[@]} < 5 )); then
  echo "need five seats in SEATS, got ${#seats[@]}" >&2
  exit 2
fi

if (( ! dry )); then
  who=$(musterd whoami 2>/dev/null | head -1)
  if [[ "$who" != *nick* ]]; then
    echo "run this as nick, from nick's team home (musterd whoami says: $who)" >&2
    exit 1
  fi
fi

run musterd goal declare "$goal_title" --goal-id "$goal_id" \
  --story "The room at Multiplayer AI picked this on 2026-10-01." || true

for i in 0 1 2 3 4; do
  if (( dry )); then
    run musterd lane open "${titles[$i]}" --goal "$goal_id" --project "$project" \
      --surface "${scopes[$i]}" --detail "${details[$i]}"
    run musterd lane handoff "<id>" --to "${seats[$i]}" --note "$note"
    continue
  fi
  out=$(musterd lane open "${titles[$i]}" --goal "$goal_id" --project "$project" \
    --surface "${scopes[$i]}" --detail "${details[$i]}")
  id=$(grep -oE '01[0-9A-HJKMNP-TV-Z]{24}' <<< "$out" | head -1)
  if [[ -z "$id" ]]; then
    echo "could not read the lane id from: $out" >&2
    exit 1
  fi
  musterd lane handoff "$id" --to "${seats[$i]}" --note "$note"
  echo "→ ${seats[$i]}  ${titles[$i]}"
done
