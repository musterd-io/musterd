# /live top-bar meter, headline ticker, log drawer (ADR 464, lane 2) Implementation Plan

> **For agentic workers:** execute this plan in your own seat with superpowers:executing-plans
> (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` reads as office + team column. The stream column and companion mode retire. The
top bar carries a busyness meter, a headline ticker runs under the room, and every message is one
keystroke away in a log drawer that hosts today's `Stream` unchanged.

**Architecture:**

- Two pure modules, node-tested like `workingOn.ts`:
  - `headline.ts`: `headline(env, ctx)` → `{ who, verb, object, target?, tone }` for the notable
    acts only; `collapseHeadlines()` folds adjacent same-actor same-verb headlines within 30s.
    Lane 4's walk tags read the same function.
  - `busyness.ts`: `busyness(envelopes, roster, now)` → last-act age, acts/hour buckets over the
    loaded span (never extrapolated), and the working / between / human counts.
- Three thin components, render-tested with `react-dom/server`:
  - `TopMeter.tsx` (team name · heartbeat · sparkline · counts) in the top bar.
  - `Ticker.tsx` (the newest ~3 headlines, newest left, each in the actor's hue; "See every
    message →").
  - `LogDrawer.tsx` (a right-edge drawer over the team column; hosts `Stream` lazily; `L` opens,
    Escape closes; `onActClick` opens it and reveals the act).
- `live.tsx` drops the stream track, the `stream` collapse key and companion mode. The canvas grid
  is two columns.

**Spec:** `docs/superpowers/specs/2026-09-28-live-audience-first-design.md` §2, §5, §9. **ADR:** 464.

## Global Constraints

- No protocol, server or schema change. No new runtime dependency.
- A headline never quotes an act body verbatim (falsifier 3); an ask's question is the one
  exception, clipped to one line. No lane id or envelope id is ever printed.
- The meter never extrapolates: under an hour loaded, the label names the true span.
- `Stream.tsx` is unchanged in behaviour: the `?lane=` deep-link, `scrollToMessage`, the reply
  quotes and the windowed DOM all still work inside the drawer.
- `/broadcast` is untouched (lane 5 adopts the ticker).
- Budgets: `initialJsGzipBytes` must not rise (the drawer makes `Stream` lazy, which should lower
  it). `totalJsGzipBytes` is at 254.1 / 255.1 KiB on main; if the branch reads over, raise by the
  ADR 183 ritual (measure main and branch, log in `docs/perf/web-live-baseline.md`, raise to
  measured + ~0.7 KB CI delta + ~1.2%). `Live.css` budget (ADR 441), `a11y:check`,
  `a11y:targets:check` at 390×844 (the drawer toggle and the ticker's link are targets).

## Review Focus

1. **The double announcement.** An `accept` act and its `lane_resolve` message land seconds apart.
   The ticker shows "stanley accepted ryder's work" and "lane closed: *title*" as two headlines,
   never a duplicate of one. Pinned in Task 2.
2. **Under an hour loaded.** The sparkline label says "last 40 min", not "N/hr". Pinned in Task 1.
3. **The drawer and the deep link.** `?lane=` and a speech-bubble click open the drawer first,
   then reveal the row (the old code waited 380ms for the column's expand transition; the drawer
   has its own). Pinned by a browser check in Task 6.
4. **Focus.** Opening the drawer moves focus into it; Escape returns focus to the opener. `L` does
   not fire while typing in a field.
5. **Ticker overflow.** A long lane title clips with an ellipsis inside its chip; the band never
   grows taller than one line.

---

### Task 1: `busyness` view-model

- [ ] Tests: last-act age; buckets over the loaded span with the true-span label under an hour;
      counts working / between / away / human from `memberPosture` and `kind`.
- [ ] Implement `packages/web/src/live/busyness.ts`.
- [ ] Commit.

### Task 2: `headline` wording + collapse

- [ ] Tests: one case per notable act (handoff, lane_handoff, accept, decline, lane_claim,
      lane_open, request_help, ask, steer, resolve, lane_resolve, lane_state→awaiting_acceptance),
      the quiet acts (`status_update`, plain `message`) return null, no body/id leakage, collapse
      of "opened 5 lanes", and the ask question clipped to one line.
- [ ] Implement `packages/web/src/live/headline.ts` with `headlineText()` for the walk tags.
- [ ] Commit.

### Task 3: `TopMeter`, `Ticker`, `LogDrawer` components

- [ ] Render tests: meter text; ticker shows three newest with the actor's hue on each chip and
      the "See every message" control; drawer markup with `role="dialog"` and a close control.
- [ ] Implement the three components. `LogDrawer` lazy-loads `Stream`.
- [ ] Commit.

### Task 4: Mount on `/live`; retire the stream column and companion mode

- [ ] `live.tsx`: `PanelId` = office | team; drop `companion`, `CompanionToggle`, `COMPANION_KEY`;
      drawer state + `L` / Escape; `onActClick` opens the drawer then reveals; mount `TopMeter`
      in the top bar, `Ticker` under the canvas, `LogDrawer` at the page level.
- [ ] `Live.css`: two-column grid; delete `--col-stream`, `is-stream-collapsed`, companion rules;
      add `.lc-meter*`, `.lc-ticker*`, `.lc-drawer*`.
- [ ] Commit.

### Task 5: Budgets

- [ ] `pnpm -r build && pnpm perf:check`. If total is over: measure main, raise per ADR 183, log
      in `docs/perf/web-live-baseline.md`, in this PR.
- [ ] Commit.

### Task 6: Gates, browser pass, docs, PR

- [ ] `docs/architecture/08-web.md`: the Stream bullet becomes the log drawer; file-tree lines.
- [ ] `pnpm typecheck && pnpm lint && pnpm format:check`, `a11y:check`, `a11y:targets:check`.
- [ ] Browser at 1920×1080: meter reads; a live act slides a headline in; `L` opens the drawer,
      Escape closes it; a bubble click reveals its row. At 390×844: no horizontal scroll.
- [ ] PR, auto-merge, `lane_submit`.

## Later lanes

3. Ask banner + in-room ask moment (+ "asking nick" card state). 4. Motion rules + walk tags + the
key. 5. `/broadcast` adopts the team column and ticker.
