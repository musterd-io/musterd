-- The frozen Postgres baseline at SQLite ladder v80 (cloud design §12.2; 1B task 3).
--
-- Generated ONCE on 2026-09-30 from the fully migrated SQLite schema through the spike's Q1 rules
-- (INTEGER → BIGINT, AUTOINCREMENT → IDENTITY, REAL → DOUBLE PRECISION, BLOB → BYTEA, VIRTUAL →
-- STORED, json_extract through the translator) with the FTS5 hand-fixes (insights_fts is a
-- tsvector table kept by two plpgsql triggers; the four FTS5 shadow tables have no counterpart),
-- statements in dependency order. Owned by hand from here: a schema change from v81 on is an entry
-- in db/ladder.ts, never an edit to this file. pg/drift.test.ts keeps it equal to the SQLite
-- ladder's table/column set.
--
-- What is NOT here, because it is derived at load time by pg/migrate.ts: the tenant row-level
-- security policies (pg/tenancy.ts, one shape for every team-owned table).

-- Roles (pg/tenancy.ts). NOLOGIN: a deployment creates login users and GRANTs them these. No
-- password ever lives in the schema. `CREATE ROLE IF NOT EXISTS` does not exist, hence the block.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_owner') THEN CREATE ROLE musterd_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_app') THEN CREATE ROLE musterd_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_operator') THEN CREATE ROLE musterd_operator NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  display     TEXT,
  default_lifecycle TEXT NOT NULL DEFAULT 'forever',
  archived_at BIGINT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
, agent_key_hash TEXT, policy TEXT, working_hours TEXT, bootstrap_cutover_at BIGINT);

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE roles (
           team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           capabilities TEXT NOT NULL DEFAULT '{}',
           charter TEXT,
           created_at BIGINT NOT NULL,
           updated_at BIGINT NOT NULL, summary TEXT,
           PRIMARY KEY (team_id, name)
         );

CREATE TABLE audit (
           id         TEXT PRIMARY KEY,
           team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           ts         BIGINT NOT NULL,
           actor      TEXT,
           action     TEXT NOT NULL,
           target     TEXT,
           result     TEXT NOT NULL CHECK (result IN ('allow','deny')),
           detail     TEXT,
           created_at BIGINT NOT NULL
         , origin_node TEXT NOT NULL DEFAULT '', origin_seq BIGINT NOT NULL DEFAULT 0, actor_model TEXT, actor_model_source TEXT);

CREATE TABLE grants (
           id         TEXT PRIMARY KEY,
           team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           scope      TEXT NOT NULL,
           target     TEXT NOT NULL,
           token_hash TEXT NOT NULL,
           issued_by  TEXT,
           lifetime   TEXT NOT NULL,
           expires_at BIGINT,
           single_use BIGINT NOT NULL DEFAULT 0,
           revoked    BIGINT NOT NULL DEFAULT 0,
           created_at BIGINT NOT NULL
         );

CREATE TABLE requests (
           id           TEXT PRIMARY KEY,
           team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           kind         TEXT NOT NULL,
           from_session TEXT NOT NULL,
           target       TEXT,
           surface      TEXT NOT NULL DEFAULT 'cli',
           status       TEXT NOT NULL,
           decided_by   TEXT,
           created_at   BIGINT NOT NULL,
           expires_at   BIGINT NOT NULL
         , model TEXT, model_source TEXT);

CREATE TABLE lanes (
           id            TEXT PRIMARY KEY,
           team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           project       TEXT NOT NULL,
           title         TEXT NOT NULL,
           detail        TEXT,
           owner_seat    TEXT,
           role          TEXT,
           surface_globs TEXT NOT NULL DEFAULT '[]',
           depends_on    TEXT NOT NULL DEFAULT '[]',
           branch        TEXT,
           state         TEXT NOT NULL,
           created_by    TEXT NOT NULL,
           created_at    BIGINT NOT NULL,
           claimed_at    BIGINT,
           resolved_at   BIGINT,
           updated_at    BIGINT NOT NULL
         , goal_id TEXT, risk TEXT, merged_json TEXT, stakes TEXT, stakes_provenance TEXT, kind TEXT, parked_json TEXT);

