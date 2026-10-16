# `musterd pick`: the lane picker, a factual board you pick work from

**Date:** 2026-10-16
**Seat:** izzo
**Status:** design agreed with nick in chat on 2026-10-16. This spec is the record of it. Nothing is
built yet.
**Lane:** `01M515KHW00AMF9AJ703RNW9GN` (goal `find-work`)

## 1. What this is for

nick asks a seat what it could work on. The seat reads the board and shows him a list. On 2026-10-15,
izzo answered that question three times. Each answer was a selection: 106 open lanes went in, and six
"fit my role" picks came out. The selection is the seat's judgement, presented as if it were the
board. nick cannot tell what was left out or why.

The lane picker removes the seat from the reading. musterd renders the open lanes from the board.
nick looks at the real list, reads a brief, and picks a lane. The seat he is talking to gets it, and
the record says who asked.

**Success:**

- The list that nick sees is the board's open lanes, computed by one function. No model writes or
  filters it.
- It works the same from every harness (Claude Code, Codex, Cursor, opencode, Grok, native, Muse).
- A pick reaches the seat on its existing channels, and the seat answers with a short plan.
- The record says who picked and how strongly that is proven.

**Out of scope (later, by nick's decision):** picking for a seat other than the one you are talking
to. This makes the picker a dispatch console. It is a separate design.

## 2. Words

A **lane picker** is new. The ADR 491 **seat picker** (the launcher, bare `musterd`) already exists.
They are different screens, so this spec always says "lane picker". The command is `musterd pick`.

## 3. Constraints found before design

- **An agent cannot open an interactive terminal UI in its own chat.** Every harness gives the
  agent's shell tool captured output and no keyboard. `!` in Claude Code is typed by the human only.
  So the lane picker is something the human runs, or something the agent opens in the browser.
- **A command run from a seat's workspace acts as that seat.** `--as` was removed (ADR 442). Identity
  comes from `.musterd/binding.json` or the `MUSTERD_*` service env (`commands/helpers.ts` `gather()`).
  `! musterd pick` in izzo's folder therefore acts as izzo and cannot sign as nick.
- **/live is signed in as the human.** A pick there is the human's act.
- **The pieces already exist.** The CLI has a full-screen picker shell (ADR 491,
  `packages/cli/src/launcher/picker/`: alternate screen, raw keypress, fuzzy search, a pure reducer,
  tests). /live has `BoardOverlay.tsx`. `lane_handoff` gives an open, unowned lane to a seat, moves
  it to `claimed`, and sends the seat a directed `handoff` act (`transport/http.ts` around 7503).
- **find-work's query grammar is not built yet** (ADR 582 §1, lane `01M4VKRXEX`). The lane picker
  must not wait for it.

## 4. Decisions

1. **musterd renders the list. The agent never does.**
2. **Scope is the seat you are talking to.**
3. **Two ways in, one backend.** When you ask the agent, it runs `musterd pick --open`, which opens
   the /live lane picker for this seat in your browser. When you want the terminal, you run
   `! musterd pick` in Claude Code, or `musterd pick` in a split pane on another harness.
4. **What a terminal pick records: an honest label.** A terminal pick is the seat's own claim. It
   carries `pick: {via: 'terminal', requested_by, attested: false, harness, at}`. The record never
   claims more than it can prove. A /live pick is the verified form, a handoff from the human.
   *Rejected:* signing a terminal pick as the human, because it reverses ADR 442 and lets any agent
   in that folder act as the human. *Deferred:* pick in the terminal and confirm in /live (a
   `--verify` flag). Add it if the unverified label proves to be a problem.
5. **Two-pane layout.** The list is on the left, grouped by goal. The brief of the highlighted lane
   is on the right. Below about 100 columns the brief moves under the list.
6. **What the agent does on a pick (behavior B).** The agent claims the lane. Then it replies with a
   3–5 line plan: what it will build, the open decisions it sees, and its default for each. It
   starts unless redirected, like the advisory and standard ask tiers that proceed after a short
   wait. A decline releases the lane to `open` with a reason.

## 5. Architecture

### 5.1 One list: `pickerRows`

`pickerRows(board, seat)` is a pure function in `@musterd/protocol`. It takes the lane board, as
`GET /lanes` returns it today, and returns rows:

- open, unowned lanes only; `parked` is never shown;
- grouped by goal, with lanes that have no goal in a final group;
- split into **claimable** (every `depends_on` lane is `done`) and **blocked** (each blocked row
  names the unmet dependency and its owner);
- each row carries id, title, goal, areas, risk tags, age, and the most recent decline note if a
  seat declined this lane.

The terminal, the plain-text fallback, and /live all call the same function, so they cannot
disagree. The filter box uses the existing fuzzy matcher (`launcher/fuzzy.ts`). When find-work's
grammar ships, the filter text is also passed to the board read as `q`.

### 5.2 `musterd pick` in a terminal

The command reuses the ADR 491 picker shell (`launcher/picker/tty.ts`) with a new two-pane view.

```
musterd pick — revive · for izzo        type to filter · tab: blocked · ⏎ pick
┌ 23 claimable ─────────────────────┐┌ 01M41PX0XB ──────────────────────────────┐
│ cloud                             ││ Cloud: a duplicate envelope id on POST   │
│▸01M41PX0XB dup envelope id → 409 …││ /messages answers 409, not 500           │
│ 01M50ZB4YM console /health build… ││                                          │
│ launch                            ││ goal cloud · areas server · opened 10-03 │
│ 01M4S5HS81 stream ensure: stall … ││ scope packages/server/src/store/messag…  │
│ seat-continuity                   ││                                          │
│ 01M46GR8AC deaf seats re-measure  ││ Seen in load run 5c: an INSERT whose …   │
└───────────────────────────────────┘└──────────────────────────────────────────┘
```

Keys:

- Type to filter.
- `↑`/`↓` to move.
- `tab` switches between claimable and blocked.
- `⏎` picks.
- `esc` quits.

The header names the seat and warns, without blocking, when the seat already carries a lane
("izzo is carrying 01M3W42669").

### 5.3 With no terminal attached

When stdout is not a TTY, which is the case when an agent runs the command, `musterd pick` never
enters raw mode. It prints the same rows as a plain table, with full ids. With `--open`, it then
opens `/live?pick=<seat>` in the browser. If there is no display, it prints the URL. The agent's
fallback output is still musterd's board, not the agent's summary.

### 5.4 /live lane picker

`PickOverlay` is a sibling of `BoardOverlay`, opened by `/live?pick=<seat>`. It uses the same rows,
the same two-pane structure, and the same keys. If the viewer is not signed in, the existing sign-in
flow runs first and returns to the overlay.

### 5.5 What a pick does

| From                      | Wire                                                                 | Who the record says asked              |
| ------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| /live                     | existing `lane_handoff`, from the human to the seat, with a note     | the human, authenticated               |
| terminal                  | the seat claims the lane, with the new optional `pick` field         | `requested_by` the human, `attested: false` |

- **/live: no wire change.** It is the existing handoff.
- **Terminal: a protocol change, so it needs an ADR.** The optional `pick` field is added to the
  claim patch, and the `lane.claimed` audit row records it.

### 5.6 The seat hears a terminal pick

In Claude Code, the output of a `!` command lands in the agent's context. In a split pane on another
harness it does not, and a seat's own claim sends that seat no act. So when a claim carries `pick`,
the daemon raises a directed notice on that seat's interrupt line. The existing per-harness hooks
(the Stop hook, the idle doorbell) then deliver it.

A /live pick needs nothing new, because the handoff act is already directed and wake-eligible.

### 5.7 The agent's side

The musterd skill and the text of the pick act describe behavior B. The seat claims the lane (or
already holds it, after a handoff). It posts a status line and replies to the human with the plan.
It then starts unless redirected.

To decline, the seat releases the lane with a reason. The reason is recorded in the lane's history,
and `pickerRows` shows it as the lane's decline note the next time the picker opens.

`lane_release` takes no reason today (`packages/mcp/src/tools/lanes.ts`, input `{id}` only). Lane 2
adds an optional `reason` to the release (MCP, CLI, and the `lane.released` audit row). A release
without a reason still works.

## 6. Errors and edge cases

- **Race: someone claims the lane while it is on screen.** The pick goes through the existing
  claim and handoff checks, so the first claim wins. The picker says "taken by dolly 20s ago",
  refreshes, and keeps the filter. The board is read when the picker opens and again just before it
  sends, never only from a cache.
- **The seat already holds lanes.** The header warns. Nothing is blocked, because holding several
  lanes is legal.
- **Blocked lanes** can be viewed but not picked. `⏎` on a blocked lane shows the unmet dependency
  and its owner.
- **Risky lanes** can be picked. The brief pane shows the risk tag and that acceptance goes to a
  human.
- **Service seats** cannot be picked for. The daemon already refuses this (ADR 232), and the
  picker says why.
- **Parked lanes** are never shown.
- **The daemon is unreachable or the credential is bad.** The picker exits non-zero with the same
  one-line diagnosis `musterd status` gives. It never shows a stale list.
- **Small terminals.** Below about 100 columns, the brief moves under the list. Below about 60
  columns, the picker prints the plain table with a hint.
- **The agent declines.** The lane returns to `open`. The decline reason appears in the lane's
  history and in the picker.
- **`--open` with no display, or a /live viewer who is not signed in.** With no display, the
  command prints the URL. A viewer who is not signed in goes through sign-in first, then returns to
  the overlay.

## 7. Testing

- **`pickerRows`:** table-driven unit tests. They cover grouping, claimable vs blocked with the
  reason, parked hidden, service seats excluded, the decline note, and the filter.
- **Terminal reducer:** pure keys-in, state-out tests, as the seat picker's are.
- **Terminal view:** snapshot tests at 120, 90, and 50 columns, so the stacked layout and the table
  fallback are both covered. Hard rule 2 applies: the two-pane frame is added to
  `docs/design/figma-brief-terminal.md`, and the snapshot holds it.
- **Fallback:** with no TTY, the table is printed and raw mode is never entered.
- **Daemon (both drivers):**
  - a terminal pick records `pick` on `lane.claimed` and raises the directed notice;
  - a /live pick creates a handoff from the human;
  - a race gets the existing refusal.
- **/live:** an overlay test inside the a11y sweep. It covers a keyboard-only pick, focus trap,
  and esc.
- **End to end:** one scenario. A human opens the picker for an agent seat and picks a lane. The
  seat hears it and replies with a plan.

## 8. ADR

One ADR, written with lane 1. It covers:

- the `pick` field (`via`, `requested_by`, `attested`, `harness`, `at`);
- the honest-label rule: a terminal pick is never `attested: true`;
- the interrupt notice for a picked claim.

**Observability:**

- picks per day, split terminal vs /live;
- declines as a share of picks;
- time from a pick to the seat's plan reply.

**Falsifier:** if most picks are declined, the list does not show what a seat can do, and
`pickerRows` needs a fit signal.

## 9. Work breakdown

The lanes open under goal `find-work` when nick approves this spec. Each lane is one PR.

| # | Lane                                                                 | Needs |
| - | -------------------------------------------------------------------- | ----- |
| 1 | ADR + `pickerRows` in protocol, with tests                           | —     |
| 2 | Daemon: the `pick` field, the audit row, the interrupt notice, and an optional reason on release | 1     |
| 3 | CLI: `musterd pick` (two-pane, table fallback, `--open`), plus the Figma frame and snapshots | 1     |
| 4 | /live `PickOverlay`                                                  | 1, 2  |
| 5 | musterd skill: behavior B (claim, plan, start; decline with a reason) | 2     |

Lanes 2 and 3 run in parallel after lane 1. Nothing waits on find-work's grammar.

## 10. Open questions

- **The decline note:** does `pickerRows` read it from the lane's history (`GET /lanes/:id`, one call
  per row), or does the board carry the latest decline reason? Lane 1 decides. The board field is
  probably right, because a picker should not make N calls.
- **The handoff note:** the wording of the /live handoff note, which the seat reads as its
  instruction. Lane 5 settles it together with the skill text.
