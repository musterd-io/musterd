# 534 — `GET /lanes` returns live lanes plus 14 days of closed ones; `?history=all` restores the rest

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (chose "window + opt-in" over an opt-in `limit` and over dropping `detail` from the
  list, 2026-10-06)
- Lane: `01M497BVG52RANKTT9WXFX8ES4` (goal `board-loops`)
- Builds on: ADR 083 (the lane board), ADR 104 (/board over `GET /lanes`), ADR 111 (staleness
  warnings), ADR 169 (verified-ness on done lanes), ADR 518 (acceptance reviewer projection)
- Protocol change: no — `LaneBoardSchema` is unchanged; the route's default population changes and
  it gains one query parameter.

## Context

`GET /teams/:slug/lanes` returned every lane the team ever opened. Done lanes accrete one per merged
change and never leave. On the revive team on 2026-10-06 that was 1628 lanes and 3.1 MB per call,
of which 1142 were done or abandoned more than 14 days earlier. The web board re-fetches it on every
lane act; `lane_board` and `musterd lanes` print all of it.

The server needs the whole board regardless — contention (ADR 083) and staleness (ADR 111) are
computed against it, and lane 01M3ANEQVR already made that one read per request. The waste is the
response: bytes on the wire and client work over history nobody on that path looks at.

## Problem

Bound the default response without breaking the callers that do want history. The caller map:

| Caller                                  | Needs closed lanes?                                      |
| --------------------------------------- | -------------------------------------------------------- |
| web `useWorkingOn` (/board, /live, /broadcast) | the 10 newest done (Done column), per-goal recent shipped |
| `musterd lanes`                         | prints everything today                                  |
| MCP `lane_board`                        | prints everything when unfiltered; agents read it for live work |
| `musterd archaeology --by-lane`         | yes — joins on `lane.merged.pr`, all of history          |
| MCP `team_inbox_check` (`?mine=1`)      | only a lane that just closed, to unfold its broadcast    |
| `musterd done`, todos snapshot          | no — live lanes only                                     |

## Decision

1. With no `history` parameter, `GET /lanes` omits `done` and `abandoned` lanes whose close is older
   than **14 days** (`LANE_HISTORY_WINDOW_MS`). A closed lane's age runs from `resolved_at`, falling
   back to `updated_at`. A live lane — any non-terminal state, `parked` included — is never omitted.
2. `?history=all` returns the full board, as before. Any other `history` value is a 400 naming it.
3. The window applies after the other filters (`project`, `mine`, `open`, `goal`, `state`), and
   only to the response: contention and staleness still read the whole board.
4. The callers that want history opt in: `musterd lanes --history`, and `archaeology --by-lane`
   always. The web board, MCP `lane_board`, the inbox fold, `done` and the todos snapshot keep the
   default. `lane_board` gets no `history` parameter: it cost 83 B of every session's standing tool
   list (over the `context:check` budget), for a read an agent makes about live work — an agent that
   needs old closed lanes runs `musterd lanes --history`.

## Consequences

- Revive's default board drops from 1628 lanes / 3.1 MB to 486 / 0.71 MB (measured 2026-10-06
  against the live daemon). It still grows with live lanes and with the 14-day close rate.
- Explicit `?state=done` is windowed too. A caller that wants every done lane says
  `?state=done&history=all`; the window is one rule, not a per-state exception.
- The web goal cards counted "N shipped" over all history; they now read "N shipped in 14d", so the
  number says what window it covers. A Goal's `status` (shipped / in-flight) comes from the server's
  own full-board derivation and is unaffected.
- Old CLIs and adapters send no `history` and get the window — the same population the web board
  sees. Nothing on the wire changed shape, so there is no skew to manage.
- Falsifier: if a caller that needs older closed lanes shows up without opting in (a "shipped"
  count that drops after 14 days, an archaeology report missing a PR), this default was too
  aggressive for it — pass `history=all` there, or revisit the window.
- _(2026-10-13, lane `01M4RNCZVBHY3ZRYEF6825ZD8E`, live-loads-fast inc 1)_: the window was not
  enough for `/live`'s first paint — revive's windowed board was 949 KB raw / 254 KB gzip, of which
  `detail` was 343 KB and `scope` 82 KB, and nothing on `/live` reads either. A second opt-in flag,
  `?brief=1`, returns every row with `detail: null` and `scope: []`; any other value is a 400 naming
  it, like `history`. Same population, same warnings and annotations, so counts and columns agree
  with the full read. `/live` fetches brief plus the repeatable `?state=` for every state but
  `abandoned`, and falls back to the full read on a 400 while a daemon is a build behind the bundle.
  Measured from the hub's store: 531 KB raw / 99 KB gzip. The rest is row count; fewer done rows is
  the next increment, if the bar in `docs/superpowers/specs/2026-10-13-live-loads-fast-design.md`
  still fails.

## Observability & Evaluation

- Traces: n/a — no agent-facing behaviour beyond `lane_board` printing fewer closed lanes; nothing
  new to trace.
- Eval: the size measurement above is the baseline (1628 / 3.1 MB on 2026-10-06); re-run
  `musterd lanes --json | wc -c` against `musterd lanes --history --json | wc -c` to read the gap.
- Experiment: n/a — a payload bound, not a behaviour under test.