CREATE TABLE tool_call_stats (
          team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          seat              TEXT NOT NULL,
          role              TEXT,
          tool              TEXT NOT NULL,
          outcome           TEXT NOT NULL,
          bucket_start      BIGINT NOT NULL,
          calls             BIGINT NOT NULL DEFAULT 0,
          total_duration_ms BIGINT NOT NULL DEFAULT 0,
          max_duration_ms   BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, seat, tool, outcome, bucket_start)
        );

CREATE TABLE "members" (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('agent','human','service')),
          role        TEXT NOT NULL DEFAULT '',
          lifecycle   TEXT NOT NULL DEFAULT 'forever' CHECK (lifecycle IN ('forever','session','until')),
          lifecycle_until BIGINT,
          availability TEXT,
          token_hash  TEXT,
          left_at     BIGINT,
          created_at  BIGINT NOT NULL,
          updated_at  BIGINT NOT NULL,
          bound_at    BIGINT,
          observer    BIGINT NOT NULL DEFAULT 0,
          account_status TEXT,
          capabilities TEXT,
          credential_hash TEXT,
          observer_scope TEXT,
          last_offline_reason TEXT,
          working_hours TEXT,
          roles TEXT,
          slack_user_id TEXT,
          hue BIGINT,
          doorbell_prefs TEXT,
          sponsored_by TEXT
        );

CREATE TABLE footprint_stacks (
          ts BIGINT NOT NULL,
          classification TEXT NOT NULL,
          seat TEXT,
          procs BIGINT NOT NULL,
          rss_kb BIGINT NOT NULL,
          pids TEXT NOT NULL
        );

CREATE TABLE footprint_machine (
          ts BIGINT PRIMARY KEY,
          swap_used_mb BIGINT,
          swap_total_mb BIGINT,
          free_mem_mb BIGINT
        );

CREATE TABLE seeds_ingest_cursor (
          team_id TEXT PRIMARY KEY,
          last_seed_id TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );

CREATE TABLE wake_turns (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          lease_id        TEXT NOT NULL,
          member_id       TEXT NOT NULL,
          turn            BIGINT NOT NULL,
          usage_json      TEXT NOT NULL,
          cost_usd        DOUBLE PRECISION,
          stop_reason     TEXT,
          transcript_json TEXT,
          created_at      BIGINT NOT NULL,
          UNIQUE(lease_id, turn)
        );

CREATE TABLE "incident_reports" (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          seat TEXT NOT NULL,
          sig TEXT,
          ref TEXT,
          message_id TEXT,
          lane_id TEXT,
          created_at BIGINT NOT NULL
        );

CREATE TABLE insights_fts (
  message_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, headline TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', headline || ' ' || body || ' ' || tags)) STORED
);
CREATE INDEX idx_insights_fts_tsv ON insights_fts USING GIN (tsv);

CREATE TABLE nodes (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          label           TEXT NOT NULL,
          credential_hash TEXT,
          enrolled_at     BIGINT,
          enrolled_by     TEXT,
          revoked_at      BIGINT,
          last_seen_at    BIGINT,
          next_seq        BIGINT NOT NULL DEFAULT 1
        );

CREATE TABLE local_node (
          team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES nodes(id)
        );

CREATE TABLE node_invites (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          code_hash   TEXT NOT NULL,
          label       TEXT,
          created_by  TEXT NOT NULL,
          created_at  BIGINT NOT NULL,
          expires_at  BIGINT NOT NULL,
          consumed_at BIGINT,
          consumed_by TEXT
        );

CREATE TABLE sync_log (
          id           TEXT NOT NULL,
          team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          origin_node  TEXT NOT NULL REFERENCES nodes(id),
          origin_seq   BIGINT NOT NULL,
          hub_seq      BIGINT NOT NULL,
          payload      TEXT NOT NULL,
          received_at  BIGINT NOT NULL
        );

