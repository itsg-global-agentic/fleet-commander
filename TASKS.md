# Fleet Commander - Task List

## Overview

Fleet Commander is a TypeScript web dashboard for orchestrating multiple Claude Code agent teams working on GitHub issues. The repository currently contains design documents (PRD, state machines, data model, types), implemented hook shell scripts (10 bash scripts including `send_event.sh`), and an MCP server (`fleet-mcp-server`). This task list covers building the complete application: Fastify backend, SQLite database layer, core services, React frontend, and integration/testing.

**Tech stack:** Fastify + TypeScript + Node.js 20+ | React + Vite + Tailwind CSS | SQLite (better-sqlite3, WAL) | SSE | gh CLI | child_process.spawn

**What already exists:**
- Hook scripts: `hooks/send_event.sh` + 9 wrapper scripts + `settings.json.example`
- MCP server: `mcp/src/server.ts`, `dashboard-client.ts`, `detect-team.ts`, `types.ts` (built, with `dist/`)
- Design docs: `docs/prd.md` (1051 lines), `docs/state-machines.md`, `docs/data-model.sql`, `docs/types.ts`

---

## Tasks

### T01: Project Scaffolding and Build Configuration
**Priority:** P0
**Depends on:** none
**Estimated complexity:** M
**Description:** Set up the monorepo-style project structure with separate backend and frontend builds. Create the root `package.json` with workspaces or scripts for both server and client. Configure TypeScript for the backend (`src/server/`), Vite + React + TypeScript for the frontend (`src/client/`), and Tailwind CSS with the dark theme from the PRD. Set up shared types between client and server. Configure path aliases, dev scripts (`dev`, `build`, `start`), and ensure the existing `mcp/` and `hooks/` directories remain untouched.

**Key files to create:**
- `package.json` (root)
- `tsconfig.json` (root, backend)
- `tsconfig.client.json` (frontend)
- `vite.config.ts`
- `tailwind.config.ts` with dark theme colors (Base: `#0D1117`, Surface: `#161B22`, Text: `#E6EDF3`, Accent: `#58A6FF`)
- `src/server/index.ts` (minimal Fastify entry point, port 4680)
- `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx` (minimal React shell)
- `src/shared/types.ts` (shared type definitions derived from `docs/types.ts`)

**Acceptance criteria:**
- [ ] `npm install` succeeds
- [ ] `npm run dev` starts both Fastify (port 4680) and Vite dev server (proxied)
- [ ] `npm run build` produces `dist/server/` and `dist/client/` outputs
- [ ] TypeScript compiles with strict mode, no errors
- [ ] Tailwind CSS produces dark-themed output with the PRD color tokens
- [ ] Visiting `http://localhost:4680` shows a minimal "Fleet Commander" page
- [ ] Existing `mcp/` and `hooks/` directories are not modified

---

### T02: SQLite Database Layer
**Priority:** P0
**Depends on:** T01
**Estimated complexity:** M
**Description:** Implement the database layer using `better-sqlite3` with WAL mode. Create schema initialization based on the PRD section 4 schema (`teams`, `pull_requests`, `events`, `commands`, `cost_entries` tables plus the `v_team_dashboard` view). This is the canonical schema for v1. Note: `docs/data-model.sql` contains an expanded schema (with `issues`, `sessions`, `agents`, `ci_runs` tables and 3 views) that can be referenced for future expansion, but v1 should use the simpler PRD schema. Build a `Database` class wrapping all queries as prepared statements. Include schema migration support (version table). The DB file should be created at a configurable path (default: `fleet.db` in project root) and be gitignored.

**Key files to create:**
- `src/server/db.ts` — Database class with connection management, schema init, WAL mode
- `src/server/schema.sql` — DDL statements (tables, indexes, views from PRD section 4)

**Key queries to implement as methods:**
- `insertTeam()`, `getTeam()`, `getTeams()`, `updateTeam()`, `getActiveTeams()`
- `insertEvent()`, `getEventsByTeam()`, `getLatestEventByTeam()`
- `insertPullRequest()`, `getPullRequest()`, `updatePullRequest()`
- `insertCommand()`, `getPendingCommands()`
- `insertCostEntry()`, `getCostByTeam()`
- `getTeamDashboard()` — uses the `v_team_dashboard` view
- `getStuckCandidates()` — teams where last_event_at exceeds thresholds
- `getAllEvents()` — query all events (filterable by team, type, time range)

**Acceptance criteria:**
- [ ] Database file is created on first run with full schema
- [ ] WAL mode is enabled (`PRAGMA journal_mode=WAL`)
- [ ] All CRUD operations work for each table
- [ ] Prepared statements are used (not string interpolation)
- [ ] `v_team_dashboard` view returns correctly joined data
- [ ] Schema version is tracked; re-running init is idempotent
- [ ] Database handle is properly closed on server shutdown

---

### T03: Server Configuration Module
**Priority:** P0
**Depends on:** T01
**Estimated complexity:** S
**Description:** Create the configuration module that centralizes all tunable parameters. Values come from environment variables with sensible defaults matching the PRD. The config object should be frozen after initialization.

**Key file:** `src/server/config.ts`

**Configuration values (from PRD section 15):**
- `port`: 4680
- `repoRoot`: `FLEET_REPO_ROOT` env or auto-detected via `git rev-parse --show-toplevel`
- `githubRepo`: `FLEET_GITHUB_REPO` env or `itsg-global-agentic/itsg-kea`
- `githubPollIntervalMs`: 30000
- `issuePollIntervalMs`: 60000
- `stuckCheckIntervalMs`: 60000
- `idleThresholdMin`: 5
- `stuckThresholdMin`: 15
- `maxUniqueCiFailures`: 3
- `claudeCmd`: `claude`
- `defaultPrompt`: `/next-issue-kea`
- `dbPath`: `fleet.db`

**Acceptance criteria:**
- [ ] All config values have defaults matching the PRD
- [ ] Environment variables override defaults
- [ ] Config object is exported as a frozen singleton
- [ ] Invalid values (e.g., negative port) throw on startup
- [ ] `GET /api/config` endpoint can return the non-sensitive config values

