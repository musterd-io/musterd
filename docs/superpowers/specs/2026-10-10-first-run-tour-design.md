# First-run tour — design

**Status:** design approved in conversation by nick, 2026-10-10. Lane `01M4FDBXPX` (alfie), goal
`first-run-10-minutes`. Context: [business plan brainstorm](2026-10-09-business-plan-design.md), gaps 2
and 3.

## Outcome

A person who has just run `musterd init` can, after the tour, say what musterd is for and when to add a
seat. They learn it by doing it, on their own team with their own agent.

## Decisions (nick, 2026-10-10)

- **Two surfaces, one script:** a CLI tour (`musterd tour`) and an in-product web tour on `/live` and
  `/board`.
- **Hands-on:** each step is a real action on the person's own team, and advances when the real event
  arrives.
- **Owners:** alfie writes the script and builds the CLI tour. miley builds the web tour from alfie's
  UI-copy spec. dreamy's `/start` page (lane `01M4GQ2NR4`) is unchanged and ends with a link into the
  tour.
- **No due dates** on the delivery order.

## The steps

Shared by both surfaces. Copy is drafted in `content/tour.data.ts`, not here.

| # | Step | The person | Advances when |
|---|---|---|---|
| 0 | What this is | reads two lines: the ADR 550 claim, in second person | they continue |
| 1 | Your team | sees the roster: themselves and their agent as named members, with the model the harness observed | immediately |
| 2 | Give it work | accepts a small, safe lane the tour opens for them: read the repo's README and write a three-line summary in the lane note. No files change. | the lane is opened under their name |
| 3 | It claims it | watches the tour ask their agent to claim the lane | the agent claims it |
| 4 | It hands it back | waits | the agent submits, and the lane is waiting on their acceptance |
| 5 | You judge it | reads the summary, then accepts it or sends it back with a note | their verdict is recorded |
| 6 | The record | sees this lane's chain: who opened it, who claimed it, which model did it, who accepted it | immediately |
| 7 | When to add a seat | reads the guide (below) | they continue |
| 8 | Where to go next | gets the board, `/live`, and the inbox, one line each | end |

Expected length: 5–8 minutes, most of it the agent's work in step 4.

### When to add a seat (step 7 content)

From nick's own reasons, each with the exact command (`musterd agent <name>`):

- **Capacity for something new:** a second piece of work to build, research or brainstorm, in parallel.
- **A different model:** another model's perspective, or to try one.
- **A role the team lacks:** a domain or responsibility nobody on the team holds.

Labelled as ideas, not yet tested with a new team: an independent reviewer on another model; a second
tool joining; a teammate bringing their own agent. The likely lead for a new team is connecting the
agents they already have (business plan brainstorm, "When to add an agent"); step 7 says that first if
first-run lane 2/3 has shipped by then.

### Claim discipline

Step 6 shows only the links the record holds for this lane. Per ADR 550 §3, "who asked" is partial: the
tour shows "opened by" and does not word it as a guarantee of who asked.

## One script, two surfaces

- **Source:** `content/tour.data.ts` at the repo root — a typed module. Each step has an id, its copy,
  the event it waits on (lane opened / claimed / awaiting acceptance / resolved, or none), and its
  "nothing yet" hints with their delays.
- **Generated copy:** `pnpm tour:gen` writes one generated, committed copy into the CLI package. The
  web package's generated folder is gitignored and rebuilt by its build-prep, which reads
  `content/tour.data.ts` there (lane `01M4M4DDYF`). Only `@musterd/protocol` may be imported across package boundaries, so neither
  package imports the root module. The precedent is `content/roadmap.data.ts` → `pnpm roadmap:gen`
  (ADR 041).
- **Drift gate:** `pnpm tour:check` fails if the CLI copy differs from the source; it runs in
  `format:check`.
- **Rejected:** putting the script in `@musterd/protocol` (it is the wire contract, ADR-gated); having
  the daemon serve it (server work for static copy).

Each surface implements the waiting its own way: the CLI on the team's event stream (as
`musterd inbox --watch` does), the web on the live events `/live` already receives. The daemon already
emits lane open, claim, state and resolve events; no server change is planned.

## Failure handling

- **No agent online at start:** steps 0–1 run; step 2 waits with one line on how to start one (open
  your harness in this folder, or `musterd agent <name>`). Ctrl-C exits cleanly.
- **Agent slow or silent:** a hint at 60s ("switch to your agent's window and say: check your inbox"),
  again at 3 minutes. The tour never times out on its own; measured cold wakes run to about 5 minutes.
- **Agent declines or challenges:** shown as the lesson, with its reason; the tour offers to reword
  the lane or skip to step 6, where the record shows the decline.
- **Person sends it back:** the agent gets the note; the tour returns to step 4.
- **Quit halfway:** the tour lane stays open, marked as the tour's. Rerunning `musterd tour` resumes
  from that lane's state; `musterd tour --reset` abandons it.
- **More than one agent:** the tour asks which one.
- **Large existing team:** the tour opens one lane, titled with a `[tour]` prefix, and sends nothing
  beyond its handoff.

## Verify first (checked 2026-10-10, read-only; details in the plan)

All three hold, with two adjustments: the lane is opened unowned and the agent is *asked* to claim it
(a handoff emits no claim event), and the CLI polls the team timeline every 2s (the socket skips a
member's own acts). The web build reads `content/tour.data.ts` at its build-prep, since the web's
generated folder is gitignored; the CLI gets the committed generated copy.

The original items:

1. **Acceptance reaches the person.** On a one-agent team, ordinary routing may find no eligible
   acceptor and let the agent self-close, which skips step 5. The handoff tells the agent to submit
   to the person by name (`lane_submit` with `to`). Confirm the daemon routes that ask to a human, and
   that the lane's stakes are `normal` so ADR 234 does not exempt it.
2. **A lane with no PR can be submitted and accepted.** The tour lane changes no files.
3. **The event shapes** each step waits on, read from the daemon's emitters rather than assumed.

## Delivery order

1. The script, `tour:gen` and `tour:check`.
2. `musterd tour`, and the offer at the end of `musterd init` ("Take the 5-minute tour? [Y/n]").
3. The web UI-copy spec, handed to miley with a new lane under `first-run-10-minutes`.
4. miley's web tour; copy fixes from the first outside run.

## Testing

- CLI: unit tests for the step machine against a fake event stream, one per failure case above;
  snapshot tests for each screen. Each new screen is added to `docs/design/figma-brief-terminal.md` in
  the same PR (AGENTS.md hard rule 2).
- `tour:check`: a test that it fails on drift.
- CI runs the suite; nothing is run locally beyond the fast gates.
- Live: nick runs `musterd tour` on a fresh team before the first outside run. That run is the real
  test of the outcome above.

## Out of scope

- An "explain only" mode with no agent.
- Translating or personalising the copy per role.
- Any server or protocol change. If verification item 1 or 2 fails, that becomes its own lane and ADR.
