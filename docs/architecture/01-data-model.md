# 01 — Data Model (SQLite)

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

Store: **SQLite via `better-sqlite3`** (synchronous, embedded). One coordination database file, default `~/.musterd/musterd.db` (override `MUSTERD_DB`), plus — since ADR 445 §3 — a separate **trace store**, `trace.db` in the same directory (override `MUSTERD_TRACE_DB`), with its own ladder (see §Migrations). Nothing joins across the two files. Tests use `:memory:` for both.

Conventions:

- All ids are **ULIDs** (lexicographically sortable, generated with the `ulid` package) stored as `TEXT`. Exception: human-facing names are slugs (see below).
- Timestamps are **integer epoch milliseconds** (`INTEGER`), UTC. Column name `*_at` or `ts`.
- Booleans are `INTEGER` 0/1.
- `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` set at open.
- Every table has `created_at`. Mutable rows also have `updated_at`.

## DDL (authoritative)

```sql
-- ============ teams ============
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,              -- ULID
  slug        TEXT NOT NULL UNIQUE,          -- human name, e.g. "dawn"; [a-z0-9-], 1..32
  display     TEXT,                          -- optional pretty name
  default_lifecycle TEXT NOT NULL DEFAULT 'forever',  -- forever|session|until (default for new members)
  archived_at INTEGER,                       -- null = active
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============ members ============
-- A durable identity. NOT a session. Unique by (team, name).
CREATE TABLE members (
  id          TEXT PRIMARY KEY,              -- ULID
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- e.g. "Ada", "nick"; unique within team (see index)
  kind        TEXT NOT NULL CHECK (kind IN ('agent','human')),
  role        TEXT NOT NULL DEFAULT '',      -- free text, e.g. "backend"
  lifecycle   TEXT NOT NULL DEFAULT 'forever' CHECK (lifecycle IN ('forever','session','until')),
  lifecycle_until INTEGER,                   -- epoch ms; required iff lifecycle='until'; ENFORCED at auth since v73 (ADR 449)
  sponsored_by TEXT REFERENCES members(id),  -- v73 (ADR 449): the member who minted this one; null = admin/local-peer mint
  account_id  TEXT,                          -- v126 (ADR 698): the console account bound at first hosted sign-in, write-once; null = unbound
  halted_at   INTEGER,                       -- v85 (ADR 501): set = a human's hold on this agent seat; null = not halted
  halted_by   TEXT,                          -- v85: the halter's NAME (the refusal sentence is built from the row alone)
  halted_reason TEXT,                        -- v85: required on halt, ≤280 chars; resume clears all three
  availability TEXT,                         -- JSON schedule; STORED, NOT ENFORCED in v1 (roadmap)
  working_hours TEXT,                        -- recurring JSON schedule; STORED, NOT ENFORCED (ADR 206)
  token_hash  TEXT,                          -- sha256 of the member's join token (null until issued)
  left_at     INTEGER,                       -- null = still a member
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
CREATE INDEX idx_members_team ON members(team_id);

-- ============ presence ============
-- Where a member is CURRENTLY attached. One member -> many presences (multiple surfaces).
-- A row exists while a surface is connected; heartbeats keep it fresh; it is deleted/expired on disconnect.
CREATE TABLE presence (
  id            TEXT PRIMARY KEY,            -- ULID (one per attachment/connection)
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_id       TEXT,                        -- v83: the member's team, so one RLS policy shape covers every table; NOT NULL on Postgres, always written by the store on SQLite
  surface       TEXT NOT NULL CHECK (surface IN ('cli','claude-code','codex','opencode','grok','cursor','web','ios','slack','other','musterd','muse')),
  status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
  conn_id       TEXT,                        -- transport connection id (WS), null for stateless HTTP pings
  last_seen_at  INTEGER NOT NULL,            -- updated on every heartbeat
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_presence_member ON presence(member_id);
CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);

-- ============ messages ============
-- The durable log of all envelopes. Append-only.
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,              -- ULID == envelope.id
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL REFERENCES members(id),
  to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
  to_member   TEXT REFERENCES members(id),  -- set iff to_kind='member'
  act         TEXT NOT NULL CHECK (act IN
                ('message','status_update','request_help','handoff','accept','decline','wait')),
  body        TEXT NOT NULL DEFAULT '',      -- the human/agent-readable content
  thread_id   TEXT,                          -- ULID of the root message of a thread; null = new thread root
  meta        TEXT,                          -- optional JSON (act-specific fields; see 02-protocol)
  ts          INTEGER NOT NULL,              -- envelope timestamp (epoch ms)
  created_at  INTEGER NOT NULL              -- server receive time (== ts unless clock skew)
);
CREATE INDEX idx_messages_team_ts ON messages(team_id, ts);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_to_member ON messages(to_member);

-- ============ inbox_cursors ============
-- Per (member, scope) high-water mark for at-least-once, cursor-based delivery.
-- A member's unread = messages addressed to them (or their team/broadcast) with ts > cursor_ts.
CREATE TABLE inbox_cursors (
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_id     TEXT,                          -- v83, as on presence
  last_read_message_id TEXT,                 -- ULID of last acknowledged message
  last_read_ts INTEGER NOT NULL DEFAULT 0,   -- ts of that message
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (member_id)
);

-- ============ meta ============
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seed: ('schema_version','1')
```

## Field notes (load-bearing decisions)

