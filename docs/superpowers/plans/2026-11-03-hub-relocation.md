# Hub Relocation Implementation Plan

> **For agentic workers:** implement this plan task-by-task in your own seat with
> superpowers:executing-plans (write work stays in a seat; no writing subagents). Steps use checkbox
> (`- [ ]`) syntax for tracking. One lane per increment (table below); claim it before you build.

**Goal:** revive's hub moves from nick's laptop to `musterd-joiner-1` with nothing lost, and nobody
using the team can tell.

**Architecture:** The box's daemon starts from a byte copy of the laptop's `musterd.db`. It
inherits the hub's own identity (`local_node`), its `sync_log` and `hub_seq`, and every joiner
credential hash. The laptop moves its file aside and enrolls fresh as a new joiner. Other joiners
are re-pointed with a new `musterd node repoint`. A new hold effect pauses wakes for the window, and
an inventory tool proves the copy and names any row only the box held.

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), better-sqlite3, vitest, the musterd CLI.

**Spec:** `docs/superpowers/specs/2026-11-03-hub-relocation-design.md`

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 0. Design and this plan | `01M67EF763ZZZ2VBQAWQP4260X` | — |
| 1. ADR + team-wide wake pause | `01M6HWV2CGBWPMYQQV4W1FTKS3` | 1–2 |
| 2. The inventory | `01M6HWV4HY93C1FX99KGEZFGMY` | 3 |
| 3. `node repoint` and `node relabel` | `01M6HWV7AF12X6T0VVPYSGM0SC` | 4–5 |
| 4. Security preconditions | `01M6HWV9E48ECHG1M77GX5HNDG` | 6 |
| 5. Rehearsal on the box | `01M6HWVB7F56DF6WPPMZT662RP` | 7 |
| 6. The switch | `01M6HWVD5J3APBQJ9PDFT5JDW5` | 8 |

Increments 1–3 are code (three PRs); 4–6 are operations with a runbook, `docs/guides/hub-relocation.md`.

## Global Constraints

- No new runtime dependency.
- Protocol changes are ADR-gated (hard rule 1): one ADR, written in Task 1, covers the
  `wakes_paused` effect and the relocation ceremony. Number from `pnpm adr:next`, draft PR pushed
  first (ADR 223).
- Pause window: target 30 minutes (nick). Drain is a hard precondition; zero loss wins over the
  window.
- The switch runs only after nick accepts an ask on `/live`, and never inside working hours,
  11:00–15:00 America/Los_Angeles.
- Seats that stay on the laptop: fifty, miley, cider, ghost. Seats that move to the box: alfie,
  big-body, dolly, wanderer, grokbot, izzo (re-read from `residency.host` on the day). delta-2 is not
  moved.
- Trace content never moves (ADR 453 §3, ADR 184); only `musterd.db` is copied.
- Never on the box: member credentials (`mskey_`/`msgr_`/`mscr_`), a team-wide agent key,
  KMS/console credentials, wrangler, nick's passkeys, hcloud.
- `http.ts` is held by miley and wallow: ask before editing it (they have said yes to small,
  named additions before).
- Fast gates before each push: `pnpm typecheck && pnpm lint && pnpm format:check`. Run one test file
  at a time locally; never the full suite (shared laptop).

## Review Focus

1. **A joiner's unpushed events when the snapshot is taken.** Expected: the switch refuses to start
   until every joiner reports an empty outbox. Task 3's `--require-drained` check, Task 7 rehearsal.
2. **A row the box's replica holds that the hub never had** (box-local seat state). Expected: the
   compare lists it by table and primary key; it is never silently dropped. Task 3 test
   `listsRowsOnlyInTheReplica`.
3. **`repoint` to a hub that does not know the joiner's credential.** Expected: refused, and
   `node.json` is unchanged. Task 4 test `refusesAHubThatRejectsTheCredential`.
4. **A wake leased just before `wakes_paused` is set.** Expected: it runs to completion; no new lease
   is minted while the hold stands; leases resume when it is lifted. Task 2 tests.
5. **The laptop daemon restarted on its old file after the switch** (by habit, or by the
   auto-refresher). Expected: it is a second hub and must not run. The moved-aside file is renamed,
   and the auto-refresher sees no `musterd.db` until the laptop enrolls fresh. Task 8 runbook check,
   rehearsed in Task 7.

---

