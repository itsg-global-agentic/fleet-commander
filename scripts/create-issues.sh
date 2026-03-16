#!/bin/bash
# Script to create all 30 Fleet Commander GitHub issues with dependencies
# Run from repo root: bash scripts/create-issues.sh

set -e

REPO="itsg-global-agentic/fleet-commander"
declare -A ISSUES  # T01 -> issue_number mapping

create_issue() {
  local task_id="$1"
  local title="$2"
  local labels="$3"
  local body="$4"

  echo "Creating $task_id: $title..."
  local result
  result=$(gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" 2>&1)
  local issue_num
  issue_num=$(echo "$result" | sed 's|.*/||')
  ISSUES[$task_id]=$issue_num
  echo "  -> #$issue_num"
}

deps_text() {
  # Build dependency text with actual issue numbers
  local deps=""
  for dep in "$@"; do
    local num="${ISSUES[$dep]}"
    if [ -n "$num" ]; then
      deps="$deps- Blocked by #$num ($dep)\n"
    fi
  done
  echo -e "$deps"
}

# ============================================================
# FOUNDATION (T01-T03)
# ============================================================

create_issue "T01" "T01: Project Scaffolding and Build Configuration" \
  "priority:P0,size:M,group:foundation" \
"$(cat <<'BODY'
## Description

Set up the monorepo-style project structure with separate backend and frontend builds. Create the root `package.json` with workspaces or scripts for both server and client. Configure TypeScript for the backend (`src/server/`), Vite + React + TypeScript for the frontend (`src/client/`), and Tailwind CSS with the dark theme from the PRD.

## Key files to create

- `package.json` (root)
- `tsconfig.json` (root, backend)
- `tsconfig.client.json` (frontend)
- `vite.config.ts`
- `tailwind.config.ts` with dark theme colors (Base: `#0D1117`, Surface: `#161B22`, Text: `#E6EDF3`, Accent: `#58A6FF`)
- `src/server/index.ts` (minimal Fastify entry point, port 4680)
- `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx` (minimal React shell)
- `src/shared/types.ts` (shared type definitions derived from `docs/types.ts`)

## Dependencies

None — this is the root task.

## Acceptance Criteria

- [ ] `npm install` succeeds
- [ ] `npm run dev` starts both Fastify (port 4680) and Vite dev server (proxied)
- [ ] `npm run build` produces `dist/server/` and `dist/client/` outputs
- [ ] TypeScript compiles with strict mode, no errors
- [ ] Tailwind CSS produces dark-themed output with the PRD color tokens
- [ ] Visiting `http://localhost:4680` shows a minimal "Fleet Commander" page
- [ ] Existing `mcp/` and `hooks/` directories are not modified

## Design References

- `docs/prd.md` section 8 (UI layout), section 15 (project structure)
- `docs/types.ts` for type definitions
BODY
)"

create_issue "T02" "T02: SQLite Database Layer" \
  "priority:P0,size:M,group:foundation" \
"$(cat <<BODY
## Description

