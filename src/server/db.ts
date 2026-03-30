// =============================================================================
// Fleet Commander — SQLite Database Layer (better-sqlite3, WAL mode)
// =============================================================================

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  Team,
  PullRequest,
  PRState,
  CIStatus,
  MergeStatus,
  Event,
  Command,
  UsageSnapshot,
  TeamDashboardRow,
  TeamStatus,
  TeamPhase,
  Project,
  ProjectGroup,
  ProjectSummary,
  ProjectStatus,
  ProjectIssueSource,
  MessageTemplate,
  TeamTransition,
  TeamMember,
  AgentMessage,
  MessageEdge,
  TeamTask,
} from '../shared/types.js';
import { encrypt, decrypt, isEncrypted, decryptWithKey } from './utils/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// UTC timestamp helper
// ---------------------------------------------------------------------------

/**
 * Convert a SQLite datetime string to ISO 8601 UTC format.
 *
 * SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` which JS Date
 * parses as *local* time. This helper appends 'T' and 'Z' so it is correctly
 * interpreted as UTC. Already-valid ISO strings (containing 'T') pass through
 * unchanged. Returns null unchanged for nullable columns.
 */
export function utcify(value: string): string;
export function utcify(value: string | null): string | null;
export function utcify(value: string | null): string | null {
  if (value == null) return null;
  // Already ISO 8601 (has 'T') — pass through unchanged
  if (value.includes('T')) return value;
  // SQLite format: "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS.000Z"
  return value.replace(' ', 'T') + '.000Z';
}

// ---------------------------------------------------------------------------
// Agent name -> role mapping
// ---------------------------------------------------------------------------

const ROLE_MAP: Record<string, string> = {
  coordinator: 'Coordinator',
  analyst: 'Analyst',
  planner: 'Planner',
  reviewer: 'Reviewer',
  'team-lead': 'Team Lead',
  tl: 'Team Lead',
  dev: 'Developer',
};

/** Derive a human-readable role from the agent name. */
function deriveRole(name: string): string {
  const lower = name.toLowerCase();
  // Strip fleet- prefix for role lookup (backward compat with un-normalized data)
  const stripped = lower.startsWith('fleet-') ? lower.slice(6) : lower;
  if (ROLE_MAP[stripped]) return ROLE_MAP[stripped];
  if (stripped.startsWith('dev-')) return `Developer (${name.replace(/^fleet-/i, '').slice(4)})`;
  if (stripped.includes('dev')) return 'Developer';
  return name;
}

// ---------------------------------------------------------------------------
// Filter / input types
// ---------------------------------------------------------------------------

export interface TeamFilter {
  status?: TeamStatus;
  issueNumber?: number;
  issueKey?: string;
  projectId?: number;
  limit?: number;
  offset?: number;
}

export interface EventFilter {
  teamId?: number;
  eventType?: string;
  since?: string;     // ISO 8601
  limit?: number;
  offset?: number;
}

export interface TeamInsert {
  issueNumber: number;
  issueTitle?: string | null;
  issueKey?: string | null;
  issueProvider?: string | null;
  projectId?: number | null;
  worktreeName: string;
  branchName?: string | null;
  status?: TeamStatus;
  phase?: TeamPhase;
  pid?: number | null;
  sessionId?: string | null;
  prNumber?: number | null;
  customPrompt?: string | null;
  headless?: boolean;
  blockedByJson?: string | null;
  launchedAt?: string | null;
}

export interface TeamUpdate {
  issueTitle?: string | null;
  branchName?: string | null;
  status?: TeamStatus;
  phase?: TeamPhase;
  pid?: number | null;
  sessionId?: string | null;
  prNumber?: number | null;
  customPrompt?: string | null;
  headless?: boolean;
  blockedByJson?: string | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalCostUsd?: number;
  retryCount?: number;
  launchedAt?: string | null;
  stoppedAt?: string | null;
  lastEventAt?: string | null;
}

export interface EventInsert {
  teamId: number;
  sessionId?: string | null;
  agentName?: string | null;
  eventType: string;
  toolName?: string | null;
  payload?: string | null;
}

export interface PRInsert {
  prNumber: number;
  teamId?: number | null;
  title?: string | null;
  state?: PRState | null;
  ciStatus?: CIStatus | null;
  mergeStatus?: MergeStatus | null;
  autoMerge?: boolean;
  ciFailCount?: number;
  checksJson?: string | null;
}

export interface PRUpdate {
  teamId?: number | null;
  title?: string | null;
  state?: PRState | null;
  ciStatus?: CIStatus | null;
  mergeStatus?: MergeStatus | null;
  autoMerge?: boolean;
  ciFailCount?: number;
  checksJson?: string | null;
  mergedAt?: string | null;
}

export interface CommandInsert {
  teamId: number;
  targetAgent?: string | null;
  message: string;
}

export interface UsageInsert {
  teamId?: number;
  projectId?: number;
  sessionId?: string;
  dailyPercent?: number;
  weeklyPercent?: number;
  sonnetPercent?: number;
  extraPercent?: number;
  dailyResetsAt?: string;
  weeklyResetsAt?: string;
  rawOutput?: string;
}

export interface StuckCandidate {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  worktreeName: string;
  status: TeamStatus;
  phase: TeamPhase;
  lastEventAt: string | null;
  minutesSinceLastEvent: number;
}

// ---------------------------------------------------------------------------
// Project input types
// ---------------------------------------------------------------------------

export interface ProjectInsert {
  name: string;
  repoPath: string;
  githubRepo?: string | null;
  groupId?: number | null;
  maxActiveTeams?: number;
  promptFile?: string | null;
  model?: string | null;
  issueProvider?: string | null;
  projectKey?: string | null;
  providerConfig?: string | null;
}

export interface ProjectUpdate {
  name?: string;
  githubRepo?: string | null;
  groupId?: number | null;
  status?: ProjectStatus;
  hooksInstalled?: boolean;
  maxActiveTeams?: number;
  promptFile?: string | null;
  model?: string | null;
  issueProvider?: string | null;
  projectKey?: string | null;
  providerConfig?: string | null;
}

export interface ProjectGroupInsert {
  name: string;
  description?: string | null;
}

export interface ProjectGroupUpdate {
  name?: string;
  description?: string | null;
}

export interface ProjectIssueSourceInsert {
  projectId: number;
  provider: string;
  label?: string | null;
  configJson: string;
  credentialsJson?: string | null;
  enabled?: boolean;
}

export interface ProjectIssueSourceUpdate {
  label?: string | null;
  configJson?: string;
  credentialsJson?: string | null;
  enabled?: boolean;
}

export interface ProjectFilter {
  status?: ProjectStatus;
}