---

### T04: Event Collector (POST /api/events + GET /api/events)
**Priority:** P0
**Depends on:** T02, T03
**Estimated complexity:** M
**Description:** Implement the HTTP endpoints that receive and query hook events from Claude Code instances. The POST endpoint is the most critical -- it must be fast, never reject valid payloads, and handle high volume (up to 240 events/minute from 4 agents). Parse the JSON payload from `send_event.sh` (fields: `event`, `team`, `timestamp`, `session_id`, `tool_name`, `agent_type`, `teammate_name`, `message`, `stop_reason`, `worktree_root`). Resolve the team name to a `team_id` in the database (auto-create team row if unknown team name arrives). Insert into the `events` table. Update `teams.last_event_at`. Apply state machine transitions (e.g., `session_start` on a `launching` team -> `running`). Emit to SSE broker after processing. Also implement `GET /api/events` for querying events across teams with filters.

**Key files:**
- `src/server/routes/events.ts` — Fastify route handler
- `src/server/services/event-collector.ts` — business logic, state transitions

**Event-to-transition mapping (from `docs/state-machines.md` section 5):**
- `session_start` -> team `launching` -> `running`; create/update session row
- `session_end` -> check if all sessions ended -> potentially `done`; mark session `ended`
- `stop` -> record stop, track stop frequency
- `subagent_start` / `subagent_stop` -> update agent status
- `notification` -> record, flag if accumulating without tool_use
- `tool_use` -> update `last_event_at` (heartbeat)
- `tool_error` -> update `last_event_at`, increment error count
- `pre_compact` -> record context pressure signal

**Acceptance criteria:**
- [ ] `POST /api/events` accepts JSON payloads matching hook format
- [ ] Returns 200 with `{event_id, team_id, processed: true}` on success
- [ ] Unknown team names auto-create a team row in `queued`/`launching` status
- [ ] `teams.last_event_at` is updated on every relevant event
- [ ] State machine transitions fire correctly (launching->running on session_start)
- [ ] Malformed payloads return 400 but never crash the server
- [ ] Events are inserted into the `events` table with all available fields
- [ ] Response time is < 50ms under normal load
- [ ] `GET /api/events` returns events filterable by `?team_id=`, `?type=`, `?since=`, `?limit=`

---

### T05: SSE Broker (Real-time Updates)
**Priority:** P0
**Depends on:** T01, T03
**Estimated complexity:** M
**Description:** Implement Server-Sent Events broker for pushing real-time updates to connected dashboard clients. Support multiple concurrent connections. Broadcast events for: team status changes, new hook events, PR/CI updates, cost updates, team launch/stop. Support filtered subscriptions via `?teams=1,2,3` query parameter. Include heartbeat keepalive (every 30s) to prevent connection drops. Handle client disconnection gracefully.

**Key files:**
- `src/server/services/sse-broker.ts` — connection management, broadcast logic
- `src/server/routes/stream.ts` — `GET /api/stream` endpoint

**SSE event types:**
- `team_status_changed` — `{team_id, status, previous_status}`
- `team_event` — `{team_id, event_type, event_id}`
- `pr_updated` — `{pr_number, team_id, ci_status, merge_status}`
- `team_launched` — `{team_id, issue_number}`
- `team_stopped` — `{team_id}`
- `cost_updated` — `{team_id, total_cost_usd}`
- `heartbeat` — `{timestamp}`

**Acceptance criteria:**
- [ ] `GET /api/stream` returns `text/event-stream` with proper headers
- [ ] Multiple browser tabs can connect simultaneously
- [ ] `?teams=1,2,3` filters events to only specified team IDs
- [ ] Heartbeat events are sent every 30 seconds
- [ ] Client disconnection is detected and connection is cleaned up
- [ ] `sseBroadcast()` function is callable from any service
- [ ] Events follow SSE format: `event: <type>\ndata: <json>\n\n`

---

### T06: Team Manager Service (Spawn/Stop/Resume)
**Priority:** P0
**Depends on:** T02, T03, T05
**Estimated complexity:** L
**Description:** Implement the core service that manages Claude Code process lifecycle. Handles launching new teams (creating git worktrees, spawning `claude` via `child_process.spawn`), stopping teams (process termination via `taskkill` on Windows), and resuming stopped teams. Maintains a rolling output buffer (last 500 lines of stdout/stderr per team). Tracks PIDs and handles process exit events. Copies hook scripts and `settings.json` to new worktrees.

**Key files:**
- `src/server/services/team-manager.ts`
- `src/server/routes/teams.ts` — route handlers for team lifecycle endpoints

**Endpoints to implement:**
- `POST /api/teams/launch` — `{issueNumber, prompt?}` -> create worktree + spawn process
- `POST /api/teams/launch-batch` — `{issues: number[], prompt?, delayMs?}`
- `POST /api/teams/:id/stop` — kill process tree
- `POST /api/teams/:id/resume` — re-spawn with `--resume` flag
- `POST /api/teams/:id/restart` — stop then relaunch
- `POST /api/teams/stop-all` — stop all running teams
- `GET /api/teams` — list all teams with dashboard data
- `GET /api/teams/:id` — full team detail
- `GET /api/teams/:id/status` — compact status (MCP-compatible)
- `GET /api/teams/:id/output` — stdout/stderr buffer
- `GET /api/teams/:id/events` — event log
- `GET /api/teams/:id/sessions` — session history

**Acceptance criteria:**
- [ ] `POST /api/teams/launch` creates a git worktree and spawns a `claude` process
- [ ] Process PID is stored in the database
- [ ] Stdout/stderr are captured in a rolling buffer (retrievable via `/output`)
- [ ] Process exit is detected and team status is updated accordingly
- [ ] `POST /api/teams/:id/stop` kills the process tree (Windows `taskkill /F /T /PID`)
- [ ] `POST /api/teams/:id/resume` spawns `claude --worktree <name> --resume`
- [ ] Hook scripts are copied to new worktree `.claude/hooks/fleet-commander/`
- [ ] `settings.json` is deployed to new worktree `.claude/` directory
- [ ] SSE events are broadcast on launch/stop/resume
- [ ] Batch launch respects `delayMs` stagger between spawns

