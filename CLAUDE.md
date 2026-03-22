# CLAUDE.md

Fleet Commander is a standalone TypeScript web app (Fastify + React + SQLite) that provides a one-click dashboard for orchestrating multiple Claude Code agent teams across multiple git repositories. It manages projects (repos), launches CC teams per issue, monitors via hooks and GitHub polling, and enables bidirectional messaging to running agents via stdin pipes.

For full implementation details, see `docs/prd.md` in the worktree archives or the implementation report from the research sprint.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Server | Fastify 5, Node.js 20+ |
| Client | React 19, Vite 6 |
| Language | TypeScript 5.7 |
| Database | SQLite via better-sqlite3, WAL mode |
| Styling | Tailwind CSS (GitHub-dark theme) |
| Real-time | Server-Sent Events (SSE) |
| Agent interface | Claude Code CLI (`--input-format stream-json`, `--output-format stream-json`) |
| GitHub | `gh` CLI for all GitHub operations |
| Testing | Vitest, Testing Library |

## Project Structure

```
fleet-commander/
  src/
    server/
      index.ts              # Fastify app entry, route registration, service startup
      config.ts             # Environment variable parsing and validation
      db.ts                 # SQLite connection (WAL mode), schema init, query helpers
      schema.sql            # 8 tables: projects, teams, pull_requests, events, commands, usage_snapshots, schema_version, message_templates
      routes/               # REST API route handlers
        teams.ts            # CRUD + launch/stop/message
        projects.ts         # CRUD + install/uninstall/cleanup
        issues.ts           # GitHub issue fetching
        events.ts           # Hook event ingestion
        prs.ts              # Pull request operations
        stream.ts           # SSE endpoint
        usage.ts            # Usage snapshot API
        state-machine.ts    # State machine transitions + message template CRUD
        costs.ts            # Cost tracking (legacy)
        system.ts           # Health check, config
      services/
        team-manager.ts     # child_process.spawn, stdin/stdout pipes, lifecycle
        event-collector.ts  # Hook event processing -> DB -> SSE broadcast
        github-poller.ts    # gh CLI polling (PRs, CI, merges) every 30s
        issue-fetcher.ts    # GraphQL issue fetch with 60s cache
        stuck-detector.ts   # Idle (3min) and stuck (5min) detection
        sse-broker.ts       # SSE connection management, 14 event types, 30s heartbeat
        usage-tracker.ts    # Usage percentage polling
        startup-recovery.ts # Recover team state on server restart
        cleanup.ts          # Worktree and branch cleanup
      middleware/           # Fastify middleware (logging, error handling)
      utils/                # Shared server utilities
    client/
      main.tsx              # React app entry
      App.tsx               # Router and layout
      index.html            # HTML shell
      index.css             # Tailwind imports
      views/
        FleetGridView.tsx   # Main dashboard: team table + Gantt timeline
        IssueTreeView.tsx   # GitHub issue hierarchy with search and Play button
        UsageViewPage.tsx   # Usage progress bars
        ProjectsPage.tsx    # Project CRUD, install, cleanup, prompt editor
        SettingsPage.tsx    # Read-only config viewer
        StateMachinePage.tsx # Team lifecycle state machine diagram + message template editor
      components/
        FleetGrid.tsx       # Team table
        TeamRow.tsx         # Single team row
        TeamDetail.tsx      # Slide-over panel: output stream, events, commands
        TeamOutput.tsx      # CC stdout stream display
        TeamTimeline.tsx    # Gantt-style timeline
        LaunchDialog.tsx    # Issue selection and team launch
        AddProjectDialog.tsx # New project form
        PRBadge.tsx         # PR status pill
        PRDetail.tsx        # PR popover with CI checks
        CIChecks.tsx        # CI check list
        CommandInput.tsx    # Send message to running agent
        EventTimeline.tsx   # Event history list
        StatusBadge.tsx     # Team status indicator
        StatusBar.tsx       # Bottom status bar
        TopBar.tsx          # Top navigation bar
        SideNav.tsx         # Side navigation
        ProjectSelector.tsx # Project filter dropdown
        TreeNode.tsx        # Issue tree node
        CleanupModal.tsx    # Cleanup preview and confirm
        Icons.tsx           # SVG icon components
      context/              # React context providers
      hooks/                # Custom React hooks
    shared/
      types.ts              # Shared TypeScript types (Team, Project, Event, etc.)
      message-templates.ts  # Message template type definitions and defaults
  hooks/                    # CC hook scripts (deployed to target repos)
    send_event.sh           # Fire-and-forget POST to Fleet Commander
    on_session_start.sh
    on_session_end.sh
    on_stop.sh
    on_notification.sh
    on_post_tool_use.sh
    on_tool_error.sh
    on_pre_compact.sh
    on_subagent_start.sh
    on_subagent_stop.sh
  scripts/
    launch.js               # Auto-install + build + open browser
    install.sh / install.ps1
    uninstall.sh / uninstall.ps1
  templates/
    workflow.md             # Workflow prompt template (deployed to target repos)
  prompts/
    default-prompt.md       # Default launch prompt ({{ISSUE_NUMBER}} placeholder)
  tests/
    server/                 # Server unit tests
    client/                 # Component tests (Testing Library)
    integration/            # API endpoint tests
    e2e/                    # Smoke test shell scripts
  fleet-commander.bat       # Windows one-click launcher
  fleet.db                  # SQLite database (auto-created)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server/index.ts` | App entry point, registers routes, starts services |