- **Member uniqueness is `(team_id, name)`**, not global. "Ada" can exist in two teams as two Members. This is intentional: a Member belongs to exactly one Team. Cross-team identity linking is a roadmap concern, not v1.
- **`memberships` is folded into `members`.** The plan mentioned a separate `memberships` table; in v1 a Member belongs to exactly one Team, so membership _is_ the member row (`team_id` FK + `left_at`). If/when a Member must span Teams, split this out via ADR. (This is a deliberate, recorded simplification — if you implement, log it as ADR 001.)
- **Presence is ephemeral but row-backed.** Rows are created on attach, refreshed by heartbeat (`last_seen_at`), and removed/expired by the presence reaper (`03-server.md`). Querying "is X online" = "does X have a presence row with `last_seen_at` within the timeout".
- **`agent_connect_nonces`** (v74, ADR 449 §4): `nonce_hash` (sha256, PK), `team_id`, `member_id` (the sponsored agent), `issued_by` (was `sponsor_id` until v76, ADR 456 §3: who asked for the link, per the team's `agent_connect` policy), `created_at`, `expires_at` (15 min), `used_at`. Single-use; one live row per agent (a re-issue burns the prior). In the DB rather than memory (unlike ADR 170's 60s handoff) so a link survives a daemon restart. **`oauth_codes.connected_by` / `oauth_tokens.connected_by`** (v76, ADR 456 §3): the member who connected an agent's device, carried from the nonce's `issued_by`. A chain is valid only while both the agent and its `connected_by` member are in good standing, checked at use (`verifyAccess`, both token grants). NULL means a human signed their own seat in.
- **`availability`** is stored, not enforced (schedule enforcement is roadmap). **`lifecycle_until` IS enforced since v73** (ADR 449): `authMember` refuses a member whose `until` lifecycle has passed, on every credential kind — expiry is an ordinary per-member setting. No reaper is load-bearing; the hourly sweeper marks expired members `left_at` as cosmetic roster hygiene only (ADR 459 §4). **`sponsored_by`** (ADR 449) records which member minted this one; removing a member disables everyone their sponsorship chain reaches (`member.revoked_cascade` audit rows). On a seat-file team the seat file carries it by name (`sponsored_by = "<sponsor>"`, ADR 700); reconcile sets the column only where the hub's `member.sponsored_agent_created` fact (replicated to joiners, refused when pushed) vouches for it, never clears a vouched one, and cascades when a pass takes the sponsor's standing. **`halted_at` / `halted_by` / `halted_reason`** (ADR 501) are a human's operational hold on an agent seat: `memberStandingRefusal` answers `forbidden` "halted by <human>: <reason>" to every call, the claim handshake refuses with code `halted`, residency hands the seat to no host, and the halt revoked its session leases and evicted its presences. Resume clears the three columns; the seat's next claim mints a fresh lease.
- **`token_hash`** stores `sha256(token)`; the plaintext join token is shown once at `team add` time and never stored. The CLI/MCP present the token to authenticate as that Member.
- **Messages are append-only.** No edits/deletes in v1. `accept`/`decline` reference the original via `thread_id`/`meta.in_reply_to`, they don't mutate it.
- **Every message carries `(origin_node, origin_seq)`** (v47, ADR 331): the local `nodes` row for its team and a per-node gapless counter (`nodes.next_seq` holds the next value), both stamped inside `insertMessage`'s own transaction — server-derived, no wire field. `nodes` holds one self-minted row per (daemon, team), unenrolled (`credential_hash` NULL) until ADR 328's enrollment adopts it.

## Two dialects, one SQL text (ADR 479)