---

### T07: Stuck Detector Service
**Priority:** P1
**Depends on:** T02, T05
**Estimated complexity:** S
**Description:** Implement the periodic stuck detection service that runs every 60 seconds. Queries all active teams and compares `last_event_at` against configurable thresholds: `running` -> `idle` after 5 minutes of no events, `idle` -> `stuck` after 15 minutes of no events. Also check CI failure counts: if a team's PR has 3+ unique CI failure types, transition phase to `blocked`. Broadcast status changes via SSE.

**Key file:** `src/server/services/stuck-detector.ts`

**Logic (from PRD section 10 and state-machines.md):**
- Every 60s, query `db.getActiveTeams()` where status is `running` or `idle`
- For each team, compute `idleMinutes = (now - last_event_at) / 60000`
- `running` + idleMinutes > `idleThresholdMin` (5) -> update status to `idle`
- `idle` + idleMinutes > `stuckThresholdMin` (15) -> update status to `stuck`
- Check PR `ci_fail_count` >= `maxUniqueCiFailures` (3) -> update phase to `blocked`
- Broadcast `team_status_changed` SSE event for each transition

**Acceptance criteria:**
- [ ] Service starts with server and runs every `stuckCheckIntervalMs` (60s)
- [ ] Teams transition `running` -> `idle` after 5 minutes without events
- [ ] Teams transition `idle` -> `stuck` after 15 minutes without events
- [ ] A new event on an `idle` team returns it to `running` (handled in event collector, T04)
- [ ] CI failure threshold (3+) marks team phase as `blocked`
- [ ] SSE events broadcast for every status transition
- [ ] Service stops cleanly on server shutdown (clears interval)

---

### T08: GitHub Poller Service (PR/CI Status)
**Priority:** P1
**Depends on:** T02, T03, T05
**Estimated complexity:** L
**Description:** Implement the service that polls GitHub for PR and CI status every 30 seconds using the `gh` CLI. For each team that has a `pr_number`, run `gh pr view` to fetch current state, merge status, CI check rollup, and auto-merge status. Compare with cached values in the database; if changed, update the DB and broadcast via SSE. Also detect new PRs: when a team has no `pr_number` but its branch has an open PR, auto-associate it. Track unique CI failure types and increment `ci_fail_count` accordingly.

**Key file:** `src/server/services/github-poller.ts`

**Polling logic:**
- Every 30s, get all teams with status in `running`, `idle`, `stuck` that have a `pr_number`
- For each: `gh pr view {pr_number} --repo {repo} --json number,state,mergeStateStatus,statusCheckRollup,autoMergeRequest,headRefName`
- Parse response, compare with DB values, update `pull_requests` table if changed
- For teams without `pr_number`: check if branch has an open PR via `gh pr list --head {branch}`
- Track unique CI failures by comparing check names + conclusion across runs

**Acceptance criteria:**
- [ ] Service polls every `githubPollIntervalMs` (30s)
- [ ] PR state, merge status, and CI status are updated in the database
- [ ] CI check details are stored in `checks_json` as a JSON array
- [ ] Auto-merge status is tracked
- [ ] New PRs are auto-detected by branch name and associated with teams
- [ ] Unique CI failure types are counted; `ci_fail_count` is incremented correctly
- [ ] Changes trigger SSE broadcast (`pr_updated` event)
- [ ] `gh` CLI errors are handled gracefully (logged, not crashed)
- [ ] Rate limiting is respected (< 120 requests/hour per PRD)

---

### T09: Team Intervention Endpoints
**Priority:** P1
**Depends on:** T06
**Estimated complexity:** M
**Description:** Implement the endpoints that allow the PM to interact with running teams. Send messages (write to a `.fleet-pm-message` signal file in the worktree, which the MCP server reads), manually set team phase, and acknowledge stuck/failed/done status. Also implement the cost and diagnostics endpoints.

**Key files:**
- `src/server/routes/teams.ts` (additional handlers)
- `src/server/routes/system.ts` — system health endpoints

**Endpoints to implement:**
- `POST /api/teams/:id/send-message` — `{message}` -> write `.fleet-pm-message` in worktree + insert `commands` row
- `POST /api/teams/:id/set-phase` — `{phase, reason?}` -> update team phase
- `POST /api/teams/:id/acknowledge` — `{status, action?}` -> acknowledge alert
- `GET /api/teams/:id/cost` — cost breakdown
- `GET /api/diagnostics/stuck` — all stuck teams with idle durations
- `GET /api/diagnostics/blocked` — teams blocked by CI failures
- `GET /api/diagnostics/health` — full fleet health summary
- `GET /api/costs` — aggregated costs
- `GET /api/costs/by-team` — per-team cost breakdown
- `GET /api/status` — server health (uptime, DB size, active teams, SSE connections)

**Acceptance criteria:**
- [ ] `send-message` writes the message to `.fleet-pm-message` in the team's worktree
- [ ] `send-message` also inserts a row in the `commands` table
- [ ] `set-phase` updates the team phase and broadcasts via SSE
- [ ] `acknowledge` clears the stuck/failed alert state
- [ ] Diagnostics endpoints return correctly computed data
- [ ] Cost endpoints aggregate from `cost_entries` table
- [ ] `GET /api/status` returns server uptime, DB size, and connection count

---

### T10: Issue Hierarchy Service (GraphQL + REST)
**Priority:** P1
**Depends on:** T02, T03
**Estimated complexity:** L
**Description:** Implement the service that fetches the GitHub issue hierarchy using GraphQL (3 levels deep: epic -> task -> subtask). Use the `gh api graphql` command to execute the query from PRD section 6. Cache results in memory with configurable refresh interval (60s). Support delta polling using `since` parameter. Also fetch project board status for each issue. Expose via REST endpoints.