CREATE TABLE sync_meta (
          team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          next_hub_seq  BIGINT NOT NULL DEFAULT 1
        );

CREATE TABLE sync_push_cursor (
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          node_id     TEXT NOT NULL,
          last_seq    BIGINT NOT NULL,
          updated_at  BIGINT NOT NULL, refused_json TEXT,
          PRIMARY KEY (team_id, node_id)
        );

CREATE TABLE agent_bootstrap_credentials (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          key_hash    TEXT NOT NULL UNIQUE,
          use_kind    TEXT NOT NULL CHECK (use_kind IN ('claim_seat', 'claim_role', 'host', 'legacy')),
          target      TEXT,
          label       TEXT,
          state       TEXT NOT NULL CHECK (state IN ('active', 'rotated', 'revoked')),
          expires_at  BIGINT,
          created_by  TEXT,
          created_at  BIGINT NOT NULL,
          rotated_at  BIGINT,
          revoked_at  BIGINT
        , migration_target_member_id TEXT REFERENCES members(id), first_used_at BIGINT);

CREATE TABLE sync_pull_cursor (
          team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          last_hub_seq  BIGINT NOT NULL,
          updated_at    BIGINT NOT NULL
        );

CREATE TABLE "presence" (
          id            TEXT PRIMARY KEY,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          surface       TEXT NOT NULL CHECK (surface IN
                          ('cli','claude-code','codex','opencode','grok','cursor','web','ios','slack',
                           'other','musterd')),
          status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
          conn_id       TEXT,
          last_seen_at  BIGINT NOT NULL,
          created_at    BIGINT NOT NULL,
          held_until    BIGINT,
          provenance    TEXT,
          workspace     TEXT,
          driver        TEXT,
          model         TEXT,
          build         TEXT,
          epoch         BIGINT,
          wake_lease    TEXT,
          model_source  TEXT
        , node TEXT, guidance_epoch BIGINT);

CREATE TABLE host_liveness (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          host    TEXT NOT NULL,
          seen_at BIGINT NOT NULL, sponsor_id TEXT,
          PRIMARY KEY (team_id, host)
        );

CREATE TABLE "seat_nodes" (
          member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          bound_at  BIGINT NOT NULL,
          PRIMARY KEY (member_id, node_id)
        );

CREATE TABLE "seeds" (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          relay_id TEXT NOT NULL,
          source TEXT NOT NULL,
          body TEXT NOT NULL,
          captured_at BIGINT NOT NULL,
          slack_user_id TEXT,
          submitted_by TEXT NOT NULL REFERENCES members(id),
          state TEXT NOT NULL,
          explorer_id TEXT REFERENCES members(id),
          final_brief TEXT,
          conclusion TEXT,
          linked_lane_id TEXT REFERENCES lanes(id),
          promotion_kind TEXT,
          research_skipped BIGINT,
          promoted_at BIGINT,
          completed_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          UNIQUE(team_id, relay_id)
        );

CREATE TABLE governed_policies (
          team_id    TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          policy     TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );

CREATE TABLE governed_launch_authorizations (
          id                  TEXT PRIMARY KEY,
          team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id           TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          node_id             TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          token_hash          TEXT NOT NULL,
          correlation          TEXT NOT NULL,
          work_context         TEXT NOT NULL,
          issued_by_member_id TEXT REFERENCES members(id),
          created_at           BIGINT NOT NULL,
          expires_at           BIGINT NOT NULL,
          consumed_at         BIGINT,
          revoked_at          BIGINT,
          presence_id         TEXT
        );

CREATE TABLE doorbell_rings (
          id         TEXT PRIMARY KEY,
          team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          act_id     TEXT NOT NULL,
          record     TEXT NOT NULL,
          sinks      TEXT NOT NULL,
          state      TEXT NOT NULL CHECK (state IN ('held','queued','done')),
          host       TEXT,
          created_at BIGINT NOT NULL
        );

CREATE TABLE oauth_clients (
          client_id          TEXT PRIMARY KEY,
          team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          client_name        TEXT NOT NULL,
          redirect_uris      TEXT NOT NULL,
          client_secret_hash TEXT,
          auth_method        TEXT NOT NULL DEFAULT 'none',
          created_at         BIGINT NOT NULL
        );

