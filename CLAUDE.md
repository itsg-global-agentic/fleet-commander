# CLAUDE.md — Fleet Commander

## Project Overview

Fleet Commander is a TypeScript web dashboard for orchestrating multiple Claude Code agent teams working on GitHub issues in parallel. It replaces manual CLI-based team management (`claude-bonanza.ps1`) with a unified web interface where a PM can launch, monitor, intervene, and resume teams from a single dashboard. The project targets the `itsg-global-agentic/itsg-kea` repository.

## Current State

**Design phase.** The hook infrastructure (10 bash scripts) and MCP server are implemented. The backend server, frontend, database layer, and tests do not exist yet. All design documents are finalized and authoritative.

## Quick Start

```bash
# When implemented, the intended workflow is:
npm install
npm run build
npm run dev          # Starts Fastify server on http://localhost:4680

# MCP server (already implemented):
cd mcp && npm install && npm run build
```

## Architecture

```
Browser (localhost:4680)
  |-- SSE (real-time updates)
  |-- REST API (CRUD, commands)
  v
Fastify Server (Node.js)
  |-- Team Manager (spawn/stop/resume via child_process.spawn)
  |-- GitHub Poller (gh CLI, every 30s for PR/CI status)
  |-- Event Collector (receives hook HTTP POSTs)
  |-- MCP Server (fleet_status tool, stdio transport)
  v
SQLite (fleet.db, WAL mode, better-sqlite3)
```

Hook events flow from Claude Code instances via `curl POST` to `/api/events`. The dashboard also polls GitHub independently via `gh` CLI for PR and CI status. See design docs for full details.

## Tech Stack

| Layer         | Technology                          | Notes                              |
|---------------|-------------------------------------|------------------------------------|
| Runtime       | Node.js 20+                         | Single process                     |
| Backend       | Fastify + TypeScript                | Port 4680                          |
| Frontend      | React + Vite + Tailwind CSS         | Dark theme default                 |
| Database      | SQLite + better-sqlite3             | WAL mode, file: `fleet.db`         |
| Real-time     | SSE (Server-Sent Events)            | EventSource API                    |
| GitHub API    | `gh` CLI (pre-authenticated)        | NOT Octokit                        |
| Process mgmt  | `child_process.spawn`               | Launches Claude Code teams         |
| Hooks         | POSIX bash scripts + curl           | Fire-and-forget, always exit 0     |
| MCP           | `@modelcontextprotocol/sdk`         | stdio transport, `fleet_status` tool |

## Project Structure

```
fleet-commander/
├── CLAUDE.md               # This file — agent reference guide
├── README.md               # Project overview
├── .gitignore              # node_modules, dist, fleet.db, .env, *.log
├── docs/
│   ├── prd.md              # Full PRD (Polish + English, 1051 lines)
│   ├── state-machines.md   # 5 FSMs: team, phase, PR, issue, event pipeline
│   ├── data-model.sql      # SQLite schema (11 tables, 3 views, with indexes)
│   └── types.ts            # TypeScript interfaces (14 interfaces, all enums)
├── hooks/
│   ├── DESIGN.md           # Hook architecture, payload format, edge cases
│   ├── send_event.sh       # Core event sender (JSON build + curl POST)
│   ├── on_session_start.sh # Hook: SessionStart
│   ├── on_session_end.sh   # Hook: SessionEnd
│   ├── on_stop.sh          # Hook: Stop
│   ├── on_subagent_start.sh# Hook: SubagentStart
│   ├── on_subagent_stop.sh # Hook: SubagentStop
│   ├── on_notification.sh  # Hook: Notification
│   ├── on_pre_compact.sh   # Hook: PreCompact
│   ├── on_post_tool_use.sh # Hook: PostToolUse (heartbeat)
│   ├── on_tool_error.sh    # Hook: PostToolUseFailure
│   └── settings.json.example # Complete settings.json with all hooks wired
├── mcp/
│   ├── DESIGN.md           # MCP server design, API contract, auto-detection
│   ├── package.json        # @modelcontextprotocol/sdk ^1.12.1
│   ├── tsconfig.json
│   ├── src/                # TypeScript source (implemented)
│   └── dist/               # Compiled JS output
└── src/                    # (NOT YET CREATED) Backend + frontend source
```

## Development Commands

```bash
# Root project (when package.json exists):
npm install               # Install dependencies
npm run build             # Compile TypeScript
npm run dev               # Start dev server with hot reload
npm test                  # Run test suite

# MCP server (already implemented):
cd mcp
npm install
npm run build             # tsc
npm run dev               # tsc && node dist/server.js
npm start                 # node dist/server.js
```

## Key Conventions

### Naming
- **Team ID** = worktree name = `kea-{ISSUE_NUMBER}` (e.g., `kea-763`)
- **Database columns** use `snake_case`
- **TypeScript interfaces** use `PascalCase`; fields use `camelCase`
- **Hook event types** use `snake_case` in payloads (e.g., `tool_use`, `session_start`)
- **API routes** follow `/api/{resource}` pattern