export interface AgentMessageInsert {
  teamId: number;
  eventId: number;
  sender: string;
  recipient: string;
  summary?: string | null;
  content?: string | null;
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class FleetDatabase {
  private db: Database.Database;
  private stmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Performance pragmas
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  // -------------------------------------------------------------------------
  // Prepared statement cache
  // -------------------------------------------------------------------------

  /**
   * Get a cached prepared statement for a static SQL string.
   * Avoids re-parsing the same SQL on every call. Only use with constant
   * SQL strings — dynamic SQL (variable SET clauses) must use db.prepare()
   * directly.
   */
  private stmt(sql: string): Database.Statement {
    let cached = this.stmtCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.stmtCache.set(sql, cached);
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  /**
   * Read and execute schema.sql to create all tables, indexes, and views.
   * Idempotent — uses IF NOT EXISTS throughout.
   * Also runs migrations for existing v1 databases.
   */
  initSchema(): void {
    // Check if this is an existing v1 database that needs migration
    const needsMigration = this.needsV2Migration();

    if (needsMigration) {
      this.migrateToV2();
    }

    // Add max_active_teams column if missing (for existing v2 databases)
    this.addMaxActiveTeamsColumn();

    // Add prompt_file column if missing (for existing databases)
    this.addPromptFileColumn();

    // Add message_templates table if missing (for existing databases)
    this.addMessageTemplatesTable();

    // Add team_transitions table if missing (for existing databases)
    this.addTeamTransitionsTable();

    // Add model column to projects if missing (for existing databases)
    this.addModelColumn();

    // Add custom_prompt column to teams if missing (for existing databases)
    this.addCustomPromptColumn();

    // Add headless column to teams if missing (for existing databases, v3 migration)
    this.addHeadlessColumn();

    // Add daily_resets_at and weekly_resets_at columns to usage_snapshots if missing
    this.addUsageResetsAtColumns();

    // Add token/cost tracking columns to teams if missing
    this.addTokenTrackingColumns();

    // Rename merge_state -> merge_status in pull_requests (for existing databases)
    this.renameMergeStateColumn();

    // Add project_groups table and group_id column to projects if missing
    this.addProjectGroupsTable();
    this.addGroupIdColumn();

    // Add agent_messages table if missing (v5 migration)
    this.addAgentMessagesTable();

    // Add stream_events table if missing (v6 migration — persist session log)
    this.addStreamEventsTable();

    // Add blocked_by_json column to teams if missing (v7 migration)
    this.addBlockedByJsonColumn();

    // Add UNIQUE constraint on teams(project_id, issue_number) (v8 migration)
    this.addTeamProjectIssueUniqueIndex();

    // Add team_tasks table if missing (v9 migration — TaskCreated hook)
    this.addTeamTasksTable();

    // Add issue provider columns to projects and teams (v10 migration)
    this.addIssueProviderColumns();

    // Update v_team_dashboard view to include issue_key/issue_provider (v11 migration)
    this.migrateToV11();

    // Encrypt existing plaintext provider_config values (v12 migration)
    this.migrateProviderConfigEncryption();

    // Add project_issue_sources table and backfill from projects (v13 migration)
    this.addProjectIssueSourcesTable();

    // Add provider_state table if missing (for persisting provider runtime state)
    this.addProviderStateTable();

    // Add retry_count column to teams if missing (v14 migration — auto-retry)
    this.addRetryCountColumn();

    // Migrate any 'paused' projects to 'active' (paused status removed in #228)
    this.migratePausedProjects();

    // Resolve schema.sql relative to this file.
    // In dev (tsx): __dirname is src/server
    // In compiled (node): __dirname is dist/server/server
    let schemaPath = path.join(__dirname, 'schema.sql');

    if (!fs.existsSync(schemaPath)) {
      // Try one level up (dist/server/schema.sql when rootDir = src)
      schemaPath = path.join(__dirname, '..', 'schema.sql');
    }

    if (!fs.existsSync(schemaPath)) {
      // Try the source location directly
      schemaPath = path.join(process.cwd(), 'src', 'server', 'schema.sql');
    }

    if (!fs.existsSync(schemaPath)) {
      throw new Error(
        `schema.sql not found. Searched:\n` +
        `  - ${path.join(__dirname, 'schema.sql')}\n` +
        `  - ${path.join(__dirname, '..', 'schema.sql')}\n` +
        `  - ${path.join(process.cwd(), 'src', 'server', 'schema.sql')}`
      );
    }

    const sql = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(sql);
  }

  /**
   * Check if a v1 database exists that needs migration to v2.
   */
  private needsV2Migration(): boolean {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) AS version FROM schema_version'
      ).get() as { version: number } | undefined;
      const version = row?.version ?? 0;
      return version === 1;
    } catch {
      // schema_version table doesn't exist yet — fresh database
      return false;
    }
  }

  /**
   * Migrate an existing v1 database to v2 (add projects table, project_id to teams).
   */
  private migrateToV2(): void {
    // DDL is auto-committed in SQLite, so run statements sequentially
    // without a transaction wrapper (db.exec inside db.transaction can throw).

    // Add projects table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        repo_path       TEXT NOT NULL UNIQUE,
        github_repo     TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        hooks_installed INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    `);

    // Add project_id column to teams if it doesn't exist
    const cols = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'project_id')) {
      this.db.exec('ALTER TABLE teams ADD COLUMN project_id INTEGER REFERENCES projects(id)');
    }

    // Add index on project_id
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_id)');

    // Drop and recreate the view to include project info
    this.db.exec('DROP VIEW IF EXISTS v_team_dashboard');

    // Insert version 2
    this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (2)');
  }

  /**
   * Add max_active_teams column to projects table if it doesn't exist.
   * Handles upgrade of existing databases that lack this column.
   */
  private addMaxActiveTeamsColumn(): void {
    try {
      // Check if column exists by querying table info
      const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'max_active_teams');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE projects ADD COLUMN max_active_teams INTEGER NOT NULL DEFAULT 5');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add prompt_file column to projects table if it doesn't exist.
   * Handles upgrade of existing databases that lack this column.
   */
  private addPromptFileColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'prompt_file');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE projects ADD COLUMN prompt_file TEXT');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add message_templates table if it doesn't exist.
   * Handles upgrade of existing databases that lack this table.
   */
  private addMessageTemplatesTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS message_templates (
          id          TEXT PRIMARY KEY,
          template    TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          description TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    } catch {
      // Table creation failed — schema.sql will handle it
    }
  }

  /**
   * Add team_transitions table if it doesn't exist.
   * Handles upgrade of existing databases that lack this table.
   */
  private addTeamTransitionsTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS team_transitions (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id         INTEGER NOT NULL REFERENCES teams(id),
          from_status     TEXT NOT NULL,
          to_status       TEXT NOT NULL,
          trigger         TEXT,
          reason          TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_team_transitions_team ON team_transitions(team_id);
      `);
    } catch {
      // Table creation failed — schema.sql will handle it
    }
  }

  /**
   * Add model column to projects table if it doesn't exist.
   * Handles upgrade of existing databases that lack this column.
   */
  private addModelColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'model');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE projects ADD COLUMN model TEXT');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  private addCustomPromptColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'custom_prompt');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE teams ADD COLUMN custom_prompt TEXT');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  private addHeadlessColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'headless');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE teams ADD COLUMN headless INTEGER NOT NULL DEFAULT 1');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add daily_resets_at and weekly_resets_at columns to usage_snapshots if missing.
   */
  private addUsageResetsAtColumns(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'daily_resets_at')) {
        this.db.exec('ALTER TABLE usage_snapshots ADD COLUMN daily_resets_at TEXT');
      }
      if (!columns.some((c) => c.name === 'weekly_resets_at')) {
        this.db.exec('ALTER TABLE usage_snapshots ADD COLUMN weekly_resets_at TEXT');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add token/cost tracking columns to teams table if missing.
   */
  private addTokenTrackingColumns(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'total_input_tokens')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN total_input_tokens INTEGER DEFAULT 0');
      }
      if (!columns.some((c) => c.name === 'total_output_tokens')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN total_output_tokens INTEGER DEFAULT 0');
      }
      if (!columns.some((c) => c.name === 'total_cache_creation_tokens')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN total_cache_creation_tokens INTEGER DEFAULT 0');
      }
      if (!columns.some((c) => c.name === 'total_cache_read_tokens')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN total_cache_read_tokens INTEGER DEFAULT 0');
      }
      if (!columns.some((c) => c.name === 'total_cost_usd')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN total_cost_usd REAL DEFAULT 0');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  private renameMergeStateColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(pull_requests)").all() as Array<{ name: string }>;
      if (columns.some((c) => c.name === 'merge_state')) {
        this.db.exec('ALTER TABLE pull_requests RENAME COLUMN merge_state TO merge_status');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  private addProjectGroupsTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_groups (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL UNIQUE,
          description     TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    } catch {
      // Table may already exist — safe to ignore
    }
  }

  private addGroupIdColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'group_id')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN group_id INTEGER REFERENCES project_groups(id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id)');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  private addAgentMessagesTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id         INTEGER NOT NULL REFERENCES teams(id),
          event_id        INTEGER REFERENCES events(id),
          sender          TEXT NOT NULL,
          recipient       TEXT NOT NULL,
          summary         TEXT,
          content         TEXT,
          session_id      TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_messages_team ON agent_messages(team_id);
      `);
    } catch {
      // Table may already exist — safe to ignore
    }
  }

  private addStreamEventsTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stream_events (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id         INTEGER NOT NULL UNIQUE REFERENCES teams(id),
          event_data      TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    } catch {
      // Table may already exist — safe to ignore
    }
  }

  /**
   * Add blocked_by_json column to teams table if it doesn't exist.
   * Stores a JSON array of blocking issue numbers for queued teams.
   * v7 migration.
   */
  private addBlockedByJsonColumn(): void {
    try {
      const columns = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      const hasColumn = columns.some((c) => c.name === 'blocked_by_json');
      if (!hasColumn) {
        this.db.exec('ALTER TABLE teams ADD COLUMN blocked_by_json TEXT');
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add UNIQUE index on teams(project_id, issue_number) to prevent race conditions.
   * Deduplicates any existing rows first by keeping only the most recent (highest id).
   * v8 migration.
   */
  private addTeamProjectIssueUniqueIndex(): void {
    try {
      // Check if the index already exists
      const indexes = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_teams_project_issue'"
      ).all();
      if (indexes.length > 0) return;

      // Delete duplicate (project_id, issue_number) rows, keeping the one with the highest id.
      // Only targets rows where project_id IS NOT NULL (SQLite treats NULLs as unique).
      this.db.exec(`
        DELETE FROM teams
        WHERE project_id IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id)
            FROM teams
            WHERE project_id IS NOT NULL
            GROUP BY project_id, issue_number
          )
      `);

      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_project_issue ON teams(project_id, issue_number)'
      );

      this.db.exec("INSERT OR IGNORE INTO schema_version (version) VALUES (8)");
      console.log('[DB] v8 migration: added UNIQUE index on teams(project_id, issue_number)');
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Add team_tasks table if it doesn't exist.
   * v9 migration — stores task items from TaskCreated hook / TodoWrite.
   */
  private addTeamTasksTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS team_tasks (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id         INTEGER NOT NULL REFERENCES teams(id),
          task_id         TEXT NOT NULL,
          subject         TEXT NOT NULL,
          description     TEXT,
          status          TEXT NOT NULL DEFAULT 'pending',
          owner           TEXT NOT NULL DEFAULT 'team-lead',
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_team_tasks_team_task ON team_tasks(team_id, task_id);
        CREATE INDEX IF NOT EXISTS idx_team_tasks_team ON team_tasks(team_id);
      `);
    } catch {
      // Table may already exist — safe to ignore
    }
  }

  /**
   * Add issue provider columns to projects and teams tables.
   * v10 migration — supports multi-provider issue tracking.
   */
  private addIssueProviderColumns(): void {
    try {
      // Check if projects table needs migration
      const projectCols = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      if (!projectCols.some(c => c.name === 'issue_provider')) {
        this.db.exec("ALTER TABLE projects ADD COLUMN issue_provider TEXT DEFAULT 'github'");
        this.db.exec('ALTER TABLE projects ADD COLUMN project_key TEXT');
        this.db.exec('ALTER TABLE projects ADD COLUMN provider_config TEXT');
      }

      // Check if teams table needs migration
      const teamCols = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      if (!teamCols.some(c => c.name === 'issue_key')) {
        this.db.exec('ALTER TABLE teams ADD COLUMN issue_key TEXT');
        this.db.exec("ALTER TABLE teams ADD COLUMN issue_provider TEXT DEFAULT 'github'");

        // Backfill issue_key from issue_number for existing rows
        this.db.exec("UPDATE teams SET issue_key = CAST(issue_number AS TEXT) WHERE issue_key IS NULL");
      }

      // Insert schema version 10
      this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (10)');
    } catch {
      // Tables may not exist yet (fresh database) — schema.sql will create them
    }
  }

  /**
   * v11 migration: Recreate v_team_dashboard view to include issue_key,
   * issue_provider, and project_issue_provider columns.
   * Also adds UNIQUE index on (project_id, issue_key).
   */
  private migrateToV11(): void {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) AS version FROM schema_version'
      ).get() as { version: number } | undefined;
      const version = row?.version ?? 0;
      if (version >= 11) return; // Already migrated

      // Recreate the view (will be done again by schema.sql, but ensure order)
      this.db.exec('DROP VIEW IF EXISTS v_team_dashboard');

      // Drop the old UNIQUE index on (project_id, issue_number) — non-numeric
      // issue keys (e.g. Jira PROJ-123) all map to issueNumber=0, which would
      // violate the UNIQUE constraint. The new idx_teams_project_issue_key index
      // (on issue_key) replaces its purpose.
      this.db.exec('DROP INDEX IF EXISTS idx_teams_project_issue');

      // Add UNIQUE index on (project_id, issue_key) for non-numeric key support
      // First, check if issue_key column exists (it should from v10)
      const teamCols = this.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
      if (teamCols.some(c => c.name === 'issue_key')) {
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_project_issue_key ON teams(project_id, issue_key)');
      }

      this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (11)');
      console.log('[DB] Migrated to v11: v_team_dashboard view updated with issue_key/issue_provider');
    } catch {
      // Tables may not exist yet (fresh database) — schema.sql will create them
    }
  }

  /**
   * v12 migration: Encrypt existing plaintext provider_config values and
   * handle key rotation when FLEET_ENCRYPTION_KEY_OLD is set.
   *
   * On first run after upgrade: plaintext values are detected (not matching
   * encrypted format) and encrypted with the current key.
   *
   * On key rotation: if FLEET_ENCRYPTION_KEY_OLD is set, encrypted values are
   * decrypted with the old key and re-encrypted with the new key.
   */
  private migrateProviderConfigEncryption(): void {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) AS version FROM schema_version'
      ).get() as { version: number } | undefined;
      const version = row?.version ?? 0;

      const oldKeyHex = process.env['FLEET_ENCRYPTION_KEY_OLD'] || null;

      // If already at v12 and no key rotation needed, skip
      if (version >= 12 && !oldKeyHex) return;

      const rows = this.db.prepare(
        'SELECT id, provider_config FROM projects WHERE provider_config IS NOT NULL'
      ).all() as Array<{ id: number; provider_config: string }>;

      if (rows.length === 0) {
        if (version < 12) {
          this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (12)');
        }
        return;
      }

      // Handle key rotation (old key -> new key)
      if (oldKeyHex) {
        if (!/^[0-9a-fA-F]{64}$/.test(oldKeyHex)) {
          console.warn('[DB] FLEET_ENCRYPTION_KEY_OLD is not valid 64-char hex — skipping key rotation');
        } else {
          const oldKey = Buffer.from(oldKeyHex, 'hex');
          let rotated = 0;
          for (const r of rows) {
            if (isEncrypted(r.provider_config)) {
              try {
                const plaintext = decryptWithKey(r.provider_config, oldKey);
                const newCiphertext = encrypt(plaintext);
                this.db.prepare(
                  "UPDATE projects SET provider_config = ?, updated_at = datetime('now') WHERE id = ?"
                ).run(newCiphertext, r.id);
                rotated++;
              } catch (err) {
                console.warn(
                  `[DB] Key rotation failed for project ${r.id}: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
          }
          if (rotated > 0) {
            console.log(`[DB] Key rotation: re-encrypted ${rotated} provider_config value(s)`);
          }
        }
      }

      // Encrypt any remaining plaintext values (first-time migration)
      let encrypted = 0;
      // Re-read rows after potential key rotation
      const currentRows = this.db.prepare(
        'SELECT id, provider_config FROM projects WHERE provider_config IS NOT NULL'
      ).all() as Array<{ id: number; provider_config: string }>;

      for (const r of currentRows) {
        if (!isEncrypted(r.provider_config)) {
          try {
            const ciphertext = encrypt(r.provider_config);
            this.db.prepare(
              "UPDATE projects SET provider_config = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(ciphertext, r.id);
            encrypted++;
          } catch (err) {
            console.warn(
              `[DB] Failed to encrypt provider_config for project ${r.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      if (encrypted > 0) {
        console.log(`[DB] Encrypted ${encrypted} plaintext provider_config value(s)`);
      }

      if (version < 12) {
        this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (12)');
        console.log('[DB] Migrated to v12: provider_config encryption');
      }
    } catch {
      // Tables may not exist yet (fresh database) — schema.sql will create them
    }
  }

  /**
   * v13 migration: Add project_issue_sources table and backfill from existing
   * projects that have a non-null github_repo. Each project gets one row with
   * provider='github' and config_json='{"owner":"X","repo":"Y"}'.
   */
  private addProjectIssueSourcesTable(): void {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) AS version FROM schema_version'
      ).get() as { version: number } | undefined;
      const version = row?.version ?? 0;
      if (version >= 13) return; // Already migrated

      // Create the table if it does not exist
      const tableCols = this.db.prepare("PRAGMA table_info(project_issue_sources)").all() as Array<{ name: string }>;
      if (tableCols.length === 0) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_issue_sources (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      INTEGER NOT NULL REFERENCES projects(id),
            provider        TEXT NOT NULL,
            label           TEXT,
            config_json     TEXT NOT NULL,
            credentials_json TEXT,
            enabled         INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(project_id, provider, config_json)
          );
          CREATE INDEX IF NOT EXISTS idx_issue_sources_project ON project_issue_sources(project_id);
        `);
      }

      // Backfill: create a github source for every project with a github_repo
      const projects = this.db.prepare(
        'SELECT id, github_repo FROM projects WHERE github_repo IS NOT NULL'
      ).all() as Array<{ id: number; github_repo: string }>;

      const insertStmt = this.db.prepare(
        `INSERT OR IGNORE INTO project_issue_sources (project_id, provider, label, config_json, enabled)
         VALUES (?, 'github', 'GitHub Issues', ?, 1)`
      );

      for (const proj of projects) {
        const parts = proj.github_repo.split('/');
        if (parts.length === 2) {
          const configJson = JSON.stringify({ owner: parts[0], repo: parts[1] });
          insertStmt.run(proj.id, configJson);
        }
      }

      this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (13)');
      console.log(`[DB] Migrated to v13: project_issue_sources table created, backfilled ${projects.length} project(s)`);
    } catch {
      // Tables may not exist yet (fresh database) — schema.sql will create them
    }
  }

  /**
   * Add provider_state table for persisting issue provider runtime state
   * (e.g. blockedBySupported flag for GitHubIssueProvider).
   */
  private addProviderStateTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS provider_state (
          key         TEXT PRIMARY KEY,
          value       TEXT NOT NULL,
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    } catch {
      // Table may already exist — safe to ignore
    }
  }

  /**
   * v14 migration: Add retry_count column to teams table for auto-retry tracking.
   */
  private addRetryCountColumn(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(teams)').all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === 'retry_count')) return; // Already exists

      this.db.exec('ALTER TABLE teams ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
      this.db.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (14)');
      console.log('[DB] Migrated to v14: added retry_count column to teams');
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  /**
   * Migrate any projects with status 'paused' to 'active'.
   * The paused status was removed in issue #228.
   */
  private migratePausedProjects(): void {
    try {
      const result = this.db.prepare(
        "UPDATE projects SET status = 'active', updated_at = datetime('now') WHERE status = 'paused'"
      ).run();
      if (result.changes > 0) {
        console.log(`[DB] Migrated ${result.changes} paused project(s) to active`);
      }
    } catch {
      // Table may not exist yet (fresh database) — schema.sql will create it
    }
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  insertProject(data: ProjectInsert): Project {
    const now = new Date().toISOString();
    const stmt = this.stmt(`
      INSERT INTO projects (name, repo_path, github_repo, group_id, max_active_teams, prompt_file, model, issue_provider, project_key, provider_config, created_at, updated_at)
      VALUES (@name, @repoPath, @githubRepo, @groupId, @maxActiveTeams, @promptFile, @model, @issueProvider, @projectKey, @providerConfig, @createdAt, @updatedAt)
    `);

    const info = stmt.run({
      name: data.name,
      repoPath: data.repoPath,
      githubRepo: data.githubRepo ?? null,
      groupId: data.groupId ?? null,
      maxActiveTeams: data.maxActiveTeams ?? 5,
      promptFile: data.promptFile ?? null,
      model: data.model ?? null,
      issueProvider: data.issueProvider ?? 'github',
      projectKey: data.projectKey ?? null,
      providerConfig: data.providerConfig ? encrypt(data.providerConfig) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getProject(Number(info.lastInsertRowid))!;
  }

  getProject(id: number): Project | undefined {
    const stmt = this.stmt('SELECT * FROM projects WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapProjectRow(row) : undefined;
  }

  getProjectByRepoPath(repoPath: string): Project | undefined {
    const stmt = this.stmt('SELECT * FROM projects WHERE repo_path = ?');
    const row = stmt.get(repoPath) as Record<string, unknown> | undefined;
    return row ? this.mapProjectRow(row) : undefined;
  }

  getProjects(filter?: ProjectFilter): Project[] {
    let sql = 'SELECT * FROM projects';
    const params: Record<string, unknown> = {};

    if (filter?.status) {
      sql += ' WHERE status = @status';
      params.status = filter.status;
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectRow(r));
  }

  getProjectSummaries(): ProjectSummary[] {
    const stmt = this.stmt(`
      SELECT
        p.*,
        COUNT(t.id) AS team_count,
        COUNT(CASE WHEN t.status IN ('launching', 'running', 'idle', 'stuck') THEN 1 END) AS active_team_count,
        COUNT(CASE WHEN t.status = 'queued' THEN 1 END) AS queued_team_count
      FROM projects p
      LEFT JOIN teams t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...this.mapProjectRow(r),
      teamCount: r.team_count as number,
      activeTeamCount: r.active_team_count as number,
      queuedTeamCount: r.queued_team_count as number,
    }));
  }

  updateProject(id: number, fields: ProjectUpdate): Project | undefined {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) {
      setClauses.push('name = @name');
      params.name = fields.name;
    }
    if (fields.githubRepo !== undefined) {
      setClauses.push('github_repo = @githubRepo');
      params.githubRepo = fields.githubRepo;
    }
    if (fields.groupId !== undefined) {
      setClauses.push('group_id = @groupId');
      params.groupId = fields.groupId;
    }
    if (fields.status !== undefined) {
      setClauses.push('status = @status');
      params.status = fields.status;
    }
    if (fields.hooksInstalled !== undefined) {
      setClauses.push('hooks_installed = @hooksInstalled');
      params.hooksInstalled = fields.hooksInstalled ? 1 : 0;
    }
    if (fields.maxActiveTeams !== undefined) {
      setClauses.push('max_active_teams = @maxActiveTeams');
      params.maxActiveTeams = fields.maxActiveTeams;
    }
    if (fields.promptFile !== undefined) {
      setClauses.push('prompt_file = @promptFile');
      params.promptFile = fields.promptFile;
    }
    if (fields.model !== undefined) {
      setClauses.push('model = @model');
      params.model = fields.model;
    }
    if (fields.issueProvider !== undefined) {
      setClauses.push('issue_provider = @issueProvider');
      params.issueProvider = fields.issueProvider;
    }
    if (fields.projectKey !== undefined) {
      setClauses.push('project_key = @projectKey');
      params.projectKey = fields.projectKey;
    }
    if (fields.providerConfig !== undefined) {
      setClauses.push('provider_config = @providerConfig');
      params.providerConfig = fields.providerConfig ? encrypt(fields.providerConfig) : fields.providerConfig;
    }

    if (setClauses.length === 0) return this.getProject(id);

    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
    return this.getProject(id);
  }

  deleteProject(id: number): boolean {
    // Delete associated issue sources first (foreign key constraint)
    this.deleteIssueSourcesByProject(id);
    const result = this.stmt('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getProjectTeams(projectId: number): TeamDashboardRow[] {
    const stmt = this.stmt('SELECT * FROM v_team_dashboard WHERE project_id = ?');
    const rows = stmt.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapDashboardRow(r));
  }

  // -------------------------------------------------------------------------
  // Project Groups
  // -------------------------------------------------------------------------

  insertProjectGroup(data: ProjectGroupInsert): ProjectGroup {
    const now = new Date().toISOString();
    const stmt = this.stmt(`
      INSERT INTO project_groups (name, description, created_at, updated_at)
      VALUES (@name, @description, @createdAt, @updatedAt)
    `);

    const info = stmt.run({
      name: data.name,
      description: data.description ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getProjectGroup(Number(info.lastInsertRowid))!;
  }

  getProjectGroup(id: number): ProjectGroup | undefined {
    const stmt = this.stmt('SELECT * FROM project_groups WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapProjectGroupRow(row) : undefined;
  }

  getProjectGroups(): ProjectGroup[] {
    const stmt = this.stmt('SELECT * FROM project_groups ORDER BY name ASC');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectGroupRow(r));
  }

  updateProjectGroup(id: number, fields: ProjectGroupUpdate): ProjectGroup | undefined {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) {
      setClauses.push('name = @name');
      params.name = fields.name;
    }
    if (fields.description !== undefined) {
      setClauses.push('description = @description');
      params.description = fields.description;
    }

    if (setClauses.length === 0) return this.getProjectGroup(id);

    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE project_groups SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
    return this.getProjectGroup(id);
  }

  deleteProjectGroup(id: number): boolean {
    // Unlink all projects from this group before deleting
    this.stmt('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(id);
    const result = this.stmt('DELETE FROM project_groups WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Project Issue Sources
  // -------------------------------------------------------------------------

  insertIssueSource(data: ProjectIssueSourceInsert): ProjectIssueSource {
    const stmt = this.stmt(`
      INSERT INTO project_issue_sources (project_id, provider, label, config_json, credentials_json, enabled)
      VALUES (@projectId, @provider, @label, @configJson, @credentialsJson, @enabled)
    `);

    const info = stmt.run({
      projectId: data.projectId,
      provider: data.provider,
      label: data.label ?? null,
      configJson: data.configJson,
      credentialsJson: data.credentialsJson ? encrypt(data.credentialsJson) : null,
      enabled: (data.enabled ?? true) ? 1 : 0,
    });

    return this.getIssueSource(Number(info.lastInsertRowid))!;
  }

  getIssueSources(projectId: number, enabledOnly?: boolean): ProjectIssueSource[] {
    if (enabledOnly) {
      const stmt = this.stmt(
        'SELECT * FROM project_issue_sources WHERE project_id = ? AND enabled = 1 ORDER BY id ASC'
      );
      const rows = stmt.all(projectId) as Record<string, unknown>[];
      return rows.map((r) => this.mapIssueSourceRow(r));
    }

    const stmt = this.stmt(
      'SELECT * FROM project_issue_sources WHERE project_id = ? ORDER BY id ASC'
    );
    const rows = stmt.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapIssueSourceRow(r));
  }

  getIssueSource(id: number): ProjectIssueSource | undefined {
    const stmt = this.stmt('SELECT * FROM project_issue_sources WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapIssueSourceRow(row) : undefined;
  }

  updateIssueSource(id: number, fields: ProjectIssueSourceUpdate): ProjectIssueSource | undefined {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.label !== undefined) {
      setClauses.push('label = @label');
      params.label = fields.label;
    }
    if (fields.configJson !== undefined) {
      setClauses.push('config_json = @configJson');
      params.configJson = fields.configJson;
    }
    if (fields.credentialsJson !== undefined) {
      setClauses.push('credentials_json = @credentialsJson');
      params.credentialsJson = fields.credentialsJson ? encrypt(fields.credentialsJson) : fields.credentialsJson;
    }
    if (fields.enabled !== undefined) {
      setClauses.push('enabled = @enabled');
      params.enabled = fields.enabled ? 1 : 0;
    }

    if (setClauses.length === 0) return this.getIssueSource(id);

    const sql = `UPDATE project_issue_sources SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
    return this.getIssueSource(id);
  }

  deleteIssueSource(id: number): boolean {
    const result = this.stmt('DELETE FROM project_issue_sources WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteIssueSourcesByProject(projectId: number): number {
    const result = this.stmt('DELETE FROM project_issue_sources WHERE project_id = ?').run(projectId);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------

  insertTeam(data: TeamInsert): Team {
    const now = new Date().toISOString();
    const stmt = this.stmt(`
      INSERT INTO teams (issue_number, issue_title, issue_key, issue_provider, project_id, worktree_name, branch_name, status, phase, pid, session_id, pr_number, custom_prompt, headless, blocked_by_json, launched_at, created_at, updated_at)
      VALUES (@issueNumber, @issueTitle, @issueKey, @issueProvider, @projectId, @worktreeName, @branchName, @status, @phase, @pid, @sessionId, @prNumber, @customPrompt, @headless, @blockedByJson, @launchedAt, @createdAt, @updatedAt)
    `);

    try {
      const info = stmt.run({
        issueNumber: data.issueNumber,
        issueTitle: data.issueTitle ?? null,
        issueKey: data.issueKey ?? String(data.issueNumber),
        issueProvider: data.issueProvider ?? 'github',
        projectId: data.projectId ?? null,
        worktreeName: data.worktreeName,
        branchName: data.branchName ?? null,
        status: data.status ?? 'queued',
        phase: data.phase ?? 'init',
        pid: data.pid ?? null,
        sessionId: data.sessionId ?? null,
        prNumber: data.prNumber ?? null,
        customPrompt: data.customPrompt ?? null,
        headless: data.headless === false ? 0 : 1,
        blockedByJson: data.blockedByJson ?? null,
        launchedAt: data.launchedAt ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return this.getTeam(Number(info.lastInsertRowid))!;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        throw new Error(
          `Team already exists for project ${data.projectId} issue #${data.issueNumber}`
        );
      }
      throw err;
    }
  }

  getTeam(id: number): Team | undefined {
    const stmt = this.stmt('SELECT * FROM teams WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTeamRow(row) : undefined;
  }

  getTeamByWorktree(name: string): Team | undefined {
    const stmt = this.stmt('SELECT * FROM teams WHERE worktree_name = ?');
    const row = stmt.get(name) as Record<string, unknown> | undefined;
    return row ? this.mapTeamRow(row) : undefined;
  }

  getTeams(filter?: TeamFilter): Team[] {
    let sql = 'SELECT * FROM teams';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter?.status) {
      conditions.push('status = @status');
      params.status = filter.status;
    }
    if (filter?.issueNumber) {
      conditions.push('issue_number = @issueNumber');
      params.issueNumber = filter.issueNumber;
    }
    if (filter?.issueKey) {
      conditions.push('issue_key = @issueKey');
      params.issueKey = filter.issueKey;
    }
    if (filter?.projectId) {
      conditions.push('project_id = @projectId');
      params.projectId = filter.projectId;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    if (filter?.limit) {
      sql += ' LIMIT @limit';
      params.limit = filter.limit;
    }
    if (filter?.offset) {
      sql += ' OFFSET @offset';
      params.offset = filter.offset;
    }

    const stmt = this.db.prepare(sql);
    const rows = (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  getTeamsCount(filter?: TeamFilter): number {
    let sql = 'SELECT COUNT(*) AS cnt FROM teams';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter?.status) {
      conditions.push('status = @status');
      params.status = filter.status;
    }
    if (filter?.issueNumber) {
      conditions.push('issue_number = @issueNumber');
      params.issueNumber = filter.issueNumber;
    }
    if (filter?.issueKey) {
      conditions.push('issue_key = @issueKey');
      params.issueKey = filter.issueKey;
    }
    if (filter?.projectId) {
      conditions.push('project_id = @projectId');
      params.projectId = filter.projectId;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const stmt = this.db.prepare(sql);
    const row = (Object.keys(params).length > 0 ? stmt.get(params) : stmt.get()) as { cnt: number };
    return row.cnt;
  }

  getActiveTeams(): Team[] {
    const stmt = this.stmt(
      "SELECT * FROM teams WHERE status IN ('queued', 'launching', 'running', 'idle', 'stuck') ORDER BY created_at DESC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  getActiveTeamsByProject(projectId: number): Team[] {
    const stmt = this.stmt(
      "SELECT * FROM teams WHERE project_id = ? AND status IN ('queued', 'launching', 'running', 'idle', 'stuck') ORDER BY created_at DESC"
    );
    const rows = stmt.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  /**
   * Count teams with active (non-queued) statuses for a project.
   * Used for enforcing max_active_teams limit — queued teams are excluded
   * because they haven't consumed a slot yet.
   */
  getActiveTeamCountByProject(projectId: number): number {
    const stmt = this.stmt(
      "SELECT COUNT(*) AS cnt FROM teams WHERE project_id = ? AND status IN ('launching', 'running', 'idle', 'stuck')"
    );
    const row = stmt.get(projectId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Get queued teams for a project, ordered by creation time (FIFO).
   */
  getQueuedTeamsByProject(projectId: number): Team[] {
    const stmt = this.stmt(
      "SELECT * FROM teams WHERE project_id = ? AND status = 'queued' ORDER BY created_at ASC"
    );
    const rows = stmt.all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  /**
   * Get queued teams that have non-null blocked_by_json.
   * Used by the GitHub poller to check DB-persisted blockers for resolution.
   */
  getQueuedBlockedTeams(): Team[] {
    const stmt = this.stmt(
      "SELECT * FROM teams WHERE status = 'queued' AND blocked_by_json IS NOT NULL ORDER BY created_at ASC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  /**
   * Get all failed teams ordered by stopped_at (oldest first).
   * Used by the retry scheduler to find teams eligible for auto-retry.
   */
  getFailedTeamsForRetry(): Team[] {
    const stmt = this.stmt(
      "SELECT * FROM teams WHERE status = 'failed' ORDER BY stopped_at ASC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  /**
   * Update team fields without returning the updated record.
   * Use when the caller discards the return value (fire-and-forget updates).
   * Skips the trailing SELECT that `updateTeam()` performs.
   */
  updateTeamSilent(id: number, fields: TeamUpdate): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.issueTitle !== undefined) {
      setClauses.push('issue_title = @issueTitle');
      params.issueTitle = fields.issueTitle;
    }
    if (fields.branchName !== undefined) {
      setClauses.push('branch_name = @branchName');
      params.branchName = fields.branchName;
    }
    if (fields.status !== undefined) {
      setClauses.push('status = @status');
      params.status = fields.status;
    }
    if (fields.phase !== undefined) {
      setClauses.push('phase = @phase');
      params.phase = fields.phase;
    }
    if (fields.pid !== undefined) {
      setClauses.push('pid = @pid');
      params.pid = fields.pid;
    }
    if (fields.sessionId !== undefined) {
      setClauses.push('session_id = @sessionId');
      params.sessionId = fields.sessionId;
    }
    if (fields.prNumber !== undefined) {
      setClauses.push('pr_number = @prNumber');
      params.prNumber = fields.prNumber;
    }
    if (fields.customPrompt !== undefined) {
      setClauses.push('custom_prompt = @customPrompt');
      params.customPrompt = fields.customPrompt;
    }
    if (fields.headless !== undefined) {
      setClauses.push('headless = @headless');
      params.headless = fields.headless ? 1 : 0;
    }
    if (fields.blockedByJson !== undefined) {
      setClauses.push('blocked_by_json = @blockedByJson');
      params.blockedByJson = fields.blockedByJson;
    }
    if (fields.totalInputTokens !== undefined) {
      setClauses.push('total_input_tokens = @totalInputTokens');
      params.totalInputTokens = fields.totalInputTokens;
    }
    if (fields.totalOutputTokens !== undefined) {
      setClauses.push('total_output_tokens = @totalOutputTokens');
      params.totalOutputTokens = fields.totalOutputTokens;
    }
    if (fields.totalCacheCreationTokens !== undefined) {
      setClauses.push('total_cache_creation_tokens = @totalCacheCreationTokens');
      params.totalCacheCreationTokens = fields.totalCacheCreationTokens;
    }
    if (fields.totalCacheReadTokens !== undefined) {
      setClauses.push('total_cache_read_tokens = @totalCacheReadTokens');
      params.totalCacheReadTokens = fields.totalCacheReadTokens;
    }
    if (fields.totalCostUsd !== undefined) {
      setClauses.push('total_cost_usd = @totalCostUsd');
      params.totalCostUsd = fields.totalCostUsd;
    }
    if (fields.launchedAt !== undefined) {
      setClauses.push('launched_at = @launchedAt');
      params.launchedAt = fields.launchedAt;
    }
    if (fields.stoppedAt !== undefined) {
      setClauses.push('stopped_at = @stoppedAt');
      params.stoppedAt = fields.stoppedAt;
    }
    if (fields.lastEventAt !== undefined) {
      setClauses.push('last_event_at = @lastEventAt');
      params.lastEventAt = fields.lastEventAt;
    }
    if (fields.retryCount !== undefined) {
      setClauses.push('retry_count = @retryCount');
      params.retryCount = fields.retryCount;
    }

    if (setClauses.length === 0) return;

    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE teams SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  /**
   * Dedicated heartbeat update using a pre-cached prepared statement.
   * Avoids the dynamic SQL construction of updateTeamSilent() on the
   * hot path — called on every single hook event via processEventTransaction
   * and processThrottledUpdate.
   */
  private updateTeamHeartbeat(id: number, lastEventAt: string): void {
    this.stmt(
      "UPDATE teams SET last_event_at = @lastEventAt, updated_at = datetime('now') WHERE id = @id"
    ).run({ id, lastEventAt });
  }

  updateTeam(id: number, fields: TeamUpdate): Team | undefined {
    this.updateTeamSilent(id, fields);
    return this.getTeam(id);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  insertEvent(data: EventInsert): Event {
    const stmt = this.stmt(`
      INSERT INTO events (team_id, session_id, agent_name, event_type, tool_name, payload)
      VALUES (@teamId, @sessionId, @agentName, @eventType, @toolName, @payload)
    `);

    const info = stmt.run({
      teamId: data.teamId,
      sessionId: data.sessionId ?? null,
      agentName: data.agentName ?? null,
      eventType: data.eventType,
      toolName: data.toolName ?? null,
      payload: data.payload ?? null,
    });

    const row = this.stmt('SELECT * FROM events WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapEventRow(row);
  }

  /**
   * Atomically execute all DB writes for a single event processing cycle.
   *
   * Wraps transition insert, status update, heartbeat update, event insert,
   * and agent message inserts in a single better-sqlite3 transaction so that
   * a failure in any write rolls back all of them — preventing partial state
   * (e.g., transition recorded but event lost).
   *
   * Logs a warning and re-throws on SQLITE_BUSY (the busy_timeout pragma
   * is the correct retry mechanism; spin-waiting after it expires wastes CPU).
   */
  processEventTransaction(ops: {
    transition?: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string };
    statusUpdate?: { teamId: number; fields: TeamUpdate };
    heartbeatUpdate: { teamId: number; lastEventAt: string };
    eventInsert: EventInsert;
    agentMessages?: Array<Omit<AgentMessageInsert, 'eventId'>>;
  }): { eventId: number } {
    const runTransaction = this.db.transaction((txOps: typeof ops) => {
      // 1. Insert transition record (if transitioning)
      if (txOps.transition) {
        this.stmt(
          'INSERT INTO team_transitions (team_id, from_status, to_status, trigger, reason) VALUES (?, ?, ?, ?, ?)'
        ).run(
          txOps.transition.teamId,
          txOps.transition.fromStatus,
          txOps.transition.toStatus,
          txOps.transition.trigger,
          txOps.transition.reason,
        );
      }

      // 2. Update team status (if transitioning) — skip trailing SELECT
      if (txOps.statusUpdate) {
        this.updateTeamSilent(txOps.statusUpdate.teamId, txOps.statusUpdate.fields);
      }

      // 3. Update heartbeat (lastEventAt) — always required, cached prepared statement
      this.updateTeamHeartbeat(txOps.heartbeatUpdate.teamId, txOps.heartbeatUpdate.lastEventAt);

      // 4. Insert event — always required
      const eventInfo = this.stmt(`
        INSERT INTO events (team_id, session_id, agent_name, event_type, tool_name, payload)
        VALUES (@teamId, @sessionId, @agentName, @eventType, @toolName, @payload)
      `).run({
        teamId: txOps.eventInsert.teamId,
        sessionId: txOps.eventInsert.sessionId ?? null,
        agentName: txOps.eventInsert.agentName ?? null,
        eventType: txOps.eventInsert.eventType,
        toolName: txOps.eventInsert.toolName ?? null,
        payload: txOps.eventInsert.payload ?? null,
      });
      const eventId = Number(eventInfo.lastInsertRowid);

      // 5. Insert agent messages (if any), filling in the eventId
      if (txOps.agentMessages && txOps.agentMessages.length > 0) {
        const msgStmt = this.stmt(`
          INSERT INTO agent_messages (team_id, event_id, sender, recipient, summary, content, session_id)
          VALUES (@teamId, @eventId, @sender, @recipient, @summary, @content, @sessionId)
        `);
        for (const msg of txOps.agentMessages) {
          msgStmt.run({
            teamId: msg.teamId,
            eventId,
            sender: msg.sender,
            recipient: msg.recipient,
            summary: msg.summary ?? null,
            content: msg.content ?? null,
            sessionId: msg.sessionId ?? null,
          });
        }
      }

      return { eventId };
    });

    try {
      return runTransaction(ops);
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code === 'SQLITE_BUSY') {
        console.warn('[DB] processEventTransaction: SQLITE_BUSY after busy_timeout exhausted');
      }
      throw err;
    }
  }

  /**
   * Wrap the throttled tool_use path's DB writes in a single transaction.
   *
   * The throttled path skips event insertion and SSE broadcast but still
   * needs to (optionally) record a transition, (optionally) update team
   * status/phase, and always update the heartbeat timestamp. Wrapping
   * these in a transaction ensures atomicity (Issue #529).
   */
  processThrottledUpdate(ops: {
    transition?: { teamId: number; fromStatus: TeamStatus; toStatus: TeamStatus; trigger: string; reason: string };
    statusUpdate?: { teamId: number; fields: TeamUpdate };
    heartbeatUpdate: { teamId: number; lastEventAt: string };
  }): void {
    const runTransaction = this.db.transaction((txOps: typeof ops) => {
      if (txOps.transition) {
        this.stmt(
          'INSERT INTO team_transitions (team_id, from_status, to_status, trigger, reason) VALUES (?, ?, ?, ?, ?)'
        ).run(
          txOps.transition.teamId,
          txOps.transition.fromStatus,
          txOps.transition.toStatus,
          txOps.transition.trigger,
          txOps.transition.reason,
        );
      }
      if (txOps.statusUpdate) {
        this.updateTeamSilent(txOps.statusUpdate.teamId, txOps.statusUpdate.fields);
      }
      this.updateTeamHeartbeat(txOps.heartbeatUpdate.teamId, txOps.heartbeatUpdate.lastEventAt);
    });

    try {
      runTransaction(ops);
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string };
      if (sqliteErr.code === 'SQLITE_BUSY') {
        console.warn('[DB] processThrottledUpdate: SQLITE_BUSY after busy_timeout exhausted');
      }
      throw err;
    }
  }

  getEventsByTeam(teamId: number, limit?: number, offset?: number): Event[] {
    let sql = 'SELECT * FROM events WHERE team_id = ? ORDER BY id DESC';
    const params: unknown[] = [teamId];

    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    if (offset) {
      sql += ' OFFSET ?';
      params.push(offset);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEventRow(r));
  }

  getEventsByTeamCount(teamId: number): number {
    const stmt = this.stmt('SELECT COUNT(*) AS cnt FROM events WHERE team_id = ?');
    const row = stmt.get(teamId) as { cnt: number };
    return row.cnt;
  }

  getLatestEventByTeam(teamId: number): Event | undefined {
    const stmt = this.stmt(
      'SELECT * FROM events WHERE team_id = ? ORDER BY id DESC LIMIT 1'
    );
    const row = stmt.get(teamId) as Record<string, unknown> | undefined;
    return row ? this.mapEventRow(row) : undefined;
  }

  getAllEvents(filters?: EventFilter): Event[] {
    let sql = 'SELECT * FROM events';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters?.teamId) {
      conditions.push('team_id = @teamId');
      params.teamId = filters.teamId;
    }
    if (filters?.eventType) {
      conditions.push('event_type = @eventType');
      params.eventType = filters.eventType;
    }
    if (filters?.since) {
      conditions.push('created_at >= @since');
      params.since = filters.since;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY id DESC';

    if (filters?.limit) {
      sql += ' LIMIT @limit';
      params.limit = filters.limit;
    }
    if (filters?.offset) {
      sql += ' OFFSET @offset';
      params.offset = filters.offset;
    }

    const stmt = this.db.prepare(sql);
    const rows = (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as Record<string, unknown>[];
    return rows.map((r) => this.mapEventRow(r));
  }

  getAllEventsCount(filters?: EventFilter): number {
    let sql = 'SELECT COUNT(*) AS cnt FROM events';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters?.teamId) {
      conditions.push('team_id = @teamId');
      params.teamId = filters.teamId;
    }
    if (filters?.eventType) {
      conditions.push('event_type = @eventType');
      params.eventType = filters.eventType;
    }
    if (filters?.since) {
      conditions.push('created_at >= @since');
      params.since = filters.since;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const stmt = this.db.prepare(sql);
    const row = (Object.keys(params).length > 0 ? stmt.get(params) : stmt.get()) as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Team Roster (subagent members derived from events)
  // -------------------------------------------------------------------------

  getTeamRoster(teamId: number): TeamMember[] {
    // Normalize agent names in SQL: strip "fleet-" prefix and coalesce empty to "team-lead"
    // for backward compatibility with data inserted before normalization was added.
    const sql = `
      SELECT
        CASE
          WHEN agent_name LIKE 'fleet-%' THEN SUBSTR(agent_name, 7)
          ELSE agent_name
        END AS name,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        SUM(CASE WHEN event_type = 'ToolUse' THEN 1 ELSE 0 END) AS tool_use_count,
        SUM(CASE WHEN event_type = 'ToolError' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN event_type = 'SubagentStart' THEN 1 ELSE 0 END) AS starts,
        SUM(CASE WHEN event_type = 'SubagentStop' THEN 1 ELSE 0 END) AS stops
      FROM events
      WHERE team_id = ? AND agent_name IS NOT NULL AND agent_name != ''
      GROUP BY CASE
        WHEN agent_name LIKE 'fleet-%' THEN SUBSTR(agent_name, 7)
        ELSE agent_name
      END
      ORDER BY MIN(created_at) ASC
    `;
    const rows = this.stmt(sql).all(teamId) as Record<string, unknown>[];
    return rows.map((row) => {
      const name = row.name as string;
      const starts = (row.starts as number) ?? 0;
      const stops = (row.stops as number) ?? 0;
      return {
        name,
        role: deriveRole(name),
        isActive: starts > stops,
        firstSeen: utcify(row.first_seen as string),
        lastSeen: utcify(row.last_seen as string),
        toolUseCount: (row.tool_use_count as number) ?? 0,
        errorCount: (row.error_count as number) ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Agent Messages (inter-agent message routing)
  // -------------------------------------------------------------------------

  insertAgentMessage(data: AgentMessageInsert): AgentMessage {
    const stmt = this.stmt(`
      INSERT INTO agent_messages (team_id, event_id, sender, recipient, summary, content, session_id)
      VALUES (@teamId, @eventId, @sender, @recipient, @summary, @content, @sessionId)
    `);

    const info = stmt.run({
      teamId: data.teamId,
      eventId: data.eventId,
      sender: data.sender,
      recipient: data.recipient,
      summary: data.summary ?? null,
      content: data.content ?? null,
      sessionId: data.sessionId ?? null,
    });

    const row = this.stmt('SELECT * FROM agent_messages WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapAgentMessageRow(row);
  }

  getAgentMessages(teamId: number, limit?: number): AgentMessage[] {
    const cols = 'id, team_id, event_id, sender, recipient, summary, session_id, created_at';
    const sql = limit
      ? `SELECT ${cols} FROM agent_messages WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      : `SELECT ${cols} FROM agent_messages WHERE team_id = ? ORDER BY created_at DESC, id DESC`;

    const stmt = this.db.prepare(sql);
    const rows = (limit ? stmt.all(teamId, limit) : stmt.all(teamId)) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentMessageRow(r));
  }

  getAgentMessageSummary(teamId: number): MessageEdge[] {
    // Normalize sender/recipient names: strip "fleet-" prefix for backward compat
    // with data inserted before normalization was added.
    // Uses CTE + ROW_NUMBER window function to find the latest summary per pair
    // in a single pass, avoiding the O(n^2) correlated subquery.
    const sql = `
      WITH normalized AS (
        SELECT
          CASE WHEN sender LIKE 'fleet-%' THEN SUBSTR(sender, 7) ELSE sender END AS norm_sender,
          CASE WHEN recipient LIKE 'fleet-%' THEN SUBSTR(recipient, 7) ELSE recipient END AS norm_recipient,
          summary,
          created_at,
          id,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE WHEN sender LIKE 'fleet-%' THEN SUBSTR(sender, 7) ELSE sender END,
              CASE WHEN recipient LIKE 'fleet-%' THEN SUBSTR(recipient, 7) ELSE recipient END
            ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM agent_messages
        WHERE team_id = ?
      )
      SELECT
        norm_sender AS sender,
        norm_recipient AS recipient,
        COUNT(*) AS count,
        MAX(CASE WHEN rn = 1 THEN summary END) AS last_summary
      FROM normalized
      GROUP BY norm_sender, norm_recipient
      ORDER BY count DESC
    `;
    const rows = this.stmt(sql).all(teamId) as Array<{
      sender: string;
      recipient: string;
      count: number;
      last_summary: string | null;
    }>;
    return rows.map((r) => ({
      sender: r.sender,
      recipient: r.recipient,
      count: r.count,
      lastSummary: r.last_summary ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Pull Requests
  // -------------------------------------------------------------------------

  insertPullRequest(data: PRInsert): PullRequest {
    const stmt = this.stmt(`
      INSERT INTO pull_requests (pr_number, team_id, title, state, ci_status, merge_status, auto_merge, ci_fail_count, checks_json)
      VALUES (@prNumber, @teamId, @title, @state, @ciStatus, @mergeStatus, @autoMerge, @ciFailCount, @checksJson)
    `);

    stmt.run({
      prNumber: data.prNumber,
      teamId: data.teamId ?? null,
      title: data.title ?? null,
      state: data.state ?? null,
      ciStatus: data.ciStatus ?? null,
      mergeStatus: data.mergeStatus ?? null,
      autoMerge: data.autoMerge ? 1 : 0,
      ciFailCount: data.ciFailCount ?? 0,
      checksJson: data.checksJson ?? null,
    });

    return this.getPullRequest(data.prNumber)!;
  }

  getPullRequest(prNumber: number): PullRequest | undefined {
    const stmt = this.stmt('SELECT * FROM pull_requests WHERE pr_number = ?');
    const row = stmt.get(prNumber) as Record<string, unknown> | undefined;
    return row ? this.mapPRRow(row) : undefined;
  }

  getAllPullRequests(): PullRequest[] {
    const stmt = this.stmt('SELECT * FROM pull_requests ORDER BY updated_at DESC');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapPRRow(r));
  }

  updatePullRequest(prNumber: number, fields: PRUpdate): PullRequest | undefined {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { prNumber };

    if (fields.teamId !== undefined) {
      setClauses.push('team_id = @teamId');
      params.teamId = fields.teamId;
    }
    if (fields.title !== undefined) {
      setClauses.push('title = @title');
      params.title = fields.title;
    }
    if (fields.state !== undefined) {
      setClauses.push('state = @state');
      params.state = fields.state;
    }
    if (fields.ciStatus !== undefined) {
      setClauses.push('ci_status = @ciStatus');
      params.ciStatus = fields.ciStatus;
    }
    if (fields.mergeStatus !== undefined) {
      setClauses.push('merge_status = @mergeStatus');
      params.mergeStatus = fields.mergeStatus;
    }
    if (fields.autoMerge !== undefined) {
      setClauses.push('auto_merge = @autoMerge');
      params.autoMerge = fields.autoMerge ? 1 : 0;
    }
    if (fields.ciFailCount !== undefined) {
      setClauses.push('ci_fail_count = @ciFailCount');
      params.ciFailCount = fields.ciFailCount;
    }
    if (fields.checksJson !== undefined) {
      setClauses.push('checks_json = @checksJson');
      params.checksJson = fields.checksJson;
    }
    if (fields.mergedAt !== undefined) {
      setClauses.push('merged_at = @mergedAt');
      params.mergedAt = fields.mergedAt;
    }

    if (setClauses.length === 0) return this.getPullRequest(prNumber);

    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE pull_requests SET ${setClauses.join(', ')} WHERE pr_number = @prNumber`;
    this.db.prepare(sql).run(params);
    return this.getPullRequest(prNumber);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  insertCommand(data: CommandInsert): Command {
    const stmt = this.stmt(`
      INSERT INTO commands (team_id, target_agent, message)
      VALUES (@teamId, @targetAgent, @message)
    `);

    const info = stmt.run({
      teamId: data.teamId,
      targetAgent: data.targetAgent ?? null,
      message: data.message,
    });

    const row = this.stmt('SELECT * FROM commands WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapCommandRow(row);
  }

  getPendingCommands(teamId: number): Command[] {
    const stmt = this.stmt(
      "SELECT * FROM commands WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC"
    );
    const rows = stmt.all(teamId) as Record<string, unknown>[];
    return rows.map((r) => this.mapCommandRow(r));
  }

  markCommandDelivered(id: number): Command | undefined {
    this.stmt(
      "UPDATE commands SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?"
    ).run(id);

    const row = this.stmt('SELECT * FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapCommandRow(row) : undefined;
  }

  // -------------------------------------------------------------------------
  // Usage Snapshots
  // -------------------------------------------------------------------------

  insertUsageSnapshot(data: UsageInsert): UsageSnapshot {
    const stmt = this.stmt(`
      INSERT INTO usage_snapshots (team_id, project_id, session_id, daily_percent, weekly_percent, sonnet_percent, extra_percent, daily_resets_at, weekly_resets_at, raw_output)
      VALUES (@teamId, @projectId, @sessionId, @dailyPercent, @weeklyPercent, @sonnetPercent, @extraPercent, @dailyResetsAt, @weeklyResetsAt, @rawOutput)
    `);

    const info = stmt.run({
      teamId: data.teamId ?? null,
      projectId: data.projectId ?? null,
      sessionId: data.sessionId ?? null,
      dailyPercent: data.dailyPercent ?? 0,
      weeklyPercent: data.weeklyPercent ?? 0,
      sonnetPercent: data.sonnetPercent ?? 0,
      extraPercent: data.extraPercent ?? 0,
      dailyResetsAt: data.dailyResetsAt ?? null,
      weeklyResetsAt: data.weeklyResetsAt ?? null,
      rawOutput: data.rawOutput ?? null,
    });

    const row = this.stmt('SELECT * FROM usage_snapshots WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapUsageRow(row);
  }

  getLatestUsage(): UsageSnapshot | undefined {
    const stmt = this.stmt(
      'SELECT * FROM usage_snapshots ORDER BY recorded_at DESC, id DESC LIMIT 1'
    );
    const row = stmt.get() as Record<string, unknown> | undefined;
    return row ? this.mapUsageRow(row) : undefined;
  }

  getUsageHistory(limit: number = 50): UsageSnapshot[] {
    const stmt = this.stmt(
      'SELECT * FROM usage_snapshots ORDER BY recorded_at DESC, id DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapUsageRow(r));
  }

  getUsageByProject(projectId?: number): UsageSnapshot[] {
    if (projectId !== undefined) {
      const stmt = this.stmt(
        'SELECT * FROM usage_snapshots WHERE project_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1'
      );
      const row = stmt.get(projectId) as Record<string, unknown> | undefined;
      return row ? [this.mapUsageRow(row)] : [];
    }

    // Latest snapshot per project_id
    const stmt = this.stmt(`
      SELECT u.* FROM usage_snapshots u
      INNER JOIN (
        SELECT project_id, MAX(id) AS max_id
        FROM usage_snapshots
        WHERE project_id IS NOT NULL
        GROUP BY project_id
      ) latest ON u.id = latest.max_id
      ORDER BY u.recorded_at DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapUsageRow(r));
  }

  // -------------------------------------------------------------------------
  // Message Templates
  // -------------------------------------------------------------------------

  /**
   * Get a single message template by ID.
   */
  getMessageTemplate(id: string): { id: string; template: string; enabled: boolean } | undefined {
    const stmt = this.stmt('SELECT id, template, enabled FROM message_templates WHERE id = ?');
    const row = stmt.get(id) as { id: string; template: string; enabled: number } | undefined;
    if (!row) return undefined;
    return { id: row.id, template: row.template, enabled: row.enabled === 1 };
  }

  /**
   * Get all message templates.
   */
  getMessageTemplates(): MessageTemplate[] {
    const stmt = this.stmt('SELECT * FROM message_templates ORDER BY id');
    const rows = stmt.all() as Array<{ id: string; template: string; enabled: number; updated_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      template: r.template,
      enabled: r.enabled === 1,
      updatedAt: utcify(r.updated_at),
    }));
  }

  /**
   * Update a message template's text and/or enabled flag.
   */
  updateMessageTemplate(id: string, fields: { template?: string; enabled?: boolean }): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.template !== undefined) {
      setClauses.push('template = @template');
      params.template = fields.template;
    }
    if (fields.enabled !== undefined) {
      setClauses.push('enabled = @enabled');
      params.enabled = fields.enabled ? 1 : 0;
    }

    if (setClauses.length === 0) return;

    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE message_templates SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  /**
   * Insert a single message template. Used by the PUT upsert endpoint
   * when a template doesn't yet exist in the DB.
   */
  insertMessageTemplate(fields: {
    id: string;
    template: string;
    enabled?: boolean;
  }): void {
    this.stmt(
      `INSERT INTO message_templates (id, template, enabled)
       VALUES (@id, @template, @enabled)`
    ).run({
      id: fields.id,
      template: fields.template,
      enabled: (fields.enabled ?? true) ? 1 : 0,
    });
  }

  /**
   * Initialize default message templates. Uses INSERT OR IGNORE so that
   * user-edited templates are preserved across restarts.
   */
  initDefaultTemplates(defaults: { id: string; template: string }[]): void {
    const stmt = this.stmt(
      'INSERT OR IGNORE INTO message_templates (id, template) VALUES (@id, @template)'
    );

    const insertMany = this.db.transaction((items: { id: string; template: string }[]) => {
      for (const item of items) {
        stmt.run({ id: item.id, template: item.template });
      }
    });

    insertMany(defaults);
  }

  /**
   * Get the file size of the database in bytes.
   */
  getDbFileSize(): number {
    try {
      const dbPath = this.db.name;
      const stats = fs.statSync(dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Stream Events (persisted session log)
  // -------------------------------------------------------------------------

  /**
   * Upsert (INSERT OR REPLACE) the serialized stream events for a team.
   * @param teamId - The team ID
   * @param eventData - JSON-serialized array of StreamEvent objects
   */
  upsertStreamEvents(teamId: number, eventData: string): void {
    this.stmt(`
      INSERT INTO stream_events (team_id, event_data, updated_at)
      VALUES (@teamId, @eventData, datetime('now'))
      ON CONFLICT(team_id) DO UPDATE SET
        event_data = @eventData,
        updated_at = datetime('now')
    `).run({ teamId, eventData });
  }

  /**
   * Get the serialized stream events JSON for a team.
   * Returns the JSON string, or null if no persisted events exist.
   */
  getStreamEvents(teamId: number): string | null {
    const row = this.stmt(
      'SELECT event_data FROM stream_events WHERE team_id = ?'
    ).get(teamId) as { event_data: string } | undefined;
    return row?.event_data ?? null;
  }

  /**
   * Delete persisted stream events for a specific team.
   */
  deleteStreamEventsByTeam(teamId: number): void {
    this.stmt('DELETE FROM stream_events WHERE team_id = ?').run(teamId);
  }

  // -------------------------------------------------------------------------
  // Views / aggregations
  // -------------------------------------------------------------------------

  getTeamDashboard(pagination?: { limit?: number; offset?: number }): TeamDashboardRow[] {
    let sql = 'SELECT * FROM v_team_dashboard ORDER BY id DESC';
    const params: Record<string, unknown> = {};

    if (pagination?.limit) {
      sql += ' LIMIT @limit';
      params.limit = pagination.limit;
    }
    if (pagination?.offset) {
      sql += ' OFFSET @offset';
      params.offset = pagination.offset;
    }

    const stmt = this.db.prepare(sql);
    const rows = (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as Record<string, unknown>[];
    return rows.map((r) => this.mapDashboardRow(r));
  }

  getTeamDashboardCount(): number {
    const stmt = this.stmt('SELECT COUNT(*) AS cnt FROM v_team_dashboard');
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Get teams that may be idle or stuck based on time since last event.
   * @param idleMinutes  - minutes of silence before considered idle (default: 3)
   * @param stuckMinutes - minutes of silence before considered stuck (default: 5)
   */
  getStuckCandidates(idleMinutes: number = 3, stuckMinutes: number = 5): StuckCandidate[] {
    const stmt = this.stmt(`
      SELECT
        t.id,
        t.issue_number,
        t.issue_title,
        t.worktree_name,
        t.status,
        t.phase,
        t.last_event_at,
        CAST(
          (julianday('now') - julianday(t.last_event_at)) * 24 * 60
          AS INTEGER
        ) AS minutes_since_last_event
      FROM teams t
      WHERE t.status IN ('running', 'idle')
        AND t.last_event_at IS NOT NULL
        AND (julianday('now') - julianday(t.last_event_at)) * 24 * 60 >= @idleMinutes
        AND (
          (t.status = 'running')
          OR (t.status = 'idle' AND (julianday('now') - julianday(t.last_event_at)) * 24 * 60 >= @stuckMinutes)
        )
      ORDER BY minutes_since_last_event DESC
    `);

    const rows = stmt.all({ idleMinutes, stuckMinutes }) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      issueNumber: r.issue_number as number,
      issueTitle: r.issue_title as string | null,
      worktreeName: r.worktree_name as string,
      status: r.status as TeamStatus,
      phase: r.phase as TeamPhase,
      lastEventAt: utcify(r.last_event_at as string | null),
      minutesSinceLastEvent: r.minutes_since_last_event as number,
    }));
  }

  // -------------------------------------------------------------------------
  // Team Transitions (state machine history)
  // -------------------------------------------------------------------------

  /**
   * Record a team state transition for history/audit purposes.
   *
   * Safety net: validates that the team's current DB status matches
   * fromStatus before inserting. If mismatched, logs a warning and
   * skips the insert (does not throw). This catches stale-state races
   * that slip past the event-collector guards.
   */
  insertTransition(data: {
    teamId: number;
    fromStatus: TeamStatus;
    toStatus: TeamStatus;
    trigger: string;
    reason: string;
  }): void {
    // Validate fromStatus matches actual DB state
    const team = this.getTeam(data.teamId);
    if (team && team.status !== data.fromStatus) {
      console.warn(
        `[DB] insertTransition: fromStatus mismatch for team ${data.teamId}: expected ${data.fromStatus}, actual ${team.status}. Skipping.`
      );
      return;
    }
    this.stmt(
      'INSERT INTO team_transitions (team_id, from_status, to_status, trigger, reason) VALUES (?, ?, ?, ?, ?)'
    ).run(data.teamId, data.fromStatus, data.toStatus, data.trigger, data.reason);
  }

  /**
   * Get all transitions for a team, ordered by creation time ascending.
   */
  getTransitions(teamId: number): TeamTransition[] {
    const rows = this.stmt(
      'SELECT id, team_id, from_status, to_status, trigger, reason, created_at FROM team_transitions WHERE team_id = ? ORDER BY created_at ASC'
    ).all(teamId) as Array<{
      id: number;
      team_id: number;
      from_status: string;
      to_status: string;
      trigger: string;
      reason: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      fromStatus: r.from_status as TeamStatus,
      toStatus: r.to_status as TeamStatus,
      trigger: r.trigger,
      reason: r.reason,
      createdAt: utcify(r.created_at),
    }));
  }

  deleteTeamsByProject(projectId: number): void {
    this.db.transaction((pid: number) => {
      this.stmt('DELETE FROM stream_events WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM agent_messages WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM team_transitions WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM events WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM commands WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM usage_snapshots WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM pull_requests WHERE team_id IN (SELECT id FROM teams WHERE project_id = ?)').run(pid);
      this.stmt('DELETE FROM teams WHERE project_id = ?').run(pid);
    })(projectId);
  }

  // -------------------------------------------------------------------------
  // Team cleanup (cascade delete team and all related records)
  // -------------------------------------------------------------------------

  /**
   * Delete a team and all related records (events, commands, usage snapshots,
   * pull requests). Used by project cleanup to purge team history.
   */
  deleteTeamAndRelated(teamId: number): void {
    this.db.transaction((id: number) => {
      this.stmt('DELETE FROM stream_events WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM agent_messages WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM team_transitions WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM events WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM commands WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM usage_snapshots WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM pull_requests WHERE team_id = ?').run(id);
      this.stmt('DELETE FROM teams WHERE id = ?').run(id);
    })(teamId);
  }

  // -------------------------------------------------------------------------
  // Factory reset (delete all data, re-seed defaults)
  // -------------------------------------------------------------------------

  /**
   * Delete all data from every table (except schema_version) in a single
   * transaction, then re-seed the default message templates.
   * Returns the number of default templates that were seeded.
   */
  factoryReset(defaultTemplates: { id: string; template: string }[]): number {
    this.db.transaction(() => {
      this.stmt('DELETE FROM stream_events').run();
      this.stmt('DELETE FROM agent_messages').run();
      this.stmt('DELETE FROM team_transitions').run();
      this.stmt('DELETE FROM events').run();
      this.stmt('DELETE FROM commands').run();
      this.stmt('DELETE FROM usage_snapshots').run();
      this.stmt('DELETE FROM pull_requests').run();
      this.stmt('DELETE FROM teams').run();
      this.stmt('DELETE FROM message_templates').run();
      this.stmt('DELETE FROM project_issue_sources').run();
      this.stmt('DELETE FROM projects').run();
    })();

    // Re-seed default templates outside the transaction (uses its own)
    this.initDefaultTemplates(defaultTemplates);

    return defaultTemplates.length;
  }

  // -------------------------------------------------------------------------
  // Data retention — batched purge of old records
  // -------------------------------------------------------------------------

  /**
   * Delete events older than `retentionDays` in batches of `batchSize`.
   * Returns total number of rows deleted.
   */
  purgeOldEvents(retentionDays: number, batchSize: number = 5000): number {
    const stmt = this.stmt(
      `DELETE FROM events WHERE id IN (
        SELECT id FROM events WHERE created_at < datetime('now', '-' || @days || ' days') LIMIT @limit
      )`
    );
    let totalDeleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run({ days: retentionDays, limit: batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * Delete usage_snapshots older than `retentionDays` in batches of `batchSize`.
   * Returns total number of rows deleted.
   */
  purgeOldUsageSnapshots(retentionDays: number, batchSize: number = 5000): number {
    const stmt = this.stmt(
      `DELETE FROM usage_snapshots WHERE id IN (
        SELECT id FROM usage_snapshots WHERE recorded_at < datetime('now', '-' || @days || ' days') LIMIT @limit
      )`
    );
    let totalDeleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run({ days: retentionDays, limit: batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * Delete commands older than `retentionDays` in batches of `batchSize`.
   * Returns total number of rows deleted.
   */
  purgeOldCommands(retentionDays: number, batchSize: number = 5000): number {
    const stmt = this.stmt(
      `DELETE FROM commands WHERE id IN (
        SELECT id FROM commands WHERE created_at < datetime('now', '-' || @days || ' days') LIMIT @limit
      )`
    );
    let totalDeleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run({ days: retentionDays, limit: batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * Delete team_transitions older than `retentionDays` in batches of `batchSize`.
   * Returns total number of rows deleted.
   */
  purgeOldTeamTransitions(retentionDays: number, batchSize: number = 5000): number {
    const stmt = this.stmt(
      `DELETE FROM team_transitions WHERE id IN (
        SELECT id FROM team_transitions WHERE created_at < datetime('now', '-' || @days || ' days') LIMIT @limit
      )`
    );
    let totalDeleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run({ days: retentionDays, limit: batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * Delete agent_messages older than `retentionDays` in batches of `batchSize`.
   * Returns total number of rows deleted.
   */
  purgeOldAgentMessages(retentionDays: number, batchSize: number = 5000): number {
    const stmt = this.stmt(
      `DELETE FROM agent_messages WHERE id IN (
        SELECT id FROM agent_messages WHERE created_at < datetime('now', '-' || @days || ' days') LIMIT @limit
      )`
    );
    let totalDeleted = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = stmt.run({ days: retentionDays, limit: batchSize });
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * Delete stream_events for teams that have been stopped for more than
   * `retentionDays`. stream_events has a UNIQUE constraint on team_id
   * (one row per team), so batch size is less critical here.
   * Returns total number of rows deleted.
   */
  purgeOldStreamEvents(retentionDays: number): number {
    const result = this.stmt(
      `DELETE FROM stream_events WHERE team_id IN (
        SELECT id FROM teams
        WHERE stopped_at IS NOT NULL
          AND stopped_at < datetime('now', '-' || @days || ' days')
      )`
    ).run({ days: retentionDays });
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  /**
   * Properly close the database connection.
   * Clears the statement cache first since prepared statements become
   * invalid after the database is closed.
   */
  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }

  /**
   * Get the underlying better-sqlite3 Database instance (for advanced usage).
   */
  get raw(): Database.Database {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Row mappers (snake_case DB rows -> camelCase TypeScript interfaces)
  // -------------------------------------------------------------------------

  private mapProjectRow(row: Record<string, unknown>): Project {
    const rawConfig = (row.provider_config as string | null) ?? null;
    let providerConfig: string | null = null;
    if (rawConfig) {
      try {
        providerConfig = isEncrypted(rawConfig) ? decrypt(rawConfig) : rawConfig;
      } catch (err) {
        console.warn(`[DB] Failed to decrypt provider_config for project ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        providerConfig = null;
      }
    }

    return {
      id: row.id as number,
      name: row.name as string,
      repoPath: row.repo_path as string,
      githubRepo: row.github_repo as string | null,
      groupId: (row.group_id as number | null) ?? null,
      status: row.status as ProjectStatus,
      hooksInstalled: (row.hooks_installed as number) === 1,
      maxActiveTeams: (row.max_active_teams as number | undefined) ?? 5,
      promptFile: (row.prompt_file as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      issueProvider: (row.issue_provider as string | null) ?? 'github',
      projectKey: (row.project_key as string | null) ?? null,
      providerConfig,
      createdAt: utcify(row.created_at as string),
      updatedAt: utcify(row.updated_at as string),
    };
  }

  private mapProjectGroupRow(row: Record<string, unknown>): ProjectGroup {
    return {
      id: row.id as number,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      createdAt: utcify(row.created_at as string),
      updatedAt: utcify(row.updated_at as string),
    };
  }

  private mapIssueSourceRow(row: Record<string, unknown>): ProjectIssueSource {
    const rawCredentials = (row.credentials_json as string | null) ?? null;
    let credentialsJson: string | null = null;
    if (rawCredentials) {
      try {
        credentialsJson = isEncrypted(rawCredentials) ? decrypt(rawCredentials) : rawCredentials;
      } catch (err) {
        console.warn(`[DB] Failed to decrypt credentials_json for issue source ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        credentialsJson = null;
      }
    }

    return {
      id: row.id as number,
      projectId: row.project_id as number,
      provider: row.provider as string,
      label: (row.label as string | null) ?? null,
      configJson: row.config_json as string,
      credentialsJson,
      enabled: (row.enabled as number) === 1,
      createdAt: utcify(row.created_at as string),
    };
  }

  private mapTeamRow(row: Record<string, unknown>): Team {
    return {
      id: row.id as number,
      issueNumber: row.issue_number as number,
      issueTitle: row.issue_title as string | null,
      issueKey: (row.issue_key as string | null) ?? null,
      issueProvider: (row.issue_provider as string | null) ?? 'github',
      projectId: (row.project_id as number | null) ?? null,
      status: row.status as TeamStatus,
      phase: row.phase as TeamPhase,
      pid: row.pid as number | null,
      sessionId: row.session_id as string | null,
      worktreeName: row.worktree_name as string,
      branchName: row.branch_name as string | null,
      prNumber: row.pr_number as number | null,
      customPrompt: (row.custom_prompt as string | null) ?? null,
      headless: (row.headless as number) !== 0,
      totalInputTokens: (row.total_input_tokens as number | undefined) ?? 0,
      totalOutputTokens: (row.total_output_tokens as number | undefined) ?? 0,
      totalCacheCreationTokens: (row.total_cache_creation_tokens as number | undefined) ?? 0,
      totalCacheReadTokens: (row.total_cache_read_tokens as number | undefined) ?? 0,
      totalCostUsd: (row.total_cost_usd as number | undefined) ?? 0,
      blockedByJson: (row.blocked_by_json as string | null) ?? null,
      retryCount: (row.retry_count as number | undefined) ?? 0,
      launchedAt: utcify(row.launched_at as string | null),
      stoppedAt: utcify(row.stopped_at as string | null),
      lastEventAt: utcify(row.last_event_at as string | null),
      createdAt: utcify(row.created_at as string),
      updatedAt: utcify(row.updated_at as string),
    };
  }

  private mapEventRow(row: Record<string, unknown>): Event {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      eventType: row.event_type as string,
      sessionId: row.session_id as string | null,
      toolName: row.tool_name as string | null,
      agentName: row.agent_name as string | null,
      payload: row.payload as string | null,
      createdAt: utcify(row.created_at as string),
    };
  }

  private mapPRRow(row: Record<string, unknown>): PullRequest {
    return {
      prNumber: row.pr_number as number,
      teamId: row.team_id as number | null,
      title: (row.title as string | null) ?? null,
      state: row.state as PRState | null,
      mergeStatus: row.merge_status as MergeStatus | null,
      ciStatus: row.ci_status as CIStatus | null,
      ciFailCount: row.ci_fail_count as number,
      checksJson: row.checks_json as string | null,
      autoMerge: (row.auto_merge as number) === 1,
      mergedAt: utcify(row.merged_at as string | null),
      updatedAt: utcify(row.updated_at as string),
    };
  }

  private mapCommandRow(row: Record<string, unknown>): Command {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      targetAgent: (row.target_agent as string | null) ?? null,
      message: row.message as string,
      status: (row.status as 'pending' | 'delivered' | 'failed') ?? 'pending',
      createdAt: utcify(row.created_at as string),
      deliveredAt: utcify((row.delivered_at as string | null) ?? null),
    };
  }

  private mapUsageRow(row: Record<string, unknown>): UsageSnapshot {
    return {
      id: row.id as number,
      teamId: row.team_id as number | null,
      projectId: row.project_id as number | null,
      sessionId: row.session_id as string | null,
      dailyPercent: row.daily_percent as number,
      weeklyPercent: row.weekly_percent as number,
      sonnetPercent: row.sonnet_percent as number,
      extraPercent: row.extra_percent as number,
      dailyResetsAt: utcify((row.daily_resets_at as string | null) ?? null),
      weeklyResetsAt: utcify((row.weekly_resets_at as string | null) ?? null),
      rawOutput: row.raw_output as string | null,
      recordedAt: utcify(row.recorded_at as string),
    };
  }

  private mapDashboardRow(row: Record<string, unknown>): TeamDashboardRow {
    return {
      id: row.id as number,
      issueNumber: row.issue_number as number,
      issueTitle: row.issue_title as string | null,
      issueKey: (row.issue_key as string | null) ?? null,
      issueProvider: (row.issue_provider as string | null) ?? (row.project_issue_provider as string | null) ?? null,
      projectId: (row.project_id as number | null) ?? null,
      projectName: (row.project_name as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      status: row.status as TeamStatus,
      phase: row.phase as TeamPhase,
      worktreeName: row.worktree_name as string,
      branchName: (row.branch_name as string | null) ?? null,
      prNumber: row.pr_number as number | null,
      launchedAt: utcify((row.launched_at as string | null) ?? null),
      lastEventAt: utcify(row.last_event_at as string | null),
      durationMin: row.duration_min as number,
      idleMin: row.idle_min as number | null,
      totalInputTokens: (row.total_input_tokens as number | undefined) ?? 0,
      totalOutputTokens: (row.total_output_tokens as number | undefined) ?? 0,
      totalCacheCreationTokens: (row.total_cache_creation_tokens as number | undefined) ?? 0,
      totalCacheReadTokens: (row.total_cache_read_tokens as number | undefined) ?? 0,
      totalCostUsd: (row.total_cost_usd as number | undefined) ?? 0,
      retryCount: (row.retry_count as number | undefined) ?? 0,
      blockedByJson: (row.blocked_by_json as string | null) ?? null,
      githubRepo: (row.github_repo as string | null) ?? null,
      maxActiveTeams: (row.max_active_teams as number | null) ?? null,
      prState: (row.pr_state as PRState | null) ?? null,
      ciStatus: (row.ci_status as CIStatus | null) ?? null,
      mergeStatus: row.merge_status as MergeStatus | null,
    };
  }

  private mapAgentMessageRow(row: Record<string, unknown>): AgentMessage {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      eventId: row.event_id as number,
      sender: row.sender as string,
      recipient: row.recipient as string,
      summary: (row.summary as string | null) ?? null,
      content: (row.content as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      createdAt: utcify(row.created_at as string),
    };
  }

  // ---------------------------------------------------------------------------
  // Team Tasks
  // ---------------------------------------------------------------------------

  /**
   * Upsert a task for a team. Uses ON CONFLICT to update existing tasks
   * (keyed on team_id + task_id) or insert new ones.
   */
  upsertTeamTask(data: {
    teamId: number;
    taskId: string;
    subject: string;
    description?: string | null;
    status: string;
    owner: string;
  }): TeamTask {
    const stmt = this.stmt(`
      INSERT INTO team_tasks (team_id, task_id, subject, description, status, owner)
      VALUES (@teamId, @taskId, @subject, @description, @status, @owner)
      ON CONFLICT(team_id, task_id) DO UPDATE SET
        subject = excluded.subject,
        description = excluded.description,
        status = excluded.status,
        owner = excluded.owner,
        updated_at = datetime('now')
    `);

    stmt.run({
      teamId: data.teamId,
      taskId: data.taskId,
      subject: data.subject,
      description: data.description ?? null,
      status: data.status,
      owner: data.owner,
    });

    const row = this.stmt(
      'SELECT * FROM team_tasks WHERE team_id = ? AND task_id = ?'
    ).get(data.teamId, data.taskId) as Record<string, unknown>;

    return this.mapTeamTaskRow(row);
  }

  /**
   * Get all tasks for a team, ordered by id ascending.
   */
  getTeamTasks(teamId: number): TeamTask[] {
    const rows = this.stmt(
      'SELECT * FROM team_tasks WHERE team_id = ? ORDER BY id ASC'
    ).all(teamId) as Record<string, unknown>[];

    return rows.map((r) => this.mapTeamTaskRow(r));
  }

  private mapTeamTaskRow(row: Record<string, unknown>): TeamTask {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      taskId: row.task_id as string,
      subject: row.subject as string,
      description: (row.description as string | null) ?? null,
      status: row.status as 'pending' | 'in_progress' | 'completed',
      owner: row.owner as string,
      createdAt: utcify(row.created_at as string),
      updatedAt: utcify(row.updated_at as string),
    };
  }

  // -------------------------------------------------------------------------
  // Provider State
  // -------------------------------------------------------------------------

  /**
   * Get a persisted provider state value by key.
   * Returns undefined if the key has not been set.
   */
  getProviderState(key: string): string | undefined {
    const row = this.db.prepare(
      'SELECT value FROM provider_state WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Set (upsert) a provider state value by key.
   */
  setProviderState(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO provider_state (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value);
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: FleetDatabase | null = null;

/**
 * Get or create the singleton database instance.
 * A dbPath is required on the first call; subsequent calls return the existing instance.
 */
export function getDatabase(dbPath?: string): FleetDatabase {
  if (!_instance) {
    if (!dbPath) {
      throw new Error('getDatabase() requires a dbPath argument on first call');
    }
    _instance = new FleetDatabase(dbPath);
    _instance.initSchema();
  }
  return _instance;
}

/**
 * Close the singleton database instance. Used for graceful shutdown.
 */
export function closeDatabase(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

export default FleetDatabase;