**Key files:**
- `src/server/services/issue-fetcher.ts` — GraphQL queries via `gh api graphql`
- `src/server/routes/issues.ts` — REST endpoints

**Endpoints:**
- `GET /api/issues` — full issue hierarchy tree (cached)
- `GET /api/issues/:number` — single issue detail
- `POST /api/issues/refresh` — force re-fetch from GitHub
- `GET /api/issues/next` — suggest next issue to work on (Ready status, no active team, highest priority)
- `GET /api/issues/available` — issues with no active team

**Acceptance criteria:**
- [ ] GraphQL query fetches 3-level issue hierarchy (parent -> child -> grandchild)
- [ ] Sub-issue summary (total, completed, percentCompleted) is included
- [ ] PR references (closedByPullRequestsReferences) are included per issue
- [ ] Project board status is fetched and mapped to BoardStatus enum
- [ ] Results are cached in memory; `GET /api/issues` returns cached data
- [ ] `POST /api/issues/refresh` forces a fresh fetch
- [ ] `GET /api/issues/next` returns the highest-priority Ready issue with no active team
- [ ] GraphQL errors are handled gracefully
- [ ] Response includes `active_team` info (team_id, status) when a team is working an issue

---

### T11: React App Shell and Routing
**Priority:** P1
**Depends on:** T01
**Estimated complexity:** M
**Description:** Build the React application shell with the layout from PRD section 8: TopBar (fixed top), SideNav (56px left, icon-only: Fleet Grid / Issue Tree / Cost View), main content area, and status bar (bottom). Set up client-side routing for the three main views. Implement the dark theme using Tailwind CSS utility classes. Create the SSE hook (`useSSE`) for real-time updates and the REST fetch wrapper (`useApi`). Set up React context for global state (team list, connection status).

**Key files:**
- `src/client/App.tsx` — layout shell with router
- `src/client/components/TopBar.tsx` — header with summary pills
- `src/client/components/SideNav.tsx` — icon navigation
- `src/client/components/StatusBar.tsx` — connection status, last update time
- `src/client/hooks/useSSE.ts` — EventSource connection, reconnection logic
- `src/client/hooks/useApi.ts` — typed REST fetch wrapper
- `src/client/context/FleetContext.tsx` — global state provider

**Acceptance criteria:**
- [ ] App renders with dark theme (bg `#0D1117`, text `#E6EDF3`)
- [ ] TopBar shows app name and placeholder summary pills
- [ ] SideNav has three navigation icons (grid, tree, dollar)
- [ ] Clicking SideNav icons switches between Fleet Grid, Issue Tree, and Cost View
- [ ] StatusBar shows SSE connection state (Connected/Disconnected) and last update time
- [ ] `useSSE` hook connects to `/api/stream`, handles reconnection on disconnect
- [ ] `useApi` hook provides typed GET/POST methods against `/api/*`
- [ ] React context distributes team state to all components

---

### T12: Fleet Grid View (Main Dashboard)
**Priority:** P1
**Depends on:** T11, T06
**Estimated complexity:** L
**Description:** Build the primary dashboard view: a table of team rows showing all active and recent teams. Each row is 64px tall (12 teams visible on 1080p without scrolling). Rows display: status badge (colored dot), issue number + truncated title, duration, session count, cost, PR number + CI status badge, and action buttons (Message, Stop/Resume). Default sort: Stuck > Running > Idle > Failed > Done, then by duration descending within group. Rows are clickable to open Team Detail slide-over. Real-time updates via SSE automatically re-sort and animate status changes.

**Key files:**
- `src/client/components/FleetGrid.tsx` — container, data fetching, sorting
- `src/client/components/TeamRow.tsx` — single team row (64px)
- `src/client/components/StatusBadge.tsx` — colored status indicator
- `src/client/components/PRBadge.tsx` — PR number + CI status

**Status colors (from PRD):**
- Running: `#3FB950` (green)
- Stuck: `#F85149` (red, pulsing dot animation)
- Idle: `#D29922` (amber)
- Done: `#56D4DD` (teal)
- Failed: `#F85149` (red, static)
- Launching: `#58A6FF` (blue)

**Acceptance criteria:**
- [ ] Fleet Grid fetches data from `GET /api/teams` and renders rows
- [ ] Each row shows: status badge, issue #, title, duration, sessions, cost, PR badge
- [ ] Rows are sorted by status priority then duration descending
- [ ] Stuck teams show a pulsing red dot animation
- [ ] SSE events update rows in real-time without full page refresh
- [ ] Clicking a row opens the Team Detail slide-over (or navigates to detail)
- [ ] Action buttons (Message, Stop) are visible on hover or always-visible
- [ ] Empty state shows "No teams running" message
- [ ] Rows are 64px tall; 12+ teams visible on 1080p without scrolling

---

### T13: TopBar with Summary Pills
**Priority:** P1
**Depends on:** T11, T04
**Estimated complexity:** S
**Description:** Implement the TopBar component with real-time summary pills showing fleet-wide counts by status and total cost. Pills show: [N Running], [N Stuck], [N Idle], [N Done], [$XX.XX total cost]. Update in real-time via SSE. Include the app title "Fleet Commander" on the left.

**Key file:** `src/client/components/TopBar.tsx`

**Acceptance criteria:**
- [ ] TopBar shows "Fleet Commander" title on the left
- [ ] Summary pills display counts for each active status (Running, Stuck, Idle, Done)
- [ ] Total cost pill shows sum of all team costs formatted as USD
- [ ] Pills are color-coded matching their status colors
- [ ] Counts update in real-time when SSE events arrive
- [ ] Stuck pill has visual emphasis (brighter, or badge count)

---

### T14: Team Detail Slide-over Panel
**Priority:** P1
**Depends on:** T12, T09
**Estimated complexity:** L
**Description:** Build the slide-over panel (520px, right side) that shows complete detail for a selected team. Opens when clicking a team row in the Fleet Grid. Fetches full data from `GET /api/teams/:id`. Sections: Header (full issue title, status badge, duration, cost), PR + CI checks (individual check names with pass/fail), Event Timeline (last 20 events with timestamps), Command Input (text field to send message), Action Buttons (Stop, Resume, Restart, Set Phase). Panel slides in from right with animation.

