# First-run tour on the web — UI-copy spec for `/live` and `/board`

Lane `01M4FDBXPX` (alfie), for miley's build lane `01M4M4DDYF`, goal `first-run-10-minutes`. Written
by alfie on 2026-10-10 from the [tour design](../superpowers/specs/2026-10-10-first-run-tour-design.md)
and the shipped CLI tour (`musterd tour`, PR #2328). Layout and build are miley's (designer). The
strings below are exact; the placement notes are recommendations.

## 1. One home for the copy

Every step's title, body and hints live in `content/tour.data.ts` at the repo root, and the CLI and
the web both render them from there. This spec names step ids; it never repeats their text, so a
copy fix is one edit in one file.

- **Build-time read.** The web's build-prep, `packages/web/scripts/gen-site-content.ts`, imports
  `content/tour.data.ts` and emits it into `packages/web/src/content/generated/` (gitignored, rebuilt
  on every build). The web never imports `content/` from `src/`: only `@musterd/protocol` crosses a
  package boundary.
- **Placeholders.** Fill `{you}`, `{agent}`, `{lane}`, `{model}` and `{verdict}` with the module's
  `fill()`. `{you}` is the viewer's member name, `{agent}` the agent taking the tour, `{lane}` the
  tour lane id.
- **Model.** Read `{model}` from the roster: the agent's first presence's `model`, ignored when it is
  `unknown`. With no model, drop every body line that contains `{model}`, except on `record`, where
  `{model}` reads `unattested`. This matches `musterd status` and the CLI tour.
- **Verdict.** `{verdict}` on `record` is one of the four forms in §4.
- **Step title.** `Step <n> of 9 · <title>`, where `<n>` is the step's position in `TOUR_STEPS`. For
  example `Step 6 of 9 · You judge it`.

## 2. Who sees the tour

The verdict in step 6 must come from a person. The daemon does not check that the member answering
an acceptance ask is the one it was routed to, so the web shows the tour only to a viewer signed in
as a **human** member. An agent viewer, or a viewer who is not signed in, sees no entry point.

A viewer's tour lane is the newest lane titled `TOUR_LANE_TITLE` filled with `{you}`; older
lanes with that title are the record of earlier runs. It is **open** when its state is one of
`open`, `claimed`, `active`, `blocked` or `awaiting_acceptance`. The CLI finds the same lane, so a
tour started in one surface resumes in the other, and a closed lane starts a fresh tour in both.

## 3. Strings

| Surface | State | Exact string | Notes |
|---|---|---|---|
| `/live`, `/board` | Entry: human viewer, at least one agent member, no tour lane of theirs in any state | `Take the tour` | Button. Show it once per page, out of the way of the roster and the board. |
| `/live`, `/board` | Entry: an open tour lane of theirs exists | `Resume the tour` | Button. Resumes at `claims` with that lane (§5). |
| `/live`, `/board` | Entry: beside `Resume the tour` | `Start over` | Link. Abandons the open lane (`state: 'abandoned'`, `abandon_reason: 'tour reset'`), then starts at `what`. |
| `/live`, `/board` | Entry: their newest tour lane is closed | `Take the tour again` | Button, same place as `Take the tour`. Starts at `what` and opens a new lane at `give_work`; the closed lane stays as the record. _(2026-10-12, lane `01M4RGKQ8P`: this row said "no entry point", and nick could not find the tour after finishing it once. The CLI already starts a fresh tour on a closed lane; the web now matches.)_ |
| Tour panel | Every step | step title (§1), then the step's `body` lines from `TOUR_STEPS` by id | Render each body line as its own line. Lines starting with two spaces on `add_seat` are a list. |
| Tour panel | `what`, `add_seat` | `Continue` | Button. Advances to the next step. |
| Tour panel | Every step before `record` | `Stop` | Link. Closes the panel and leaves the tour lane open. See `Stopped` below. |
| Tour panel | After `Stop` | `Stopped. Resume the tour any time to pick up where you left off.` | Toast or inline line. Web wording of the CLI's `STOPPED`; the CLI line names a command the web viewer has no reason to run. |
| Tour panel | `team`, more than one agent member | `TOUR_MESSAGES.pickAgent` | Then one choice per agent member, labelled with its name. Ask before `give_work` opens the lane. |
| Tour panel | `team`, no agent member | `TOUR_MESSAGES.noAgent` | The tour stops here. The entry point is hidden in this state anyway; this covers an agent that leaves mid-tour. |
| Tour panel | `team` | — | Advances by itself. Recommended placement: point at the roster on `/live`. |
| Tour panel | `give_work` | — | Advances once the lane is open and the request is sent (§5). |
| Tour panel | `claims` waiting | `TOUR_STEPS` `claims` hints | First hint at 60 s, second at 180 s after the step began. Show only the latest due hint, once. |
| Tour panel | `hands_back` waiting | `TOUR_STEPS` `hands_back` hint | At 180 s after the step began. |
| Tour panel | `judge` | the step's body, then the lane's `detail` | Render `detail` as plain text, never as HTML or markdown: an agent wrote it. |
| Tour panel | `judge`, `detail` is empty | `The lane has no summary yet.` | Muted. |
| Tour panel | `judge` | `Accept it` | Primary button. |
| Tour panel | `judge` | `Send it back with a note` | Secondary button. Opens the note field. |
| Tour panel | `judge`, note field label | `What should change?` | Required. |
| Tour panel | `judge`, note field submit | `Send it back` | Button. |
| Tour panel | After `Send it back` | `TOUR_MESSAGES.sentBack` | Then the panel returns to `hands_back`. |
| Tour panel | Agent declined the request | `TOUR_MESSAGES.declined` followed by the agent's reason | Reason as plain text (see `judge`). |
| Tour panel | After a decline | `See the record` | Button. Goes to `record`. |
| Tour panel | After a decline | `Stop here` | Link. Same as `Stop`. |
| Tour panel | Agent closed the lane itself | `TOUR_MESSAGES.selfClosed` | Then `record`. |
| Tour panel | `record` | the step's body | Recommended placement: point at the lane's card on `/board`. |
| Tour panel | `add_seat` | the step's body, then `Continue` | |
| Tour panel | `next` | the step's body | The three lines are commands; set them in mono. |
| Tour panel | `next` | `Done` | Button. Closes the panel. |
| Tour panel | Every step, panel header | `–` | Button, labelled `Minimize the tour (Esc)` for assistive tech, tooltip `Minimize (Esc)`. Collapses the panel to the pill below. Esc does the same, except while the viewer is typing or a control outside the panel has focus. The tour keeps running while collapsed. |
| `/live`, `/board` | Panel collapsed | `Tour · <n>/9` then, while waiting on the agent, the elapsed `m:ss` | The pill. One button, labelled `Open the tour, <step title>`; a click reopens the panel at the current step. Shows the waiting dot of the `claims` and `hands_back` steps so a collapsed tour still says it is waiting. _(Added 2026-10-12, lane `01M4RHD7Q3`: built in PR #2345, named here on nick's ask so the strings have one home.)_ |

## 4. The verdict line on `record`

| Outcome | `{verdict}` |
|---|---|
| The viewer accepted | `accepted by {you}` |
| The viewer sent it back at least once, then accepted | `sent back by {you}, then accepted by {you}` |
| The agent resolved the lane itself | `closed by {agent} itself` |
| The agent declined the request | `declined by {agent}` |

`record` says "opened by", never "asked by" (ADR 550 §3): the lane holds who opened it, and that is
all the tour claims.

## 5. What moves each step

The web reads the same acts the CLI does, from the events `/live` already receives. Only acts about
this tour's lane move it; a real team sends many others.

| Step | Moves on |
|---|---|
| `give_work` | The viewer's own calls: open the lane (`title` from §2, `stakes: 'normal'`, unowned), then send `request_help` to the agent with `TOUR_REQUEST` filled with `{you}` and `{lane}`. Keep the request's act id. |
| `claims` → `hands_back` | An act from the agent with `meta.lane_claim.lane` equal to the tour lane. |
| `hands_back` → `judge` | An `ask` to the viewer with `meta.lane_review.lane` equal to the tour lane. Keep its act id. |
| `judge` → `record` | The viewer's verdict: `accept`, or `decline` with the note as body, sent to the team with `meta.in_reply_to` set to the ask's id. A `decline` returns to `hands_back`. |
| `claims` → decline state | A `decline` or `challenge` from the agent with `meta.in_reply_to` equal to the request's id. |
| `hands_back` or `judge` → `record` | An act from the agent with `meta.lane_resolve.lane` equal to the tour lane (the self-close). |

**Resume** starts at `claims` and replays the team's acts from 5 s before the lane opened (the
lane's ULID carries the time), so a lane already claimed or waiting on the viewer lands on the right
step. It never opens a second lane. Deduplicate acts by id.

## 6. Glossary and voice

Terms used: member, team, lane, seat, act — each in its brand.md §5 sense. The strings in §3 are
second person and present tense, with no contrast frame, per brand.md §4. If a step's copy reads
wrong on the web, change `content/tour.data.ts` and regenerate (`pnpm tour:gen`); both surfaces pick
it up.
