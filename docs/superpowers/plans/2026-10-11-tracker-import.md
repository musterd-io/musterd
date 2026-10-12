# Import from GitHub, Linear and Jira, and re-sync — implementation plan

> **For agentic workers:** implement in your own seat, one lane per increment (AGENTS.md hard rule 8);
> TDD every step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a team's open GitHub, Linear or Jira issues land on the board through `musterd import
github|linear|jira`, and running the command again keeps the board matching the tracker.

**Architecture:** `source_ref` becomes a real lane field, with one open lane per ref per team, enforced in
the store transaction. Each tracker module turns issues into the `ImportRow[]` a CSV produces. A pure
`planSync` compares them with the board's lanes for that source, and adds rename, abandon and adopt actions
to the existing stage → preview → save.

**Tech stack:** TypeScript, zod, vitest, better-sqlite3 + Postgres (one migration ladder), Node's built-in
`fetch` and `node:http` (test fakes). No new dependency.

**Spec:** [docs/superpowers/specs/2026-10-11-tracker-import-design.md](../specs/2026-10-11-tracker-import-design.md)

## Increments

| Increment | What | Lane | Branch |
| --------- | ---- | ---- | ------ |
| 1 | `source_ref` lane field: protocol, server, CLI, MCP, `/live`; the file import sends it (ADR, epoch) | `01M4M4ABWQ7M5VEB9RS3VG99VF` | `feat/lane-source-ref` |
| 2 | `musterd import github`, `planSync` re-sync, skill emits `owner/repo#N` | `01M4Q7PMAPNXP4772YPHTKM0K2` | `feat/import-github` |
| 3 | `musterd import linear` | `01M4Q7PNWW8MBB40FS1421ZX99` | `feat/import-linear` |
| 4 | `musterd import jira` | `01M4Q7PQGX9JPJP9S691JCSDDN` | `feat/import-jira` |

Each increment is its own branch, PR, `lane_submit` and acceptance. Claim the next lane only after the
previous one merges.

## Global constraints

- **Field:** `source_ref` is a string of 1–200 characters. Its error message reads `source_ref "<ref>"
  already belongs to lane <id>`, sent as a 409 `conflict`.
- **No new dependency.** `musterd/0.3` is unchanged; `FEATURE_EPOCH` goes up by 1 (32 → 33, or the next
  free value when increment 1 lands).
- **Credentials:** a tracker token travels only in request headers. It is never written to the stage,
  stdout or stderr, or sent to the daemon.
- **Exit codes:** missing or refused credentials exit 2 with a one-line fix. A fetch failure exits 1 and
  stages nothing.
- **Local testing:** single test files only (`pnpm --filter <pkg> exec vitest run <file>`), never a whole
  suite. The fast gates are `pnpm change-adr:check && pnpm typecheck && pnpm lint && pnpm format:check`.
- **Docs:** a behaviour change updates its doc in the same commit (AGENTS.md hard rule 3), and a new
  source file gets a described line in its architecture tree (`arch-trees:check`).

## Ruling made while planning (differs from the spec; record it in the ADR and fix the spec)

**The cross-machine refusal can't live in the fold.** Lane opens on a synced team are local writes that
replicate as `lane.opened` events, and the fold applies history; it never refuses an event (block, don't
skip). So:

- the one-open-lane-per-ref check runs at each daemon's own write (`openLane`, `updateLaneInTx`), which
  covers the hub's arbitrated writes too;
- the fold carries `source_ref` and never refuses;
- two machines opening the same ref at once can still leave two open lanes. `planSync` treats a ref held
  by more than one open lane as a warning (`duplicate_ref`) and acts on none of them.

**Cost if wrong:** a rare duplicate on a synced team, which re-sync names instead of fixing.

## Review focus

1. **A lane reopened from done or abandoned onto a ref an open lane already holds.** It must be refused,
   the same as an open.
2. **A tracker whose open set is empty** (a 200 with `[]`). The fetch must succeed, and every board lane
   for the source must go through the per-issue state check. Nothing may be abandoned from the empty list
   alone.
