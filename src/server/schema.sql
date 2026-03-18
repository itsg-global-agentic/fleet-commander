-- =============================================================================
-- Fleet Commander — SQLite Schema (v2, with projects entity)
-- =============================================================================

-- Schema version tracking for migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- PROJECTS — a local git repository managed by Fleet Commander
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,                      -- user-friendly, e.g. "my-project"
  repo_path       TEXT NOT NULL UNIQUE,               -- absolute path, e.g. "C:/Git/my-project"
  github_repo     TEXT,                               -- e.g. "org/my-project"
  status          TEXT NOT NULL DEFAULT 'active',     -- active | paused | archived
  hooks_installed INTEGER NOT NULL DEFAULT 0,         -- 0 | 1
  max_active_teams INTEGER NOT NULL DEFAULT 5,        -- max concurrent active teams before queueing
  prompt_file     TEXT,                               -- relative path to launch prompt .md file
  model           TEXT,                               -- Claude model override e.g. "opus", "sonnet", "claude-opus-4-6"
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ---------------------------------------------------------------------------
-- TEAMS — a Claude Code worktree session working on an issue
-- ---------------------------------------------------------------------------
-- Lifecycle: queued -> launching -> running -> idle (5min) -> stuck (15min) -> done/failed
CREATE TABLE IF NOT EXISTS teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number    INTEGER NOT NULL,
  issue_title     TEXT,
  project_id      INTEGER REFERENCES projects(id),
  worktree_name   TEXT NOT NULL UNIQUE,           -- e.g. "my-project-763"
  branch_name     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued|launching|running|idle|stuck|done|failed
  phase           TEXT NOT NULL DEFAULT 'init',   -- init|analyzing|implementing|reviewing|pr|done|blocked
  pid             INTEGER,
  session_id      TEXT,
  pr_number       INTEGER,
  launched_at     TEXT,
  stopped_at      TEXT,
  last_event_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);
CREATE INDEX IF NOT EXISTS idx_teams_issue ON teams(issue_number);
CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_id);

-- ---------------------------------------------------------------------------
-- PULL REQUESTS — associated with teams, tracked through CI lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pull_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number       INTEGER NOT NULL UNIQUE,
  team_id         INTEGER REFERENCES teams(id),
  title           TEXT,
  state           TEXT,                           -- OPEN|MERGED|CLOSED|draft
  ci_status       TEXT,                           -- none|pending|passing|failing
  merge_state     TEXT,                           -- unknown|clean|behind|blocked|dirty
  auto_merge      INTEGER NOT NULL DEFAULT 0,     -- 0|1
  ci_fail_count   INTEGER NOT NULL DEFAULT 0,     -- unique failure types; >= 3 means blocked
  checks_json     TEXT,                           -- JSON array: [{name, status, conclusion}]
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at       TEXT
);

-- ---------------------------------------------------------------------------
-- EVENTS — hook events from Claude Code sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  session_id      TEXT,
  agent_name      TEXT,
  event_type      TEXT NOT NULL,                  -- session_start|session_end|stop|subagent_start|subagent_stop|notification|tool_use|tool_error|pre_compact
  tool_name       TEXT,
  payload         TEXT,                           -- JSON blob
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- ---------------------------------------------------------------------------
-- COMMANDS — messages sent to running teams (PM -> agent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  target_agent    TEXT,                           -- null = team-level, or specific agent name
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT
);

-- ---------------------------------------------------------------------------
-- VIEW: Dashboard overview (one row per team)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_team_dashboard;
CREATE VIEW IF NOT EXISTS v_team_dashboard AS
SELECT
  t.id,
  t.issue_number,
  t.issue_title,
  t.project_id,
  p.name AS project_name,
  p.model AS model,
  t.status,
  t.phase,
  t.worktree_name,
  t.branch_name,
  t.pr_number,
  t.launched_at,
  t.last_event_at,
  ROUND((julianday('now') - julianday(t.launched_at)) * 24 * 60, 0) AS duration_min,
  ROUND((julianday('now') - julianday(t.last_event_at)) * 24 * 60, 1) AS idle_min,
  COALESCE(u.total_cost, 0) AS total_cost,
  COALESCE(u.session_count, 0) AS session_count,
  pr.state AS pr_state,
  pr.ci_status,
  pr.merge_state AS merge_status,
  t.created_at,
  t.updated_at
