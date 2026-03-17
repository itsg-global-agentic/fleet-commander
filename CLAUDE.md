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
      schema.sql            # 6 tables: projects, teams, pull_requests, events, commands, usage_snapshots
      routes/               # REST API route handlers
        teams.ts            # CRUD + launch/stop/message
        projects.ts         # CRUD + install/uninstall/cleanup
        issues.ts           # GitHub issue fetching
        events.ts           # Hook event ingestion
        prs.ts              # Pull request operations
        stream.ts           # SSE endpoint
        usage.ts            # Usage snapshot API
        costs.ts            # Cost tracking (legacy)
        system.ts           # Health check, config
      services/
        team-manager.ts     # child_process.spawn, stdin/stdout pipes, lifecycle
        event-collector.ts  # Hook event processing -> DB -> SSE broadcast
        github-poller.ts    # gh CLI polling (PRs, CI, merges) every 30s
        issue-fetcher.ts    # GraphQL issue fetch with 60s cache
        stuck-detector.ts   # Idle (5min) and stuck (15min) detection
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
    workflow.md             # GitHub Actions workflow template
    next-issue.md           # Slash command template
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
| `src/server/schema.sql` | Full database schema (6 tables + 1 view) |
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

SQLite with WAL mode, 6 tables:

| Table | Purpose |
|-------|---------|
| `projects` | Registered repositories (path, GitHub slug, max teams, prompt file) |
| `teams` | Agent team instances (status, phase, PID, session, PR link) |
| `pull_requests` | PR tracking (state, CI status, merge state, auto-merge flag) |
| `events` | Hook events from CC sessions (type, tool name, payload JSON) |
| `commands` | Messages sent from dashboard to running agents |
| `usage_snapshots` | Usage percentage snapshots (daily, weekly, Sonnet, extra) |

Plus one view: `v_team_dashboard` (joins teams + projects + PRs for the grid).

## Team Lifecycle

| Transition | Trigger |
|------------|---------|
| `queued` -> `launching` | Slot available, spawn begins |
| `launching` -> `running` | CC process started, first event received |
| `running` -> `idle` | No events for 5 minutes |
| `running` -> `done` | Session ends normally |
| `running` -> `failed` | Process crashes or exits non-zero |
| `idle` -> `running` | New event received |
| `idle` -> `stuck` | No events for 15 minutes |
| `stuck` -> `running` | New event received |

Team ID format: `{project_slug}-{issue_number}` (used as worktree name).

## SSE Event Types

The SSE broker emits 14 event types:

1. `team:created`
2. `team:updated`
3. `team:output`
4. `team:removed`
5. `event:new`
6. `pr:created`
7. `pr:updated`
8. `ci:updated`
9. `command:sent`
10. `command:delivered`
11. `project:created`
12. `project:updated`
13. `usage:updated`
14. `heartbeat` (every 30s)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4680` | Server port |
| `FLEET_IDLE_THRESHOLD_MIN` | `5` | Minutes before idle status |
| `FLEET_STUCK_THRESHOLD_MIN` | `15` | Minutes before stuck status |
| `FLEET_MAX_CI_FAILURES` | `3` | Unique CI failures before blocking |
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