## Increment 1 — ADR + wake pause (lane `01M6HWV2CGBWPMYQQV4W1FTKS3`)

### Task 1: The ADR

**Files:** Create `docs/decisions/NNN-hub-relocation.md`. Modify `docs/decisions/376-*.md`
(a dated Consequences note: decision 4 is decided by NNN).

- [ ] **Step 1:** Branch `feat/hub-relocation-pause` from `origin/main`; run `pnpm adr:next`; commit a
      stub; push a draft PR with `Lane \`01M6HWV2CGBWPMYQQV4W1FTKS3\`.` in the body.
- [ ] **Step 2:** Write the ADR. Decision: the ceremony as in the spec, steps 1–8; the box inherits
  the hub identity through the file copy; the laptop re-enrolls as a new node, so no
  `(origin_node, origin_seq)` is reused; a new hold effect `wakes_paused`. Observability: the hold's
  `holds` row and `hold.set`/`hold.lifted` audit, the inventory reports, and the switch's
  `status_update`.
- [ ] **Step 3:** `pnpm format:check`; commit `docs: ADR NNN hub relocation (lane 01M6HWV2CG)`.

### Task 2: `wakes_paused`

**Files:** Modify `packages/protocol/src/holds.wire.ts` (the effect set),
`packages/server/src/store/residency.ts` (the seat loop in `deriveSeatPasses`). Test:
`packages/server/src/store/residency.test.ts`, `packages/protocol/src/holds*.test.ts`.

**Interfaces:** Produces `HOLD_EFFECTS` gaining `'wakes_paused'` (enforced). Produces an
`activeHold(db, teamId, 'wakes_paused', now): Promise<HoldRow | null>` read, if `store/holds.ts` has
none by that name; otherwise reuse the existing read.

- [ ] **Step 1: Failing tests** in residency.test.ts:
  - `it('ADR NNN: a wakes_paused hold leases nothing, even a human steer')`: set the hold, send a
    steer from nick, then `claimWakeLeases` returns `[]`.
  - `it('ADR NNN: a lease minted before the hold is untouched; leases resume when it lifts')`: lease
    one, set the hold, the second poll leases nothing and the first lease is still `leased`; lift
    the hold, and the next due act leases.
  - In the protocol tests: `'wakes_paused'` parses as an effect.
- [ ] **Step 2:** Run `pnpm --filter @musterd/server test -- residency.test.ts -t "ADR NNN"`; expect
  FAIL.
- [ ] **Step 3:** Implement. Read the hold once per poll, before the enrollment loop; when it stands,
  return no passes. It is checked before the provisioned first-wake and before human passes, since
  the pause means no new wakes at all.
- [ ] **Step 4:** Run the file, then PASS. Fast gates. Commit; `gh pr ready`; auto-merge;
  `lane_submit`.

---

## Increment 2 — The inventory (lane `01M6HWV4HY93C1FX99KGEZFGMY`)

### Task 3: Inventory and compare

**Files:** Create `packages/server/src/ops/inventory.ts`, `packages/server/src/ops/inventory.test.ts`,
`scripts/hub/inventory.ts`. Modify `docs/architecture/03-server.md` (file-tree line).

**Interfaces (produces):**

```ts
export interface TableInventory { table: string; rows: number; digest: string; pk: string[] }
export interface Inventory {
  taken_at: number; tables: TableInventory[];
  sync: { hub_seq: number; origins: Record<string, number> };   // MAX(origin_seq) per origin_node
  outbox_pending: number;                                        // this store's unpushed events
}
export function takeInventory(db: Database.Database): Inventory;   // opens nothing; read-only queries
export interface Mismatch { table: string; kind: 'count' | 'digest' | 'missing_table'; a: unknown; b: unknown }
export function compareInventories(a: Inventory, b: Inventory, opts?: { ignore?: string[] }): Mismatch[];
export function rowsOnlyIn(replica: Database.Database, hub: Database.Database, table: string): unknown[][];  // PK tuples
export const EPHEMERAL_TABLES: readonly string[];  // presence, wake_leases, footprint_*, schema_meta, sync_push_cursor, sync_pull_cursor, pull_announcements
```

`digest` is sha256 over each row's JSON in primary-key order, so two stores holding the same rows
in any physical order match. Primary keys come from `pragma_table_info`; a table with no declared PK
uses `rowid`.