FROM teams t
LEFT JOIN projects p ON p.id = t.project_id
LEFT JOIN pull_requests pr ON pr.team_id = t.id
LEFT JOIN (
  SELECT
    team_id,
    ROUND(SUM(COALESCE(json_extract(raw_output, '$.total_cost_usd'), 0)), 4) AS total_cost,
    COUNT(*) AS session_count
  FROM usage_snapshots
  WHERE raw_output IS NOT NULL AND json_extract(raw_output, '$.total_cost_usd') IS NOT NULL
  GROUP BY team_id
) u ON u.team_id = t.id;

-- ---------------------------------------------------------------------------
-- USAGE SNAPSHOTS — usage percentage tracking (replaces cost tracking)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER,
  project_id      INTEGER,
  session_id      TEXT,
  daily_percent   REAL DEFAULT 0,
  weekly_percent  REAL DEFAULT 0,
  sonnet_percent  REAL DEFAULT 0,
  extra_percent   REAL DEFAULT 0,
  raw_output      TEXT,
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_snapshots(recorded_at);

-- ---------------------------------------------------------------------------
-- MESSAGE TEMPLATES — editable notification templates for state transitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_templates (
  id          TEXT PRIMARY KEY,              -- transition ID e.g. 'ci_green', 'pr_merged'
  template    TEXT NOT NULL,                 -- message template with {{PLACEHOLDERS}}
  enabled     INTEGER NOT NULL DEFAULT 1,   -- 0=don't send, 1=send
  description TEXT,                          -- human-readable purpose
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed default templates (INSERT OR IGNORE so user edits survive server restarts)
INSERT OR IGNORE INTO message_templates (id, template, description) VALUES
  ('ci_green',
   'CI passed on PR #{{PR_NUMBER}}, all checks green. Auto-merge is {{AUTO_MERGE_STATUS}}.',
   'Tell TL that CI passed on the PR');
INSERT OR IGNORE INTO message_templates (id, template, description) VALUES
  ('ci_red',
   'CI failed on PR #{{PR_NUMBER}}. Failing checks: {{FAILED_CHECKS}}. Fix count: {{FAIL_COUNT}}/{{MAX_FAILURES}}. What went wrong?',
   'Tell TL that CI failed and ask what went wrong');
INSERT OR IGNORE INTO message_templates (id, template, description) VALUES
  ('pr_merged',
   'PR #{{PR_NUMBER}} merged. Close the issue, clean up, and finish.',
   'Tell TL the PR merged and to wrap up');
INSERT OR IGNORE INTO message_templates (id, template, description) VALUES
  ('ci_blocked',
   'STOP. {{FAIL_COUNT}} unique CI failure types on PR #{{PR_NUMBER}}. Wait for my instructions.',
   'Tell TL the team is blocked due to repeated CI failures');
INSERT OR IGNORE INTO message_templates (id, template, description) VALUES
  ('stuck_nudge',
   'Hey, you have been idle for a while on issue #{{ISSUE_NUMBER}}. What is the status? Do you need help?',
   'Nudge sent to TL when team transitions to stuck');

-- ---------------------------------------------------------------------------
-- TEAM TRANSITIONS — state machine transition history per team
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  trigger         TEXT,                             -- 'hook' | 'timer' | 'poller' | 'pm_action' | 'system'
  reason          TEXT,                             -- human-readable reason
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_team_transitions_team ON team_transitions(team_id);

-- Insert schema version 2 (or upgrade from 1)
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
