// =============================================================================
// Fleet Commander — Shared TypeScript Types (v1, aligned with PRD section 4)
// =============================================================================

// ---------------------------------------------------------------------------
// Enums / Union Types
// ---------------------------------------------------------------------------

/** Team operational status */
export type TeamStatus = 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed';

/** Team domain phase */
export type TeamPhase = 'init' | 'analyzing' | 'implementing' | 'reviewing' | 'pr' | 'done' | 'blocked';

/** Pull request state */
export type PRState = 'draft' | 'open' | 'merged' | 'closed';

/** CI pipeline status */
export type CIStatus = 'none' | 'pending' | 'passing' | 'failing';

/** PR merge readiness status (from GitHub mergeStateStatus) */
export type MergeStatus = 'unknown' | 'clean' | 'behind' | 'blocked' | 'dirty' | 'unstable' | 'has_hooks' | 'draft';

/** Project status */
export type ProjectStatus = 'active' | 'paused' | 'archived';

/** Usage zone for queue gating */
export type UsageZone = 'green' | 'red';

// ---------------------------------------------------------------------------
// Core Entities (matching PRD section 4 schema)
// ---------------------------------------------------------------------------

/** A project representing a local git repository */
export interface Project {
  id: number;
  name: string;
  repoPath: string;
  githubRepo: string | null;
  status: ProjectStatus;
  hooksInstalled: boolean;
  maxActiveTeams: number;
  promptFile: string | null;
  model?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Detailed file-level info for a single install artifact */
export interface InstallFileStatus {
  name: string;
  exists: boolean;
  hasCrlf?: boolean;
}

/** Detailed install status for a single category */
export interface InstallCategoryStatus {
  installed: boolean;
  files: InstallFileStatus[];
}

/** Detailed install status for hooks (includes counts) */
export interface InstallHooksStatus extends InstallCategoryStatus {
  total: number;
  found: number;
}

/** Detailed install status for the artifacts deployed by install.sh */
export interface InstallStatus {
  hooks: InstallHooksStatus;
  prompt: InstallCategoryStatus;
  agents: InstallCategoryStatus;
  settings: InstallFileStatus;
}

/** Project with team count for list view */
export interface ProjectSummary extends Project {
  teamCount: number;
  activeTeamCount: number;
  queuedTeamCount: number;
  installStatus?: InstallStatus;
}

/** A team of agents working on a single issue in a worktree */
export interface Team {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  projectId: number | null;
  status: TeamStatus;
  phase: TeamPhase;
  pid: number | null;
  sessionId: string | null;
  worktreeName: string;
  branchName: string | null;
  prNumber: number | null;
  customPrompt: string | null;
  headless: boolean;
  launchedAt: string | null;
  stoppedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A pull request associated with a team */
export interface PullRequest {
  prNumber: number;
  teamId: number | null;
  title: string | null;
  state: PRState | null;
  mergeStatus: MergeStatus | null;
  ciStatus: CIStatus | null;
  ciFailCount: number;
  checksJson: string | null;
  autoMerge: boolean;
  mergedAt: string | null;
  updatedAt: string;
}

/** A hook event received from a Claude Code instance */
export interface Event {
  id: number;
  teamId: number;
  eventType: string;
  sessionId: string | null;
  toolName: string | null;
  agentName: string | null;
  payload: string | null;
  createdAt: string;
}

/** A team state transition record */
export interface TeamTransition {
  id: number;
  teamId: number;
  fromStatus: TeamStatus;
  toStatus: TeamStatus;
  trigger: string;
  reason: string;
  createdAt: string;
}

/** A command from the PM to a team */
export interface Command {
  id: number;
  teamId: number;
  targetAgent: string | null;
  message: string;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
  deliveredAt: string | null;
}

/** A usage snapshot for tracking usage percentages */
export interface UsageSnapshot {
  id: number;
  teamId: number | null;
  projectId: number | null;
  sessionId: string | null;
  dailyPercent: number;
  weeklyPercent: number;
  sonnetPercent: number;
  extraPercent: number;
  dailyResetsAt: string | null;
  weeklyResetsAt: string | null;
  rawOutput: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Cleanup (v2 — preview + selective confirm)
// ---------------------------------------------------------------------------

/** A single item that could be cleaned up */
export interface CleanupItem {
  type: 'worktree' | 'signal_file' | 'stale_branch' | 'team_record';
  name: string;
  path: string;
  reason: string;
}

/** Preview of what would be cleaned (dry run) */
export interface CleanupPreview {
  projectId: number;
  projectName: string;
  items: CleanupItem[];
}

/** Result of executing a confirmed cleanup */
export interface CleanupResult {
  removed: string[];
  failed: { name: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Message Templates (editable notification templates)
// ---------------------------------------------------------------------------

/** An editable message template stored in the database */
export interface MessageTemplate {
  id: string;
  template: string;
  enabled: boolean;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CC Query Service (structured queries to Claude Code)
// ---------------------------------------------------------------------------

/** Generic result wrapper for all CC query responses */
export interface CCQueryResult<T> {
  success: boolean;
  data?: T;
  text?: string;
  costUsd: number;
  durationMs: number;
  error?: string;
}

/** Issue category determined by AI prioritization */
export type IssueCategory = 'critical-bug' | 'bug' | 'perf' | 'feature' | 'refactor' | 'cleanup';

/** A single issue with computed priority from CC analysis */
export interface PrioritizedIssue {
  number: number;
  title: string;
  /** Priority score from 1 (highest) to 10 (lowest) */
  priority: number;
  category: IssueCategory;
  reason: string;
}

/** Complexity estimate for an issue */
export interface ComplexityEstimate {
  complexity: 'low' | 'medium' | 'high';
  estimatedHours: number;
  reason: string;
  risks: string[];
}

/** Lightweight issue summary used as input to query methods */
export interface IssueSummary {
  number: number;
  title: string;
  labels: string[];
}

/** Constraints for queue assignment planning */
export interface QueueConstraints {
  maxConcurrent: number;
  preferredOrder?: 'priority' | 'complexity' | 'fifo';
}

/** Ordered assignment plan returned by CC */
export interface AssignmentPlan {
  order: { number: number; reason: string }[];
  estimatedTotalHours: number;
}

// ---------------------------------------------------------------------------
// Dashboard View (v_team_dashboard)
// ---------------------------------------------------------------------------

/** Aggregated row from the v_team_dashboard view */
export interface TeamDashboardRow {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  projectId: number | null;
  projectName: string | null;
  model: string | null;
  status: TeamStatus;
  phase: TeamPhase;
  worktreeName: string;
  branchName: string | null;
  prNumber: number | null;
  launchedAt: string | null;
  lastEventAt: string | null;
  durationMin: number;
  idleMin: number | null;
  prState: PRState | null;
  ciStatus: CIStatus | null;
  mergeStatus: MergeStatus | null;
}

// ---------------------------------------------------------------------------
// Team Detail (full detail returned by GET /api/teams/:id)
// ---------------------------------------------------------------------------

/** Individual CI check result */
export interface CICheck {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Full team detail returned by GET /api/teams/:id */
export interface TeamDetail {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  model?: string | null;
  status: TeamStatus;
  phase: TeamPhase;
  pid: number | null;
  sessionId: string | null;
  worktreeName: string;
  branchName: string | null;
  prNumber: number | null;
  launchedAt: string | null;
  stoppedAt: string | null;
  lastEventAt: string | null;
  durationMin: number;
  idleMin: number | null;
  pr: {
    number: number;
    state: PRState | null;
    mergeStatus: MergeStatus | null;
    ciStatus: CIStatus | null;
    ciFailCount: number;
    checks: CICheck[];
    autoMerge: boolean;
  } | null;
  recentEvents: Event[];
  outputTail: string | null;
}