3. **A GitHub issue transferred to another repo** (the 301 lands on another repo's issue). It is
   `not_found` (a warning), never `closed`.
4. **A stage written before increment 2** (no `sync` key, `source.format` csv/jsonl). It must still read
   and save.
5. **A lane claimed between preview and save.** Save must not abandon it; it skips with a warning.

---

# Increment 1 — `source_ref` as a lane field (lane `01M4M4ABWQ7M5VEB9RS3VG99VF`)

### Task 1: Branch, ADR number, draft PR

- [ ] `git fetch origin main && git checkout -b feat/lane-source-ref origin/main`
- [ ] `pnpm adr:next`. Expected: a free number `NNN`.
- [ ] Push an empty draft first, per ADR 223:
  - `git commit --allow-empty -m "wip: ADR NNN lane source_ref"` (with the seat trailer), then
    `git push -u origin feat/lane-source-ref`;
  - `gh pr create --draft --title "feat: source_ref as a lane field — ADR NNN (lane 01M4M4ABWQ)"`, with
    the body opening `` Lane `01M4M4ABWQ7M5VEB9RS3VG99VF`. ``
- [ ] Write `docs/decisions/NNN-lane-source-ref.md` with Context, Problem, Decision and Consequences:
  - **Context:** phase 1 put the ref in a `Source:` detail line, and re-sync needs to match on it.
  - **Decision:** the field; one open lane per ref per team, checked in the store transaction (a partial
    unique index can't say "not done or abandoned"); a done or abandoned lane keeps its ref as history;
    the `?source_ref=` filter; the epoch bump.
  - **Consequences:** the cross-machine ruling above; the file import sends the field; a 409 on save is
    adopted.

### Task 2: Protocol schema

**Files:** `packages/protocol/src/lanes.ts` (LaneSchema ~:492, OpenLaneSchema ~:572, UpdateLaneSchema
~:594), `packages/protocol/src/feature-epoch.ts`, `packages/protocol/src/lanes.test.ts`.

**Produces:** `LaneSourceRefSchema = z.string().min(1).max(200)`. `Lane.source_ref?: string | null`,
`OpenLane.source_ref?: string`, `UpdateLane.source_ref?: string`.

- [ ] **Failing test** in `lanes.test.ts`:

```ts
describe('source_ref (ADR NNN)', () => {
  it('rides open and update, and a lane without it still parses (older daemon)', () => {
    expect(OpenLaneSchema.parse({ title: 't', source_ref: 'acme/app#12' }).source_ref).toBe('acme/app#12');
    expect(UpdateLaneSchema.parse({ source_ref: 'ENG-42' }).source_ref).toBe('ENG-42');
    expect(() => OpenLaneSchema.parse({ title: 't', source_ref: '' })).toThrow();
    expect(() => OpenLaneSchema.parse({ title: 't', source_ref: 'x'.repeat(201) })).toThrow();
    const lane = LaneSchema.parse(minimalLane()); // the existing fixture helper in this file
    expect(lane.source_ref).toBeUndefined();
    expect(LaneSchema.parse({ ...minimalLane(), source_ref: null }).source_ref).toBeNull();
  });
});
```

- [ ] Run `pnpm --filter @musterd/protocol exec vitest run src/lanes.test.ts`. Expected: FAIL (the
  schemas don't have the key).
- [ ] **Implement:**
  - add `export const LaneSourceRefSchema = z.string().min(1).max(200);` near `LaneFollowsUpSchema`;
  - on `LaneSchema`, add `source_ref: LaneSourceRefSchema.nullable().optional(),` after `abandon_reason`,
    with the doc comment "ADR NNN: the issue this lane came from (`acme/app#12`, `ENG-42`). Absent reads
    as none (skew posture, like `follows_up`)";
  - on `OpenLaneSchema` and `UpdateLaneSchema`, add `source_ref: LaneSourceRefSchema.optional(),`;
  - bump `FEATURE_EPOCH` and add its rules entry: "33 — lanes carry `source_ref` (ADR NNN)".
- [ ] Re-run. Expected: PASS. Run `pnpm --filter @musterd/protocol exec vitest run
  src/feature-epoch.test.ts` too, if the file exists.

### Task 3: Migration v91

**Files:** `packages/server/src/db/ladder.ts`, `packages/server/src/db/db.test.ts`.

- [ ] **Failing test** in `db.test.ts`, next to the v81 column test: after `openDb(':memory:')`,
  `pragma_table_info('lanes')` includes `source_ref`, and `idx_lanes_team_source_ref` exists.
- [ ] Run it. Expected: FAIL.
- [ ] **Implement** a ladder entry after v90:

```ts
  {
    // v91 — ADR NNN: the issue a lane came from. Nullable, no backfill; a lane imported before this
    // keeps its `Source:` detail line until a re-sync adopts it. The index serves the per-ref lookup
    // the store runs before a write and `GET /lanes?source_ref=`; it is not unique — uniqueness is
    // "among lanes not done or abandoned", which only the store transaction can say.
    version: 91,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('source_ref')) db.exec('ALTER TABLE lanes ADD COLUMN source_ref TEXT');
      db.exec(LANES_SOURCE_REF_INDEX_SQL);
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS source_ref TEXT');
      await d.exec(LANES_SOURCE_REF_INDEX_SQL);
    },
  },
```

  with `const LANES_SOURCE_REF_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_lanes_team_source_ref ON
  lanes(team_id, source_ref) WHERE source_ref IS NOT NULL';`.
- [ ] Re-run `db.test.ts`, then `pnpm migrations:check`. Expected: both pass. Run the Postgres drift test
  file (`src/db/pg/drift.test.ts`) only if pglite runs locally in under a minute; otherwise CI is the
  authority.

### Task 4: Store, fold and uniqueness

**Files:**
- `packages/server/src/store/lanes.ts`:
  - `LaneRow` gets `source_ref: string | null`; `rowToLane` adds `...(row.source_ref ? { source_ref:
    row.source_ref } : {})`.
  - In `openLane`: set the row, the INSERT column and value, and `source_ref` in the `lane.opened` audit
    data.
  - In `updateLaneInTx`: `next.source_ref`, `'source_ref'` in `columns`, `'source_ref'` in
    `AUDITED_LANE_FIELDS`.
  - `insertLaneSnapshot` gets the column.
  - `LaneFilter.sourceRef` and `filterLanes`.
- `packages/server/src/sync/fold.ts`: the `lane.opened` INSERT gets `source_ref`, and the `lane.updated`
  column map gets `source_ref: 'source_ref'`.
- **New:** `packages/server/src/store/sourceRef.test.ts`.

**Produces:** `export async function laneHoldingSourceRef(db: Driver, teamId: string, ref: string,
exceptId?: string): Promise<{ id: string } | undefined>`. It is a SELECT on `team_id = ? AND source_ref
= ? AND state NOT IN ('done','abandoned') AND id <> ?`.

- [ ] **Failing tests** (`sourceRef.test.ts`, with `openDb(':memory:')` and the team/member setup that
  `followsUp.test.ts` uses):
  - Open with `source_ref: 'acme/app#1'`; reading it back gives `source_ref` `'acme/app#1'`.
  - A second `openLane` with the same ref rejects a `MusterdError` whose code is `conflict`, and whose
    message matches `/already belongs to lane 01/`.
  - After the first lane goes `abandoned` (`updateLane {state:'abandoned', abandon_reason:'x'}`), a new
    open with the ref succeeds.
  - Reopening that abandoned lane (`{state:'open'}`) while the new lane is open rejects `conflict`
    (Review focus 1).
  - `updateLane {source_ref:'acme/app#2'}` onto a ref another open lane holds rejects `conflict`;
    patching a lane with its own current ref succeeds.
  - Two lanes on different teams may share a ref.
  - `filterLanes(board, { sourceRef: 'acme/app#1' })` returns only that lane.
  - **Fold:** a `lane.opened` event whose data carries `source_ref` lands the column. Use the fold test's
    event builder.
- [ ] Run `pnpm --filter @musterd/server exec vitest run src/store/sourceRef.test.ts`. Expected: FAIL.
- [ ] **Implement** the uniqueness check:
  - in `openLane`, inside `db.tx` before the INSERT;
  - in `updateLaneInTx`, after `next` is built and before the UPDATE, when `!LANE_TERMINAL_STATES.has(state)
    && next.source_ref !== null && (next.source_ref !== rawRow.source_ref ||
    LANE_TERMINAL_STATES.has(existing.state))`.

```ts
const holder = await laneHoldingSourceRef(t, teamId, ref, id);
if (holder)
  throw new MusterdError('conflict', `source_ref "${ref}" already belongs to lane ${holder.id}`);
```

  `next.source_ref = patch.source_ref !== undefined ? patch.source_ref : (existing.source_ref ?? null)`.
- [ ] Re-run; expected PASS. Then run `src/store/followsUp.test.ts` and `src/sync/fold.test.ts` (the
  neighbours whose INSERTs changed). Expected: PASS.

### Task 5: HTTP filter and CLI client

**Files:** `packages/server/src/transport/http.ts` (GET `/lanes` ~:6342),
`packages/server/src/transport/integration.test.ts`, `packages/cli/src/client.ts` (`laneBoard` ~:1180).

- [ ] **Failing integration test:** open two lanes, one with `source_ref: 'ENG-1'`. `GET
  /teams/:slug/lanes?source_ref=ENG-1` returns exactly that lane. A second `POST /lanes` with `ENG-1`
  returns 409 with body `error.code === 'conflict'`.
- [ ] Run it. Expected: FAIL on the filter (the 409 may already pass from Task 4 — note it).
- [ ] **Implement:** `...(url.searchParams.get('source_ref') !== null ? { sourceRef:
  url.searchParams.get('source_ref')! } : {})` in the `filterLanes` call, and `source_ref?: string` in
  `laneBoard`'s `q` (`params.set('source_ref', q.source_ref)`).
- [ ] Re-run. Expected: PASS.

### Task 6: CLI, MCP and `/live` surfaces

**Files:**
- `packages/cli/src/commands/lane.ts`: USAGE :28 and :34, open flags ~:180, update ~:384, `renderLane`
  :97.
- `packages/cli/src/commands/lane.test.ts`.
- `packages/mcp/src/tools/lanes.ts`: `fmtLane` :35–41, `lane_open` :126, `lane_update` :293.
- `packages/mcp/src/tools/tools.test.ts`.
- `docs/perf/context-budgets.json`.
- `packages/web/src/live/Board.tsx`, next to the goal chip at :462.
- `packages/cli/src/help/catalog.ts`.

- [ ] **Failing tests:**
  - **CLI:** `lane open "t" --source-ref acme/app#3` sends `source_ref`, and `renderLane` prints `⌁
    acme/app#3` (theme.meta) after the goal.
  - **MCP:** `lane_open {title, source_ref}` passes it through, and `fmtLane` prints ` src=acme/app#3`.
- [ ] Run each file. Expected: FAIL.
- [ ] **Implement:**
  - the `--source-ref` flag on open and update (`flagStr(parsed.flags, 'source-ref')`);
  - `source_ref: z.string().min(1).max(200).optional().describe('the issue this lane came from, e.g.
    acme/app#12 or ENG-42 — one open lane per ref')` on both MCP tools;
  - `const src = l.source_ref ? \` src=${l.source_ref}\` : ''` in `fmtLane`;
  - on the web side, `{lane.source_ref && <span className="lc-card__chip lc-card__chip--src">{href ? <a
    href={href} target="_blank" rel="noreferrer">{lane.source_ref}</a> : lane.source_ref}</span>}`, where
    `href` is the first `https://` URL on the first line of `lane.detail`; reuse the goal chip's CSS,
    with a muted variant.
- [ ] Re-run the files. Then `pnpm context:check`. If it fails, raise the budget for the two tools in
  `context-budgets.json` by the measured delta and say so in the commit.

### Task 7: The file import sends the field

**Files:** `packages/cli/src/import/check.ts`, `check.test.ts`, `save.ts`, `save.test.ts`,
`commands/import.ts`.

**Produces:**
- `PlannedLane.source_ref?: string`;
- `BoardSnapshot.lanes[].source_ref?: string | null`;
- diagnostic code `already_on_board` (warning);
- `SavePort.laneBoard(team, q: { source_ref: string }): Promise<{ lanes: { id: string; state: string
  }[] }>`.

- [ ] **Failing tests:**
  - `check.test.ts`:
    - a row with `source_ref: 'github#7'` plans a lane with `source_ref` `'github#7'`, and its `detail` no
      longer has a `Source:` line (this replaces the assertion at :106);
    - a row whose ref an open board lane holds is left out of `plan.lanes`, with a warning
      `already_on_board` naming that lane id;
    - a ref held only by a done lane is planned normally.
  - `save.test.ts`: when the port's `openLane` throws `new CliError('source_ref "x" already belongs to
    lane L1', 1, 'conflict')`, save records `created[ref] = 'L1'` (looked up through
    `port.laneBoard(team,{source_ref})`, first lane not done or abandoned) and finishes. The result row
    has `resumed: false, adopted: true`.
- [ ] Run each. Expected: FAIL.
- [ ] **Implement:**
  - in check.ts, drop the `Source:` join (detail is `r.detail` only), set `lane.source_ref`, and build
    `openRefs = new Map(board.lanes.filter(open && source_ref).map(l => [l.source_ref, l.id]))`;
  - save.ts sends `body.source_ref`; on `err instanceof CliError && err.code === 'conflict' &&
    l.source_ref`, adopt;
  - `render.ts` prints adopted lanes as `↺ <title> (already on the board)`;
  - `HttpClient` already satisfies the port once Task 5 has landed.
- [ ] Re-run `check.test.ts`, `save.test.ts` and `commands/import.test.ts`. Expected: PASS.

### Task 8: Docs, gates, land, accept

- [ ] Docs:
  - `01-data-model.md`: the lanes columns list (:136–140) gets `source_ref`, and a uniqueness note at
    :240.
  - `03-server.md`: GET `/lanes` filters (:366–380) and the 409.
  - `04-cli.md`: the `lane open/update --source-ref` lines (:265).
  - `05-mcp.md`: the `lane_open`/`lane_update` args (:423).
  - The spec gets a dated note under §1 recording the cross-machine ruling.
- [ ] Fast gates (see Global constraints). Expected: green, apart from the 12 known lint warnings.
- [ ] Commit with `Refs ADR-NNN` and the seat trailer. Push, `gh pr ready`, then `gh pr merge --squash
  --auto --delete-branch`, and arm a waiter that exits on MERGED or a failed `gates` run.
- [ ] Acceptance on the isolated daemon (`$SP/accept`, rebuilt from `origin/main` after merge):
  - `lane open --source-ref X` twice prints the 409 line;
  - `lane_board` shows `src=X`;
  - `/live` shows the chip.
- [ ] `lane_submit {id:'01M4M4ABWQ7M5VEB9RS3VG99VF', pr, sha, authorized_by:'nick', follows_up:
  '01M4Q7PMAPNXP4772YPHTKM0K2'}`, then follow its reply. Clear the local branch.

---

# Increment 2 — `musterd import github` and re-sync (lane `01M4Q7PMAPNXP4772YPHTKM0K2`)

### Task 9: The shared tracker HTTP helper

**Files:** create `packages/cli/src/import/trackers/http.ts` and `http.test.ts`.

**Produces:**

```ts
export interface TrackerHttp { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }
export const defaultHttp: TrackerHttp = { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export class TrackerAuthError extends CliError {}            // exit 2
export async function getJson(
  http: TrackerHttp, url: string, init: { headers: Record<string, string>; method?: 'GET' | 'POST'; body?: string },
  ctx: { tracker: string; authFix: string },
): Promise<{ status: number; json: unknown; headers: Headers }>;
```

**Rules:**
- **401/403:** throw `TrackerAuthError(\`${tracker} refused the credentials (${status}) — ${authFix}\`,
  2)`.
- **404 and 410:** return `{status}` with `json: null`, so the caller decides.
- **429 or 5xx:** retry once after `Retry-After` seconds, capped at 30 s, default 2 s. A second failure
  throws `CliError(\`${tracker} answered ${status} twice — try again in a minute\`, 1)`.
- **Network error:** `CliError(\`cannot reach ${host}: ${cause}\`, 1)`.
- No error message may contain a header value.

- [ ] **Failing tests**, against a `node:http` fake on port 0 with `sleep` stubbed to record the ms:
  - a 429 with `Retry-After: 3`, then a 200, returns the json and recorded `[3000]`;
  - 503 twice throws `/answered 503 twice/`;
  - a 401 throws a `TrackerAuthError` with exit code 2 whose message lacks the token string passed in
    `headers.authorization`;
  - a 404 returns `{status:404, json:null}`.
- [ ] Run. Expected: FAIL (no module). Implement. Re-run. Expected: PASS.

### Task 10: The GitHub source and issues → rows

**Files:** create in `packages/cli/src/import/trackers/`:
- `types.ts`;
- `rows.ts`;
- `github.ts`;
- `github.test.ts`;
- `rows.test.ts`;
- `fixtures/github-issues-p1.json` and `fixtures/github-issues-p2.json` (trimmed from a real `gh api`
  call).

**Produces (types.ts):**

```ts
export type Tracker = 'github' | 'linear' | 'jira';
export interface TrackerIssue {
  ref: string; title: string; url: string; body?: string;
  group?: { key: string; title: string };   // milestone / project / epic
  stakes?: LaneStakes;
}
export type UpstreamState = 'open' | 'closed' | 'not_found';
export interface TrackerSource {
  tracker: Tracker;
  label: string;            // 'GitHub' — used in abandon_reason
  scope: string;            // 'acme/app' | 'ENG' | 'PROJ'
  ownsRef(ref: string): boolean;   // github: startsWith(`${scope}#`); linear/jira: /^SCOPE-\d+$/
  open(limit?: number): Promise<TrackerIssue[]>;
  state(ref: string): Promise<UpstreamState>;
}
```

**rows.ts:**

```ts
export function issuesToRows(issues: TrackerIssue[]): ImportRow[];
```

- One goal row per distinct `group.key`, keyed `slugify(group.title)`. The slug lowercases, turns runs of
  non-`[a-z0-9]` into `-`, trims `-`, cuts to 64 characters, and falls back to `group-<key>` when empty.
- Then one lane row per issue: `title`, `detail = [url, body?.slice(0, 4000)].join('\n\n')`, `goal` the
  slug, `stakes`, `source_ref: ref`. Row numbers count from 1 in emitted order.

**github.ts:**

```ts
export function githubToken(env = process.env, run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' })): string;
  // `gh auth token` trimmed; on failure or empty → env.GITHUB_TOKEN; else throw TrackerAuthError('no GitHub token — run `gh auth login`, or set GITHUB_TOKEN', 2)
export function repoFromRemote(run = …): string;   // parse `git remote get-url origin` (https or ssh) → 'owner/repo'; else CliError('no GitHub repo — pass owner/repo', 2)
export function githubSource(opts: { repo: string; token: string; http?: TrackerHttp; apiBase?: string }): TrackerSource;
```

- **`open()`:** `GET {apiBase}/repos/{repo}/issues?state=open&per_page=100&page=N`, following the `Link:
  rel="next"` header. It skips items with a `pull_request` key and stops at `limit`. It maps
  `milestone{number,title}` to `group {key: String(number), title}`. The labels `priority:high` and
  `priority:low` (case-insensitive) set stakes. The ref is `${repo}#${number}`.
- **`state(ref)`:** `GET /repos/{repo}/issues/{n}`. A 404 or 410 returns `not_found`. If
  `repository_url` doesn't end with `/repos/${repo}` the issue was transferred, so it returns `not_found`
  (Review focus 3). Otherwise it returns `json.state === 'closed' ? 'closed' : 'open'`.
- **Headers:** `authorization: Bearer <token>`, `accept: application/vnd.github+json`, `user-agent:
  musterd`.

- [ ] **Failing tests** (the fake serves the fixtures; page 1's `Link` points at page 2):
  - `open()` returns the issues of both pages, without the PR item;
  - the GitHub `milestone` becomes the group, and `priority:high` becomes `stakes: 'high'`;
  - an empty `[]` page returns `[]` without error (Review focus 2);
  - `state()` gives `closed`, `not_found` for a 404, and `not_found` for a transferred issue;
  - `githubToken` with `run` throwing and no env throws exit 2 with the `gh auth login` line;
  - `repoFromRemote` parses `git@github.com:acme/app.git` and `https://github.com/acme/app`;
  - `issuesToRows`: two issues in one `milestone` give one goal row and two lane rows, and the output parses
    cleanly through `checkAgainstBoard` with an empty board.
- [ ] Run each. Expected: FAIL. Implement. Re-run. Expected: PASS.

### Task 11: `planSync`

**Files:** create `packages/cli/src/import/trackers/sync.ts` and `sync.test.ts`.

**Produces:**

```ts
export interface BoardLane { id: string; title: string; state: string; owner_seat: string | null; project: string; detail: string | null; source_ref?: string | null }
export interface SyncAction {
  kind: 'rename' | 'abandon' | 'adopt';
  lane_id: string; ref: string;
  title?: string;            // rename: the new title
  from?: string;             // rename: the old title
  reason?: string;           // abandon: `closed in GitHub (acme/app#9)`
}
export interface SyncPlan {
  fresh: TrackerIssue[];               // open upstream, no lane → through issuesToRows + check
  actions: SyncAction[];
  unchanged: number;
  warnings: Diagnostic[];              // codes: closed_held, not_found, duplicate_ref
}
/** Lanes this source owns but whose issue is not in the open set — the caller asks `state()` for each. */
export function absentRefs(source: Pick<TrackerSource, 'ownsRef'>, open: TrackerIssue[], lanes: BoardLane[], project: string): string[];
export function planSync(input: {
  source: Pick<TrackerSource, 'label' | 'scope' | 'ownsRef' | 'tracker'>;
  open: TrackerIssue[]; lanes: BoardLane[]; project: string;
  upstream: Record<string, 'closed' | 'not_found' | 'open'>;   // answers for absentRefs
}): SyncPlan;
```

**Rules** (spec §3; only lanes not done or abandoned are considered):

1. **The lane's ref** is `lane.source_ref`. Otherwise it is the legacy `Source: <ref>` line, matched by
   `/^Source: (\S+)\s*$/m` on `detail`, with this adjustment for GitHub: a legacy `github#N` maps to
   `${scope}#N` only when `lane.project === project`. A lane counts only when `ownsRef(ref)` holds.
2. **A ref held by two or more open lanes** gives a `duplicate_ref` warning listing the lane ids. All of
   those lanes are skipped, and the issue isn't counted as fresh.
3. **For each open issue:** with no lane it is fresh. With a legacy lane it is adopted (and also renamed
   if the title differs). With a lane whose `title !== issue.title`, it is renamed. Otherwise it is
   unchanged.
4. **For each owned lane whose ref is absent from the open set:** `upstream[ref]`
   - `closed` with `owner_seat === null` and state `open` or `parked` → abandon, with reason `closed in
     ${label} (${ref})`;
   - `closed` and held (an owner, or `awaiting_acceptance`, `ready_for_review`, `active`, `blocked`,
     `claimed`) → a `closed_held` warning: `${ref} closed upstream — lane ${id} held by ${owner ?? state},
     left alone`;
   - `not_found` → a `not_found` warning: `${ref} not found upstream (deleted, moved, or no access) — lane
     ${id} left alone`;
   - `open` (it reopened between the list and the check) → unchanged.
5. **Legacy adoption of an absent ref** still emits `adopt` before an abandon, so the ref is recorded on
   the lane.

- [ ] **Failing tests**, one per row of the spec's re-sync table, plus:
  - legacy `github#9` adopted only with a matching project;
  - `duplicate_ref`;
  - a lane on another repo's ref (`other/app#1`) is ignored;
  - a done lane holding the ref is ignored (so the issue is fresh);
  - `absentRefs` returns exactly the owned refs missing from the open set.
- [ ] Run. Expected: FAIL. Implement. Re-run. Expected: PASS.

### Task 12: Stage, preview and save carry the sync

**Files:** `packages/cli/src/import/stage.ts`, `render.ts`, `save.ts`, and tests for each.

**Produces:**
- `ImportStage.source.format: ImportFormat | Tracker` (StageShape enum widened);
- `ImportStage.sync?: { actions: SyncAction[]; unchanged: number }`;
- `SavePort.updateLane(team, id, patch: UpdateLane): Promise<unknown>`;
- `SaveResult.sync: { kind: SyncAction['kind']; lane_id: string; ok: boolean; note?: string }[]`.

- [ ] **Failing tests:**
  - **`stage.test.ts`:** a stage JSON without `sync` and with format `csv` still reads (Review focus 4),
    and one with `format: 'github'` and `sync` round-trips.
  - **`render.test.ts`:** `renderPreview` of a stage with 4 new lanes, 2 renames, 3 abandons, 7 adopts and
    1 warning prints the line `new 4 · renamed 2 · closed upstream: abandon 3 · adopted 7 · 1 warning`.
    Zero counts are left out. Under it come `↻ renamed: "<from>" → "<to>"` rows and `✕ abandon:
    <title> (<ref>)` rows.
  - **`save.test.ts`:**
    - **Order:** adopt (`updateLane {source_ref}`), then goals, then new lanes, then renames (`{title}`),
      then abandons (`{state:'abandoned', abandon_reason}`).
    - **Re-check:** before a rename or abandon, save calls `port.laneBoard(team,{source_ref: ref})`. If
      the lane is now owned, or its state is not open or parked, the abandon is skipped with `note: 'claimed
      since the preview — left alone'` (Review focus 5).
    - **Abandoned already:** an abandon on a lane that is already abandoned counts as `ok`.
    - **Resume:** each completed action is recorded in `stage.created` under the key `sync:<kind>:<lane_id>`,
      so a re-run skips it.
- [ ] Run each. Expected: FAIL. Implement. Re-run. Expected: PASS.

### Task 13: `musterd import github`

**Files:** `packages/cli/src/commands/import.ts`, `commands/import.test.ts`, `help/catalog.ts`,
`docs/architecture/04-cli.md` (the file tree for `trackers/*`, plus the command).

**Produces:**

```ts
export async function runTrackerImport(source: TrackerSource, ctx: { ws: string; team: string; http: HttpClient; project: string; limit?: number }): Promise<number>
```

The flow:

1. `open = await source.open(limit)`. If `limit` was hit, or more than 500 issues came back, add a warning
   `large_backlog`.
2. `board = await http.laneBoard(team, { history: true })`.
3. `upstream = Object.fromEntries(await mapSeries(absentRefs(...), async (r) => [r, await
   source.state(r)]))`.
4. `plan = planSync(...)`.
5. `rows = issuesToRows(plan.fresh)`.
6. `checkAgainstBoard(rows, …)`.
7. `createStage` with `source: { path: \`${tracker}:${scope}\`, sha256: hash of the open issues JSON,
   format: tracker }` and `sync`.
8. `renderPreview`.

A fetch failure throws before `createStage` ever runs.

USAGE gains:

```
  musterd import github [owner/repo] [--limit N]   open issues from GitHub (gh auth token, or GITHUB_TOKEN); run again to re-sync
```

- [ ] **Failing tests** (`import.test.ts`, using the in-memory server already set up there, plus a
  `node:http` GitHub fake; pass `apiBase` and the token through env `MUSTERD_GITHUB_API` and
  `GITHUB_TOKEN` read by the command, with `gh` stubbed by `PATH` pointing at nothing):
  - The first run of `import github acme/app` stages 2 goals and 3 lanes. The token string appears in
    neither stdout nor the stage file. `save` opens them, each with `source_ref` `acme/app#N`.
  - The fake then renames #1, closes #2 and adds #4, and lane #3 is claimed by Ada. #3 is also closed
    upstream.
  - The second run's preview contains `new 1 · renamed 1 · closed upstream: abandon 1 · 1 warning`. After
    `save`, the board has #1 retitled, #2 abandoned with `closed in GitHub (acme/app#2)`, #4 open, and #3
    still claimed by Ada.
  - A third run immediately after previews nothing to do: `new` and `abandon` are both absent.
- [ ] Run. Expected: FAIL. Implement. Re-run. Expected: PASS.

### Task 14: The skill emits `owner/repo#N`

**Files:** `packages/protocol/src/guidance.ts:594`, `guidance.test.ts`, ADR 333 (a dated Consequences
note).

- [ ] **Failing test:** the import skill text contains `` `source_ref` `<owner>/<repo>#<number>` `` and
  not `github#<number>`. It also names `musterd import github` as the way to bring in, and later re-sync,
  a GitHub backlog when the CLI is available.
- [ ] Run. Expected: FAIL. Edit line 594, add one line under step 2 (`- **GitHub:** \`musterd import
  github\` fetches and re-syncs on its own; use it rather than writing the file by hand.`), and bump
  `GUIDANCE_CONTENT_VERSION`.
- [ ] Run the test, read the printed hash, and add it to `SNAPSHOTS`. Re-run. Expected: PASS.

### Task 15: Land and accept increment 2

- [ ] Fast gates, commit, PR (`` Lane `01M4Q7PMAPNXP4772YPHTKM0K2`. ``), auto-merge, waiter.
- [ ] Acceptance on the isolated daemon:
  1. Take a real repo with open issues grouped by `milestone` (one of nick's, or a public repo that uses them,
     read with nick's `gh` token).
  2. Run `import github` and save.
  3. Re-run immediately: the preview must show no changes.
  4. Retitle one issue on a scratch repo nick names, if he names one. Otherwise exercise the
     rename/abandon path on the test fake only and say so.
- [ ] `lane_submit` with `follows_up: '01M4Q7PNWW8MBB40FS1421ZX99,01M4Q7PQGX9JPJP9S691JCSDDN'`.

---

# Increment 3 — `musterd import linear` (lane `01M4Q7PNWW8MBB40FS1421ZX99`)

### Task 16: The Linear source

**Files:** create `packages/cli/src/import/trackers/linear.ts`, `linear.test.ts` and
`fixtures/linear-*.json`. Also change `commands/import.ts` (the subcommand), `help/catalog.ts` and
`04-cli.md`.

**Produces:** `linearSource({ team, key, http?, endpoint? = 'https://api.linear.app/graphql' }):
TrackerSource` and `linearKey(env)`. The key comes from `LINEAR_API_KEY`; otherwise
`TrackerAuthError('no Linear key — create one in Linear (Settings → API) and set LINEAR_API_KEY', 2)`.

**`open()`** POSTs `{query, variables:{team, after}}` with header `authorization: <key>`, paging on
`pageInfo`:

```graphql
query($team: String!, $after: String) {
  issues(first: 100, after: $after,
         filter: { team: { key: { eq: $team } }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { identifier title url description priority project { id name } cycle { number name } }
    pageInfo { hasNextPage endCursor }
  }
}
```

- **Group:** `project ? {key: project.id, title: project.name} : cycle ? {key: \`cycle-${number}\`,
  title: cycle.name ?? \`Cycle ${number}\`} : undefined`.
- **Stakes:** priority 1 → `high`, 4 → `low`.
- **Ref:** `identifier`. `ownsRef` is `/^${team}-\d+$/`.
- A GraphQL `errors[]` with an authentication error code becomes a `TrackerAuthError`; any other error
  becomes `CliError(…, 1)`.

**`state(ref)`:** query `issue(id: $ref) { state { type } }`. A `completed` or `canceled` type gives
`closed`; an "Entity not found" error gives `not_found`.

**USAGE:** `musterd import linear --team <KEY> [--limit N]   open issues from Linear (LINEAR_API_KEY);
run again to re-sync`. `--team` is required, and its absence exits 2 with that line.

- [ ] **Failing tests** (GraphQL fake): two pages; project grouping, else cycle; Urgent → `high`; the
  auth error exits 2 without leaking the key; `state` gives `closed` and `not_found`; and the
  `import.test.ts` twice-run shape with one closed and one renamed issue.
- [ ] Run. Expected: FAIL. Implement. Re-run. Expected: PASS.
- [ ] Gates, PR (`` Lane `01M4Q7PNWW8MBB40FS1421ZX99`. ``), merge.
- [ ] Acceptance runs against a real workspace only if nick provides a key; otherwise the recorded
  payloads stand in, and the submit says so.
- [ ] `lane_submit`.

---

# Increment 4 — `musterd import jira` (lane `01M4Q7PQGX9JPJP9S691JCSDDN`)

### Task 17: The Jira source

**Files:** create `packages/cli/src/import/trackers/jira.ts`, `jira.test.ts` and `fixtures/jira-*.json`.
Also change `commands/import.ts`, `help/catalog.ts` and `04-cli.md`.

**Produces:** `jiraSource({ site, project, auth, http? }): TrackerSource` and `jiraAuth(env)`.

**Auth:**
- `JIRA_EMAIL` + `JIRA_API_TOKEN` → basic auth (base64 of `email:token`);
- otherwise `JIRA_PAT` → `Bearer`;
- otherwise anonymous.

**The API:** a site whose host ends with `.atlassian.net` uses `GET
/rest/api/3/search/jql?jql=…&fields=summary,priority,fixVersions,parent&maxResults=100&nextPageToken=…`.
Any other site uses `GET /rest/api/2/search?jql=…&fields=summary,description,priority,fixVersions,parent&startAt=N&maxResults=100`.
The JQL is `project = "${project}" AND statusCategory != Done ORDER BY key`.

- **Group:** `parent` when `parent.fields.issuetype.name === 'Epic'` gives `{key: parent.key, title:
  parent.fields.summary}`. Otherwise the first `fixVersions[]` gives `{key: \`fv-${id}\`, title: name}`.
- **Stakes:** Highest → `high`; Low or Lowest → `low`.
- **Body:** v2 `description` (a string) only. The v3 ADF body is left out, and the URL alone goes in
  `detail`.
- **URL:** `${site}/browse/${key}`.
- **Ref:** `key`. `ownsRef` is `/^${project}-\d+$/`.

**`state(ref)`:** `GET /rest/api/{2|3}/issue/{ref}?fields=status`. A `statusCategory.key === 'done'`
gives `closed`, and a 404 gives `not_found`.

**USAGE:** `musterd import jira --site <url> --project <KEY> [--limit N]   open issues from Jira
(JIRA_EMAIL+JIRA_API_TOKEN, JIRA_PAT, or anonymous on a public site); run again to re-sync`.

- [ ] **Failing tests** (fake): v2 paging by `startAt`; v3 paging by `nextPageToken` (the fake answers on
  the `.atlassian.net` path; inject `apiVersion` for the test); grouping by `Epic`, else fix version; Highest →
  `high`; anonymous sends no `authorization` header; a 401 exits 2 naming `JIRA_EMAIL`/`JIRA_API_TOKEN` or
  `JIRA_PAT`; and the twice-run import test.
- [ ] Run. Expected: FAIL. Implement. Re-run. Expected: PASS.
- [ ] Gates, PR (`` Lane `01M4Q7PQGX9JPJP9S691JCSDDN`. ``), merge.
- [ ] Acceptance:
  1. Run `musterd import jira --site https://issues.apache.org/jira --project CLI` anonymously on the
     isolated daemon.
  2. Save, then re-run: the preview must show no changes.
  3. Compare the count with the open issues in `$SP/jira/all.csv`.
- [ ] `lane_submit` with `follows_up: 'none'`. Stop the isolated daemon on port 4899 once nick has seen
  the result.