- [ ] **Step 1: Failing tests** in inventory.test.ts (better-sqlite3 in-memory, `runMigrations`):
  - `matchesAByteCopy`: copy a seeded store with `db.backup`; `compareInventories` is `[]`.
  - `namesACountMismatch`: delete one `messages` row from the copy; result is one mismatch,
    `{table:'messages', kind:'count'}`.
  - `namesADigestMismatch`: update one `audit` row's detail; result is `kind:'digest'`.
  - `listsRowsOnlyInTheReplica`: insert a `seat_memory` row only in the replica; `rowsOnlyIn` returns
    its PK.
  - `ignoresEphemeralTables`: a `presence` row only on one side, with `ignore: EPHEMERAL_TABLES`,
    gives `[]`.
  - `reportsOutboxPending`: an event staged but not pushed gives `outbox_pending: 1`.
- [ ] **Step 2:** Run `pnpm --filter @musterd/server test -- inventory.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement. `scripts/hub/inventory.ts <db> [--compare <other.json>]
  [--replica <db> --hub <db>] [--require-drained]` opens the files read-only (`{readonly: true}`),
  prints JSON, and exits 1 on any mismatch, any non-ephemeral replica-only row, or (with
  `--require-drained`) a non-zero `outbox_pending`.
- [ ] **Step 4:** PASS; fast gates; commit; PR; auto-merge; `lane_submit`.

---

## Increment 3 — `node repoint` and `node relabel` (lane `01M6HWV7AF12X6T0VVPYSGM0SC`)

### Task 4: `musterd node repoint <hub-url>`

**Files:** Modify `packages/server/src/node/state.ts`, `packages/server/src/transport/http.ts`
(ask miley/wallow first: a localhost-only `POST /node/repoint` beside `POST /node/enroll`),
`packages/cli/src/commands/node.ts`, `packages/cli/src/help/catalog.ts`. Test:
`packages/server/src/transport/node-enroll-http.test.ts`, `packages/cli/src/commands/node.test.ts`.

**Interfaces (produces):** `repointNodeEnrollment(team: string, hubUrl: string): NodeEnrollment` in
state.ts, which rewrites `hub_url` and keeps `node_id`, `credential` and `enrolled_at`.
`POST /node/repoint {team, hub_url}`, localhost-only, which:

1. probes `GET <hub_url>/teams/:slug/sync/pull?after=<cursor>` with the stored credential;
2. on 200, saves and calls `kickSyncStream`;
3. on any other answer, refuses `conflict` and leaves the file untouched.

- [ ] **Step 1: Failing tests:** `repointsWhenTheNewHubAcceptsTheCredential` (a second test daemon
  seeded from a copy of the first, so it holds the hash) and `refusesAHubThatRejectsTheCredential`
  (a fresh daemon gives 409, and node.json is byte-identical).
- [ ] **Step 2:** FAIL; implement; PASS.
- [ ] **Step 3:** CLI `musterd node repoint <hub-url> [--team <slug>]` calls it and prints
  `✓ this machine now syncs with <hub-url>`. Add the catalog entry. `pnpm cli-flags:check`.
- [ ] **Step 4:** Commit.

### Task 5: `musterd node relabel <node> <label>`

**Files:** `packages/server/src/store/nodes.ts` (`relabelNode(db, teamId, nodeId, label)`),
`http.ts` (admin `POST /teams/:slug/nodes/:id/label`), `packages/cli/src/commands/node.ts`. Test:
`packages/server/src/store/nodes*.test.ts`.

Why: after the copy, the hub identity's label is the laptop's hostname (`mac.lan`) while it runs on
the box. `musterd move --to` matches labels, so the label must say `musterd-joiner-1`.

- [ ] **Step 1: Failing test** `relabelsAndMoveResolvesTheNewLabel`: relabel, then
  `resolveNodeRef(db, team, 'musterd-joiner-1')` returns the node.
- [ ] **Step 2:** FAIL; implement (audit `node.relabeled`); PASS. Fast gates; commit; PR;
  auto-merge; `lane_submit`.

---

## Increment 4 — Security preconditions (lane `01M6HWV9E48ECHG1M77GX5HNDG`)

### Task 6: Each precondition, done and recorded

**Files:** Create `docs/guides/hub-relocation.md` (the runbook), with its section "Credentials on the
box" as the revocation list.

- [ ] **Step 1:** nick creates a fine-grained GitHub token: pull requests and checks read,
      `musterd-io/musterd` only. A deploy key with write goes on `SandRiseStudio/musterd-revive`,
      plus branch protection on its default branch. These need nick's GitHub; fifty asks by
      `team_question` with the exact settings.
- [ ] **Step 2:** Read the away relay's operator-map entry for revive. If a per-hub credential can be
      minted, mint one for the box. Record which.
- [ ] **Step 3:** Rotate and re-pair once on a test pairing. Stop a test daemon, set its
      `app-channel.key` aside, restart it (a new key is generated), then pair a phone again with
      "Pair again". Record the steps and the result.
- [ ] **Step 4:** On the box, confirm from config:
  - the daemon binds the tailnet address only (`ss -ltnp`);
  - the firewall drops 4849 on the public IP;
  - the tailnet ACL allows only named operators and the laptop's and delta-2's nodes.
- [ ] **Step 5:** Write the revocation list: each credential on the box, and how to revoke it in one
      step. Ask big-body to read the runbook section (`request_help`). Commit; PR; `lane_submit`.

---

## Increment 5 — Rehearsal (lane `01M6HWVB7F56DF6WPPMZT662RP`)

### Task 7: The full ceremony against a staging copy, timed

- [ ] **Step 1:** On the laptop, `sqlite3 ~/.musterd/musterd.db ".backup /tmp/rehearsal.db"` (a
      consistent online copy), then `inventory.ts /tmp/rehearsal.db > laptop.json`.
- [ ] **Step 2:** Copy to the box over the tailnet. Start a second daemon there:
  `MUSTERD_DB=~/rehearsal.db MUSTERD_PORT=4859 MUSTERD_NODE_STATE=~/rehearsal-node.json`, with every
  loop that writes outward disabled (relay, PR watch, sync push). Then run `inventory.ts` there
  and `--compare laptop.json`. It must be `[]`.
- [ ] **Step 3:** Run `inventory.ts --replica ~/.musterd/musterd.db --hub ~/rehearsal.db` on the
  box. For every non-ephemeral replica-only row, add the table and its carry rule to the ADR from
  Task 1 (an amendment if it has merged).
- [ ] **Step 4:** Time every runbook step (drain, snapshot, copy, verify, re-point, move) against
      the 30 minutes. Write the timings and the replica-only list to the runbook. Stop the
      rehearsal daemon and delete its copy.
- [ ] **Step 5:** Commit the runbook update; PR; `lane_submit`.

---

## Increment 6 — The switch (lane `01M6HWVD5J3APBQJ9PDFT5JDW5`)

### Task 8: Run it

- [ ] **Step 1:** Raise an ask to nick on `/live` naming the window, the steps and the rollback.
      Wait for his accept.
- [ ] **Step 2:** Run the runbook:
  1. Set `wakes_paused`.
  2. Wait for live leases to end.
  3. Drain every joiner (`inventory.ts --require-drained` on each).
  4. Stop the laptop daemon and its auto-refresher.
  5. Snapshot `musterd.db` (WAL checkpointed) to `~/.musterd/backups/<date>-hub/` and inventory it.
  6. Copy it to the box, and set the box's replica aside.
  7. Start the box daemon as hub, and compare inventories.
  8. On a mismatch: roll back per the spec, then stop.
- [ ] **Step 3:** Re-point:
  1. `musterd node relabel <hub-node> musterd-joiner-1`.
  2. Revoke the box's old joiner node credential.
  3. The laptop: rename `musterd.db` to `musterd.db.pre-relocation`, start fresh, `musterd node
     join <box-url> <invite>`.
  4. delta-2: `musterd node repoint <box-url>`.
  5. The box's and laptop's `musterd host` `--server` point at the hub (the box: localhost; the
     laptop: the box's tailnet URL).
  6. `musterd move` for each moving seat.
  7. `musterd node unbind`, then claim, for fifty, miley, cider and ghost, so they bind to the
     laptop's new node.
  8. Re-enroll ghost's and miley's residency on the laptop.
  9. Move the app-channel key and relay credential; turn the laptop's relay off.
- [ ] **Step 4:** Lift `wakes_paused`. Check each surface: `/live` on the laptop, `musterd status`,
      `team_status`, a phone delivery, and a seat wake on each machine. Post a `status_update` with
      the inventory result and the window's length. Add the measured numbers to the wiki.
- [ ] **Step 5:** `lane_submit` for this lane, then lane `01M67EF763`. Keep the snapshot and the
      set-aside replica for 30 days.