Implement the database layer using \`better-sqlite3\` with WAL mode. Create schema initialization based on the PRD section 4 schema (\`teams\`, \`pull_requests\`, \`events\`, \`commands\`, \`cost_entries\` tables plus the \`v_team_dashboard\` view). Build a \`Database\` class wrapping all queries as prepared statements. Include schema migration support (version table).

Note: \`docs/data-model.sql\` contains an expanded schema (with \`issues\`, \`sessions\`, \`agents\`, \`ci_runs\` tables) that can be referenced for future expansion, but v1 should use the simpler PRD schema.

## Key files

- \`src/server/db.ts\` — Database class with connection management, schema init, WAL mode
- \`src/server/schema.sql\` — DDL statements

## Key queries to implement

- \`insertTeam()\`, \`getTeam()\`, \`getTeams()\`, \`updateTeam()\`, \`getActiveTeams()\`
- \`insertEvent()\`, \`getEventsByTeam()\`, \`getLatestEventByTeam()\`, \`getAllEvents()\`
- \`insertPullRequest()\`, \`getPullRequest()\`, \`updatePullRequest()\`
- \`insertCommand()\`, \`getPendingCommands()\`
- \`insertCostEntry()\`, \`getCostByTeam()\`
- \`getTeamDashboard()\` — uses the \`v_team_dashboard\` view
- \`getStuckCandidates()\` — teams where last_event_at exceeds thresholds

## Dependencies

$(deps_text T01)

## Acceptance Criteria

- [ ] Database file is created on first run with full schema
- [ ] WAL mode is enabled (\`PRAGMA journal_mode=WAL\`)
- [ ] All CRUD operations work for each table
- [ ] Prepared statements are used (not string interpolation)
- [ ] \`v_team_dashboard\` view returns correctly joined data
- [ ] Schema version is tracked; re-running init is idempotent
- [ ] Database handle is properly closed on server shutdown

## Design References

- \`docs/prd.md\` section 4 (v1 schema)
- \`docs/data-model.sql\` (expanded schema for reference)
BODY
)"

create_issue "T03" "T03: Server Configuration Module" \
  "priority:P0,size:S,group:foundation" \
"$(cat <<BODY
## Description

Create the configuration module that centralizes all tunable parameters. Values come from environment variables with sensible defaults matching the PRD. The config object should be frozen after initialization.

## Key file

\`src/server/config.ts\`

## Configuration values

- \`port\`: 4680
- \`repoRoot\`: \`FLEET_REPO_ROOT\` env or auto-detected via \`git rev-parse --show-toplevel\`
- \`githubRepo\`: \`FLEET_GITHUB_REPO\` env or \`itsg-global-agentic/itsg-kea\`
- \`githubPollIntervalMs\`: 30000
- \`issuePollIntervalMs\`: 60000
- \`stuckCheckIntervalMs\`: 60000
- \`idleThresholdMin\`: 5
- \`stuckThresholdMin\`: 15
- \`maxUniqueCiFailures\`: 3
- \`claudeCmd\`: \`claude\`
- \`defaultPrompt\`: \`/next-issue-kea\`
- \`dbPath\`: \`fleet.db\`

## Dependencies

$(deps_text T01)

## Acceptance Criteria

- [ ] All config values have defaults matching the PRD
- [ ] Environment variables override defaults
- [ ] Config object is exported as a frozen singleton
- [ ] Invalid values (e.g., negative port) throw on startup
- [ ] \`GET /api/config\` endpoint can return the non-sensitive config values

## Design References

- \`docs/prd.md\` section 15 (config values)
BODY
)"

# ============================================================
# CORE SERVICES (T04-T09)
# ============================================================

create_issue "T04" "T04: Event Collector (POST /api/events + GET /api/events)" \
  "priority:P0,size:M,group:core-services" \
"$(cat <<BODY
## Description

Implement the HTTP endpoints that receive and query hook events from Claude Code instances. The POST endpoint is the most critical — it must be fast, never reject valid payloads, and handle high volume. Parse the JSON payload from \`send_event.sh\`. Resolve team name to \`team_id\`. Insert into the \`events\` table. Update \`teams.last_event_at\`. Apply state machine transitions. Emit to SSE broker after processing.

## Key files

- \`src/server/routes/events.ts\` — Fastify route handler
- \`src/server/services/event-collector.ts\` — business logic, state transitions

## Event-to-transition mapping (from \`docs/state-machines.md\`)

- \`session_start\` -> team \`launching\` -> \`running\`; create/update session row
- \`session_end\` -> check if all sessions ended -> potentially \`done\`
- \`stop\` -> record stop, track stop frequency
- \`subagent_start\` / \`subagent_stop\` -> update agent status
- \`notification\` -> record, flag if accumulating without tool_use
- \`tool_use\` -> update \`last_event_at\` (heartbeat)
- \`tool_error\` -> update \`last_event_at\`, increment error count
- \`pre_compact\` -> record context pressure signal

## Dependencies

$(deps_text T02 T03)

## Acceptance Criteria

- [ ] \`POST /api/events\` accepts JSON payloads matching hook format
- [ ] Returns 200 with \`{event_id, team_id, processed: true}\` on success
- [ ] Unknown team names auto-create a team row in \`queued\`/\`launching\` status
- [ ] \`teams.last_event_at\` is updated on every relevant event
- [ ] State machine transitions fire correctly (launching->running on session_start)
- [ ] Malformed payloads return 400 but never crash the server
- [ ] Events are inserted into the \`events\` table with all available fields
- [ ] Response time is < 50ms under normal load
- [ ] \`GET /api/events\` returns events filterable by \`?team_id=\`, \`?type=\`, \`?since=\`, \`?limit=\`

## Design References

- \`docs/state-machines.md\` section 5 (event pipeline)
- \`hooks/DESIGN.md\` (payload format)
BODY
)"

create_issue "T05" "T05: SSE Broker (Real-time Updates)" \
  "priority:P0,size:M,group:core-services" \
"$(cat <<BODY
## Description

Implement Server-Sent Events broker for pushing real-time updates to connected dashboard clients. Support multiple concurrent connections. Broadcast events for: team status changes, new hook events, PR/CI updates, cost updates, team launch/stop. Support filtered subscriptions via \`?teams=1,2,3\` query parameter. Include heartbeat keepalive (every 30s).

## Key files

- \`src/server/services/sse-broker.ts\` — connection management, broadcast logic
- \`src/server/routes/stream.ts\` — \`GET /api/stream\` endpoint

## SSE event types

- \`team_status_changed\` — \`{team_id, status, previous_status}\`
- \`team_event\` — \`{team_id, event_type, event_id}\`
- \`pr_updated\` — \`{pr_number, team_id, ci_status, merge_status}\`
- \`team_launched\` / \`team_stopped\` — \`{team_id}\`
- \`cost_updated\` — \`{team_id, total_cost_usd}\`
- \`heartbeat\` — \`{timestamp}\`

## Dependencies

$(deps_text T01 T03)

## Acceptance Criteria

- [ ] \`GET /api/stream\` returns \`text/event-stream\` with proper headers
- [ ] Multiple browser tabs can connect simultaneously
- [ ] \`?teams=1,2,3\` filters events to only specified team IDs
- [ ] Heartbeat events are sent every 30 seconds
- [ ] Client disconnection is detected and connection is cleaned up
- [ ] \`sseBroadcast()\` function is callable from any service
- [ ] Events follow SSE format: \`event: <type>\ndata: <json>\n\n\`

## Design References

- \`docs/prd.md\` section 7 (SSE broker)
BODY
)"

create_issue "T06" "T06: Team Manager Service (Spawn/Stop/Resume)" \
  "priority:P0,size:L,group:core-services" \
"$(cat <<BODY
## Description

Implement the core service that manages Claude Code process lifecycle. Handles launching new teams (creating git worktrees, spawning \`claude\` via \`child_process.spawn\`), stopping teams (process termination via \`taskkill\` on Windows), and resuming stopped teams. Maintains a rolling output buffer (last 500 lines). Tracks PIDs. Copies hook scripts and \`settings.json\` to new worktrees.

## Key files

- \`src/server/services/team-manager.ts\`
- \`src/server/routes/teams.ts\` — route handlers

## Endpoints

- \`POST /api/teams/launch\` — \`{issueNumber, prompt?}\` -> create worktree + spawn process
- \`POST /api/teams/launch-batch\` — \`{issues: number[], prompt?, delayMs?}\`
- \`POST /api/teams/:id/stop\` — kill process tree
- \`POST /api/teams/:id/resume\` — re-spawn with \`--resume\` flag
- \`POST /api/teams/:id/restart\` — stop then relaunch
- \`POST /api/teams/stop-all\` — stop all running teams
- \`GET /api/teams\` — list all teams with dashboard data
- \`GET /api/teams/:id\` — full team detail
- \`GET /api/teams/:id/status\` — compact status (MCP-compatible)
- \`GET /api/teams/:id/output\` — stdout/stderr buffer
- \`GET /api/teams/:id/events\` — event log
- \`GET /api/teams/:id/sessions\` — session history

## Dependencies

$(deps_text T02 T03 T05)

## Acceptance Criteria

- [ ] \`POST /api/teams/launch\` creates a git worktree and spawns a \`claude\` process
- [ ] Process PID is stored in the database
- [ ] Stdout/stderr are captured in a rolling buffer (retrievable via \`/output\`)
- [ ] Process exit is detected and team status is updated accordingly
- [ ] \`POST /api/teams/:id/stop\` kills the process tree (Windows \`taskkill /F /T /PID\`)
- [ ] \`POST /api/teams/:id/resume\` spawns \`claude --worktree <name> --resume\`
- [ ] Hook scripts are copied to new worktree \`.claude/hooks/fleet-commander/\`
- [ ] \`settings.json\` is deployed to new worktree \`.claude/\` directory
- [ ] SSE events are broadcast on launch/stop/resume
- [ ] Batch launch respects \`delayMs\` stagger between spawns

## Design References

- \`docs/prd.md\` section 10 (Team Manager)
- \`docs/state-machines.md\` section 1 (team lifecycle)
BODY
)"

create_issue "T07" "T07: Stuck Detector Service" \
  "priority:P1,size:S,group:core-services" \
"$(cat <<BODY
## Description

Implement the periodic stuck detection service that runs every 60 seconds. Queries all active teams and compares \`last_event_at\` against configurable thresholds: \`running\` -> \`idle\` after 5min, \`idle\` -> \`stuck\` after 15min. Also check CI failure counts: 3+ unique CI failures -> phase \`blocked\`. Broadcast status changes via SSE.

## Key file

\`src/server/services/stuck-detector.ts\`

## Logic (from PRD section 10 and state-machines.md)

- Every 60s, query \`db.getActiveTeams()\`
- For each team, compute \`idleMinutes = (now - last_event_at) / 60000\`
- \`running\` + idleMinutes > 5 -> status = \`idle\`
- \`idle\` + idleMinutes > 15 -> status = \`stuck\`
- CI \`ci_fail_count\` >= 3 -> phase = \`blocked\`
- Broadcast \`team_status_changed\` SSE event for each transition

## Dependencies

$(deps_text T02 T05)

## Acceptance Criteria

- [ ] Service starts with server and runs every \`stuckCheckIntervalMs\` (60s)
- [ ] Teams transition \`running\` -> \`idle\` after 5 minutes without events
- [ ] Teams transition \`idle\` -> \`stuck\` after 15 minutes without events
- [ ] A new event on an \`idle\` team returns it to \`running\` (handled in event collector, T04)
- [ ] CI failure threshold (3+) marks team phase as \`blocked\`
- [ ] SSE events broadcast for every status transition
- [ ] Service stops cleanly on server shutdown (clears interval)

## Design References

- \`docs/state-machines.md\` section 1 (team lifecycle thresholds)
- \`docs/prd.md\` section 10 (stuck detection)
BODY
)"

create_issue "T08" "T08: GitHub Poller Service (PR/CI Status)" \
  "priority:P1,size:L,group:core-services" \
"$(cat <<BODY
## Description

Implement the service that polls GitHub for PR and CI status every 30 seconds using the \`gh\` CLI. For each team with a \`pr_number\`, run \`gh pr view\` to fetch state, merge status, CI check rollup, and auto-merge status. Compare with cached DB values; if changed, update and broadcast via SSE. Also detect new PRs by branch name.

## Key file

\`src/server/services/github-poller.ts\`

## Polling logic

- Every 30s, get all teams with status in \`running\`, \`idle\`, \`stuck\` that have a \`pr_number\`
- For each: \`gh pr view {pr_number} --repo {repo} --json number,state,mergeStateStatus,statusCheckRollup,autoMergeRequest,headRefName\`
- Parse response, compare with DB values, update \`pull_requests\` table if changed
- For teams without \`pr_number\`: check if branch has an open PR via \`gh pr list --head {branch}\`
- Track unique CI failures; increment \`ci_fail_count\`

## Dependencies

$(deps_text T02 T03 T05)

## Acceptance Criteria

- [ ] Service polls every \`githubPollIntervalMs\` (30s)
- [ ] PR state, merge status, and CI status are updated in the database
- [ ] Auto-merge status is tracked
- [ ] New PRs are auto-detected by branch name and associated with teams
- [ ] Unique CI failure types are counted; \`ci_fail_count\` is incremented correctly
- [ ] Changes trigger SSE broadcast (\`pr_updated\` event)
- [ ] \`gh\` CLI errors are handled gracefully (logged, not crashed)
- [ ] Rate limiting is respected (< 120 requests/hour)

## Design References

- \`docs/prd.md\` section 6 (GitHub polling)
- \`docs/state-machines.md\` section 3 (PR lifecycle)
BODY
)"

create_issue "T09" "T09: Team Intervention Endpoints" \
  "priority:P1,size:M,group:core-services" \
"$(cat <<BODY
## Description

Implement endpoints for PM to interact with running teams: send messages (write \`.fleet-pm-message\` signal file), set team phase, acknowledge alerts, diagnostics, and cost endpoints.

## Key files

- \`src/server/routes/teams.ts\` (additional handlers)
- \`src/server/routes/system.ts\` — system health endpoints

## Endpoints

- \`POST /api/teams/:id/send-message\` — write \`.fleet-pm-message\` + insert \`commands\` row
- \`POST /api/teams/:id/set-phase\` — update team phase
- \`POST /api/teams/:id/acknowledge\` — acknowledge alert
- \`GET /api/teams/:id/cost\` — cost breakdown
- \`GET /api/diagnostics/stuck\` — stuck teams with idle durations
- \`GET /api/diagnostics/blocked\` — teams blocked by CI
- \`GET /api/diagnostics/health\` — full fleet health
- \`GET /api/costs\`, \`GET /api/costs/by-team\` — aggregated costs
- \`GET /api/status\` — server health (uptime, DB size, SSE connections)

## Dependencies

$(deps_text T06)

## Acceptance Criteria

- [ ] \`send-message\` writes the message to \`.fleet-pm-message\` in the team's worktree
- [ ] \`send-message\` inserts a row in the \`commands\` table
- [ ] \`set-phase\` updates the team phase and broadcasts via SSE
- [ ] \`acknowledge\` clears the stuck/failed alert state
- [ ] Diagnostics endpoints return correctly computed data
- [ ] Cost endpoints aggregate from \`cost_entries\` table
- [ ] \`GET /api/status\` returns server uptime, DB size, connection count

## Design References

- \`docs/prd.md\` section 9 (intervention endpoints)
BODY
)"

# ============================================================
# GITHUB INTEGRATION (T10)
# ============================================================

create_issue "T10" "T10: Issue Hierarchy Service (GraphQL + REST)" \
  "priority:P1,size:L,group:github" \
"$(cat <<BODY
## Description

Implement the service that fetches GitHub issue hierarchy using GraphQL (3 levels deep: epic -> task -> subtask). Use \`gh api graphql\` command. Cache results in memory with configurable refresh interval (60s). Support delta polling. Fetch project board status for each issue. Expose via REST.

## Key files

- \`src/server/services/issue-fetcher.ts\` — GraphQL queries via \`gh api graphql\`
- \`src/server/routes/issues.ts\` — REST endpoints

## Endpoints

- \`GET /api/issues\` — full issue hierarchy tree (cached)
- \`GET /api/issues/:number\` — single issue detail
- \`POST /api/issues/refresh\` — force re-fetch
- \`GET /api/issues/next\` — suggest next issue (Ready, no active team, highest priority)
- \`GET /api/issues/available\` — issues with no active team

## Dependencies

$(deps_text T02 T03)

## Acceptance Criteria

- [ ] GraphQL query fetches 3-level issue hierarchy
- [ ] Sub-issue summary (total, completed, percentCompleted) is included
- [ ] PR references are included per issue
- [ ] Project board status is fetched and mapped to BoardStatus enum
- [ ] Results are cached; \`GET /api/issues\` returns cached data
- [ ] \`POST /api/issues/refresh\` forces a fresh fetch
- [ ] \`GET /api/issues/next\` returns the highest-priority Ready issue with no active team
- [ ] Response includes \`active_team\` info when a team is working an issue

## Design References

- \`docs/prd.md\` section 6 (Issue hierarchy GraphQL)
BODY
)"

# ============================================================
# FRONTEND (T11-T16)
# ============================================================

create_issue "T11" "T11: React App Shell and Routing" \
  "priority:P1,size:M,group:frontend" \
"$(cat <<BODY
## Description

Build the React application shell with PRD layout: TopBar (fixed top), SideNav (56px left, icons: Fleet Grid / Issue Tree / Cost View), main content area, status bar (bottom). Client-side routing. Dark theme. SSE hook (\`useSSE\`) and REST wrapper (\`useApi\`). React context for global state.

## Key files

- \`src/client/App.tsx\` — layout shell with router
- \`src/client/components/TopBar.tsx\` — header with summary pills
- \`src/client/components/SideNav.tsx\` — icon navigation
- \`src/client/components/StatusBar.tsx\` — connection status
- \`src/client/hooks/useSSE.ts\` — EventSource connection + reconnection
- \`src/client/hooks/useApi.ts\` — typed REST fetch wrapper
- \`src/client/context/FleetContext.tsx\` — global state provider

## Dependencies

$(deps_text T01)

## Acceptance Criteria

- [ ] App renders with dark theme (bg \`#0D1117\`, text \`#E6EDF3\`)
- [ ] TopBar shows app name and placeholder summary pills
- [ ] SideNav has three navigation icons (grid, tree, dollar)
- [ ] Clicking SideNav icons switches between views
- [ ] StatusBar shows SSE connection state
- [ ] \`useSSE\` hook connects to \`/api/stream\`, handles reconnection
- [ ] \`useApi\` hook provides typed GET/POST methods
- [ ] React context distributes team state to all components

## Design References

- \`docs/prd.md\` section 8 (UI layout, colors)
BODY
)"

create_issue "T12" "T12: Fleet Grid View (Main Dashboard)" \
  "priority:P1,size:L,group:frontend" \
"$(cat <<BODY
## Description

Build the primary dashboard view: a table of team rows showing all active and recent teams. 64px row height (12 teams visible on 1080p). Columns: status badge (colored dot), issue number + title, duration, sessions, cost, PR + CI badge, action buttons. Default sort: Stuck > Running > Idle > Failed > Done. Real-time SSE updates.

## Key files

- \`src/client/components/FleetGrid.tsx\` — container, data fetching, sorting
- \`src/client/components/TeamRow.tsx\` — single team row
- \`src/client/components/StatusBadge.tsx\` — colored status indicator
- \`src/client/components/PRBadge.tsx\` — PR number + CI status

## Status colors

- Running: \`#3FB950\` (green), Stuck: \`#F85149\` (red, pulsing), Idle: \`#D29922\` (amber)
- Done: \`#56D4DD\` (teal), Failed: \`#F85149\` (red, static), Launching: \`#58A6FF\` (blue)

## Dependencies

$(deps_text T11 T06)

## Acceptance Criteria

- [ ] Fleet Grid fetches data from \`GET /api/teams\` and renders rows
- [ ] Each row shows: status badge, issue #, title, duration, sessions, cost, PR badge
- [ ] Rows are sorted by status priority then duration descending
- [ ] Stuck teams show a pulsing red dot animation
- [ ] SSE events update rows in real-time
- [ ] Clicking a row opens the Team Detail slide-over
- [ ] Rows are 64px tall; 12+ teams visible on 1080p without scrolling
- [ ] Empty state shows "No teams running" message

## Design References

- \`docs/prd.md\` section 8 (Fleet Grid layout, colors)
BODY
)"

create_issue "T13" "T13: TopBar with Summary Pills" \
  "priority:P1,size:S,group:frontend" \
"$(cat <<BODY
## Description

Implement the TopBar component with real-time summary pills showing fleet-wide counts by status and total cost. Pills: [N Running], [N Stuck], [N Idle], [N Done], [\$XX.XX total cost]. Update via SSE.

## Key file

\`src/client/components/TopBar.tsx\`

## Dependencies

$(deps_text T11 T04)

## Acceptance Criteria

- [ ] TopBar shows "Fleet Commander" title on the left
- [ ] Summary pills display counts for each active status
- [ ] Total cost pill shows sum formatted as USD
- [ ] Pills are color-coded matching status colors
- [ ] Counts update in real-time via SSE
- [ ] Stuck pill has visual emphasis

## Design References

- \`docs/prd.md\` section 8 (TopBar design)
BODY
)"

create_issue "T14" "T14: Team Detail Slide-over Panel" \
  "priority:P1,size:L,group:frontend" \
"$(cat <<BODY
## Description

Build the slide-over panel (520px, right side) showing complete team detail. Opens on clicking a team row. Sections: Header (issue title, status, duration, cost), PR + CI checks, Event Timeline (last 20 events), Command Input (send message), Action Buttons (Stop, Resume, Restart, Set Phase).

## Key files

- \`src/client/components/TeamDetail.tsx\` — slide-over container
- \`src/client/components/EventTimeline.tsx\` — scrollable event list
- \`src/client/components/CommandInput.tsx\` — message input + send
- \`src/client/components/CIChecks.tsx\` — individual CI check display

## Dependencies

$(deps_text T12 T09)

## Acceptance Criteria

- [ ] Panel slides in from the right (520px) with animation
- [ ] Header shows issue title, status badge, phase, duration, cost
- [ ] PR section shows PR number, state, merge status, individual CI checks
- [ ] Event Timeline lists last 20 events with timestamps
- [ ] Command Input sends message via \`POST /api/teams/:id/send-message\`
- [ ] Stop/Resume buttons call appropriate endpoints with confirmation
- [ ] Escape or clicking outside closes the panel
- [ ] Panel updates in real-time via SSE

## Design References

- \`docs/prd.md\` section 8 (Team Detail)
BODY
)"

create_issue "T15" "T15: Issue Tree View" \
  "priority:P2,size:M,group:frontend" \
"$(cat <<BODY
## Description

Build the Issue Tree view showing GitHub issue hierarchy (3 levels) as a collapsible tree. Each node shows: issue number, title, state, active team status, PR badge, and "Launch" (Play) button for issues with no active team. Sub-issue progress bar.

## Key files

- \`src/client/components/IssueTree.tsx\` — tree container
- \`src/client/components/TreeNode.tsx\` — recursive tree node
- \`src/client/components/LaunchDialog.tsx\` — confirm launch dialog

## Dependencies

$(deps_text T10 T11)

## Acceptance Criteria

- [ ] Tree renders 3-level hierarchy from \`GET /api/issues\`
- [ ] Nodes are collapsible
- [ ] Each node shows: issue number, title, state badge
- [ ] Active teams show status badge next to issue
- [ ] Play button for issues with no active team
- [ ] Clicking Play opens LaunchDialog with optional prompt
- [ ] Sub-issue progress bar shows completion percentage
- [ ] "Refresh" button triggers \`POST /api/issues/refresh\`

## Design References

- \`docs/prd.md\` section 8 (Issue Tree)
BODY
)"

create_issue "T16" "T16: Cost View" \
  "priority:P2,size:M,group:frontend" \
"$(cat <<BODY
## Description

Build the Cost View page: table sorted by cost descending (team/issue, total cost, sessions, duration), daily summary section (cost per day), total fleet cost at top. Auto-refresh every 60s.

## Key files

- \`src/client/components/CostView.tsx\` — cost dashboard page
- \`src/client/components/CostTable.tsx\` — sortable cost table
- \`src/client/components/DailyChart.tsx\` — simple daily cost bar chart (CSS-only)

## Dependencies

$(deps_text T09 T11)

## Acceptance Criteria

- [ ] Cost table shows all teams sorted by cost descending
- [ ] Columns: Issue #, Title, Status, Total Cost, Sessions, Duration
- [ ] Total fleet cost displayed prominently at top
- [ ] Daily summary shows cost per day for last 7 days
- [ ] Bar chart visualizes daily costs
- [ ] Data refreshes every 60s or on SSE \`cost_updated\` events
- [ ] Cost values formatted as USD with 2 decimal places

## Design References

- \`docs/prd.md\` section 8 (Cost View)
BODY
)"

# ============================================================
# INTEGRATION (T17, T18-T22)
# ============================================================

create_issue "T17" "T17: Install/Uninstall Mechanism" \
  "priority:P1,size:M,group:integration" \
"$(cat <<BODY
## Description

Create scripts that cleanly install and uninstall Fleet Commander's hooks and settings into a target repo's \`.claude\` directory. Install: copy hooks to \`.claude/hooks/fleet-commander/\`, merge hook entries into existing \`settings.json\` (preserving other hooks), add MCP entry to \`.mcp.json\`. Uninstall: remove fleet-commander hooks, clean entries from settings.json, remove MCP entry. Both scripts must be idempotent and safe.

## Key files

- \`scripts/install.sh\` — install hooks + settings into target repo
- \`scripts/uninstall.sh\` — cleanly remove hooks + settings
- \`scripts/install.ps1\` — PowerShell wrapper for Windows
- \`scripts/uninstall.ps1\` — PowerShell wrapper for Windows

## Install behavior

1. Accept target repo path as argument (default: auto-detect)
2. Copy \`hooks/\` directory to \`<target>/.claude/hooks/fleet-commander/\`
3. Read existing \`<target>/.claude/settings.json\` (if any)
4. Merge Fleet Commander hook entries (add to arrays, don't replace)
5. Write updated \`settings.json\`
6. Add MCP server entry to \`<target>/.mcp.json\`
7. Print summary of what was installed

## Uninstall behavior

1. Remove \`<target>/.claude/hooks/fleet-commander/\` directory
2. Read \`<target>/.claude/settings.json\`
3. Remove only Fleet Commander entries (identify by path containing \`fleet-commander/\`)
4. If a hook type array becomes empty, remove the key entirely
5. Write cleaned \`settings.json\` (or remove if empty)
6. Remove MCP server entry from \`<target>/.mcp.json\`
7. Print summary of what was removed

## Dependencies

$(deps_text T01 T06)

## Acceptance Criteria

- [ ] \`./scripts/install.sh /path/to/repo\` copies hooks and updates settings
- [ ] Existing hooks (e.g., \`pr-watcher-idle.sh\`) are preserved during install
- [ ] \`./scripts/uninstall.sh /path/to/repo\` removes only Fleet Commander artifacts
- [ ] Running install twice is idempotent (no duplicate entries)
- [ ] Running uninstall on a repo without Fleet Commander is a safe no-op
- [ ] MCP server entry is added/removed from \`.mcp.json\`
- [ ] Scripts work on Windows with Git Bash
- [ ] Both scripts print clear success/failure messages

## Design References

- \`hooks/DESIGN.md\` section 4.3 (deployment)
- \`hooks/settings.json.example\` (reference config)
BODY
)"

create_issue "T18" "T18: PR Management Endpoints" \
  "priority:P2,size:M,group:github" \
"$(cat <<BODY
## Description

Implement PR management REST endpoints: list PRs, detail with full check breakdown, force-refresh, enable/disable auto-merge, update-branch. All wrap \`gh\` CLI commands.

## Key file

\`src/server/routes/prs.ts\`

## Endpoints

- \`GET /api/prs\` — list all tracked PRs
- \`GET /api/prs/:number\` — single PR detail with checks
- \`POST /api/prs/refresh\` — force re-poll all
- \`POST /api/prs/:number/enable-auto-merge\` — \`gh pr merge --auto --squash\`
- \`POST /api/prs/:number/disable-auto-merge\`
- \`POST /api/prs/:number/update-branch\` — merge base into head

## Dependencies

$(deps_text T08)

## Acceptance Criteria

- [ ] \`GET /api/prs\` returns all tracked PRs with current status
- [ ] \`GET /api/prs/:number\` includes individual CI checks array
- [ ] \`POST /api/prs/refresh\` triggers immediate re-poll
- [ ] Enable/disable auto-merge calls \`gh pr merge\` correctly
- [ ] All \`gh\` CLI errors are caught and returned as structured responses
- [ ] Successful actions trigger SSE broadcast

## Design References

- \`docs/prd.md\` section 9b (PR endpoints)
BODY
)"

create_issue "T19" "T19: MCP Server Dashboard Integration" \
  "priority:P2,size:S,group:integration" \
"$(cat <<BODY
## Description

Update existing MCP server to work with Fleet Commander backend. Fix default URL to \`http://localhost:4680\`. Ensure \`GET /api/teams/:id/status\` returns \`FleetStatusResponse\` format. Verify fallback mode still works when dashboard is offline.

## Key files

- \`mcp/src/dashboard-client.ts\` — update default URL to port 4680
- \`src/server/routes/teams.ts\` — ensure \`/api/teams/:id/status\` matches MCP format

## Dependencies

$(deps_text T04 T09)

## Acceptance Criteria

- [ ] MCP server's default URL points to \`http://localhost:4680\`
- [ ] \`GET /api/teams/:id/status\` returns JSON matching \`FleetStatusResponse\`
- [ ] MCP \`fleet_status\` tool returns dashboard data when server is running
- [ ] Fallback to \`gh\` CLI when server is down still works
- [ ] PM messages appear in MCP response \`pm_message\` field
- [ ] MCP types remain backward-compatible

## Design References

- \`mcp/DESIGN.md\` (API contract)
BODY
)"

create_issue "T20" "T20: Startup Recovery and Worktree Discovery" \
  "priority:P2,size:M,group:integration" \
"$(cat <<BODY
## Description

On server startup, scan for existing worktrees and running Claude processes to reconstruct state. Check \`.claude/worktrees/\` for existing directories. Check if PIDs are still alive. Re-attach to running processes. Mark orphaned worktrees as \`idle\`.

## Key file

\`src/server/services/startup-recovery.ts\`

## Recovery logic

1. Read \`teams\` table for teams with status in \`running\`, \`idle\`, \`launching\`
2. Check if \`pid\` is still alive (\`tasklist\` on Windows)
3. If alive: re-attach stdout/stderr listeners
4. If dead: update status to \`idle\` or \`failed\`
5. Scan filesystem for worktrees not in DB: log warning
6. Recovery runs before accepting HTTP requests

## Dependencies

$(deps_text T02 T06)

## Acceptance Criteria

- [ ] Previously-running teams with alive PIDs are re-attached
- [ ] Dead processes are detected and team status is updated
- [ ] Orphan worktrees are logged as warnings
- [ ] Server can restart without losing track of running teams
- [ ] Recovery runs during server init, before accepting requests
- [ ] Works on Windows (uses \`tasklist\` for PID checks)

## Design References

- \`docs/prd.md\` section 10 (startup recovery)
BODY
)"

create_issue "T21" "T21: Cost Tracking Service" \
  "priority:P2,size:M,group:integration" \
"$(cat <<BODY
## Description

Implement cost tracking by parsing cost data from Claude Code hook events. Extract input/output token counts and cost from \`SessionEnd\` events. Store in \`cost_entries\` table. Provide aggregation methods.

## Key file

\`src/server/services/cost-tracker.ts\`

## Dependencies

$(deps_text T02 T04)

## Acceptance Criteria

- [ ] \`SessionEnd\` events with cost data create \`cost_entries\` rows
- [ ] Cost data includes \`input_tokens\`, \`output_tokens\`, \`cost_usd\`
- [ ] \`GET /api/costs\` returns total cost for a time range
- [ ] \`GET /api/costs/by-team\` returns per-team breakdown
- [ ] \`GET /api/costs/by-day\` returns daily aggregation
- [ ] Cost is tracked per session_id to avoid double-counting
- [ ] \`v_team_dashboard\` view includes accurate total cost per team

## Design References

- \`docs/prd.md\` section 12 (cost tracking)
BODY
)"

create_issue "T22" "T22: Static File Serving and Production Build" \
  "priority:P1,size:S,group:integration" \
"$(cat <<BODY
## Description

Configure Fastify to serve Vite-built React frontend as static files in production. Proxy Vite dev server in dev mode. Single \`dist/\` folder with both server and client. SPA fallback for client-side routing.

## Key changes

- \`src/server/index.ts\` — add \`@fastify/static\`
- \`vite.config.ts\` — output to \`dist/client/\`
- \`package.json\` — \`build\` chains server + client builds

## Dependencies

$(deps_text T01 T11)

## Acceptance Criteria

- [ ] \`npm run build\` produces \`dist/server/\` and \`dist/client/\`
- [ ] \`npm start\` serves the React app at \`http://localhost:4680/\`
- [ ] API routes (\`/api/*\`) work alongside static file serving
- [ ] SPA fallback: non-API routes return \`index.html\`
- [ ] In dev mode, Vite HMR works with Fastify backend
- [ ] Source maps are generated

## Design References

- \`docs/prd.md\` section 15 (project structure)
BODY
)"

# ============================================================
# QUALITY (T23-T30)
# ============================================================

create_issue "T23" "T23: Backend Unit Tests" \
  "priority:P1,size:L,group:quality" \
"$(cat <<BODY
## Description

Write unit tests for core backend services using Vitest. Test: database layer (CRUD, views, schema init), event collector (parsing, state transitions), stuck detector (thresholds), SSE broker (connections, filtering), team manager (lifecycle). Use temporary SQLite DB. Mock external deps (\`gh\`, \`child_process\`).

## Key files

- \`tests/server/db.test.ts\`
- \`tests/server/event-collector.test.ts\`
- \`tests/server/stuck-detector.test.ts\`
- \`tests/server/sse-broker.test.ts\`
- \`tests/server/team-manager.test.ts\`
- \`vitest.config.ts\`

## Dependencies

$(deps_text T02 T04 T05 T07)

## Acceptance Criteria

- [ ] \`npm test\` runs all tests and reports results
- [ ] Database tests use temporary/in-memory DB
- [ ] All state machine transitions are tested
- [ ] Event collector tests cover all 9 event types
- [ ] External commands are mocked, not called
- [ ] Tests are isolated (fresh DB per test)
- [ ] Code coverage > 70% on core services
BODY
)"

create_issue "T24" "T24: Frontend Unit Tests" \
  "priority:P2,size:M,group:quality" \
"$(cat <<BODY
## Description

Write component tests for React frontend using Vitest + React Testing Library. Test rendering, interactions, and SSE-driven updates for: FleetGrid, TeamRow, StatusBadge, TopBar, TeamDetail, IssueTree, CostView. Mock API and SSE events.

## Key files

- \`tests/client/FleetGrid.test.tsx\`
- \`tests/client/TeamRow.test.tsx\`
- \`tests/client/TeamDetail.test.tsx\`
- \`tests/client/TopBar.test.tsx\`
- \`tests/client/IssueTree.test.tsx\`

## Dependencies

$(deps_text T12 T14 T15)

## Acceptance Criteria

- [ ] FleetGrid renders correct number of rows from mock data
- [ ] TeamRow displays all fields
- [ ] StatusBadge renders correct color for each status
- [ ] TopBar pills show correct counts
- [ ] TeamDetail opens and displays full information
- [ ] SSE mock events trigger re-renders
- [ ] Tests pass with \`npm run test:client\`
BODY
)"

create_issue "T25" "T25: API Integration Tests" \
  "priority:P2,size:M,group:quality" \
"$(cat <<BODY
## Description

Write integration tests that start Fastify with temp SQLite DB and exercise the full API request/response cycle. Test: event ingestion (POST -> DB -> state transition -> SSE), team lifecycle (launch -> events -> stuck -> stop), issue fetching with mocked \`gh\`.

## Key files

- \`tests/integration/event-flow.test.ts\`
- \`tests/integration/team-lifecycle.test.ts\`
- \`tests/integration/api-endpoints.test.ts\`

## Dependencies

$(deps_text T04 T06 T08 T09 T10)

## Acceptance Criteria

- [ ] Integration tests start and stop a real Fastify instance
- [ ] Event ingestion: POST \`/api/events\` -> verify DB row + SSE event
- [ ] Team lifecycle: create -> POST events -> verify status transitions
- [ ] All REST endpoints return correct HTTP status codes and shapes
- [ ] Tests clean up (temp DB, server shutdown) after each test
- [ ] \`gh\` CLI calls are mocked at the \`execSync\` level
BODY
)"

create_issue "T26" "T26: Error Handling and Logging" \
  "priority:P1,size:M,group:quality" \
"$(cat <<BODY
## Description

Add structured error handling and logging throughout the backend. Consistent error response format. Fastify's pino logger with appropriate log levels. Request ID tracking. Graceful shutdown (close DB, stop pollers, drain SSE, kill processes).

## Key changes

- \`src/server/index.ts\` — error handler plugin, graceful shutdown hooks
- \`src/server/middleware/error-handler.ts\` — centralized error formatting
- All route files — consistent error responses

## Dependencies

$(deps_text T01 T04 T06)

## Acceptance Criteria

- [ ] All API errors return \`{error, code, details?}\` format
- [ ] 400/404/500 status codes used appropriately
- [ ] Request logging: method, path, status code, response time
- [ ] Stack traces logged server-side only, not sent to client
- [ ] Uncaught exceptions log and keep server running
- [ ] Graceful shutdown: DB closed, intervals cleared, SSE closed, processes notified
- [ ] \`SIGINT\` and \`SIGTERM\` trigger graceful shutdown
- [ ] Log level configurable via \`LOG_LEVEL\` env var
BODY
)"

create_issue "T27" "T27: Event Throttling and Deduplication" \
  "priority:P2,size:S,group:quality" \
"$(cat <<BODY
## Description

Add server-side throttling for high-volume \`tool_use\` events. Per-team rate limiting: at most one DB insert per 5 seconds per team for \`tool_use\` events. Still update \`last_event_at\` for heartbeat. Never throttle non-\`tool_use\` events.

## Key changes

- \`src/server/services/event-collector.ts\` — add throttle/dedup logic

## Dependencies

$(deps_text T04)

## Acceptance Criteria

- [ ] \`tool_use\` events from same team within 5s are deduplicated
- [ ] \`last_event_at\` is still updated (heartbeat preserved)
- [ ] Non-\`tool_use\` events are never throttled
- [ ] Deduplicated events return 200 with \`processed: false\`
- [ ] DB growth reduced (~12 tool_use rows per team per minute max)
- [ ] SSE broadcast suppressed for deduplicated events
BODY
)"

create_issue "T28" "T28: Launch Dialog and Batch Launch UI" \
  "priority:P2,size:M,group:frontend" \
"$(cat <<BODY
## Description

Build UI for launching new teams. "Launch Team" button in TopBar opens dialog: issue number input (autocomplete from available issues), optional prompt, batch mode (comma-separated issues + stagger delay). Wire Play button in Issue Tree to same dialog.

## Key files

- \`src/client/components/LaunchDialog.tsx\` — modal dialog
- \`src/client/components/BatchLaunchForm.tsx\` — batch input

## Dependencies

$(deps_text T06 T12 T15)

## Acceptance Criteria

- [ ] "Launch Team" button in TopBar opens dialog
- [ ] Issue number input with autocomplete from \`GET /api/issues/available\`
- [ ] Optional prompt field (default: \`/next-issue-kea {number}\`)
- [ ] "Launch" calls \`POST /api/teams/launch\`
- [ ] Batch mode: comma-separated, stagger delay, calls \`POST /api/teams/launch-batch\`
- [ ] Play button in Issue Tree pre-fills dialog
- [ ] Success/error feedback after launch
- [ ] FleetGrid updates via SSE on successful launch
BODY
)"

create_issue "T29" "T29: End-to-End Smoke Test" \
  "priority:P2,size:M,group:quality" \
"$(cat <<BODY
## Description

E2E smoke test validating full flow without real Claude Code or GitHub. Start server, simulate hook events via POST, verify API responses, verify SSE events, check UI renders. Use mock \`claude\` command (sleep script).

## Key files

- \`tests/e2e/smoke-test.sh\` — bash script exercising full flow
- \`tests/e2e/mock-claude.sh\` — mock \`claude\` command
- \`tests/e2e/simulate-hooks.sh\` — sends hook event sequence

## Test flow

1. Start server with \`FLEET_CLAUDE_CMD=./tests/e2e/mock-claude.sh\`
2. POST \`session_start\` for team \`kea-999\`
3. POST several \`tool_use\` events
4. Verify \`GET /api/teams\` shows \`kea-999\` as \`running\`
5. Wait or set \`idleThresholdMin=0.1\`, verify team goes \`idle\`
6. POST another \`tool_use\`, verify returns to \`running\`
7. POST \`session_end\`, verify transition
8. Verify SSE stream received all expected events

## Dependencies

$(deps_text T04 T06 T11 T12 T17)

## Acceptance Criteria

- [ ] Smoke test runs without real Claude Code or GitHub access
- [ ] Hook event simulation produces correct state transitions
- [ ] SSE events are received by test client
- [ ] API responses match expected shapes
- [ ] Test completes in under 30 seconds (reduced thresholds)
- [ ] \`npm run test:e2e\` runs the test
BODY
)"

create_issue "T30" "T30: Documentation and Developer Guide" \
  "priority:P2,size:S,group:quality" \
"$(cat <<BODY
## Description

Update \`README.md\` with practical setup instructions, dev workflow, architecture overview. Document install/uninstall hooks, dev server, tests, production build, environment variables, troubleshooting.

## Key file

\`README.md\` (update existing)

## Sections

- Prerequisites (Node.js 20+, \`gh\` CLI, Git)
- Quick Start (install deps, start dev server, install hooks)
- Development (scripts, structure, adding features)
- Configuration (environment variables table)
- Architecture (component diagram, data flow)
- Troubleshooting (port conflicts, \`gh\` auth, worktree issues)
- API Reference (link to PRD)

## Dependencies

$(deps_text T17 T22)

## Acceptance Criteria

- [ ] README includes step-by-step Quick Start for Windows 10 + Git Bash
- [ ] All environment variables documented with defaults
- [ ] Install/uninstall scripts documented with examples
- [ ] Development workflow documented
- [ ] Architecture section includes component diagram
- [ ] Troubleshooting covers: port 4680, \`gh auth status\`, Git Bash paths
BODY
)"

echo ""
echo "=============================="
echo "All 30 issues created!"
echo "=============================="
echo ""
echo "Issue number mapping:"
for key in $(echo "${!ISSUES[@]}" | tr ' ' '\n' | sort); do
  echo "  $key -> #${ISSUES[$key]}"
done