| `src/server/config.ts` | All env var parsing, validation, frozen config object |
| `src/server/db.ts` | SQLite connection, WAL mode, schema initialization |
| `src/server/schema.sql` | Full database schema (8 tables + 1 view) |
| `src/server/services/team-manager.ts` | Spawns CC processes, manages stdin/stdout pipes |
| `src/server/services/event-collector.ts` | Receives hook events, writes to DB, broadcasts SSE |
| `src/server/services/github-poller.ts` | Polls GitHub via `gh` CLI for PR/CI/merge status |
| `src/server/services/sse-broker.ts` | Manages SSE connections and broadcasts |
| `src/server/services/stuck-detector.ts` | Periodic idle/stuck team detection |
| `src/shared/types.ts` | All shared TypeScript interfaces and type unions |
| `src/client/App.tsx` | React router and main layout |
| `src/client/views/FleetGridView.tsx` | Primary dashboard view |
| `src/client/components/TeamDetail.tsx` | Team detail slide-over panel |
| `hooks/send_event.sh` | Hook helper that POSTs events to the server |

## Development Commands

```bash
npm run dev          # Dev server + Vite HMR
npm run build        # Production build (tsc + vite)
npm start            # Production server (node dist/server/index.js)
npm test             # All tests (vitest)
npm run test:client  # Client tests only
npm run test:e2e     # End-to-end smoke test
npm run launch       # Full launch: install + build + open browser
```

## Database

SQLite with WAL mode, 8 tables:

| Table | Purpose |
|-------|---------|
| `projects` | Registered repositories (path, GitHub slug, max teams, prompt file) |
| `teams` | Agent team instances (status, phase, PID, session, PR link) |
| `pull_requests` | PR tracking (state, CI status, merge state, auto-merge flag) |
| `events` | Hook events from CC sessions (type, tool name, payload JSON) |
| `commands` | Messages sent from dashboard to running agents |
| `usage_snapshots` | Usage percentage snapshots (daily, weekly, Sonnet, extra) |
| `schema_version` | Migration tracking |
| `message_templates` | Editable PM->TL message templates |

Plus one view: `v_team_dashboard` (joins teams + projects + PRs for the grid).

## Team Lifecycle

| Transition | Trigger |
|------------|---------|
| `queued` -> `launching` | Slot available, spawn begins |
| `launching` -> `running` | CC process started, first event received |
| `running` -> `idle` | No events for 3 minutes |
| `running` -> `done` | Session ends normally |
| `running` -> `failed` | Process crashes or exits non-zero |
| `idle` -> `running` | New event received |
| `idle` -> `stuck` | No events for 5 minutes |
| `stuck` -> `running` | New event received |

Team ID format: `{project_slug}-{issue_number}` (used as worktree name).

## SSE Event Types

The SSE broker emits 14 event types:

1. `team_status_changed`
2. `team_event`
3. `team_output`
4. `pr_updated`
5. `team_launched`
6. `team_stopped`
7. `usage_updated`
8. `project_added`
9. `project_updated`
10. `project_removed`
11. `project_cleanup`
12. `snapshot`
13. `heartbeat` (every 30s)
14. `dependency_resolved`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4680` | Server port |
| `FLEET_HOST` | `0.0.0.0` | Network interface to bind to |
| `FLEET_IDLE_THRESHOLD_MIN` | `3` | Minutes before idle status |
| `FLEET_STUCK_THRESHOLD_MIN` | `5` | Minutes before stuck status |
| `FLEET_LAUNCH_TIMEOUT_MIN` | `5` | Minutes before a launching team is marked failed |
| `FLEET_MAX_CI_FAILURES` | `3` | Unique CI failures before blocking |
| `FLEET_EARLY_CRASH_THRESHOLD_SEC` | `120` | Seconds before a SubagentStop is considered an early crash |
| `FLEET_EARLY_CRASH_MIN_TOOLS` | `5` | Minimum tool-use events for a subagent to be considered healthy |
| `FLEET_GITHUB_POLL_MS` | `30000` | GitHub poll interval |
| `FLEET_DB_PATH` | `./fleet.db` | Database file location |
| `FLEET_TERMINAL` | `auto` | Windows terminal preference (`auto`/`wt`/`cmd`) |
| `FLEET_CLAUDE_CMD` | `claude` | Claude Code CLI command |
| `FLEET_SKIP_PERMISSIONS` | `true` | Skip CC permission prompts |
| `LOG_LEVEL` | `info` | Server log level |

## Rules for AI Agents

1. **Read the PRD** -- `docs/prd.md` (in worktree archives) has full specifications.
2. **Projects are per-repo, teams are per-issue** -- one project = one git repository, one team = one issue being worked on.
3. **Team ID = `{project_slug}-{issue_number}`** -- this is the worktree name and must be unique.
4. **Use `gh` CLI, not Octokit** -- all GitHub operations go through the `gh` command-line tool.
5. **SQLite WAL mode, synchronous API** -- use better-sqlite3's synchronous methods. No async DB calls.
6. **Hooks must never block CC** -- all hook scripts are fire-and-forget, must `exit 0` regardless of POST success/failure.
7. **Dark theme is default** -- use the GitHub-dark Tailwind palette. Do not add light theme toggles.
8. **Windows compatibility required** -- all file paths, process spawning, and scripts must work on Windows.
9. **Port 4680** -- the server always runs on port 4680 unless overridden by `PORT` env var.
10. **SSE, not WebSockets** -- real-time updates use Server-Sent Events exclusively.
11. **Stream JSON for CC** -- Claude Code is invoked with `--input-format stream-json --output-format stream-json` for stdin/stdout piping.
12. **No Octokit, no REST wrappers** -- shell out to `gh` for GitHub API calls.
13. **State machine transitions must ALWAYS be kept in sync with code.** The file `src/shared/state-machine.ts` defines all team status transitions, their triggers, conditions, and message templates. When modifying any code that changes team status (`db.updateTeam({ status: ... })`), you MUST also update `state-machine.ts` to reflect the change. The State Machine view in the UI (`/lifecycle`) reads from this file — if it's out of date, users will see incorrect transition information. The `message_templates` database table stores editable versions of messages sent to teams; defaults come from `state-machine.ts` and are seeded on startup.

## Development Workflow

This repo (`fleet-commander-dirty`) is the **development/dogfooding clone**. The production instance lives at `C:\Git\fleet-commander` (port 4680). This clone runs on **port 4681** with a separate database (`fleet-dirty.db`) so both can run side-by-side without interference.

- **Production:** `C:\Git\fleet-commander` — port 4680, `fleet.db` — used for real team orchestration
- **Development:** `C:\Git\fleet-commander-dirty` — port 4681 — used for development, testing, dogfooding

Start with: `fleet-commander-dirty.bat` (Windows) or `PORT=4681 node dist/server/index.js`

Never push untested changes directly to the production repo. Develop and validate here first.

## State Machine

The team lifecycle state machine is defined in `src/shared/state-machine.ts`. This is the single source of truth for:
- All valid status transitions (from → to)
- What triggers each transition (hook, timer, poller, PM action, system)
- What message (if any) is sent to the team via stdin
- Available {{PLACEHOLDER}} variables for each message

Message templates are stored in the `message_templates` DB table and can be edited from the `/lifecycle` UI view. The `resolveMessage()` utility in `src/server/utils/resolve-message.ts` reads templates from DB and replaces placeholders at runtime.

## MCP Server

Fleet Commander exposes tools via the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio transport. This allows Claude Code (or any MCP client) to query fleet state programmatically.

### Starting the MCP Server

```bash
node bin/fleet-commander-mcp.js
```

The MCP server is a separate process from the Fastify HTTP server. It initializes the database and background services but does NOT start HTTP. All logging goes to stderr since stdout is reserved for MCP JSON-RPC.

### `.mcp.json` Configuration

```json
{
  "mcpServers": {
    "fleet-commander": {
      "command": "node",
      "args": ["bin/fleet-commander-mcp.js"],
      "cwd": "/path/to/fleet-commander"
    }
  }
}
```

### Tool Naming Convention

All MCP tools use the `fleet_` prefix (e.g., `fleet_system_health`, `fleet_list_teams`).

### Adding New Tools

1. Create a new file in `src/server/mcp/tools/` (kebab-case filename without the `fleet_` prefix, e.g., `list-teams.ts`)
2. Export a single `register<ToolName>Tool(server: McpServer)` function
3. Use `server.tool(name, description, handler)` for zero-arg tools or `server.tool(name, description, schema, handler)` with Zod schemas for tools with parameters
4. Call exactly one service method from the handler — keep the tool thin
5. Return `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`
6. Register the tool in `src/server/mcp/index.ts`
7. Add tests in `tests/server/mcp/`