**Key files:**
- `src/client/components/TeamDetail.tsx` — slide-over container
- `src/client/components/EventTimeline.tsx` — scrollable event list
- `src/client/components/CommandInput.tsx` — message input + send button
- `src/client/components/CIChecks.tsx` — individual CI check display

**Acceptance criteria:**
- [ ] Panel slides in from the right (520px width) with transition animation
- [ ] Header shows full issue title, status badge, phase, duration, total cost
- [ ] PR section shows PR number, state, merge status, and individual CI checks
- [ ] Each CI check shows name + pass/fail/pending icon
- [ ] Event Timeline lists last 20 events with timestamps and event type icons
- [ ] Command Input sends message via `POST /api/teams/:id/send-message`
- [ ] Stop button calls `POST /api/teams/:id/stop` with confirmation
- [ ] Resume button calls `POST /api/teams/:id/resume`
- [ ] Clicking outside the panel or pressing Escape closes it
- [ ] Panel updates in real-time via SSE for the selected team

---

### T15: Issue Tree View
**Priority:** P2
**Depends on:** T10, T11
**Estimated complexity:** M
**Description:** Build the Issue Tree view that shows the GitHub issue hierarchy (3 levels: epic -> task -> subtask) as a collapsible tree. Each node shows: issue number, title, state (color-coded), active team status (if any), PR badge (if any), and a "Launch" (Play) button for issues that have no active team. Tree is fetched from `GET /api/issues`. Nodes with children are collapsible. Sub-issue progress bar shows completed/total.

**Key files:**
- `src/client/components/IssueTree.tsx` — tree container, data fetching
- `src/client/components/TreeNode.tsx` — recursive tree node component
- `src/client/components/LaunchDialog.tsx` — dialog to confirm launching a team for an issue

**Acceptance criteria:**
- [ ] Tree renders 3-level hierarchy from `GET /api/issues`
- [ ] Nodes are collapsible (click arrow to expand/collapse)
- [ ] Each node shows: issue number, title, state badge
- [ ] Active teams show their status next to the issue (e.g., "RUNNING" badge)
- [ ] PR badge shows when a PR exists for the issue
- [ ] Play button appears for issues with no active team
- [ ] Clicking Play opens LaunchDialog to confirm launch with optional custom prompt
- [ ] Sub-issue progress bar shows completion percentage
- [ ] "Refresh" button triggers `POST /api/issues/refresh`

---

### T16: Cost View
**Priority:** P2
**Depends on:** T09, T11
**Estimated complexity:** M
**Description:** Build the Cost View page showing cost breakdown across all teams. Displays a table sorted by cost descending with columns: team/issue, total cost, session count, duration. Fetches from `GET /api/costs/by-team`. Include a daily summary section showing cost per day (fetched from `GET /api/costs/by-day`). Show total fleet cost prominently at the top. Auto-refresh every 60 seconds.

**Key files:**
- `src/client/components/CostView.tsx` — cost dashboard page
- `src/client/components/CostTable.tsx` — sortable cost table
- `src/client/components/DailyChart.tsx` — simple daily cost bar chart (CSS-only, no chart library needed)

**Acceptance criteria:**
- [ ] Cost table shows all teams sorted by total cost descending
- [ ] Columns: Issue #, Title, Status, Total Cost, Sessions, Duration
- [ ] Total fleet cost is displayed prominently at the top
- [ ] Daily summary shows cost per day for the last 7 days
- [ ] Bar chart visualizes daily costs (simple CSS bars are acceptable)
- [ ] Data refreshes every 60 seconds or on SSE `cost_updated` events
- [ ] Cost values are formatted as USD with 2 decimal places

---

### T17: Install/Uninstall Mechanism
**Priority:** P1
**Depends on:** T01, T06
**Estimated complexity:** M
**Description:** Create scripts that cleanly install and uninstall Fleet Commander's hooks and settings into a target repository's `.claude` directory. The install script should: copy hook scripts to `.claude/hooks/fleet-commander/`, merge Fleet Commander hook entries into the existing `.claude/settings.json` (preserving existing hooks like `pr-watcher-idle.sh`), and set up the MCP server entry in `.mcp.json`. The uninstall script should: remove the `fleet-commander` hook directory, remove Fleet Commander hook entries from `settings.json` (without touching other hooks), and remove the MCP entry. Both scripts should be idempotent and safe to run multiple times.

**Key files:**
- `scripts/install.sh` — install hooks + settings into target repo
- `scripts/uninstall.sh` — cleanly remove hooks + settings from target repo
- `scripts/install.ps1` — PowerShell wrapper for Windows convenience
- `scripts/uninstall.ps1` — PowerShell wrapper for Windows convenience

