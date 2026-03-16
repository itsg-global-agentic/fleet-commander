# Fleet Status MCP Server — Design Document

## Purpose

Lets Claude Code agent teams inspect how they appear to the PM dashboard ("Claude Fleet Commander"). Prevents hallucination by providing objective, external data — the team sees what the dashboard sees, not its own opinion.

## Architecture

```
                     ┌──────────────────────┐
                     │  Claude Fleet        │
                     │  Commander Dashboard │
                     │  (http://host:4680)  │
                     └──────┬───────────────┘
                            │ GET /api/teams/:id/status
                            │
┌────────────┐  stdio  ┌────┴───────────┐  fallback  ┌───────────────┐
│ Agent      │◄───────►│ fleet-mcp      │◄──────────►│ gh CLI + git  │
│ (worktree) │         │ server (node)  │            │ + signal files│
└────────────┘         └────────────────┘            └───────────────┘
```

### Two modes of operation

1. **Dashboard mode** (primary): MCP server forwards `fleet_status` call to the dashboard HTTP API. Dashboard has the authoritative view — session counts, costs, PM messages, team lifecycle.

2. **Standalone mode** (fallback): When the dashboard is unreachable (dev machine, offline), the server reconstructs status locally from:
   - `gh issue view` / `gh pr list` — issue and PR state
   - `gh pr view --json statusCheckRollup` — CI check details
   - `.pr-watcher-*` signal files — PR watcher state machine
   - `.fleet-pm-message` — PM messages (written by dashboard or manually)
   - `git log` — activity timestamps and branch divergence

## Single Tool: `fleet_status`

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "team_id": {
      "type": "string",
      "description": "Team identifier, e.g. 'kea-763'. Auto-detected if omitted."
    }
  }
}
```

### Output Schema

```json
{
  "team": "kea-763",
  "issue": {
    "number": 763,
    "title": "Add unit tests for AcceptanceMonit",
    "state": "open",
    "labels": ["P0", "unit-tests"]
  },
  "status": "running",
  "duration_minutes": 42,
  "sessions": 3,
  "last_event": "2025-03-16T14:30:00Z",
  "pr": {
    "number": 847,
    "state": "open",
    "ci_status": "failing",
    "checks": { "passed": 3, "failed": 2, "pending": 0 },
    "auto_merge": true,
    "url": "https://github.com/itsg-global-agentic/itsg-kea/pull/847"
  },
  "pm_message": "CI failing on integration tests, focus on NHibernate mapping",
  "cost_usd": 4.50,
  "workflow_state": "pr:ci-red"
}
```

### Status Values

| Status     | Meaning                                      |
|------------|----------------------------------------------|
| queued     | Issue assigned, team not yet spawned          |
| launching  | Team spawned, agents starting up              |
| running    | Agents actively working                       |
| stuck      | No activity >10 min while issue still open    |
| idle       | Agents alive but no recent activity (5-10m)   |
| done       | Issue closed, PR merged                       |
| failed     | Blocked or too many CI failures               |

### Workflow States

| State           | Coordinator FSM equivalent       |
|-----------------|----------------------------------|
| analyzing       | Analyst working on brief         |
| implementing    | Dev(s) coding                    |
| reviewing       | Weryfikator doing code review    |
| pr              | PR created, no CI data yet       |
| pr:ci-pending   | CI running                       |
| pr:ci-green     | CI passed                        |
| pr:ci-red       | CI failed, dev fixing            |
| pr:watching     | PR watcher active                |
| done            | Issue closed, PR merged          |

### Error Response

```json
{
  "error": "Cannot detect team ID",
  "code": "TEAM_NOT_FOUND",
  "suggestion": "Pass team_id explicitly (e.g. 'kea-763')"
}
```

## Team ID Auto-Detection

Detection order (first match wins):

1. **Explicit `team_id` parameter** — agent passes it directly
2. **Git branch name**:
   - `worktree-kea-763` -> `kea-763`
   - `refactor/fix/763-add-tests` -> `kea-763`
3. **Current directory path**: `.../kea-763/...` -> `kea-763`
4. **Environment variable**: `FLEET_TEAM_ID=kea-763`

## Configuration

### Per-project `.mcp.json` (recommended)

Add to the existing `.mcp.json`:

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["tools/fleet-mcp/dist/server.js"],
      "env": {
        "FLEET_SERVER_URL": "http://localhost:4680"
      }
    }
  }
}
```

### Per-session via `.claude/settings.json`

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["tools/fleet-mcp/dist/server.js"],
      "env": {
        "FLEET_SERVER_URL": "http://localhost:4680",
        "FLEET_TEAM_ID": "kea-763"
      }
    }
  }
}
```

### Environment Variables

| Variable          | Default                  | Description                    |
|-------------------|--------------------------|--------------------------------|
| FLEET_SERVER_URL  | http://localhost:4680    | Dashboard API base URL         |
| FLEET_TEAM_ID     | (auto-detected)          | Override team ID detection     |
| FLEET_TIMEOUT_MS  | 5000                     | HTTP timeout for dashboard API |

## Dashboard HTTP API Contract

The dashboard must implement this single endpoint:

```
GET /api/teams/:team_id/status
Accept: application/json

200 OK -> FleetStatusResponse (JSON)
404 Not Found -> { "error": "Team not found", "code": "TEAM_NOT_FOUND", ... }
500 Internal Server Error -> { "error": "...", "code": "INTERNAL_ERROR", ... }
```

## When Teams Should Call This

Agents should call `fleet_status` in these situations:

1. **Before creating a PR** — verify the issue is still in progress, no conflicting PR exists
2. **When stuck** — check if the PM sent a message or instruction
3. **After CI failure** — see the dashboard's view of check results
4. **Periodically during long operations** — verify the dashboard doesn't see the team as "stuck"
5. **At start of work** — confirm the issue is assigned and the team is tracked

## PM Message Mechanism

The dashboard (or a human) can send messages to a team by:

1. **Dashboard mode**: Setting `pm_message` in the team's database record
2. **Standalone mode**: Writing to `.fleet-pm-message` file in the worktree:
   ```bash
   echo "Focus on fixing NHibernate mapping first" > .fleet-pm-message
   ```

The agent sees this message in the `pm_message` field of the response.

## Installation

```bash
cd tools/fleet-mcp
npm install
npm run build
```

## Integration with Existing Infrastructure

This server complements the existing hook-based coordination:

- **`.pr-watcher-*` signal files** — read by fleet-mcp to determine workflow state
- **`.fleet-pm-message`** — new file, read by fleet-mcp for PM messages
- **`pr-watcher-idle.sh` hook** — unchanged, continues to manage CI monitoring
- **`gh` CLI** — used by fleet-mcp for GitHub API queries (same auth as agents)

No changes to existing agent prompts or hooks are required. The MCP server is additive.