CREATE TABLE agent_connect_nonces (
          nonce_hash  TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          issued_by  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          created_at  BIGINT NOT NULL,
          expires_at  BIGINT NOT NULL,
          used_at     BIGINT
        );

CREATE TABLE team_invites (
          id           TEXT PRIMARY KEY,
          team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          selector     TEXT NOT NULL,
          secret_hash  TEXT NOT NULL,
          code_mac     TEXT NOT NULL,
          max_uses     BIGINT NOT NULL,
          uses         BIGINT NOT NULL DEFAULT 0,
          fail_budget  BIGINT NOT NULL,
          failures     BIGINT NOT NULL DEFAULT 0,
          expires_at   BIGINT NOT NULL,
          member_until BIGINT,
          created_by   TEXT NOT NULL,
          created_at   BIGINT NOT NULL,
          revoked_at   BIGINT
        );

CREATE TABLE host_provisions (
          id            TEXT PRIMARY KEY,
          team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id     TEXT NOT NULL REFERENCES members(id),
          sponsor_id    TEXT NOT NULL REFERENCES members(id),
          host          TEXT,
          state         TEXT NOT NULL CHECK (state IN ('pending','claimed','ready','failed','cancelled')),
          claimed_by    TEXT,
          claimed_at    BIGINT,
          ready_at      BIGINT,
          first_wake_at BIGINT,
          failed_reason TEXT,
          connect_origin TEXT,
          created_at    BIGINT NOT NULL
        );

CREATE TABLE oauth_client_bindings (
          team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL,
          source    TEXT NOT NULL CHECK (source IN ('dcr', 'cimd')),
          PRIMARY KEY (team_id, client_id)
        );

CREATE TABLE "oauth_codes" (
          code_hash      TEXT PRIMARY KEY,
          team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id      TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          client_id      TEXT NOT NULL,
          redirect_uri   TEXT NOT NULL,
          code_challenge TEXT NOT NULL,
          scope          TEXT,
          created_at     BIGINT NOT NULL,
          expires_at     BIGINT NOT NULL,
          used_at        BIGINT,
          connected_by   TEXT REFERENCES members(id),
          FOREIGN KEY (team_id, client_id)
            REFERENCES oauth_client_bindings(team_id, client_id) ON DELETE CASCADE
        );

CREATE TABLE "oauth_tokens" (
          token_hash  TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          client_id   TEXT NOT NULL,
          chain_id    TEXT NOT NULL,
          scope       TEXT,
          created_at  BIGINT NOT NULL,
          expires_at  BIGINT NOT NULL,
          replaced_at BIGINT,
          revoked_at  BIGINT,
          connected_by TEXT REFERENCES members(id),
          FOREIGN KEY (team_id, client_id)
            REFERENCES oauth_client_bindings(team_id, client_id) ON DELETE CASCADE
        );

CREATE INDEX idx_audit_team_ts ON audit(team_id, ts);

CREATE INDEX idx_grants_team ON grants(team_id);

CREATE INDEX idx_grants_token_hash ON grants(token_hash);

CREATE INDEX idx_requests_team ON requests(team_id, created_at);

CREATE INDEX idx_requests_expiry ON requests(status, expires_at);

CREATE INDEX idx_requests_dedup ON requests(team_id, from_session, target);

CREATE INDEX idx_lanes_team_project ON lanes(team_id, project);

CREATE INDEX idx_lanes_state ON lanes(team_id, state);

CREATE INDEX idx_lanes_goal ON lanes(team_id, goal_id);

CREATE INDEX idx_tool_call_stats_team_bucket ON tool_call_stats(team_id, bucket_start);

CREATE INDEX idx_audit_team_action_ts ON audit(team_id, action, ts);

CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);

CREATE INDEX idx_members_team ON members(team_id);

CREATE INDEX idx_footprint_stacks_ts ON footprint_stacks(ts);

