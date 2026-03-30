// =============================================================================
// Fleet Commander — Shared TypeScript Types (v1, aligned with PRD section 4)
// =============================================================================

// ---------------------------------------------------------------------------
// Enums / Union Types
// ---------------------------------------------------------------------------

/** Team operational status */
export type TeamStatus = 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed';

/** Terminal statuses — teams in these states should not be transitioned by hook events */
export const TERMINAL_STATUSES: ReadonlySet<TeamStatus> = new Set(['done', 'failed']);

/** Team domain phase */
export type TeamPhase = 'init' | 'analyzing' | 'implementing' | 'reviewing' | 'pr' | 'done' | 'blocked';

/** Pull request state */
export type PRState = 'draft' | 'open' | 'merged' | 'closed';

/** CI pipeline status */
export type CIStatus = 'none' | 'pending' | 'passing' | 'failing';

/** PR merge readiness status (from GitHub mergeStateStatus) */
export type MergeStatus = 'unknown' | 'clean' | 'behind' | 'blocked' | 'dirty' | 'unstable' | 'has_hooks' | 'draft';

/** Project status */
export type ProjectStatus = 'active' | 'archived';

/** Usage zone for queue gating */
export type UsageZone = 'green' | 'red';

// ---------------------------------------------------------------------------
// Core Entities (matching PRD section 4 schema)
// ---------------------------------------------------------------------------

