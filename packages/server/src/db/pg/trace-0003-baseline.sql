-- The frozen Postgres baseline of the TRACE store (ADR 445 §3) at trace ladder v3 (1B).
--
-- Hand-translated on 2026-09-30 from TRACE_MIGRATIONS v1–v3 (db/traceDb.ts) with the same rules as
-- 0080-baseline.sql (INTEGER → BIGINT). A separate database in Cloud as it is a separate file
-- locally: nothing joins it to the coordination store. From trace v4 on, a change is an entry in
-- TRACE_LADDER (db/ladder.ts), never an edit here. Roles and grants are those of the main baseline
-- (a deployment runs both baselines against databases the same login users reach); the tenant
-- policy on trace_events is derived at load time by pg/migrate.ts.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_owner') THEN CREATE ROLE musterd_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_app') THEN CREATE ROLE musterd_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_operator') THEN CREATE ROLE musterd_operator NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per harness hook event (ADR 445 §3; content since increment 1b; content_pruned_at v2;
-- origin_node v3). team_id is plain text: no FK can cross to the coordination store.
CREATE TABLE trace_events (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  seat              TEXT NOT NULL,
  session_digest    TEXT NOT NULL,
  seq               BIGINT NOT NULL,
  ts                BIGINT NOT NULL,
  received_at       BIGINT NOT NULL,
  harness           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  tool_name         TEXT,
  tool_use_id       TEXT,
  agent_id          TEXT,
  parent_agent_id   TEXT,
  duration_ms       BIGINT,
  outcome           TEXT,
  detail            TEXT,
  content           TEXT,
  redactions        BIGINT,
  truncated         BIGINT NOT NULL DEFAULT 0,
  content_pruned_at BIGINT,
  origin_node       TEXT,
  UNIQUE (team_id, session_digest, seq)
);
CREATE INDEX idx_trace_events_seat_ts ON trace_events (team_id, seat, ts);
CREATE INDEX idx_trace_events_tool_use ON trace_events (team_id, tool_use_id);
CREATE INDEX idx_trace_events_content_age ON trace_events (received_at) WHERE content IS NOT NULL;
CREATE INDEX idx_trace_events_origin ON trace_events (team_id, origin_node);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO musterd_app, musterd_operator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO musterd_app, musterd_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO musterd_app, musterd_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO musterd_app, musterd_operator;
