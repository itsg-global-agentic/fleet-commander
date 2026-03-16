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
  Event,
  Command,
  CostEntry,
  TeamDashboardRow,
  TeamStatus,
  TeamPhase,
} from '../shared/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Filter / input types
// ---------------------------------------------------------------------------

export interface TeamFilter {
  status?: TeamStatus;
  issueNumber?: number;
}

export interface EventFilter {
  teamId?: number;
  eventType?: string;
  since?: string;     // ISO 8601
  limit?: number;
}

export interface TeamInsert {
  issueNumber: number;
  issueTitle?: string | null;
  worktreeName: string;
  branchName?: string | null;
  status?: TeamStatus;
  phase?: TeamPhase;
  pid?: number | null;
  sessionId?: string | null;
  prNumber?: number | null;
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
  state?: string | null;
  ciStatus?: string | null;
  mergeState?: string | null;
  autoMerge?: boolean;
  ciFailCount?: number;
  checksJson?: string | null;
}

export interface PRUpdate {
  teamId?: number | null;
  title?: string | null;
  state?: string | null;
  ciStatus?: string | null;
  mergeState?: string | null;
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

export interface CostInsert {
  teamId: number;
  sessionId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
}

export interface CostByDay {
  day: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
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
// Database class
// ---------------------------------------------------------------------------

export class FleetDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? process.env['FLEET_DB_PATH'] ?? 'fleet.db';
    this.db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Performance pragmas
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  /**
   * Read and execute schema.sql to create all tables, indexes, and views.
   * Idempotent — uses IF NOT EXISTS throughout.
   */
  initSchema(): void {
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
   * Get the current schema version.
   */
  getSchemaVersion(): number {
    try {
      const row = this.db.prepare(
        'SELECT MAX(version) AS version FROM schema_version'
      ).get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Teams
  // -------------------------------------------------------------------------

  insertTeam(data: TeamInsert): Team {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO teams (issue_number, issue_title, worktree_name, branch_name, status, phase, pid, session_id, pr_number, launched_at, created_at, updated_at)
      VALUES (@issueNumber, @issueTitle, @worktreeName, @branchName, @status, @phase, @pid, @sessionId, @prNumber, @launchedAt, @createdAt, @updatedAt)
    `);

    const info = stmt.run({
      issueNumber: data.issueNumber,
      issueTitle: data.issueTitle ?? null,
      worktreeName: data.worktreeName,
      branchName: data.branchName ?? null,
      status: data.status ?? 'queued',
      phase: data.phase ?? 'init',
      pid: data.pid ?? null,
      sessionId: data.sessionId ?? null,
      prNumber: data.prNumber ?? null,
      launchedAt: data.launchedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return this.getTeam(Number(info.lastInsertRowid))!;
  }

  getTeam(id: number): Team | undefined {
    const stmt = this.db.prepare('SELECT * FROM teams WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTeamRow(row) : undefined;
  }

  getTeamByWorktree(name: string): Team | undefined {
    const stmt = this.db.prepare('SELECT * FROM teams WHERE worktree_name = ?');
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

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(params) as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  getActiveTeams(): Team[] {
    const stmt = this.db.prepare(
      "SELECT * FROM teams WHERE status IN ('queued', 'launching', 'running', 'idle', 'stuck') ORDER BY created_at DESC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapTeamRow(r));
  }

  updateTeam(id: number, fields: TeamUpdate): Team | undefined {
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

    if (setClauses.length === 0) return this.getTeam(id);

    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE teams SET ${setClauses.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
    return this.getTeam(id);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  insertEvent(data: EventInsert): Event {
    const stmt = this.db.prepare(`
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

    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapEventRow(row);
  }

  getEventsByTeam(teamId: number, limit?: number): Event[] {
    const sql = limit
      ? 'SELECT * FROM events WHERE team_id = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM events WHERE team_id = ? ORDER BY id DESC';

    const stmt = this.db.prepare(sql);
    const rows = (limit ? stmt.all(teamId, limit) : stmt.all(teamId)) as Record<string, unknown>[];
    return rows.map((r) => this.mapEventRow(r));
  }

  getLatestEventByTeam(teamId: number): Event | undefined {
    const stmt = this.db.prepare(
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

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEventRow(r));
  }

  // -------------------------------------------------------------------------
  // Pull Requests
  // -------------------------------------------------------------------------

  insertPullRequest(data: PRInsert): PullRequest {
    const stmt = this.db.prepare(`
      INSERT INTO pull_requests (pr_number, team_id, title, state, ci_status, merge_state, auto_merge, ci_fail_count, checks_json)
      VALUES (@prNumber, @teamId, @title, @state, @ciStatus, @mergeState, @autoMerge, @ciFailCount, @checksJson)
    `);

    stmt.run({
      prNumber: data.prNumber,
      teamId: data.teamId ?? null,
      title: data.title ?? null,
      state: data.state ?? null,
      ciStatus: data.ciStatus ?? null,
      mergeState: data.mergeState ?? null,
      autoMerge: data.autoMerge ? 1 : 0,
      ciFailCount: data.ciFailCount ?? 0,
      checksJson: data.checksJson ?? null,
    });

    return this.getPullRequest(data.prNumber)!;
  }

  getPullRequest(prNumber: number): PullRequest | undefined {
    const stmt = this.db.prepare('SELECT * FROM pull_requests WHERE pr_number = ?');
    const row = stmt.get(prNumber) as Record<string, unknown> | undefined;
    return row ? this.mapPRRow(row) : undefined;
  }

  getAllPullRequests(): PullRequest[] {
    const stmt = this.db.prepare('SELECT * FROM pull_requests ORDER BY updated_at DESC');
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
    if (fields.mergeState !== undefined) {
      setClauses.push('merge_state = @mergeState');
      params.mergeState = fields.mergeState;
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
    const stmt = this.db.prepare(`
      INSERT INTO commands (team_id, target_agent, message)
      VALUES (@teamId, @targetAgent, @message)
    `);

    const info = stmt.run({
      teamId: data.teamId,
      targetAgent: data.targetAgent ?? null,
      message: data.message,
    });

    const row = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapCommandRow(row);
  }

  getPendingCommands(teamId: number): Command[] {
    const stmt = this.db.prepare(
      "SELECT * FROM commands WHERE team_id = ? AND status = 'pending' ORDER BY created_at ASC"
    );
    const rows = stmt.all(teamId) as Record<string, unknown>[];
    return rows.map((r) => this.mapCommandRow(r));
  }

  markCommandDelivered(id: number): Command | undefined {
    this.db.prepare(
      "UPDATE commands SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?"
    ).run(id);

    const row = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapCommandRow(row) : undefined;
  }

  // -------------------------------------------------------------------------
  // Cost Entries
  // -------------------------------------------------------------------------

  insertCostEntry(data: CostInsert): CostEntry {
    const stmt = this.db.prepare(`
      INSERT INTO cost_entries (team_id, session_id, input_tokens, output_tokens, cost_usd)
      VALUES (@teamId, @sessionId, @inputTokens, @outputTokens, @costUsd)
    `);

    const info = stmt.run({
      teamId: data.teamId,
      sessionId: data.sessionId ?? null,
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      costUsd: data.costUsd ?? 0,
    });

    const row = this.db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(
      Number(info.lastInsertRowid)
    ) as Record<string, unknown>;
    return this.mapCostRow(row);
  }

  getCostByTeam(teamId: number): CostSummary {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COUNT(*) AS entry_count
      FROM cost_entries
      WHERE team_id = ?
    `);

    const row = stmt.get(teamId) as Record<string, unknown>;
    return {
      totalCostUsd: row.total_cost_usd as number,
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      entryCount: row.entry_count as number,
    };
  }

  getCostSummary(): CostSummary {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COUNT(*) AS entry_count
      FROM cost_entries
    `);

    const row = stmt.get() as Record<string, unknown>;
    return {
      totalCostUsd: row.total_cost_usd as number,
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      entryCount: row.entry_count as number,
    };
  }

  getCostByDay(): CostByDay[] {
    const stmt = this.db.prepare(`
      SELECT
        date(recorded_at) AS day,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COUNT(*) AS entry_count
      FROM cost_entries
      GROUP BY date(recorded_at)
      ORDER BY day DESC
    `);

    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => ({
      day: r.day as string,
      totalCostUsd: r.total_cost_usd as number,
      totalInputTokens: r.total_input_tokens as number,
      totalOutputTokens: r.total_output_tokens as number,
      entryCount: r.entry_count as number,
    }));
  }

  /**
   * Get cost summary broken down by team (all teams).
   * Includes team metadata (issue number, title, status, duration, session count).
   */
  getCostByTeamBreakdown(): Array<CostSummary & {
    teamId: number;
    worktreeName: string;
    issueNumber: number;
    issueTitle: string | null;
    status: TeamStatus;
    sessionCount: number;
    durationMin: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        c.team_id,
        t.worktree_name,
        t.issue_number,
        t.issue_title,
        t.status,
        COUNT(DISTINCT c.session_id) AS session_count,
        ROUND((julianday('now') - julianday(t.launched_at)) * 24 * 60, 0) AS duration_min,
        COALESCE(SUM(c.cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(c.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(c.output_tokens), 0) AS total_output_tokens,
        COUNT(*) AS entry_count
      FROM cost_entries c
      JOIN teams t ON t.id = c.team_id
      GROUP BY c.team_id
      ORDER BY total_cost_usd DESC
    `);

    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => ({
      teamId: r.team_id as number,
      worktreeName: r.worktree_name as string,
      issueNumber: r.issue_number as number,
      issueTitle: r.issue_title as string | null,
      status: r.status as TeamStatus,
      sessionCount: r.session_count as number,
      durationMin: r.duration_min as number,
      totalCostUsd: r.total_cost_usd as number,
      totalInputTokens: r.total_input_tokens as number,
      totalOutputTokens: r.total_output_tokens as number,
      entryCount: r.entry_count as number,
    }));
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
  // Views / aggregations
  // -------------------------------------------------------------------------

  getTeamDashboard(): TeamDashboardRow[] {
    const stmt = this.db.prepare('SELECT * FROM v_team_dashboard');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapDashboardRow(r));
  }

  /**
   * Get teams that may be idle or stuck based on time since last event.
   * @param idleMinutes  - minutes of silence before considered idle (default: 5)
   * @param stuckMinutes - minutes of silence before considered stuck (default: 15)
   */
  getStuckCandidates(idleMinutes: number = 5, stuckMinutes: number = 15): StuckCandidate[] {
    const stmt = this.db.prepare(`
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
      ORDER BY minutes_since_last_event DESC
    `);

    const rows = stmt.all({ idleMinutes }) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      issueNumber: r.issue_number as number,
      issueTitle: r.issue_title as string | null,
      worktreeName: r.worktree_name as string,
      status: r.status as TeamStatus,
      phase: r.phase as TeamPhase,
      lastEventAt: r.last_event_at as string | null,
      minutesSinceLastEvent: r.minutes_since_last_event as number,
    }));
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  /**
   * Properly close the database connection.
   */
  close(): void {
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

  private mapTeamRow(row: Record<string, unknown>): Team {
    return {
      id: row.id as number,
      issueNumber: row.issue_number as number,
      issueTitle: row.issue_title as string | null,
      status: row.status as TeamStatus,
      phase: row.phase as TeamPhase,
      pid: row.pid as number | null,
      sessionId: row.session_id as string | null,
      worktreeName: row.worktree_name as string,
      worktreePath: null, // not stored in v1 schema; reserved for future use
      branchName: row.branch_name as string | null,
      prNumber: row.pr_number as number | null,
      launchedAt: row.launched_at as string,
      stoppedAt: row.stopped_at as string | null,
      lastEventAt: row.last_event_at as string | null,
      createdAt: row.created_at as string,
    };
  }

  private mapEventRow(row: Record<string, unknown>): Event {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      hookType: row.event_type as string,
      sessionId: row.session_id as string | null,
      toolName: row.tool_name as string | null,
      agentType: row.agent_name as string | null,
      payload: row.payload as string | null,
      createdAt: row.created_at as string,
    };
  }

  private mapPRRow(row: Record<string, unknown>): PullRequest {
    return {
      prNumber: row.pr_number as number,
      teamId: row.team_id as number | null,
      state: row.state as string | null,
      mergeStatus: row.merge_state as string | null,
      ciStatus: row.ci_status as string | null,
      ciConclusion: null, // not in v1 schema; reserved for future use
      ciFailCount: row.ci_fail_count as number,
      checksJson: row.checks_json as string | null,
      autoMerge: (row.auto_merge as number) === 1,
      lastPolledAt: null, // not in v1 schema; reserved for future use
      updatedAt: row.updated_at as string,
    };
  }

  private mapCommandRow(row: Record<string, unknown>): Command {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      message: row.message as string,
      sentAt: row.created_at as string,
      delivered: row.status === 'delivered',
    };
  }

  private mapCostRow(row: Record<string, unknown>): CostEntry {
    return {
      id: row.id as number,
      teamId: row.team_id as number,
      sessionId: row.session_id as string | null,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      costUsd: row.cost_usd as number,
      recordedAt: row.recorded_at as string,
    };
  }

  private mapDashboardRow(row: Record<string, unknown>): TeamDashboardRow {
    return {
      id: row.id as number,
      issueNumber: row.issue_number as number,
      issueTitle: row.issue_title as string | null,
      status: row.status as TeamStatus,
      phase: row.phase as TeamPhase,
      worktreeName: row.worktree_name as string,
      prNumber: row.pr_number as number | null,
      launchedAt: row.launched_at as string,
      lastEventAt: row.last_event_at as string | null,
      durationMin: row.duration_min as number,
      idleMin: row.idle_min as number | null,
      totalCost: row.total_cost as number,
      sessionCount: row.session_count as number,
      prState: row.pr_state as string | null,
      ciStatus: row.ci_status as string | null,
      mergeStatus: row.merge_status as string | null,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: FleetDatabase | null = null;

/**
 * Get or create the singleton database instance.
 * Call with a path to override the default on first use.
 */
export function getDatabase(dbPath?: string): FleetDatabase {
  if (!_instance) {
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