The store is written once, in SQLite's SQL, against the async `Driver` (`03-server.md` §db/). The
Postgres side never sees hand-written Postgres: `db/dialect.ts` translates each statement's text,
memoised per statement — `?` → `$n` outside literals, `json_extract` → `->>` / `#>>` (a `= 1` /
`<> 0` flag test compares as jsonb so JSON `true`/`false` qualify; an ordering compare casts to
numeric), `LIKE` → `ILIKE`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `instr` → `strpos`, `CAST(… AS INTEGER)` →
`BIGINT` (Postgres `INTEGER` is 32-bit; an epoch-millis cast overflows it), the null-safe `x IS ?` /
`x IS NOT ?` → `IS [NOT] DISTINCT FROM ?`,
two-argument `MAX`/`MIN` → `GREATEST`/`LEAST`. What the translator will not paper over, the SQL
avoids: positional `?` params only (never better-sqlite3's `@name` objects), `CAST(? AS TEXT)`
where a bare `? IS NULL` would leave Postgres unable to type the parameter, columns qualified in
`ON CONFLICT … DO UPDATE`, no SELECT alias reused in `WHERE`, every grouped-query column in its
`GROUP BY`, and `SUM(CASE WHEN … THEN 1 ELSE 0 END)` rather than summing a boolean. The one
dialect branch above the driver is `store/teamMemory.ts` (FTS5 `MATCH` locally, the tsvector
table in Postgres). `withDrivers` runs a store test on both engines by default; the PGlite double
is migrated by `db/pg/migrate.ts` — the frozen v80 baseline (`db/pg/0080-baseline.sql`) and then
the portable `db/ladder.ts` from v81, the same ladder SQLite runs after its legacy entries. From v81
on there is one ladder: an entry is portable SQL both engines accept, or an explicit `{sqlite,
postgres}` pair when they differ (SQLite cannot `ALTER COLUMN … SET NOT NULL`). v81 and v82 (ADR 487: `lanes.follows_up_json`, `abandon_reason`, `unfinished_todos_json`)
landed on main as SQLite entries and moved into the ladder as pairs, so Postgres has them too. v83
adds `team_id` to the four tables that were owned only through `members` / `seeds` — `presence`,
`inbox_cursors`, `seat_memory`, `seed_thread_entries` — backfilled from the owner, orphans dropped,
`NOT NULL` on Postgres; the store writes it on every insert (member-keyed tables take it off the
`members` row in the same `INSERT … SELECT`). v84 (cloud increment 1C) adds `console_token_jti (jti TEXT PRIMARY
KEY, exp BIGINT NOT NULL)`, portable SQL: a console token's id, redeemed once across every Cloud
server (cloud design §4.3) — a duplicate insert is a replay; redemption refuses an expired token itself, and prunes rows only an hour past their `exp` so a prune can never reopen one.
v85 (ADR 501, halt as revocation) adds three nullable columns to `members` — `halted_at`,
`halted_by`, `halted_reason` — the halt standing (per-engine `ADD COLUMN`; no backfill). Not an
`account_status`: a halt never cascades, touches no credential, and is lifted by a human
(`POST /members/:name/resume`), never by time.
v87 (ADR 516, holds) adds `holds (id PK, team_id, effect, reason, created_by, created_at, expires_at,
lifted_at, lifted_by)` plus `idx_holds_team_expires`: a time-bounded Team rule only a human admin sets
or lifts. Active is derived (`lifted_at IS NULL AND now < expires_at`) — no status column, no timer —
and rows are never deleted. The id is minted once on the hub and crosses the fold verbatim
(`hold.set` / `hold.lifted` under the `policy` sync kind), so the projection is idempotent. v86 is
ADR 514's.
v88 (ADR 519, calendar entries) adds `calendar_entries (id PK, team_id, title, date, start_time,
end_time, tz, kind, status, place, url, note, pick, source, source_ref, created_by, created_at,
updated_at)` plus `idx_calendar_team_updated` and the partial unique `idx_calendar_team_source_ref`
on `(team_id, source_ref) WHERE source_ref IS NOT NULL` — the one-time import's key. `start_time` /
`end_time` because `end` is reserved in SQL; `pick` is 0/1 on both engines. Deletes are real; a
`?since` delta reads them back from the `calendar.entry_deleted` audit rows, so there is no
tombstone column. Local to the daemon that took the write — no sync kind.
v89 (lane 01M477RQGV) is Postgres-only, with a SQLite no-op: `messages` gets
`autovacuum_analyze_scale_factor = 0.01` and `autovacuum_analyze_threshold = 500`, so it re-analyzes
after ~1 % churn. Under the tenant policy the roster's latest-status pick plans on `team_id`
statistics, and a team newer than the last ANALYZE plans a per-team scan instead of a per-member one.
Cloud run 14 measured 32 ms per roster read with the stale plan and 3.8 ms after an ANALYZE.
v90 ([ADR 531](../decisions/531-origin-seq-stamped-at-commit.md)) makes `idx_messages_origin` partial,
`WHERE origin_seq > 0`, the shape `idx_audit_origin` has had since v58. A replicated row is now
inserted with `origin_seq = 0` and numbered just before its transaction commits, so two unstamped
rows of one node can coexist inside a transaction. Every committed replicated row is stamped, and
the readers say `origin_seq > 0` so the index applies.

**Tenancy (cloud design §12.1).** On Postgres every team-owned table carries `team_id` (`teams`:
its `id`) and one derived row-level-security policy, `tenant`, on
`current_setting('app.team_id', true)` — ENABLE and FORCE, so the owner is bound too. The
`Driver` is the seam: `forTeam(teamId)` stamps every transaction it opens with `SET LOCAL ROLE
musterd_app` and `set_config('app.team_id', …, true)`; the unscoped connection handle stamps the
role and no tenant, so it sees no row (fail-closed); `asOperator()` runs as `musterd_operator`
(BYPASSRLS) and is the greppable list of every cross-tenant read. (The PGlite test double holds the same scopes at session level instead — one connection, switched only on change; `03-server.md`.) The app role owns nothing and
cannot bypass RLS; migrations run as the owner, a separate step. The seam is the transport: `http.ts`
scopes `ctx` where it resolves `/teams/:slug`, `ws.ts` where the claim frame names its team
(`03-server.md` §Auth); store code never sets tenant context. Tables that are not team-owned —
`schema_meta`, `footprint_machine`, `footprint_stacks`, `console_token_jti` — are the `GLOBAL_TABLES` allowlist in
`db/pg/tenancy.ts`; the inventory test fails on a table in neither set. On SQLite (one team per
file) `forTeam` and `asOperator` return the handle itself.

## Migrations

Both engines refuse to run against a database whose `schema_version` is past what the build's
ladder knows (cloud design §6; `db/guard.ts`, the stable sentence "schema newer than this build"):
under expand/contract the old binary keeps serving the expanded schema, but never one contracted by
something newer. `runMigrations` (both SQLite ladders) and `migratePostgres` share the check. A
Cloud server goes one step further: migrations never run on boot, and `listen()` refuses a database
at any version but its own — older is "schema older than this build", the migrate step not run
(`assertSchemaCurrent`, `03-server.md` §Cloud mode).

### Shared Seeds (unreleased — ADR 291)

Migration v43 adds an optional, Team-unique `members.slack_user_id` for human Members, Seed rows keyed
by immutable `(team_id, relay_id)`, and a narrow public Seed-thread table. Each Seed snapshots the
Slack user id and resolved submitting Member beside its immutable raw body, source, and capture time.
Mutable columns hold lifecycle state, explorer, exhaustive final brief, conclusion, promotion metadata,
completion time, and a nullable linked Lane id. The relay cursor remains separate. Promotion creates
the ordinary Lane and links it in the same SQLite transaction. Every accepted capture starts `open`;
only an active explorer's posted question creates `needs_clarification` (ADR 291/311/312).

### The trace store (ADR 445 §3, increment 1a)

`packages/server/src/db/traceDb.ts` carries `TRACE_MIGRATIONS`, a second forward-only ladder applied by the same runner (`runMigrations(db, ladder)`) to `trace.db`, gated by that file's own `schema_meta`. `pnpm migrations:check` parses both ladders; their versions are independent.

- **trace v1:** `trace_events` — one row per harness hook event: `id` (ULID), `team_id`, `seat`, `session_digest` (the ADR 131 §5 keyed HMAC, never the raw id), `seq` (daemon-assigned, monotonic per `(team_id, session_digest)`, `UNIQUE` with them), `ts`, `received_at`, `harness`, `kind` (the `TraceEvent` kinds), `tool_name`, `tool_use_id`, `agent_id`, `parent_agent_id`, `duration_ms`, `outcome`, `detail` (bounded structural JSON), and three columns reserved for increment 1b and unwritten in 1a: `content`, `redactions`, `truncated`. Indexes on `(team_id, seat, ts)` and `(team_id, tool_use_id)`. No foreign key can reference the coordination store; `team_id` is plain text.
- **trace v2 (increment 3a):** `trace_events.content_pruned_at` (when the 30-day lifecycle nulled `content`; NULL while content is live or was never captured) and the partial index `idx_trace_events_content_age ON (received_at) WHERE content IS NOT NULL`, the prune's scan. `schema_meta` also holds `content_captured_through` once `pnpm corpus:snapshot` has captured this file — the highest `received_at` in the captured image, stamped monotonically; the prune never goes past it.
- **trace v4 (1B, portable — `db/traceLadder.ts`):** `trace_events.row_seq` — the `/sync/trace` push cursor's column, replacing SQLite's `rowid` which Postgres lacks: on SQLite an `AFTER INSERT` trigger mirrors `rowid` into it (existing rows backfilled), on Postgres it is `BIGINT GENERATED ALWAYS AS IDENTITY`; `idx_trace_events_row_seq ON (team_id, row_seq)`. Nothing deletes from the table, so it only grows and the ADR 453 cursor argument holds unchanged.
- **trace v3 (ADR 453):** `trace_events.origin_node TEXT` (NULL = minted by this daemon; a node id = received over `/sync/trace` from that joiner) and `idx_trace_events_origin ON (team_id, origin_node)`. `schema_meta` gains, on a joiner, `sync_trace_cursor:<team_id>` (the highest rowid the hub acked) and `sync_trace_id_key` (a random 32-byte key, minted once, never sent — the HMAC key under which `tool_use_id` / `agent_id` / `parent_agent_id` cross as 24-hex digests). `rowid` is the cursor because nothing deletes from this table (the content prune is an UPDATE).

- Single forward-only migration runner. `schema_meta.schema_version` gates it. v1 ships version `1` = the DDL above. A migration is a `(version, up(db))` pair in `packages/server/src/db/migrations.ts`; the runner applies any with version > current inside a transaction, then bumps `schema_version`.
- No down-migrations in v1.
- **v29 (`musterd/0.3`, ADR 206):** `ALTER TABLE teams ADD COLUMN working_hours TEXT` + `ALTER TABLE members ADD COLUMN working_hours TEXT`. The nullable JSON value stores a validated recurring schedule (`timezone`, weekday list, `start`, `end`); a Member value replaces the Team value for that Member, and missing values inherit. It is informational and never enforces Presence.
- **v30 (`musterd/0.3`, ADR 206):** initialize the existing `revive` Team to Monday–Friday, 11:00–15:00 `America/Los_Angeles` only when its Team schedule is still unset. Explicit operator values are preserved.
- **v131 (ADR 728):** nullable `node_id`, `ceremony_origin`, and `ceremony_rp_id` on `approval_nonces` and `enrollment_codes`. Hub-local ceremonies leave them NULL; relayed ceremonies bind the one-use row to the authenticated node and its operator-configured WebAuthn origin/RP id. Challenge/proof material remains one-use and is never a member credential.
- **v2 (`musterd/0.2`, ADR 010):** `ALTER TABLE presence ADD COLUMN held_until INTEGER`. Non-null once a connection has cleanly dropped — the row becomes a _reclaim hold_ (`conn_id` cleared, `held_until = now + 45s`) instead of being deleted, so the member can reconnect within the grace window. Agent single-active is decided by _active_ presence (`conn_id` set, `held_until` NULL); held rows are excluded from the live roster and swept by the reaper when `held_until` passes. (Single-active is kind-scoped — agents only; a human seat holds multiple live rows, ADR 042.) The v1 DDL block above is unchanged; this is an additive ALTER.
- **v3 (`musterd/0.2`, ADR 014):** `ALTER TABLE presence ADD COLUMN provenance TEXT` + `ADD COLUMN workspace TEXT`. The provenance/where-on-attach seed: `provenance` (`session | asked | hook | scheduled | daemon`) records _why_ this attachment exists; `workspace` records the gracefully-degrading "where" label (folder, qualified by branch/subpath). Both are nullable, captured once at attach from the client's `hello`, surfaced on the roster, and never guessed by the server. Additive ALTERs; pre-v3 rows read `null`.
- **v4 (`musterd/0.2`, ADR 021):** `ALTER TABLE presence ADD COLUMN driver TEXT`. Driver co-presence: `driver` records the human steering this session, when one is, so the roster reads `driven by <name>` instead of showing the driving human offline. Nullable, captured once at attach from the client's `hello` (the MCP adapter sets it from `MUSTERD_DRIVER`), surfaced on the roster, never guessed. Additive ALTER; pre-v4 rows read `null`.
- **v5 (`musterd/0.3`, ADR 025):** the terminal `resolve` act. Because the `messages.act` CHECK is frozen in the v1 DDL above and SQLite cannot `ALTER` a CHECK in place, this migration **rebuilds** the `messages` table with the widened constraint (`… ,'resolve')`) and copies the append-only log across, then recreates its three indexes. Safe under `foreign_keys = ON`: no table references `messages`, and the copied rows still reference live teams/members. The v1 DDL block above is left unchanged (it records v1); the live `act` CHECK after migration includes `resolve`. **Superseded by v14 (ADR 103):** adding the steering acts `steer`/`challenge`/`defer` would have needed the same rebuild again, so v14 rebuilds `messages` one last time with `act` as **open `TEXT` (no CHECK)** — the boundary `ActSchema` (Zod) is the real validator, and the CHECK had cost two rebuilds; the vocabulary now widens with no further migration (the same open-TEXT lesson v10 recorded).
- **v6 (`musterd/0.3`, ADR 058):** `ALTER TABLE members ADD COLUMN bound_at INTEGER`, then **backfill `bound_at = created_at` for every existing row** in the same migration. The held/unheld bit for the durable-roster model: `bound_at` is set on a seat's _first authenticated touch_ (`authMember`) and distinguishes a **held** seat (a teammate holds its token) from a merely **declared** one — durable across the holder going offline, which presence deliberately is not (ADR 057). It is cleared on rotation, operator `reclaim`, and `unbind` (back to declared). The backfill is load-bearing: under the pre-058 model mint == delivery, so every legacy member is already held; a null would let a stray `claim` rotate a live token out from under an active session. Nullable, additive ALTER; the v1 DDL block above is unchanged. (Durable seat identity — name/kind/role/lifecycle — lives in git-tracked `.musterd/seats/*.toml`; the daemon's `members` row is their projection, with `id` + `token_hash` + `bound_at` as daemon-private anchors. See [058](../decisions/058-durable-on-git-live-on-daemon.md).)
- **v15 (`musterd/0.3`, ADR 101):** `ALTER TABLE presence ADD COLUMN model TEXT` + `ALTER TABLE requests ADD COLUMN model TEXT`. Model attestation: the harness-attested model id rides the **occupancy** (the `presence` row), never the durable seat — a different harness can occupy the same chair tomorrow with a different model (ADR 087). Attested, never verified (only the harness knows); nullable and rendered `unknown` when absent (warn-never-block). Captured at claim, re-attested on heartbeat, kept **sticky** across ambient touches (`COALESCE(?, model)`); CLI/HTTP one-shots may also re-attest via `x-musterd-model` on ambient touch for **agent** seats only ([119](../decisions/119-ambient-http-model-reattest.md), [121](../decisions/121-guard-human-x-musterd-model.md) — humans ignore the header). `requests.model` carries a grant-less claimant's attestation across the admin-approval gap so the approved occupancy isn't born `unknown`. The switch history lives in the audit log (`occupancy.model_attested`, source `claim|heartbeat|ambient`), not a column. Both additive ALTERs; pre-v15 rows read `null`. The per-act stamp (`meta.model`, server-controlled) is derived from this occupancy value at send time. See [101](../decisions/101-model-as-a-variable.md).
- **v16 (`musterd/0.3`, ADR 131):** two new tables for the harness-residency wake ledger. `residency` — per-seat enrollment (`member_id` UNIQUE: one enrollment, one host per seat; re-enroll is an audited last-enrolled-wins upsert) with `harness`, `host`, `grant_id` (the standing resume grant whose revocation is the kill switch), `authorized_by` (ADR 127 actor≠authorizer), and a reserved nullable `policy` JSON column for increment 5's per-seat knobs. `wake_leases` — the stored mutual-exclusion record for wake **actuation** (`act_id`, `host`, `lane` immediate|batched, `status` leased|reported|expired, `expires_at` ~120s): the argued exception to ADR 090's derive-everything maxim, following the `requests` precedent (short TTL, reaper-expired) because best-effort audit rows cannot bear correctness. Everything *rate-shaped* (cooldown, hourly cap, per-act attempt cap) stays derived from `residency.woke`/`residency.wake_failed` audit rows. Both tables additive; no wire bump. See [131](../decisions/131-harness-residency-wake-ledger-host.md).
- **v17 (`musterd/0.3`, ADR 135):** `ALTER TABLE presence ADD COLUMN build TEXT` — build attestation: the client's dist stamp rides every connect/touch so the roster can flag a stale binary (skew warnings in `team_status`/doctor). Additive nullable.
- **v18 (`musterd/0.3`, ADR 136):** `ALTER TABLE members ADD COLUMN observer_scope TEXT` + backfill existing observer rows to `'full'` — observer grades: a shared watch-link mints a `public`-grade seat (team/broadcast only) while the local dashboard stays full-visibility. ADR 601 adds a third stored value, `'broadcast'`: the stream's seat, which reads everything `full` reads except a DM between two human, non-observer members, and gets every string credential-scrubbed on the way out. NULL reads as `full` (ADR 136); any other string this build cannot name reads as `public` (ADR 601 §8, as amended 2026-10-15).
- **v19 (`musterd/0.3`, ADR 131 inc 4):** `ALTER TABLE residency ADD COLUMN resumable_harness TEXT` + `ALTER TABLE residency ADD COLUMN resumable_at INTEGER` — the session-capture *resumable attestation* pushed by `musterd session start --stdin` (SessionStart hook). Harness CLASS + timestamp only: a session id or transcript path never reaches the daemon (they live only in the workspace's gitignored `binding.session`, never committed, never read by the MCP adapter). Lives on the enrollment row, not `presence` — capture is presence-neutral by contract (ADR 057). The v15 additive-nullable precedent; pre-capture rows read null. The related deferral state (the local-session guard's snooze) is **derived** from `residency.wake_deferred` audit rows, never stored — and that verb is deliberately outside the `woke`/`wake_failed` rate reads, so a deferral burns no attempt/cooldown/cap budget.
- **v20 (`musterd/0.3`, ADR 141):** `ALTER TABLE members ADD COLUMN last_offline_reason TEXT` — sticky how-the-seat-went-dark (`disconnected` on `release`, `signed_off` on unbind/remove). Projected as `MemberSummary.offline_reason` with reclaimable → `reconnecting` and availability `off_hours` overlays. Cleared on next live attach. Additive nullable.
- **v42 (`musterd/0.3`, ADR 301):** `ALTER TABLE presence ADD COLUMN model_source TEXT` + `ALTER TABLE requests ADD COLUMN model_source TEXT`. Which tier produced the occupancy's `model` — `observed` | `environment` | `binding`. NULL for every pre-existing row and for any client that does not send it (absence is not an assertion, never defaulted to `binding`). The pair never travels split: no `model` ⇒ `model_source` is null. Per-act `meta.model_source` is derived from this occupancy value at send time, server-controlled. See [301](../decisions/301-per-act-model-source-tier.md).
- **v52 (`musterd/0.3`, ADR 344):** adds `agent_bootstrap_credentials`: independently revocable `mskey_` hashes scoped to one seat claim, role claim, or residency host label, with optional inventory label/expiry and lifecycle timestamps. Existing `teams.agent_key_hash` values are copied to marked `legacy` records for the compatibility window; new scoped minting never creates a Team-wide record.
- **v79 (`musterd/0.3`, ADR 463 §2):** adds `host_provisions` — one row per sponsored agent minted while its sponsor's host polled within 10 minutes: `member_id` (the agent), `sponsor_id`, `host` (label), `state` pending→claimed→ready|failed|cancelled, `claimed_by`/`claimed_at`, `ready_at`, `first_wake_at` (the one `provisioned` wake), `failed_reason`, `connect_origin` (so the sweep can build a fallback connect link with no request in hand), `created_at`. Adds nullable `host_liveness.sponsor_id` — whose host key last polled a label (one per label: two sponsors sharing a label see only the last to poll, and the other falls back to the connect link). A sponsored agent (`members.sponsored_by`) runs in its sponsor's OS account; losing the sponsor's standing (remove, expiry) cascades to the agent's residency, standing grant and any open provision.
- **v54 (`musterd/0.3`, ADR 350):** adds `teams.bootstrap_cutover_at` plus `agent_bootstrap_credentials.migration_target_member_id` and `first_used_at`. The Member reference proves which independently authenticated seat received a migration successor; first use records successful scoped authentication, so minting alone cannot satisfy cutover readiness. The Team timestamp is the durable, idempotent per-Team cutover marker.

