# Figma Brief 2 — "musterd / Terminal UX"

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

**Audience:** a Figma-capable agent. **These frames ARE the CLI output specification.** The CLI implementation in `packages/cli` must match them exactly — same columns, same glyphs, same color roles. When the CLI and these frames disagree, that is a bug to resolve via ADR, not a free choice. Cross-reference [`brand.md`](./brand.md) §2 (ANSI mapping) and §5 (glossary), and [`../architecture/04-cli.md`](../architecture/04-cli.md) for command semantics.

---

> **Status: EXECUTED** (2026-06-10, see [ADR 008](../decisions/008-ui-ux-figma-execution.md); integration-doctor frames added 2026-09-06 under [ADR 385](../decisions/385-optional-tailscale-aperture-doctor.md)). File: [musterd / Terminal UX](https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ). The frames mirror the **already-shipped CLI** (reality wins): `cmd/team-add` shows the MCP env block the CLI actually emits (not a generic join token), and `cmd/claim` shows the default `cli` surface.

## File

- **Figma file name:** `musterd / Terminal UX`
- **Pages:** `Components`, `Commands`, `States`

## The terminal grid (build on the Brand file's mono grid)

Create a component `terminal/frame`:

- **80 columns × variable rows**, JetBrains Mono `14/22` ([ADR 706](../decisions/706-web-type-dm-sans.md); the real CLI inherits the user's terminal font).
- Background `zinc-900` (`#18181B`), default text `zinc-50`.
- A 2-row chrome header is optional and OFF by default (we show raw output, not a fake window). If shown, use a minimal dotless bar.
- Define **ANSI color styles** as Figma styles, mapped per `brand.md` §2: `ansi/yellow-bold` (accent), `ansi/cyan` (agent name), `ansi/magenta` (human name), `ansi/green` (online/success), `ansi/yellow` (away/warning), `ansi/red` (error/decline), `ansi/bright-black` (dim/meta), `ansi/white` (default).

## Page: Components (build BEFORE Commands)

Each is a Figma component with variants where noted:

1. `cmp/prompt-line` — `$ musterd <…>` ; `$` in bright-black, command in white.
2. `cmp/member-chip` — `name` colored by kind (variant: `agent`=cyan, `human`=magenta) + role in bright-black parens, e.g. `Ada (backend)`.
3. `cmp/presence-dot` — variants `online ●` green / `away ●` yellow / `offline ○` bright-black.
4. `cmp/act-badge` — `[message] [status_update] [request_help] [handoff] [accept] [decline] [wait] [resolve]`. Variant styling: `request_help` yellow-bold, `decline` red, `resolve` green-bold (terminal/done), rest dim white in brackets.
5. `cmp/message-row` — composed: `HH:MM` (bright-black) + `member-chip` + `act-badge` + body (white, wraps at col 80 with 2-space hanging indent).
6. `cmp/table-row` — for `status`/roster: fixed columns, see Commands.
7. `cmp/banner` — **UPDATED ([ADR 114](../decisions/114-cli-rollcall-wordmark.md)):** a rounded nameplate (dim borders) holding three presence dots (online green · away mustard · offline dim), the lowercase `musterd` word in bold mustard (no block behind it — [ADR 497](../decisions/497-the-new-mark.md) retired the reversed-out chip; a terminal cannot draw the mark) with a trailing cursor `▊`, and the tagline in bright-black. No multi-line letter-art. (Source of truth is `renderBanner` in `packages/cli/src/render/rows.ts`.)

## Page: Commands (one frame per command output)

Use realistic data: team `dawn`, members `Ada (agent, backend)`, `Lin (agent, frontend)`, `nick (human, lead)`. Each frame named `cmd/<name>`.

1. `cmd/team-create` — `$ musterd team create dawn` → success line `✓ team "dawn" created` (green ✓), then `you are now a member: nick (human, lead)`, then a hint line in dim: `add members with: musterd team add <name> --kind agent`.
2. `cmd/team-add` — `$ musterd team add Ada --kind agent --role backend` → `✓ added Ada (agent, backend) to dawn` + a dim MCP env block: `connect this agent via MCP with its scoped key:` then `  MUSTERD_TEAM=… MUSTERD_AGENT_KEY=mskey_… MUSTERD_CLAIM=seat:Ada MUSTERD_LAUNCH_SURFACE=claude-code` (ADR 344: the shown-once key can bootstrap only Ada; a human member instead gets a `musterd claim …` hint).
3. `cmd/claim` — `$ musterd claim Ada --team dawn --detach --key …` → `✓ Ada — occupied on dawn` + presence line `● Ada online via cli` (default surface is `cli`).
4. `cmd/send` — `$ musterd send --to Lin --act handoff "auth module ready for wiring"` → echoes the sent `message-row` with `✓ sent`.
5. `cmd/inbox` — `$ musterd inbox` → header `inbox — dawn (2 unread)`, then 2–4 `message-row`s, newest last; unread marked with a leading accent `▌`. Footer dim: `musterd inbox --watch to follow live`.
6. `cmd/inbox-watch` — `$ musterd inbox --watch` → same header with a live indicator `◉ watching` (green), a stream of rows, and a blinking-cursor affordance at the bottom. Show one incoming `request_help` highlighted (yellow-bold badge) to demonstrate the flagship moment.
7. `cmd/status` — `$ musterd status` → table: columns `MEMBER` (member-chip), `KIND`, `ROLE`, `MODEL` (occupancy-attested model id, ADR 101; absent → `unknown`), `LIFECYCLE`, `ACTIVITY` (presence-dot + surface / working label). One row per member. Header row in bright-black, aligned to 80 cols. (The shipped frame still says `PRESENCE` before LIFECYCLE — frame update tracked with ADR 008 lockstep; code is the source of truth.)

### Multi-harness frames (ADR 281/282/286)

8. `cmd/harness-configure` — `$ musterd harness configure` → a registry-ordered **multi-select**
   (checkbox list), preselecting the current desired set. Only installed harnesses are offered
   (ADR 643); one already selected but now uninstalled stays, with a dim `(pending — not installed
   here)` hint, so it can be deselected. Above the list, each uninstalled harness gets its own row
   with its install command, in dim:
   ```
   ●  not installed here — install one, then run `musterd harness configure` again:
        codex  npm install -g @openai/codex
        muse   curl -fsSL https://dev.meta.ai/install.sh | bash
   ◆ Which harnesses should launch this worktree's member? (space toggles, enter confirms)
   ◼ claude-code
   ◻ cursor
   ◻ grok (pending — grok install not found)
   ◼ musterd (native host)
   ```
   On confirm: `✓ desired harnesses: claude-code, musterd`, then a dim delta against the prior set
   (`  added grok · removed cursor`, or `  no change from the previous set` — so an Enter that
   toggled nothing is visible), then one line per reconciled fragment
   (see the status verdict glyphs below). Every fragment reconciled ends
   `✓ worktree configured — musterd wire repairs it any time` and exits **0**.
   A fragment that did not ends on this line and exits **1**:
   ```
   ⚠ some fragments need attention — `musterd harness status` for the detail
   ```
   The backticks around the command are characters in the line.
   Cancel (esc) prints `no changes made` (dim) and exits **0**.
9. `cmd/harness-status` — `$ musterd harness status` → one block per registry adapter:
   ```
   claude-code   selected · available
     mcp.musterd   repo-shared   ✓ in place
     hooks.local   folder        ✓ in place
     permissions   folder        → needs wire
   cursor        not selected · available
   codex         selected · pending (not installed here)
   musterd       selected · native (no external footprint)
   ```
   Verdict glyphs (exact strings): `✓ in place` (owned-exact, ours) · `✓ satisfied (unmanaged)` ·
   `→ needs wire` (would create/add-owner) · `✗ conflict — not musterd's to overwrite` ·
   `✗ drifted — evidence retained` · `✗ pre-ADR-286 registration — run musterd harness configure` (covers both the retired `MUSTERD_SURFACE` marker and the marker-less ADR 165 shape) ·
   `✗ release blocked — drifted while deselected` · `⏳ busy — another reconciler holds this` ·
   `✗ container unreadable` · `journal pending — re-run musterd wire`.
   Exit code annotation: **0** only when every desired fragment is usable and every undesired owned
   contribution is released (pending unavailability still exits 0); otherwise **1**.
   When two rows in one harness share a fragment key, each row keeps those columns and adds the
   resource's repository or folder path after the verdict, dim. A unique key gains nothing. When
   those paths match, the row adds the registration id instead.
10. `state/harness-legacy` — status/wire over a version-1 identity: red
    `✗ this worktree is pre-ADR-281 (version-1 identity) — run musterd harness configure to convert it`,
    exit **1** (wire exits **6** when no selection exists at all:
    `✗ no harness selection here — run musterd harness configure (or musterd init for a fresh folder)`).

### Shared Seed frames (ADR 319)

11. `cmd/seed-list` — `$ musterd seed list` → one active tray row per Seed, using the exact
    `<id> <state>[ — <explorer>] · <body>` shape. Sample:
    `01SEED00000000000000000000 open · Try a shared Seed tray`. IDs are dim; `completed` is green;
    `needs_clarification` is mustard.
12. `cmd/seed-claim` — `$ musterd seed claim 01SEED00000000000000000000` → exact success line
    `✓ Seed 01SEED00000000000000000000 — exploring as Ada`, with the checkmark green.
13. `cmd/seed-promote` — `$ musterd seed promote 01SEED00000000000000000000` → exact success line
    `✓ Seed 01SEED00000000000000000000 — promoted to Lane 01LANE00000000000000000000`, with the
    checkmark green.

### Optional integration doctor (ADR 385)

14. [`cmd/integration-doctor`](https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ?node-id=18-2) — the exact no-color combined frame for `musterd integration doctor --tailscale --aperture https://aperture.tailnet.ts.net`: separate Tailscale `verified` and Aperture `off (configuration ready)` headings, the 13 stable checks in protocol order, including ADR 394's `one exact Member tag; standard user role` identity line, and the two `LIMITS` non-claims. The frame is 80-column-safe, JetBrains Mono `14/22`, and matches the renderer snapshot character-for-character.

15. `cmd/integration-generate-aperture` — the exact no-color frame for `musterd integration generate aperture --write`: one success line, `Aperture policy is current`. Preview identifies the generated `policy.hujson`; `--check` uses `Aperture policy is stale; run musterd integration generate aperture --write` when either managed file differs. No generated content contains a credential or a claim that enforcement is active.
16. `cmd/integration-generate-tailscale` — the exact no-color frame for `musterd integration generate tailscale --write`: one success line, `Tailscale transport policy is current`. Preview identifies generated `policy.hujson` and `workloads.json`; `--check` uses `Tailscale transport policy is stale; run musterd integration generate tailscale --write` when either managed file differs. Generated output contains only explicit tag ownership, exact workload-to-Aperture HTTPS ACLs, and opaque node keys; never credentials, runtime node IDs, paths, or a claim that transport is active.
17. [`cmd/integration-doctor/blocked`](https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ?node-id=18-4) — combined selected failures: red `✗` on the failed check, dim `→` repair and `·` skipped dependent checks, with both section headings `blocked`. Selected failure exits **1**; invalid command/URL usage exits **2**; neither selected renders both sections `off` and exits **0**.

### Seat launcher frames (ADR 491)

18. `cmd/seats` — `$ musterd seats` (no color, 80 columns; [ADR 503](../decisions/503-roster-first-launcher-catalog.md)):
    ```
    seats on this machine · 3

    revive/agents
      stanley  claude   ○ idle  2h
      miley    claude   ● live  here · since 15:37
      gptbot   codex    ○ idle  needs repair

    revive · on the team
      bo  on air-2  wake
      cy  on air-2

    2 stale · musterd init --prune-bindings --apply
    ```
    Columns: member (longest + 2), harness (9), state (8), then the tail. The tail is `here · since`
    or `on <node> · since` when live, `needs repair` in yellow when broken, otherwise when it was last
    used. Then, per team, `<team> · on the team` (accent): every roster member with no Workspace
    here — member (longest + 2), where it lives (dim: `on <node label>` · `cloud · <label>` ·
    `nowhere`), then the dim verb for what this machine can do (`wake` · `set up`; a seat that is
    not yours to wake carries no verb). When a team's roster did not answer within the time box, one
    dim line replaces its block: `revive: roster unavailable — this machine's folders only`. The
    exact text is `seats.test.ts`'s `cmd/seats` case.
19. `cmd/launch-receipt` — the line `musterd <seat>` prints to stderr when the harness exits:
    `✓ stanley · claude · 42m · exit 0 · musterd - to go back` (green `✓` on exit 0, red `✗`
    otherwise; the last segment dim).
20. `cmd/launcher-recent` — `$ musterd` in an 80-column terminal, after the roster answered. The
    exact no-color text is `view.test.ts`'s first case:
    ```
    ● ● ○ musterd                                              revive · 3 seats here

      recent
    › stanley  revive/agents  claude   ○ idle  ★ last used · 2h
      miley    revive/agents  claude   ● live  here · since 15:37
      gptbot   revive/agents  codex    ○ idle  1d

      ⏎ launch · ⌃R resume · type to search · → browse · esc quit
    ```
    The header shows ` · checking…` until the roster answers and ` · offline · live state
    unavailable` when it cannot (rows then show `?`).
21. `cmd/launcher-browse` — `→` from recent: `musterd › teams` (a team with no Workspace here is dim
    `○ no Workspace here` and is skipped by the cursor), `musterd › revive` (projects, with the remote
    name dim when it differs from the folder), and `musterd › revive › agents` (members).
22. `cmd/launcher-live-confirm` — `⏎` on a live seat replaces the footer with the question,
    word-wrapped to the terminal width (never clipped, so `(y/N)` always shows). At 80 columns:
    ```
      miley is live here (claude-code) since 15:37. Open a second session in the
      same folder? (y/N)
    ```
22a. `cmd/launcher-wake-menu` — `⏎` on a seat whose live session is a wake on this machine
    ([ADR 546](../decisions/546-wake-take-over.md)) asks take over / watch instead of the question
    above; `musterd <seat>` prints the same lines. Each key is one keypress; `esc` leaves the wake
    alone. A line that fits keeps its indent in the picker footer; a long one is word-wrapped:
    ```
      stanley is busy — a wake started 09:24 to carry on with lane 01M46YWG8Y.
        ⏎  take over   stop the wake, continue its conversation here
        w  watch       follow it live; ⏎ takes over at any point
        esc cancel
    ```
    `w` opens the watch view (`cmd/launcher-watch`): the header, the wake's last ten words and tool
    calls, then new ones as they land — one row each, `HH:MM`, cut to the width, credentials
    redacted. `⏎` takes over, `esc` leaves; when the wake's process is gone it prints
    `wake finished — opening its conversation` (it ended on `end_turn`) or `wake ended before
    finishing` and asks `⏎ open its conversation · esc quit`:
    ```
    watching stanley's wake — ⏎ take over · esc leave
    09:24  “Checking whether the umbrella's three PRs reached main.”
    09:24  ▸ Bash  git log --oneline origin/main -5
    09:25  ▸ lane_submit  01M46YWG8YHEV2SKW9F1N0W8FG
    ```
    The reason clause follows [ADR 543](../decisions/543-launcher-names-a-wake.md) and is dropped when
    the daemon cannot say why. Without a TTY: `stanley is live here — a wake … — pass --take-over to
    continue its conversation, --watch to follow it, or --force`.
23. `cmd/launcher-team` — `musterd › revive › agents`, the members level
    ([ADR 503](../decisions/503-roster-first-launcher-catalog.md) Decision 3; the exact no-color text
    is `view.test.ts`'s `cmd/launcher-team` case):
    ```
    ● ● ○ musterd › revive › agents                            revive · 2 seats here

      on this machine
    › nick     human    ○ idle
      stanley  claude   ○ idle  ★ last used · 2h
      on the team
      bo       on air-2  wake
      cy       on air-2
      slate    nowhere  set up
      + new seat

      ⏎ launch · ⌃R resume · ⇥ harness · ← back · esc back
    ```
    Every member of the team appears once. `on this machine` holds the Workspaces here (frame 20's
    seat row, without the address column); `on the team` holds the rest, each with where it lives
    (dim: `on <node label>` · `cloud · <label>` · `nowhere`) and a dim verb for what `⏎` does from
    here: `set up` for a seat that lives nowhere, `wake` for a seat resident elsewhere that you
    sponsor or may administer, no verb for one that is not yours to wake. A Workspace here whose
    seat lives elsewhere carries the same where label and verb in its tail. `+ new seat` (accent)
    closes the list. The footer follows the cursor: on a `wake` row,
    `  ⏎ wake — rings its doorbell (a steer, as you) · ← back · esc back`; on a row with no verb,
    the move ceremony, word-wrapped like frame 22 —
    `  resident on air-2 — move it: musterd residency off + node unbind there`
    (`resident in the cloud — …` for a cloud seat); on a `set up` row,
    `  ⏎ set up here · ← back · esc back`. `⏎` on `set up` replaces the footer with the set-up line
    of ADR 491:
    `  set up slate here → ~/musterd/revive/agents/slate · claude (⇥ to change) · ⏎ set up and launch · esc cancel`;
    `+ new seat` first asks `  new seat in revive/agents › ▏   ⏎ next · esc cancel`. With no human
    Workspace of yours in the project, `+ new seat` gives way to one dim line:
    `set up your own seat here first: musterd human <you>` — the team still shows. A seat resident
    on another node is never offered `set up` (that would be a silent move); `· not here` is gone.
24. `cmd/launcher-harness-step` — `⏎` or `⌃R` on an agent seat replaces the footer with the seat's
    configured harnesses, shown even when there is one; the one used last carries a dim `last used`:
    ```
      stanley · 1 harness configured
      › claude    last used
      ⏎ launch · ↑↓ choose · esc back
    ```
    With several, `↑↓` (or `⇥`) moves the accent `›`; `⏎` launches the pick (a live seat then asks
    frame 22's question); `esc` returns to the list.
24a. `cmd/launcher-workspace` — bare `musterd` inside an agent member's workspace opens that
    member's harness step (ADR 717, [ADR 720](../decisions/720-launcher-names-this-member.md)). The
    list behind it is still the recent screen, so teams stay one key away. The header names the
    folder: `this member · ghost`, and that member's row carries `this member`. Every other member
    shows a machine. The same machine reads `mac (this machine)`; before the roster names the node
    it reads `this machine`. Another machine stays `on air-2`. The last row configures this
    workspace's harnesses. The count does not include that row:
    ```
      ghost · 1 harness configured
      › claude    last used
        configure harnesses
      ⏎ launch · ↑↓ choose · esc back
    ```
    With the cursor on the last row the keys read `⏎ configure harnesses · ↑↓ choose · esc back`.
    `⏎` on another member does not launch. The footer gains one line:
    ```
      this folder is ghost — stanley starts from /w/stanley
      ⏎ launch · ⌃R resume · type to search · → teams · esc quit
    ```
    A member with no workspace on this machine reads `this folder is ghost — bo starts from bo's own workspace`.
    A new seat reads `this folder is ghost — a new seat starts from a folder that is not a member workspace`.
    A human member's workspace stays the recent screen with the cursor on that member; `⏎` opens a login shell.
    From a directory that is not a member workspace, frame 20 is unchanged.

### Huddle trace frame (ADR 493)

23. `cmd/huddle-show-trace` — `musterd huddle show <id> --trace`, no-color, 80 columns: a head line
    (`huddle trace <topic> <open|closed> · <id prefix> · N seats`), the open/close line with the
    room's run time, a seat table ordered fastest-to-speak first (silent seats last, `not yet`), then
    one event per line, clock first. Accent on the head; seat names in their kind colour; `act`
    bold, `hook` yellow, other kinds dim; a tool's outcome green when `ok`, red otherwise. The
    renderer snapshot (`render/huddleTrace.test.ts`) pins these rows:
    ```
    huddle trace goal:demo closed · 01M3WBAWCE · 4 seats
      opened by izzo 11:23:30 · closed 11:30:35 (7m 05s)

      seat      in as    wake                       harness      to turn
      izzo      opener   —                          claude-code  —
      miley     named    resumed · 27.5s · $0.56    claude-code  +1.4m
      ryder     named    fresh · 44.2s · $2.31      claude-code  +5.6m
      lazara    steered  —                          —            not yet

      11:23:30  izzo      act    message: REHEARSAL 3
      11:24:20  miley     wake   woke · resumed
      11:24:26  miley     tool   Bash  ok 11.0s
      11:24:32  lazara    hook   hook timeout 10.0s
      11:24:54  miley     act    message: I'd take lane 2
    ```

### Orientation brief frame (ADR 490)

24. [`cmd/next`](https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ?node-id=24-2) — `$ musterd next` as Ada, no color, 80 columns, with one review promise in each of the
    three ADR 490 sections and nothing else in flight. The renderer (`packages/cli/src/commands/next.ts`,
    `renderNext`) and this frame match character-for-character — pinned by `orient.test.ts` with a
    fixed clock (`2h` / `3d` / `1h` are `shortDuration` of the fixture's ages):

    ```
    next — as Ada

    review promises — 1 you accepted, still open:
      01REQ0000000000000000000001 for nick · accepted 2h ago
        "please check the migration" · PR dawn/app#42
        close: `musterd send --act resolve --thread 01REQ0000000000000000000001 "…"`

    reviews you asked for — 1 accepted, still open:
      01REQ0000000000000000000002 Lin accepted 3d ago
        "sanity-check the roster render" · lane 01ARZ3NDEKTSV4RRFFQ69G5FAV

    review closed for you — by someone else, 1:
      01REQ0000000000000000000003 closed by nick 1h ago
        resolve 01RES0000000000000000000003 — read your inbox and it is gone
    ```

    `review promises` is what Ada accepted and still owes (the close command follows, since the
    thread is the request id); `reviews you asked for` is what Ada asked and someone accepted; `review
    closed for you` is a close by someone other than the owner, shown until Ada's inbox cursor crosses
    that `resolve`. An older daemon omits all three arrays and the brief prints one dim line,
    `review promises: not reported by this daemon — it predates ADR 490`; a supporting daemon with nothing
    to show prints no section at all. Sections sit below `owed by you` and above the stale-goal line.

### Halt frames (ADR 501)

25. `cmd/halt` — `$ musterd halt Ada --reason "looping on the wrong lane"` as nick, no color, 80
    columns. The renderer is `packages/cli/src/commands/halt.ts` (`haltCommand`), pinned by
    `halt.test.ts`:

    ```
    ✓ halted Ada — looping on the wrong lane
      next: musterd resume Ada
    effective at the seat's next tool boundary or musterd call — nothing is killed; 1 live session evicted
    ```

    When an evicted session was on a harness with no PreToolUse hook (Codex, OpenCode — ADR 442),
    one warn line follows (lane 01M41Q39C9, measured on big-body 2026-10-03):

    ```
    ⚠ local tools are not gated on codex — the seat stops at its next musterd call
    ```

26. `cmd/resume` — `$ musterd resume Ada`:

    ```
    ✓ resumed Ada — was halted by nick: looping on the wrong lane
      next: musterd status
    its next claim mints a fresh lease; residency wakes it again
    ```

27. `cmd/status-halted` — the `cmd/status` roster with Ada halted: her row carries the warn facet
    `halted by nick: looping on the wrong lane` right after `agent`, on whichever group she is in
    (`renderRoster`, `rows.test.ts`).

### Agent style frames (ADR 514, increment 4)

28. `cmd/style` — `$ musterd style` as nick, no color, 80 columns, after
    `musterd style set length=concise pushback=every-time --prose "Lead with the result."`. The
    renderer is `packages/cli/src/commands/style.ts` (`styleCommand`), pinned exactly by
    `style.test.ts`. Each dial reads `yours` or `team default`; the prose prints JSON-quoted so a
    multi-line note can never shed its label; the block below is the one a seat steered by nick
    reads — byte-identical to its `team_join` reply (`renderStyleBlock`, one renderer). The epoch
    is eight hex characters of the resolved style, so the value below is a sample; the test pins
    the shape:

    ```
    style — nick (epoch 41122c7c)
      pushback   every-time       yours
      bluntness  plain            team default
      length     concise          yours
      format     prose            team default
      prose      "Lead with the result." yours
    the block a seat steered by you reads:
      Style (epoch 41122c7c) — how you talk here.
      Floor (team): assess before you agree; no praise before a check; disagree once, with the reason, then follow the decision; a concession names what you checked; weigh a human's critique by its evidence, like anyone's.
      For nick (in chat, and in any act addressed to nick): pushback every time · plain · concise · prose.
      nick adds: "Lead with the result."
      Everyone else, @team and the record: team defaults (pushback when it matters · plain · normal · prose).
    musterd style set length=concise · musterd style set --prose "…" · musterd style clear
    ```

    The `set` line that preceded it: `✓ style set — pushback every-time, length concise`, then
    `  next: musterd style`, then dim `your seats now read: pushback every time · plain · concise ·
    prose`. `clear` prints `✓ style cleared — team defaults` with the same two lines. From an agent
    seat, bare `style` prints `style — the block this seat reads (driver nick)`, the block, and
    `a seat has no preferences — a human sets theirs with: musterd style set`; `set`/`clear` exit
    5 with `style preferences are for human members — a seat reads the block it is given (musterd
    style)`.

29. `cmd/team-policy-style` — `$ musterd team policy style` as nick (admin), on a team at the
    shipped style — the one positional area of `team policy` (lane 01M47A4WRRWVD3SN6D7DSZ9V3J moved
    it under `team` from a top-level `policy` word: one home per knob). The renderer is
    `packages/cli/src/commands/policy.ts` (`teamPolicyStyle`), pinned exactly by
    `style.test.ts`. Every knob carries `default` or `set by <who>` — the latter read from the
    `policy.change` audit rows, the newest one in which the knob took its current value; a reader
    the audit log refuses sees `set`:

    ```
    policy style — dawn (team epoch 7f3a2b1c)
      floor
        assess_before_agreeing           on  default
        disagree_once_then_commit        on  default
        concession_names_check           on  default
        human_critique_weighed_as_peer   on  default
      defaults
        pushback                         when-it-matters  default
        bluntness                        plain            default
        length                           normal           default
        format                           prose            default
      prose                              none
    ```

    After `musterd team policy style set concession_names_check=off length=thorough`, the success
    line `✓ policy style set` + `  next: musterd team policy style` precedes the same table with
    `concession_names_check           off set by nick` and `length … thorough         set by nick`.

30. `cmd/status-style-stale` — the `cmd/status` roster with Ada attesting a style epoch: her row
    carries `style 41122c7c` after the model (and `build …` when that differs), on every live group
    (`renderRoster`, `rows.test.ts`). When the daemon's current epoch for her seat differs — an admin
    moved a default, or her driver set a dial, since she last heard — the facet is the warn
    `style stale` instead, the guidance-drift treatment; it clears on her next heartbeat after the
    adapter re-reads the block. A seat attesting nothing shows neither (an older adapter, not a stale
    one); an `out` seat is silent.

### First-run tour frames (spec 2026-10-10-first-run-tour-design)

The copy comes from `content/tour.data.ts`, copied into the CLI by `pnpm tour:gen`; these frames
pin how the CLI fills it. Each step prints as a note titled by `stepTitle` with its body under it.
All four are pinned character-for-character by `packages/cli/src/tour/screens.test.ts`, as nick with
agent ada, no color, 80 columns. Every step wraps to the terminal width, keeping each line's indent,
so a box is never wider than the screen.

31. `cmd/tour` · title — the note title on every step:

    ```
    Step 3 of 9 · Give it work
    ```

32. `cmd/tour` · team — step 2 with an observed model. With no observed model the second line drops.
    Under the body, the roster: you, then the agent, then `and N more members` on a larger team:

    ```
    This is your roster. You and ada are both members, each with a name that stays.
    ada is running claude-opus-5-5. The harness reports the model; the agent does not choose what it says.

      nick  human, you
      ada   agent
    ```

33. `cmd/tour` · record — step 7 after nick accepts. With no observed model the chain reads
    `model unattested`; sent back once, then accepted, it ends `sent back by nick, then accepted by
    nick`; closed by the agent itself, `closed by ada itself`:

    ```
    This is the chain the team keeps for lane 01M4TOUR01:
    opened by nick · claimed by ada · model claude-opus-5-5 · accepted by nick
    Every lane on the team carries the same chain, whoever does the work.
    ```

34. `cmd/tour` · waiting hints — while step 4 waits for the claim, one dim line at 60s, then at 3m:

    ```
    Still waiting. Switch to ada's window and say: check your inbox.
    ada can take a few minutes to wake. The tour waits as long as it takes. Ctrl-C to stop; `musterd tour` picks up where you left off.
    ```

### First-run connect frames (ADR 559)

`musterd init`'s default path. Strings come from `packages/cli/src/onboard/connect.ts` and
`onboard/init.ts`; `resultLine` is pinned by `connect.test.ts`, the prompts' options by
`connect.run.test.ts`. Shown as nick on revive, no color.

35. `cmd/init` · intent — the new first option, selected by default:

    ```
    What would you like to do on revive?
    ● Connect the agents you already have  (one seat per repo, every agent on this machine wired in)
    ○ Add a new agent
    ○ Activate an existing member
    ○ Just me — watch the team live
    ```

36. `cmd/init` · repos — this folder first and preselected, then suggestions with the agents that
    worked there and how long ago:

    ```
    Which repos should be connected? (each becomes a seat)
    ◼ ~/code/api     (this folder)
    ◻ ~/code/web     (Claude Code, Cursor · 2h ago)
    ◻ ~/code/infra   (Codex · 3d ago)
    ```

37. `cmd/init` · connect summary — one line per repo (`✓` wired, `⚠` bound with a wiring problem,
    `✗` failed), then how to start each:

    ```
    ✓ api — Claude Code, Cursor
    ⚠ web — Claude Code; cursor: mcp.json unreadable; run musterd wire there
    ✗ infra — mint refused

    ┌ Start any of them
    │ api  cd ~/code/api && claude
    │ web  cd ~/code/web && claude
    │
    │ musterd status   see them on the roster
    └
    2 seats on revive.
    ```

    When init knows who is driving it and at least one seat connected, the same tour offer as the
    **Add a new agent** path comes between the note and the last line: `Take the 5-minute tour?
    (it makes you a workspace of your own first)`. Yes ends with `Starting the tour.` instead of the
    seat count.

### Lane picker frames (ADR 624/626, lane 01M5162QS1)

38. `cmd/pick-stacked` — `$ musterd pick` in a 90-column terminal: header (`musterd pick` bold;
    the active tab's count accent, the other dim), the filter line, the list grouped by goal (goal
    names dim, the cursor row accent with `▸`), a dim rule, then the highlighted lane's brief (id and
    title bold, the meta line dim), and the dim key footer. The exact no-color text is
    `pick/view.test.ts`'s `cmd/pick-stacked` case:
    ```
    musterd pick — revive · for stanley   3 claimable · 1 blocked
    filter › ▏
    find-work
    ▸ 01M5162QS1 musterd pick 3: CLI two-pane lane picker
      01M5DT2PVN Board search: short ids that resolve
    no goal
      01M2H2N0Y6 Decline a handoff and re-route it

    ──────────────────────────────────────────────────────────────────────────────────────────
    01M5162QS1
    musterd pick 3: CLI two-pane lane picker

    goal find-work · areas cli · opened 2026-10-18 (2d ago)
    scope packages/cli/src/pick/**

    type to filter · ↑↓ move · tab claimable/blocked · ⏎ pick · esc quit
    ```
39. `cmd/pick-wide` — at 100 columns or more the brief sits beside the list behind a dim `│`
    (the list takes 45% of the width, at least 36 columns); the `cmd/pick-wide` case is 120 columns.
    A terminal under 60 columns at launch (the `cmd/pick-narrow` case is 50) gets the plain
    `cmd/pick-table` board, a blank line, and the dim hint `widen the terminal to 60 columns for the
    picker`. A terminal shrunk under 60 mid-session shows one dim line, `widen the terminal to 60
    columns · esc quits`.
40. `cmd/pick-blocked` — `tab` shows the blocked lanes; `⏎` on one replaces the filter line with a
    yellow notice, `blocked on 01M1T6DJ7J (owner miley) — it can be viewed, not picked`, and the brief
    adds a yellow `blocked: <detail>` line. A lane taken while the screen was open gets the same yellow
    line: `<id> was taken by <seat> 12s ago — pick another`.
41. `cmd/pick-table` — no TTY (an agent's shell tool) or `--open`: the same board as plain text with
    full ids, no color. `--open` adds `opening the lane picker <url>` (accent). Exact text:
    `pick/view.test.ts`'s `cmd/pick-table` case.

## Page: States (empty + error)

1. `state/empty-inbox` — `inbox empty — nobody's mustered anything yet` (dim). (Exact string; the CLI uses it verbatim.)
2. `state/no-team` — running a team command with no team configured: red `✗ no team — run: musterd team create <name>`.
3. `state/unknown-member` — `✗ no member "Bob" in dawn` (red) + dim hint `musterd status to list members`.
4. `state/server-down` — `✗ can't reach team server at ws://localhost:4849 — is the daemon running?` (red).
5. `state/not-permitted` / generic error — `✗ <message>` red, exit code shown in a side annotation (errors exit non-zero; see `04-cli.md` exit-code table).
6. `state/empty-seeds` — `no active Seeds — send an idea through the Team's Slack capture` (dim).

For every error frame, annotate the **exit code** in a Figma comment/sticky so the CLI brief and implementation agree.

## Acceptance checklist

- [ ] `terminal/frame` plus all 7 components exist with the listed variants.
- [ ] ANSI color styles exist and match `brand.md` §2 exactly.
- [ ] All 15 `cmd/*` frames exist, 80-col aligned, using the shared components and the canonical sample data.
- [ ] All 6 `state/*` frames exist; each error frame annotates its exit code and uses the verbatim strings above.
- [ ] No glyph or color is used that the CLI can't reproduce in a 16-color ANSI terminal.
- [ ] Every literal string a frame shows is reproducible character-for-character (these are the spec for CLI copy).

## Iteration protocol

1. Build Components first, post screenshots, get sign-off before Commands.
2. Build Commands + States, post per-frame screenshots.
3. Revisions named per frame only (e.g. "`cmd/status` ROLE column should be left-aligned").
4. When green, export the Commands page as PNG reference sheet for the CLI implementer and mark done.