### State Machines (follow exactly as defined)
- **Team status:** `queued -> launching -> running -> idle (5min) -> stuck (15min) -> done/failed`
- **Team phase:** `analyzing -> implementing -> reviewing -> pr -> done/blocked`
- **PR lifecycle:** `none -> draft -> open -> ci_pending -> ci_passing/ci_failing -> merged`
- **Issue board:** `Backlog -> Ready -> InProgress -> Done/Blocked`

### Thresholds
```typescript
const IDLE_THRESHOLD_MIN = 5;
const STUCK_THRESHOLD_MIN = 15;
const MAX_UNIQUE_CI_FAILURES = 3;  // triggers "blocked"
const GITHUB_POLL_INTERVAL_SEC = 30;
```

### Constraints
- Dashboard port: **4680**
- Database file: `fleet.db` (gitignored, SQLite WAL mode)
- Hooks POST to `http://localhost:4680/api/events`
- Hooks must **never block** Claude Code (curl backgrounded, exit 0 always)
- Use **`gh` CLI** for all GitHub operations, never Octokit
- **Windows-first**: runs on Windows 10 + Git Bash; no Linux-only tools (no tmux, no Linux-only commands)
- Frontend must default to **dark theme**
- Hooks coexist with existing `pr-watcher-idle.sh` (non-destructive)

## Design Docs Reference

| Document                     | Covers                                                         |
|------------------------------|----------------------------------------------------------------|
| `docs/prd.md`                | Full requirements, architecture diagram, API endpoints, UI     |
| `docs/prd.md` section 4      | **V1 database schema** (5 tables + 1 view) — use this for implementation |
| `docs/state-machines.md`     | All 5 FSMs with transition tables, event-to-transition mapping |
| `docs/data-model.sql`        | Expanded schema (8 tables, 3 views) — reference for future expansion |
| `docs/types.ts`              | All TypeScript interfaces and enum types (aligned with expanded schema) |
| `hooks/DESIGN.md`            | Hook architecture, payload format, edge cases, rate limiting   |
| `mcp/DESIGN.md`              | MCP server design, `fleet_status` tool, auto-detection logic   |

## Environment Variables

| Variable             | Default                    | Description                                |
|----------------------|----------------------------|--------------------------------------------|
| `FLEET_SERVER_URL`   | `http://localhost:4680`    | Dashboard API base URL                     |
| `FLEET_TEAM_ID`      | (auto-detected)            | Override team ID detection                 |
| `FLEET_COMMANDER_OFF`| (unset)                    | Set to `1` to disable hook event sending   |
| `FLEET_TIMEOUT_MS`   | `5000`                     | HTTP timeout for MCP -> dashboard API      |
| `PORT`               | `4680`                     | Dashboard server port                      |

## Rules for AI Agents

1. **Read the relevant design doc before implementing.** The PRD, state machines, data model, and type definitions are authoritative. Do not deviate from them.

2. **Follow state machine transitions exactly.** All valid transitions are enumerated in `docs/state-machines.md`. Do not invent new states or transitions.

3. **Hooks must never block Claude Code.** Every hook script must background its curl call and exit 0 unconditionally. See `hooks/DESIGN.md` section 2.1.

4. **Use `gh` CLI for GitHub, not Octokit.** The system assumes `gh` is pre-authenticated. Shell out to `gh pr view`, `gh run list`, etc.

5. **SQLite with WAL mode and better-sqlite3.** Use synchronous API (not async). Enable WAL mode on database open: `PRAGMA journal_mode=WAL`.

6. **Dark theme is the default** for all frontend components. Use Tailwind CSS dark-mode utilities.

7. **Windows compatibility is required.** Test with Git Bash on Windows 10. Avoid Linux-only commands. Use forward slashes in paths within bash scripts.

8. **Team ID format is `kea-{ISSUE_NUMBER}`.** This is the worktree name and the primary identifier across hooks, database, and API.

9. **Port 4680** is the canonical dashboard port. Do not change it.

10. **Observe, don't ask.** Team status is derived from hooks, git state, and GitHub API polling. Never rely on agent self-reports.

11. **Fire-and-forget for hooks.** The dashboard tolerates lost events. If the server is down, events are simply dropped. The dashboard can reconstruct state from git and GitHub on restart.

12. **Coexist with existing infrastructure.** Do not modify or replace `pr-watcher-idle.sh`, `bash-worktree-fix.sh`, or other existing hooks. Fleet Commander hooks are additive observers only.

13. **Two schemas exist — use the PRD schema for v1.** The PRD section 4 has a simpler 5-table schema (`teams`, `pull_requests`, `events`, `commands`, `cost_entries` + `v_team_dashboard` view). The file `docs/data-model.sql` has an expanded 8-table schema (adding `issues`, `sessions`, `agents`, `ci_runs`). For v1, implement the PRD schema. The expanded schema in `docs/data-model.sql` and `docs/types.ts` is reference material for future iterations. Note: the PRD includes an `init` phase not present in `docs/state-machines.md` — implement with `init` as the default phase value matching the PRD.