**Install behavior:**
1. Accept target repo path as argument (default: auto-detect from `FLEET_REPO_ROOT` or `git rev-parse --show-toplevel`)
2. Copy `hooks/` directory to `<target>/.claude/hooks/fleet-commander/`
3. Read existing `<target>/.claude/settings.json` (if any)
4. Merge Fleet Commander hook entries (add to arrays, don't replace)
5. Write updated `settings.json`
6. Add MCP server entry to `<target>/.mcp.json`
7. Print summary of what was installed

**Uninstall behavior:**
1. Remove `<target>/.claude/hooks/fleet-commander/` directory
2. Read `<target>/.claude/settings.json`
3. Remove only Fleet Commander hook entries (identify by path containing `fleet-commander/`)
4. If a hook type array becomes empty, remove the key entirely
5. Write cleaned `settings.json` (or remove if empty)
6. Remove MCP server entry from `<target>/.mcp.json`
7. Print summary of what was removed

**Acceptance criteria:**
- [ ] `./scripts/install.sh /path/to/repo` copies hooks and updates settings
- [ ] Existing hooks (e.g., `pr-watcher-idle.sh`) are preserved during install
- [ ] `./scripts/uninstall.sh /path/to/repo` removes only Fleet Commander artifacts
- [ ] Running install twice is idempotent (no duplicate entries)
- [ ] Running uninstall on a repo without Fleet Commander is a safe no-op
- [ ] MCP server entry is added/removed from `.mcp.json`
- [ ] Scripts work on Windows with Git Bash
- [ ] Both scripts print clear success/failure messages

---

### T18: PR Management Endpoints
**Priority:** P2
**Depends on:** T08
**Estimated complexity:** M
**Description:** Implement the PR management REST endpoints that allow the PM to view PR details, force-refresh PR status, and manage auto-merge settings from the dashboard. These wrap `gh` CLI commands.

**Key file:** `src/server/routes/prs.ts`

**Endpoints:**
- `GET /api/prs` — list all tracked PRs with CI status
- `GET /api/prs/:number` — single PR detail with full check breakdown
- `POST /api/prs/refresh` — force re-poll all PR statuses
- `POST /api/prs/:number/refresh` — force re-poll single PR
- `POST /api/prs/:number/enable-auto-merge` — `gh pr merge --auto --squash`
- `POST /api/prs/:number/disable-auto-merge` — `gh pr merge --disable-auto`
- `POST /api/prs/:number/update-branch` — `gh pr update-branch` (merge base into head)

**Acceptance criteria:**
- [ ] `GET /api/prs` returns all tracked PRs with current status
- [ ] `GET /api/prs/:number` includes individual CI checks array
- [ ] `POST /api/prs/refresh` triggers immediate re-poll of all PRs
- [ ] `POST /api/prs/:number/enable-auto-merge` calls `gh pr merge --auto --squash`
- [ ] `POST /api/prs/:number/update-branch` calls `gh api` to merge base into head
- [ ] All `gh` CLI errors are caught and returned as structured error responses
- [ ] Successful actions trigger SSE broadcast of `pr_updated` event

---

### T19: MCP Server Dashboard Integration
**Priority:** P2
**Depends on:** T04, T09
**Estimated complexity:** S
**Description:** Update the existing MCP server (`mcp/src/dashboard-client.ts`) to work with the new Fleet Commander backend. The MCP server currently falls back to local `gh` CLI reconstruction when the dashboard is unreachable. Update the `FLEET_SERVER_URL` default to `http://localhost:4680` (matching the Fastify server port). Ensure the `GET /api/teams/:id/status` endpoint on the backend returns the `FleetStatusResponse` format that the MCP server expects. Verify the fallback mode still works when the dashboard is offline.

**Key files:**
- `mcp/src/dashboard-client.ts` — update default URL to port 4680
- `src/server/routes/teams.ts` — ensure `/api/teams/:id/status` matches MCP response format

**Acceptance criteria:**
- [ ] MCP server's default URL points to `http://localhost:4680`
- [ ] `GET /api/teams/:id/status` returns JSON matching `FleetStatusResponse` interface
- [ ] MCP `fleet_status` tool returns dashboard data when server is running
- [ ] MCP `fleet_status` tool falls back to `gh` CLI when server is down
- [ ] PM messages set via `POST /api/teams/:id/send-message` appear in MCP response `pm_message` field
- [ ] MCP types remain backward-compatible

---

### T20: Startup Recovery and Worktree Discovery
**Priority:** P2
**Depends on:** T02, T06
**Estimated complexity:** M
**Description:** On server startup, scan for existing worktrees and running Claude processes to reconstruct state from a previous run. Check `.claude/worktrees/` for existing worktree directories. For each, check if a Claude process is still running (match by PID from DB or by process listing). Re-attach to running processes (capture stdout/stderr). Mark orphaned worktrees (worktree exists but no process) as `idle`. This enables clean server restarts without losing track of running teams.

**Key file:** `src/server/services/startup-recovery.ts`

**Recovery logic:**
1. Read `teams` table for teams with status in `running`, `idle`, `launching`
2. For each, check if `pid` is still alive (platform-appropriate: `tasklist` on Windows)
3. If process is alive: re-attach stdout/stderr listeners, update `last_event_at`
4. If process is dead: update status to `idle` (if was `running`) or `failed` (if was `launching`)
5. Scan filesystem for worktrees not in DB: log warning (orphan worktrees)
6. Update `v_team_dashboard` data

**Acceptance criteria:**
- [ ] On startup, previously-running teams with alive PIDs are re-attached
- [ ] Dead processes are detected and team status is updated
- [ ] Orphan worktrees (not in DB) are logged as warnings
- [ ] Server can restart without losing track of teams that are still running
- [ ] Recovery runs before accepting HTTP requests (during server init)
- [ ] Works on Windows (uses `tasklist` to check PID existence)

---

### T21: Cost Tracking Service
**Priority:** P2
**Depends on:** T02, T04
**Estimated complexity:** M
**Description:** Implement cost tracking by parsing cost data from Claude Code hook events and session data. When `SessionEnd` events arrive with cost information, extract input/output token counts and computed cost. Store in the `cost_entries` table. Provide aggregation methods for total cost, per-team cost, and per-day cost. If cost data is not available in hook events, implement estimation from token counts using known model pricing.

**Key file:** `src/server/services/cost-tracker.ts`

**Cost data sources:**
- `SessionEnd` hook events may contain cost data in payload
- `CostUpdate` hook events (if implemented in future)
- Manual entries via API (future)

**Acceptance criteria:**
- [ ] `SessionEnd` events with cost data create `cost_entries` rows
- [ ] Cost data includes `input_tokens`, `output_tokens`, `cost_usd`
- [ ] `GET /api/costs` returns total cost for a time range
- [ ] `GET /api/costs/by-team` returns per-team breakdown
- [ ] `GET /api/costs/by-day` returns daily aggregation
- [ ] Cost is tracked per session_id to avoid double-counting
- [ ] `v_team_dashboard` view includes accurate `total_cost` per team

---

### T22: Static File Serving and Production Build
**Priority:** P1
**Depends on:** T01, T11
**Estimated complexity:** S
**Description:** Configure the Fastify server to serve the Vite-built React frontend as static files in production mode. In development, proxy Vite dev server requests. Ensure the production build produces a single deployable artifact: a `dist/` folder containing both compiled server code and built client assets. Create a `start` script that runs the production server.

**Key changes:**
- `src/server/index.ts` — add `@fastify/static` for serving `dist/client/`
- `vite.config.ts` — output to `dist/client/`
- `package.json` — `build` script chains server and client builds, `start` runs production

**Acceptance criteria:**
- [ ] `npm run build` produces `dist/server/` (compiled TS) and `dist/client/` (Vite build)
- [ ] `npm start` serves the React app at `http://localhost:4680/`
- [ ] API routes (`/api/*`) work alongside static file serving
- [ ] SPA fallback: non-API routes return `index.html` for client-side routing
- [ ] In dev mode, Vite HMR works with the Fastify backend
- [ ] Source maps are generated for both server and client

---

### T23: Backend Unit Tests
**Priority:** P1
**Depends on:** T02, T04, T05, T07
**Estimated complexity:** L
**Description:** Write unit tests for the core backend services using Vitest. Test the database layer (CRUD operations, views, schema initialization), event collector (payload parsing, state machine transitions), stuck detector (threshold logic), SSE broker (connection management, filtering), and team manager (lifecycle methods, output buffering). Use an in-memory or temporary SQLite database for test isolation. Mock external dependencies (`gh` CLI, `child_process`).

**Key files:**
- `tests/server/db.test.ts`
- `tests/server/event-collector.test.ts`
- `tests/server/stuck-detector.test.ts`
- `tests/server/sse-broker.test.ts`
- `tests/server/team-manager.test.ts`
- `vitest.config.ts`

**Test areas:**
- Database: schema creation, CRUD for all tables, view queries, prepared statement correctness
- Event collector: valid payload processing, invalid payload rejection, state transitions (launching->running, running->idle->running), unknown team auto-creation
- Stuck detector: threshold calculations, status transitions, CI failure counting
- SSE broker: client connection/disconnection, filtered subscriptions, broadcast
- Team manager: launch creates worktree + process, stop kills process, resume spawns with --resume

**Acceptance criteria:**
- [ ] `npm test` runs all tests and reports results
- [ ] Database tests use temporary/in-memory DB (not production `fleet.db`)
- [ ] All state machine transitions are tested (at least: launching->running, running->idle, idle->stuck, idle->running)
- [ ] Event collector tests cover all 9 event types
- [ ] External commands (`gh`, `claude`, `git`) are mocked, not called
- [ ] Tests are isolated (each test gets a fresh DB state)
- [ ] Code coverage is reported (aim for >70% on core services)

---

### T24: Frontend Unit Tests
**Priority:** P2
**Depends on:** T12, T14, T15
**Estimated complexity:** M
**Description:** Write component tests for the React frontend using Vitest + React Testing Library. Test rendering, user interactions, and SSE-driven updates for core components: FleetGrid, TeamRow, StatusBadge, TopBar, TeamDetail, IssueTree, and CostView. Mock API responses and SSE events.

**Key files:**
- `tests/client/FleetGrid.test.tsx`
- `tests/client/TeamRow.test.tsx`
- `tests/client/TeamDetail.test.tsx`
- `tests/client/TopBar.test.tsx`
- `tests/client/IssueTree.test.tsx`

**Acceptance criteria:**
- [ ] FleetGrid renders correct number of rows from mock data
- [ ] TeamRow displays all fields (status, issue #, title, cost, PR)
- [ ] StatusBadge renders correct color for each status
- [ ] TopBar pills show correct counts from mock team data
- [ ] TeamDetail opens and displays full team information
- [ ] SSE mock events trigger component re-renders
- [ ] Tests pass with `npm run test:client`

---

### T25: API Integration Tests
**Priority:** P2
**Depends on:** T04, T06, T08, T09, T10
**Estimated complexity:** M
**Description:** Write integration tests that start the Fastify server (with a temporary SQLite DB) and exercise the full API request/response cycle. Test the event ingestion flow end-to-end: POST event -> DB insert -> state machine transition -> SSE broadcast. Test team lifecycle: launch -> receive events -> detect stuck -> stop. Test issue fetching with mocked `gh` responses.

**Key files:**
- `tests/integration/event-flow.test.ts`
- `tests/integration/team-lifecycle.test.ts`
- `tests/integration/api-endpoints.test.ts`

**Acceptance criteria:**
- [ ] Integration tests start and stop a real Fastify server instance
- [ ] Event ingestion: POST to `/api/events` -> verify DB row + SSE event
- [ ] Team lifecycle: create team -> POST events -> verify status transitions
- [ ] All REST endpoints return correct HTTP status codes and response shapes
- [ ] Tests clean up (temporary DB, server shutdown) after each test
- [ ] `gh` CLI calls are mocked at the `execSync` level

---

### T26: Error Handling and Logging
**Priority:** P1
**Depends on:** T01, T04, T06
**Estimated complexity:** M
**Description:** Add structured error handling throughout the backend. Create a consistent error response format for all API endpoints. Add logging using Fastify's built-in `pino` logger with appropriate log levels (info for requests, warn for recoverable errors, error for failures). Add request ID tracking. Handle uncaught exceptions and unhandled rejections gracefully. Ensure no stack traces leak to clients. Add graceful shutdown (close DB, stop pollers, drain SSE connections, kill managed processes).

**Key changes:**
- `src/server/index.ts` — error handler plugin, graceful shutdown hooks
- `src/server/middleware/error-handler.ts` — centralized error formatting
- All route files — consistent error responses

**Acceptance criteria:**
- [ ] All API errors return `{error: string, code: string, details?: any}` format
- [ ] 400 for validation errors, 404 for not found, 500 for internal errors
- [ ] Request logging shows method, path, status code, response time
- [ ] Errors are logged with stack traces (server-side only, not sent to client)
- [ ] Uncaught exceptions log and keep the server running
- [ ] Graceful shutdown: DB closed, intervals cleared, SSE connections closed, processes notified
- [ ] `SIGINT` and `SIGTERM` trigger graceful shutdown
- [ ] Log level is configurable via `LOG_LEVEL` env var

---

### T27: Event Throttling and Deduplication
**Priority:** P2
**Depends on:** T04
**Estimated complexity:** S
**Description:** Add server-side throttling and deduplication for high-volume `tool_use` events. Multiple agents can generate hundreds of events per minute. Implement: (1) per-team rate limiting for `tool_use` events (at most one per 5 seconds per team, updating `last_event_at` but not inserting duplicate DB rows), (2) deduplication by `(team, event_type, timestamp_rounded_to_second)`. This reduces database growth and SSE noise while preserving the heartbeat signal for stuck detection.

**Key changes:**
- `src/server/services/event-collector.ts` — add throttle/dedup logic

**Acceptance criteria:**
- [ ] `tool_use` events from the same team within 5 seconds are deduplicated
- [ ] `last_event_at` is still updated for deduplicated events (heartbeat preserved)
- [ ] Non-`tool_use` events (session_start, stop, etc.) are never throttled
- [ ] Deduplicated events return 200 (not rejected) but `processed: false`
- [ ] DB growth is reduced (no more than ~12 `tool_use` rows per team per minute)
- [ ] SSE broadcast is suppressed for deduplicated `tool_use` events

---

### T28: Launch Dialog and Batch Launch UI
**Priority:** P2
**Depends on:** T06, T12, T15
**Estimated complexity:** M
**Description:** Build the UI components for launching new teams. A "Launch Team" button in the TopBar opens a dialog where the PM can enter an issue number (or select from available issues) and an optional custom prompt. Support batch launch: enter comma-separated issue numbers (e.g., "763,812,756") with configurable stagger delay. The dialog fetches available issues from `GET /api/issues/available` for autocomplete. Also wire up the Play button in the Issue Tree view to open the same dialog pre-filled with the issue number.

**Key files:**
- `src/client/components/LaunchDialog.tsx` — modal dialog for launching teams
- `src/client/components/BatchLaunchForm.tsx` — batch launch input

**Acceptance criteria:**
- [ ] "Launch Team" button in TopBar opens the launch dialog
- [ ] Dialog has issue number input with autocomplete from available issues
- [ ] Optional prompt field (defaults to `/next-issue-kea {number}`)
- [ ] "Launch" button calls `POST /api/teams/launch` and shows result
- [ ] Batch mode: comma-separated issues, stagger delay input, calls `POST /api/teams/launch-batch`
- [ ] Play button in Issue Tree opens dialog pre-filled with issue number
- [ ] Dialog shows success/error feedback after launch
- [ ] Dialog closes on successful launch; FleetGrid updates via SSE

---

### T29: End-to-End Smoke Test
**Priority:** P2
**Depends on:** T04, T06, T11, T12, T17
**Estimated complexity:** M
**Description:** Create an end-to-end smoke test that validates the full flow without requiring actual Claude Code or GitHub access. The test script: (1) starts the Fleet Commander server, (2) simulates hook events by POSTing to `/api/events` (mimicking what `send_event.sh` would send), (3) verifies the API returns correct team status, (4) verifies SSE events are received, (5) opens the web UI and checks the Fleet Grid renders teams. Use a mock `claude` command (a script that just sleeps) for the team manager. This serves as a developer integration test and demo.

**Key files:**
- `tests/e2e/smoke-test.sh` — bash script that exercises the full flow
- `tests/e2e/mock-claude.sh` — mock `claude` command that simulates a running agent
- `tests/e2e/simulate-hooks.sh` — sends a sequence of hook events to the server

**Test flow:**
1. Start server with `FLEET_CLAUDE_CMD=./tests/e2e/mock-claude.sh`
2. POST `session_start` event for team `kea-999`
3. POST several `tool_use` events (heartbeats)
4. Verify `GET /api/teams` shows team `kea-999` as `running`
5. Wait 6 minutes (or set `idleThresholdMin=0.1` for testing), verify team goes `idle`
6. POST another `tool_use` event, verify team returns to `running`
7. POST `session_end` event, verify team transitions appropriately
8. Verify SSE stream received all expected events

**Acceptance criteria:**
- [ ] Smoke test runs without real Claude Code or GitHub access
- [ ] Hook event simulation produces correct state transitions
- [ ] SSE events are received by test client
- [ ] API responses match expected shapes
- [ ] Test completes in under 30 seconds (with reduced thresholds)
- [ ] Test exits with 0 on success, non-zero on failure
- [ ] Test can be run with `npm run test:e2e`

---

### T30: Documentation and Developer Guide
**Priority:** P2
**Depends on:** T17, T22
**Estimated complexity:** S
**Description:** Update the existing `README.md` with practical setup instructions, development workflow, and architecture overview. Document: how to install/uninstall hooks into a target repo, how to start the development server, how to run tests, how to build for production, environment variables reference, and troubleshooting common issues (port conflicts, `gh` CLI not authenticated, worktree issues on Windows).

**Key file:** `README.md` (update existing)

**Sections to add:**
- Prerequisites (Node.js 20+, `gh` CLI authenticated, Git)
- Quick Start (install deps, start dev server, install hooks)
- Development (scripts, project structure, adding new features)
- Configuration (environment variables table)
- Architecture (component diagram, data flow)
- Troubleshooting (common issues and solutions)
- API Reference (link to PRD or brief summary)

**Acceptance criteria:**
- [ ] README includes step-by-step Quick Start that works on Windows 10 with Git Bash
- [ ] All environment variables are documented with defaults
- [ ] Install/uninstall scripts are documented with examples
- [ ] Development workflow is documented (dev server, tests, build)
- [ ] Architecture section includes simplified component diagram
- [ ] Troubleshooting covers: port 4680 in use, `gh auth status` check, Git Bash path issues