CREATE INDEX idx_wake_turns_lease ON wake_turns(team_id, lease_id, turn);

CREATE UNIQUE INDEX idx_members_team_slack_user
          ON members(team_id, slack_user_id) WHERE slack_user_id IS NOT NULL;

CREATE INDEX idx_incident_reports_team_gate ON incident_reports(team_id, gate);

END;

END;

CREATE INDEX idx_nodes_team ON nodes(team_id);

CREATE INDEX idx_node_invites_team ON node_invites(team_id);

CREATE UNIQUE INDEX idx_node_invites_code ON node_invites(code_hash);

CREATE UNIQUE INDEX idx_sync_log_origin ON sync_log(origin_node, origin_seq);

CREATE UNIQUE INDEX idx_sync_log_hub ON sync_log(team_id, hub_seq);

CREATE UNIQUE INDEX idx_sync_log_origin_id ON sync_log(origin_node, id);

CREATE INDEX idx_agent_bootstrap_credentials_lookup
          ON agent_bootstrap_credentials(team_id, key_hash, state, expires_at);

CREATE INDEX idx_bootstrap_migration_target
        ON agent_bootstrap_credentials(
          team_id,
          migration_target_member_id,
          state,
          first_used_at
        );

CREATE INDEX idx_presence_member ON presence(member_id);

CREATE INDEX idx_presence_last_seen ON presence(last_seen_at);

CREATE UNIQUE INDEX idx_audit_origin ON audit(origin_node, origin_seq) WHERE origin_seq > 0;

CREATE INDEX idx_presence_node ON presence(node);

CREATE INDEX idx_seat_nodes_node ON seat_nodes(node_id);

CREATE INDEX idx_seeds_team_state ON seeds(team_id, state, updated_at);

CREATE INDEX idx_governed_launch_token
          ON governed_launch_authorizations(team_id, token_hash);

CREATE INDEX idx_governed_launch_member
          ON governed_launch_authorizations(team_id, member_id, created_at);

CREATE INDEX idx_governed_launch_correlation
          ON governed_launch_authorizations(team_id, correlation);

CREATE INDEX idx_doorbell_rings_state ON doorbell_rings(team_id, state);

CREATE INDEX idx_doorbell_rings_held ON doorbell_rings(member_id) WHERE state = 'held';

CREATE INDEX idx_doorbell_rings_age ON doorbell_rings(state, created_at);

CREATE INDEX idx_oauth_clients_team ON oauth_clients(team_id);

CREATE INDEX idx_agent_connect_nonces_member ON agent_connect_nonces(member_id);

CREATE INDEX idx_team_invites_team ON team_invites(team_id, selector);

CREATE INDEX idx_host_provisions_team_state ON host_provisions(team_id, state);

CREATE INDEX idx_host_provisions_member ON host_provisions(member_id);

CREATE INDEX idx_oauth_codes_team ON oauth_codes(team_id);

CREATE INDEX idx_oauth_tokens_member ON oauth_tokens(team_id, member_id, revoked_at);

CREATE INDEX idx_oauth_tokens_chain ON oauth_tokens(chain_id);

CREATE TABLE inbox_cursors (
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_message_id TEXT,
  last_read_ts BIGINT NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (member_id)
);

CREATE TABLE seat_memory (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        headline  TEXT NOT NULL,
        body      TEXT NOT NULL,
        saved_at  BIGINT NOT NULL
      );

CREATE TABLE "messages" (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          from_member TEXT NOT NULL REFERENCES members(id),
          to_kind     TEXT NOT NULL CHECK (to_kind IN ('member','team','broadcast')),
          to_member   TEXT REFERENCES members(id),
          act         TEXT NOT NULL,
          body        TEXT NOT NULL DEFAULT '',
          thread_id   TEXT,
          meta        TEXT,
          ts          BIGINT NOT NULL,
          created_at  BIGINT NOT NULL
        , from_provenance TEXT, origin_node TEXT NOT NULL DEFAULT '', origin_seq BIGINT NOT NULL DEFAULT 0, in_reply_to TEXT GENERATED ALWAYS AS ((meta::jsonb ->> 'in_reply_to')) STORED);