- **v71 (`musterd/0.4`):** adds `messages.in_reply_to`, a `VIRTUAL` generated column equal to `json_extract(meta, '$.in_reply_to')`, plus four indexes for the discharge shapes (`idx_messages_in_reply_to`, `idx_messages_from_reply`, `idx_messages_thread_from`, `idx_messages_thread_act`) and an `ANALYZE messages`. Why a column and not an expression index: `json_extract` has no affinity and `messages.id` is `TEXT`, so SQLite never uses an expression index for `json_extract(dr.meta, '$.in_reply_to') = m.id` and the discharge `NOT EXISTS` scanned the team per candidate — the 2026-09-24 `daemon_wedged` pair. Every read of that JSON path goes through the column now (same value by definition). See [sqlite expression-index affinity](../wiki/sqlite-expression-index-affinity.md).
- **v77 (`musterd/0.4`, lane 01M3D4069F):** adds `idx_messages_from_act_ts` on `messages(from_member, act, ts, id)` and runs `ANALYZE messages`. The roster reads each member's latest `status_update` (`latestStatusUpdate`). Without this index that read searched `idx_messages_from_reply` and sorted in a temp B-tree, about 4 ms per member. That was ~100 ms of a ~118 ms `GET /teams/:slug` on the live copy, and the route's p95 in the 2026-09-28 tunnel bench was 2.2 s. The index serves the lookup and its `ORDER BY`: 1.7 ms for 25 members.
- **v78 (`musterd/0.4`, ADR 466):** adds nullable `lanes.parked_json` — `{by, at, reason, until?}` for a lane in the `parked` state, set on the move in and cleared on the move out (same shape and reason as `merged_json`). No backfill: no lane was parked before it.
- **v81 (ADR 487):** adds nullable `lanes.follows_up_json` — what a closing lane said is left, the JSON of `"none"` or a lane-id list (null reads as none) — and `lanes.abandon_reason` (≤ 280), set on or after the move to `abandoned` and cleared if the lane is reopened. No backfill: every earlier close predates the question.
- **v91 (ADR 561):** adds nullable `lanes.source_ref` — the issue a lane came from (`acme/app#12`, `ENG-42`), 1–200 characters, no control characters — and the non-unique index `idx_lanes_team_source_ref ON lanes(team_id, source_ref) WHERE source_ref IS NOT NULL`. **One lane per ref per team that is neither `done` nor `abandoned`:** the store refuses an open, an update onto a ref, or a reopen of a closed lane carrying one, with 409 `conflict` (`source_ref "<ref>" already belongs to lane <id>`), checked inside the write transaction — a partial unique index cannot say "not done or abandoned" over a state that changes. A closed lane keeps its ref as history. The fold carries the column and never refuses, so two machines opening one ref at once can leave two live lanes; `musterd import` re-sync reports that as `duplicate_ref`. No backfill.
- **v92 (lane 01M4S0ZAG8):** adds `idx_audit_team_action_target_ts ON audit(team_id, action, target, ts)`. The wake poll's per-seat audit reads (deferral snooze, dream-night spend, last wake) filter on `target` within one action; the `(team_id, action, ts)` index walked every row of that action for each seat. No data change.
- **v93 (lane 01M4S7GW7P):** adds `idx_messages_thread_act_ts ON messages(team_id, act, thread_id, ts)`. The open-directed ledger asks, per open act, for the earliest `resolve` in its thread (`ORDER BY ts LIMIT 1`); with `ts` missing from the key SQLite chose the `(team_id, ts)` index to skip the sort and walked the team's messages for each call (305 calls × 23k rows on the Air). No data change.
- **v94 (ADR 576, lane 01M4SDYXKC):** adds `idx_wake_leases_one_live`, a partial unique index on `wake_leases(member_id) WHERE status = 'leased'`: at most one live lease per seat, on SQLite and Postgres alike. The wake-lease claim no longer derives inside one transaction, so the schema now holds the no-double-spawn guarantee. Before building the index it expires all but the newest `leased` row for any member that has more than one.
- **v97 (ADR 478 Cloud amendment, lane 01M3W6GWVN):** adds `audit_archive (id PK, team_id, month, row_count, from_ts, to_ts, body, created_at)` plus `idx_audit_archive_team_month`. This is where Cloud puts churn-class `audit` rows before it prunes them. A Fly VM has no durable disk to hold the local `~/.musterd/archive/audit-YYYY-MM.jsonl.gz` file. Each row is one team's rows for one month from one prune batch. `body` is base64 of the gzipped JSONL, byte-for-byte what a local archive member holds; it is TEXT, so both engines and every driver read it back as a string. The insert and the delete of the rows it holds run in one transaction. The table is team-owned, so it gets the tenant policy. A local SQLite store keeps archiving to its file and leaves the table empty. No backfill.
- **v98 (ADR 582 §3, lane 01M4VKSDJH):** adds nullable `lanes.areas_json` — a JSON array of declared area names. Null means the areas are derived at read time from `surface_globs`. A declared list replaces the derived one. No backfill.
- **v99 (ADR 621, lane 01M3Z42GN1):** adds nullable `members.ceiling` and `team_invites.ceiling`. On a member, `'guest'` makes it talk-only: `resolveCapabilities` clamps the projected capabilities with `GUEST_CEILING` at read time, so reconcile cannot widen it. NULL means no ceiling, and an unrecognised value reads as `'guest'`. On an invite, `'guest'` (the default for new invites) is stamped on every member it admits; NULL, as on every invite minted before v99, admits members. No backfill.
- **v100 (ADR 623, lane 01M515KYT64):** adds `ask_channel_tokens` (the sha256 of a per-ask, per-channel token plus the bound reference: ask id and digest, action class, channel, binding id and generation, required assurance, `expires_at`, `consumed_at`; the plaintext is never stored) and `ask_decisions` (primary key `(team_id, ask_id)`: one decision per ask across every channel, which makes the decision a compare-and-set). New team-owned tables, no backfill.
- **v101 (ADR 624, lane 01M5162MTC):** adds nullable `lanes.declined_json`: the lane's latest decline, `{by, reason, at}`, written by a release that carries `release_reason` and cleared by any claim. The lane picker shows it. No backfill; NULL means never declined.
- **v102 (ADR 629, lane 01M4EDCQ2W):** adds nullable `lanes.requested_json` — `{by, basis, ref?}`. `basis` is `act` (a steer, an ask, or a handoff; `by` is that act's sender), `seed` (a seed; `by` is its submitter), `self` (the seat writing the record), or `stated` (that seat's word about someone else). Null means missing, which is not the opener and not "nobody". No backfill. Once written, a different value is a 409. The fold stores a record it can parse and does not re-check the act or the seed.
- **v105 (ADR 644, lane 01M55WJXNP):** adds nullable `lanes.reads_on` (`YYYY-MM-DD`, the day the lane's read is due) and `lanes.read_verdict_json` (`{outcome, note, by, at}`). No backfill: an older lane is undated. `read_status` (`read` / `dropped` / `waiting` / `due` / `overdue`) is derived on the projection in `CALENDAR_DEFAULT_TZ` and never stored. A move to `done` with `reads_on` and no verdict is refused (`validation`), including an acceptance `accept`; the abandoned-acceptance sweep leaves such a lane. Each verdict written is one `lane.read_recorded` audit row; the fold carries both fields through `lane.opened` / `lane.updated`.
- **v106 (ADR 645, lane 01M55PDKAT):** adds nullable `lanes.pre_registered_json` (`{run, verdict_rule, record, expected_spend, by, at}` — the band-2 declaration, stamped by the daemon from the writer; no backfill, nothing was declared before) and `pull_announcements` (one row per (lane, seat) pull in flight: `ask_id`, `announced_by` (the host's service seat), `tier`, `state` announced → granted | declined → claimed, `lane_updated_at` the window's change guard, `window_ends_at`, `decided_at`, `reason`). Not replicated: the pull is decided at the hub and ends in an ordinary replicated claim. The declaration is refused where `preRegisteredRefusal` says (400) and on a lane that is not open (409); the fold carries it through `lane.opened` / `lane.updated`.
- **v107 (ADR 654, lane 01M561Y8QF):** adds nullable `seat_memory.writer` — a JSON stamp `{surface?, workspace?, node?, machine?}` of the session that saved the note (the Presence behind its session lease, and the daemon's node). No backfill: a note saved before this reads as "not recorded". The replicated `continuity.memory_saved` row carries the same stamp and the fold writes it through, so a second machine knows where the note was saved.
- **v108 (lane 01M57Y2E7Z):** Postgres only. It widens `pull_announcements.lane_updated_at`, `announced_at`, `window_ends_at` and `decided_at` from `INTEGER` to `BIGINT`. v106 had typed these epoch-millisecond columns `INTEGER`, which is 32-bit on Postgres, so the first announcement overflowed. SQLite's `INTEGER` is already 64-bit, so its step is a no-op.
- **v109 (ADR 657, lane 01M561YWP0):** adds nullable `nodes.note_key`, the machine's public X25519 note key (raw 32 bytes, base64url) that a human seat's note is sealed to. It is set by `POST /teams/:slug/memory/recipients`, or on the hub by its `sync/note-recipients` forward, and is never replicated: a joiner asks the hub. A human seat's `seat_memory` row, and the `continuity.memory_saved` row that carries it, hold only the sealed note (headline `sealed note`).
- **v134 (ADR 751, lane 01M61T04S9):** adds nullable `lanes.card_json` (`{x, y, by, at}`): where the lane's card hangs on the wall board, a place within its goal × board-column cell; null when the lane is off the board (parked, abandoned). Backfilled for every lane on the board in `created_at` order by the same picker the writes use (`store/laneCard.ts`), so every daemon computes the same places without a sync. `card` rides `lane.opened` / `lane.updated`.
- **v137 (ADR 778, lane 01M67EEB6Q):** indexes for the statements that held the hub's event loop, each on the expression its query already uses: `idx_messages_lane_review ON messages(team_id, json_extract(meta, '$.lane_review.lane')) WHERE act = 'ask'`, `idx_messages_digest_day ON messages(team_id, json_extract(meta, '$.digest.day')) WHERE … IS NOT NULL`, `idx_audit_team_action_target_act ON audit(team_id, action, target, json_extract(detail, '$.act'))`, and `idx_lanes_team_owner_created` / `idx_lanes_team_created` for the `ORDER BY created_at` lane lists. The two `messages` indexes are partial, so most inserts skip them. Postgres gets only the two lane indexes; its JSON reads keep today's plan (as v135).
- **v112 (ADR 673, lane 01M5B1YQVH):** adds nullable `lanes.metric_json` (`{name, unit, baseline, target, direction, source, by, at}`, stamped by the daemon; needs `reads_on`) and `lane_samples (team_id, lane_id, day, value, n, by_name, at)`, one row per lane per day, primary key `(team_id, lane_id, day)`, a later write for the day replacing the earlier one. No backfill. The newest 60 samples ride a metric lane's projection. Each write is one `lane.sample_recorded` audit row, which the fold replays into `lane_samples` on the hub; `metric` rides `lane.opened` / `lane.updated`. A `met` / `missed` verdict on a metric lane must carry `measured {value, n}`.
- **v117 (ADR 676, lane 01M5BER5GX):** adds nullable `app_keys` (JSON, public halves only: the phone's signing and receive public keys, App Attest key id and environment, device name, and on the binding the enrolled `device_key_id`) to `pairing_nonces` and `channel_bindings`. An app pairing stages it on the nonce row; the binding it becomes keeps it. No backfill.
- **v118 (ADR 677):** scrubs secrets from historical `policy.change` audit details and matching `sync_log` event payloads in place. The policy secret keys become `{"$redacted":"policy-secret"}`; event ids, timestamps, actors, origin/hub sequence numbers, and ordinary policy fields remain unchanged. Malformed matching JSON aborts the migration. New policy events use the same marker, while replica folds omit marker-valued fields before writing their local policy projection. The hub's `teams.policy` retains the complete configured policy.
- **v121 (ADR 689):** adds nullable `agent_bootstrap_credentials.replicated_from` — the node id a sponsor-scoped credential was projected from (`credential.accepted`, a hub-origin ledger row carrying the hash), null when minted here. A replicated row is honoured sponsor-only: `hostKeyScope` never grants it team-wide reach, whatever its creator is on the hub. No backfill.
- **v122 (ADR 689 d5):** adds nullable `host_liveness.node` — the node a host label is bound to, first-writer-wins at the hub's ingest of a ledger row whose `detail.actor_kind` is `host` (`bindHostToNode`); a row in that label's name pushed from any other node is refused. Null until such a row is pushed. No backfill.
- **v124 (lane 01M5G7KWJP):** adds `idx_audit_team_target_ts ON audit(team_id, target, ts)`. `laneHistory` filters `action LIKE 'lane.%' AND target = ?`; the LIKE stops the action indexes at the team, so every `GET /lanes/:id` walked all of the team's audit rows (306,790 on the revive hub, 3.9 s cold, a synchronous event-loop stall each time). A lane id is a ULID, so the seek leaves a handful of rows. No data change.
- **v125 (lane 01M5G9FKCG):** adds `idx_messages_inbox_cover ON messages(team_id, created_at, id, to_kind, to_member, from_member)`. Every `GET /inbox` runs `countInbox` and `countUnread`, which filter on columns `(team_id, created_at)` lacks, so each fetched every message row since its floor (all of the team's for a seat with no cursor) from a 491 MB file that does not stay cached on the hub. The covering index answers both counts, the cursor-tiebreak shape included, without touching the table (3.4 MB of index for 28 MB of rows). No data change.
- **v128 (ADR 696 / ADR 703, lane 01M5GDGC5Z):** adds `host_provisions.kind` (`mint` | `move`, default `mint`) and nullable `host_provisions.move_json` (the revoked harness and policy). Existing rows stay mints. No backfill.
- **v82 (ADR 487 §5.2):** adds nullable `lanes.unfinished_todos_json` — `{items, at}`, the seat session's unfinished to-do titles written by the turn-end hook, last write wins (an empty list clears it); kept on a closed lane so the acceptor and the weekly sweep can read it. No backfill.

## Seed data for tests (`06-testing.md` references this)

```
team:    dawn
members: nick  (human, role "lead",     lifecycle forever)
         Ada   (agent, role "backend",  lifecycle session)
         Lin   (agent, role "frontend", lifecycle session)
```

A test helper `seedDawn(db)` inserts exactly this and returns the created ids. Use it in integration + scenario tests so fixtures stay identical to the Figma terminal frames' sample data.