/** A logical group of projects (repos) */
export interface ProjectGroup {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A project representing a local git repository */
export interface Project {
  id: number;
  name: string;
  repoPath: string;
  githubRepo: string | null;
  groupId: number | null;
  status: ProjectStatus;
  hooksInstalled: boolean;
  maxActiveTeams: number;
  promptFile: string | null;
  model?: string | null;
  issueProvider: string | null;
  projectKey: string | null;
  providerConfig: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An issue source configuration for a project (multi-provider support) */
export interface ProjectIssueSource {
  id: number;
  projectId: number;
  provider: string;        // 'github' | 'jira' | 'linear'
  label: string | null;
  configJson: string;      // JSON: provider-specific config
  credentialsJson: string | null;
  enabled: boolean;
  createdAt: string;
}

/** API response shape for issue sources — credentials stripped, hasCredentials flag added */
export interface ProjectIssueSourceResponse {
  id: number;
  projectId: number;
  provider: string;
  label: string | null;
  configJson: string;
  hasCredentials: boolean;
  enabled: boolean;
  createdAt: string;
}

/** Jira source configuration stored in configJson */
export interface JiraSourceConfig {
  jiraUrl: string;
  projectKey: string;
}

/** Jira source credentials stored in credentialsJson (encrypted at rest) */
export interface JiraSourceCredentials {
  email: string;
  apiToken: string;
}

/** GitHub auth mode: gh CLI (default, no credentials needed) or PAT */
export type GitHubAuthMode = 'gh-cli' | 'pat';

/** GitHub source configuration stored in configJson */
export interface GitHubSourceConfig {
  owner: string;
  repo: string;
  authMode: GitHubAuthMode;
}

/** GitHub source credentials stored in credentialsJson (encrypted at rest) */
export interface GitHubSourceCredentials {
  pat: string;
}

/** Detailed file-level info for a single install artifact */
export interface InstallFileStatus {
  name: string;
  exists: boolean;
  hasCrlf?: boolean;
  /** Version stamp found in the installed file (e.g. "0.0.6"), or undefined if absent */
  installedVersion?: string;
  /** Current Fleet Commander version for comparison */
  currentVersion?: string;
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

/** GitHub repository settings (auto-merge, branch protection) */
export interface RepoSettings {
  autoMergeEnabled: boolean;
  defaultBranch: string;
  branchProtection?: {
    enabled: boolean;
    requiredChecks: string[];
  };
}

/** Health status for git commit check */
export type GitCommitHealth = 'green' | 'amber' | 'red' | 'unknown';

/** Per-file git commit status */
export interface GitCommitFileStatus {
  /** Relative path from repo root (e.g. ".claude/agents/fleet-planner.md") */
  path: string;
  /** Whether the file is committed to the default branch */
  committed: boolean;
  /** Version stamp found in the committed copy */
  committedVersion?: string;
  /** Current FC version for comparison */
  currentVersion?: string;
}

/** Git commit status for .claude/ files on the default branch */
export interface GitCommitStatus {
  /** Overall health: red = not committed/gitignored, amber = outdated, green = all good */
  health: GitCommitHealth;
  /** Whether .claude is in .gitignore */
  gitignored: boolean;
  /** Default branch name used for the check */
  defaultBranch: string;
  /** Per-file commit status */
  files: GitCommitFileStatus[];
  /** Summary message for the UI */
  message: string;
}

/** Detailed install status for the artifacts deployed by install.sh */
export interface InstallStatus {
  hooks: InstallHooksStatus;
  prompt: InstallCategoryStatus;
  agents: InstallCategoryStatus;
  guides?: InstallCategoryStatus;
  settings: InstallFileStatus;
  repoSettings?: RepoSettings;
  /** Number of installed files whose version stamp does not match the current FC version */
  outdatedCount: number;
  /** Current Fleet Commander version */
  currentVersion: string;
  /** Git commit status for .claude/ files on the default branch */
  gitCommitStatus?: GitCommitStatus;
}

/** Result of a project readiness check for launching teams */
export interface ProjectReadiness {
  /** Whether the project is ready for team launches */
  ready: boolean;
  /** Non-blocking issues (e.g. outdated files) — launch is allowed */
  warnings: string[];
  /** Blocking issues (e.g. hooks not installed) — launch is denied */
  errors: string[];
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
  issueKey: string | null;
  issueProvider: string | null;
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  launchedAt: string | null;
  stoppedAt: string | null;
  lastEventAt: string | null;
  blockedByJson: string | null;
  retryCount: number;
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
// Team Roster (subagent members derived from events)
// ---------------------------------------------------------------------------

/** A subagent team member derived from hook events */
export interface TeamMember {
  name: string;
  role: string;
  isActive: boolean;
  firstSeen: string;
  lastSeen: string;
  toolUseCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Agent Messages (inter-agent message routing)
// ---------------------------------------------------------------------------

/** A routed message between agents captured from SendMessage tool use */
export interface AgentMessage {
  id: number;
  teamId: number;
  eventId: number;
  sender: string;
  recipient: string;
  summary: string | null;
  content: string | null;
  sessionId: string | null;
  createdAt: string;
}

/** A task item from the TL's task list (TodoWrite/TaskCreate) */
export interface TeamTask {
  id: number;
  teamId: number;
  taskId: string;
  subject: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed';
  owner: string;
  createdAt: string;
  updatedAt: string;
}

/** Aggregated edge for the communication graph (sender -> recipient) */
export interface MessageEdge {
  sender: string;
  recipient: string;
  count: number;
  lastSummary: string | null;
}

// ---------------------------------------------------------------------------
// Issue Dependencies (GitHub issue dependency tracking)
// ---------------------------------------------------------------------------

/** A single dependency reference (blocking issue) */
export interface DependencyRef {
  /** Issue number of the blocker */
  number: number;
  /** Repository owner (e.g. "octocat") */
  owner: string;
  /** Repository name (e.g. "hello-world") */
  repo: string;
  /** Current state of the blocking issue */
  state: 'open' | 'closed';
  /** Issue title */
  title: string;
  /** Universal issue key (e.g. "PROJ-123" for Jira). Undefined for GitHub deps. */
  issueKey?: string;
  /** Direct URL to the dependency in its provider's UI */
  url?: string;
}

/** Dependency info for an issue */
export interface IssueDependencyInfo {
  /** The issue these dependencies belong to */
  issueNumber: number;
  /** Universal issue key (e.g. "42", "PROJ-123") */
  issueKey?: string;
  /** Issues that block this one */
  blockedBy: DependencyRef[];
  /** Whether all blockers are resolved (closed) */
  resolved: boolean;
  /** Number of open (unresolved) blockers */
  openCount: number;
}

// ---------------------------------------------------------------------------
// Dashboard View (v_team_dashboard)
// ---------------------------------------------------------------------------

/** Aggregated row from the v_team_dashboard view */
export interface TeamDashboardRow {
  id: number;
  issueNumber: number;
  issueTitle: string | null;
  issueKey: string | null;
  issueProvider: string | null;
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  retryCount: number;
  blockedByJson: string | null;
  githubRepo: string | null;
  maxActiveTeams: number | null;
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
  issueKey: string | null;
  issueProvider: string | null;
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  retryCount: number;
  githubRepo?: string | null;
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

// ---------------------------------------------------------------------------
// Unified Timeline (merged session log + hook events)
// ---------------------------------------------------------------------------

/** Base fields shared by all timeline entries */
interface BaseTimelineEntry {
  id: string;
  source: 'stream' | 'hook';
  timestamp: string;
  teamId: number;
}

/** A timeline entry originating from the Claude Code stream (stdout) */
export interface StreamTimelineEntry extends BaseTimelineEntry {
  source: 'stream';
  streamType: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  tool?: { name?: string; input?: unknown };
  /** Agent name derived from parent_tool_use_id mapping (e.g. 'team-lead', 'dev', 'planner') */
  agentName?: string;
  /** Human-readable description from system/task_progress events */
  description?: string;
  /** Last tool name from system/task_progress events */
  lastToolName?: string;
}

/** A timeline entry originating from a hook event (DB) */
export interface HookTimelineEntry extends BaseTimelineEntry {
  source: 'hook';
  eventType: string;
  toolName?: string;
  agentName?: string;
  payload?: string;
}

/** Discriminated union of all timeline entry types */
export type TimelineEntry = StreamTimelineEntry | HookTimelineEntry;

// ---------------------------------------------------------------------------
// Pagination (offset/limit envelope)
// ---------------------------------------------------------------------------

/** Paginated response envelope for list endpoints */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}