CREATE TABLE residency (
          id            TEXT PRIMARY KEY,
          team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          harness       TEXT NOT NULL,
          host          TEXT NOT NULL,
          grant_id      TEXT,
          authorized_by TEXT,
          policy        TEXT,
          created_at    BIGINT NOT NULL,
          updated_at    BIGINT NOT NULL
        , resumable_harness TEXT, resumable_at BIGINT);

CREATE TABLE "wake_leases" (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          act_id      TEXT,
          lane_id     TEXT,
          host        TEXT NOT NULL,
          lane        TEXT NOT NULL CHECK (lane IN ('immediate','batched')),
          status      TEXT NOT NULL DEFAULT 'leased' CHECK (status IN ('leased','reported','expired')),
          created_at  BIGINT NOT NULL,
          expires_at  BIGINT NOT NULL
        , edge TEXT, spawned_at BIGINT);

CREATE TABLE seed_thread_entries (
          id TEXT PRIMARY KEY,
          seed_id TEXT NOT NULL REFERENCES seeds(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          member_id TEXT NOT NULL REFERENCES members(id),
          created_at BIGINT NOT NULL
        );

CREATE TABLE session_leases (
          id          TEXT PRIMARY KEY,
          team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          presence_id TEXT NOT NULL REFERENCES presence(id) ON DELETE CASCADE,
          token_hash  TEXT NOT NULL UNIQUE,
          expires_at  BIGINT NOT NULL,
          revoked_at  BIGINT,
          created_at  BIGINT NOT NULL
        );

CREATE INDEX idx_messages_team_ts ON messages(team_id, ts);

CREATE INDEX idx_messages_thread ON messages(thread_id);

CREATE INDEX idx_messages_to_member ON messages(to_member);

CREATE UNIQUE INDEX idx_residency_member ON residency(member_id);

CREATE INDEX idx_residency_team ON residency(team_id);

CREATE INDEX idx_wake_leases_member ON wake_leases(member_id, status);

CREATE INDEX idx_wake_leases_team ON wake_leases(team_id, status);

CREATE INDEX idx_wake_leases_edge ON wake_leases(team_id, lane_id, edge);

CREATE INDEX idx_seed_thread_entries_seed ON seed_thread_entries(seed_id, created_at);

CREATE FUNCTION insights_fts_ins_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.act = 'insight' THEN
    INSERT INTO insights_fts (message_id, team_id, headline, body, tags)
    VALUES (NEW.id, NEW.team_id, COALESCE(NEW.meta::jsonb ->> 'headline', ''), NEW.body, COALESCE(NEW.meta::jsonb ->> 'tags', ''));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER insights_fts_ins AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION insights_fts_ins_fn();

CREATE FUNCTION insights_fts_del_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.act = 'insight' THEN DELETE FROM insights_fts WHERE message_id = OLD.id; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER insights_fts_del AFTER DELETE ON messages FOR EACH ROW EXECUTE FUNCTION insights_fts_del_fn();

CREATE INDEX idx_session_leases_lookup
          ON session_leases(team_id, member_id, presence_id, expires_at);

CREATE INDEX idx_messages_team_created ON messages(team_id, created_at);

CREATE UNIQUE INDEX idx_messages_origin ON messages(origin_node, origin_seq);

CREATE INDEX idx_messages_in_reply_to ON messages(team_id, in_reply_to);

CREATE INDEX idx_messages_from_reply ON messages(team_id, from_member, in_reply_to);

CREATE INDEX idx_messages_thread_from ON messages(team_id, thread_id, from_member, created_at);

CREATE INDEX idx_messages_thread_act ON messages(team_id, act, thread_id);

CREATE INDEX idx_messages_from_act_ts ON messages(from_member, act, ts, id);

-- Privileges. The app and operator roles own nothing; they read and write through grants, and
-- tables the ladder adds later inherit them through the default privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO musterd_app, musterd_operator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO musterd_app, musterd_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO musterd_app, musterd_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO musterd_app, musterd_operator;
