# Fleet Commander

**One-click dashboard for orchestrating Claude Code agent teams across multiple repositories.**

No setup. No config files. Double-click and go.

> **Why Fleet Commander?** Other tools require you to configure YAML, write plugins, set up databases. Fleet Commander works out of the box.

## Prerequisites

- **Node.js 20+** ([download](https://nodejs.org/))
- **GitHub CLI** (`gh`) authenticated -- run `gh auth login`, then `gh auth status` to verify

That's it.

## Quick Start

### Windows (double-click)
1. Clone this repo
2. Double-click `fleet-commander.bat`
3. Browser opens -- add your first project -- launch teams

### Terminal
```bash
git clone https://github.com/itsg-global-agentic/fleet-commander.git
cd fleet-commander
npm run launch    # auto-installs, builds, opens browser
```

That's it. Fleet Commander automatically:
- Installs dependencies on first run
- Builds the app on first run
- Opens your browser to the dashboard
- Creates the database
- Installs hooks when you add a project
- Removes hooks when you remove a project

### Adding Your First Project

1. Click the **Projects** icon in the sidebar
2. Click **"Add Project"**
3. Browse to your repo folder
4. Click **Add** -- hooks are auto-installed
5. Go to **Issue Tree** -- click **Refresh** -- see your issues
6. Launch teams from **Fleet Grid** or **Issue Tree**

## Installing Hooks Manually

Fleet Commander installs and removes hooks automatically when you add or remove a project. If you need manual control:

```bash
./scripts/install.sh /path/to/target/repo
```

This copies hook scripts into the target repo's `.claude/` directory and merges the required `settings.json` entries. Hooks are additive observers -- they do not modify or replace existing hooks.

To cleanly remove all Fleet Commander hooks from a target repo:

```bash
./scripts/uninstall.sh /path/to/target/repo
```

## Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend (Fastify) + frontend (Vite) with hot reload |
| `npm run build` | Production build (TypeScript + Vite) |
| `npm test` | Backend unit tests (208+ tests) |
| `npm run test:client` | Frontend component tests (42+ tests) |
| `npm run test:e2e` | End-to-end smoke test (requires running server) |
| `npm run test:watch` | Run backend tests in watch mode |

### Project Structure

```
fleet-commander/
├── src/
│   ├── server/              # Fastify backend
│   │   ├── index.ts         # Server entry point
│   │   ├── config.ts        # Environment-driven configuration
│   │   ├── db.ts            # SQLite database layer (WAL mode)
│   │   ├── routes/          # API route handlers
│   │   │   ├── teams.ts     # Team CRUD + lifecycle
│   │   │   ├── events.ts    # Hook event ingestion
│   │   │   ├── prs.ts       # Pull request management
│   │   │   ├── issues.ts    # GitHub issue tracking
│   │   │   ├── projects.ts  # Project CRUD (multi-repo)
│   │   │   ├── usage.ts     # Usage tracking aggregation
│   │   │   ├── stream.ts    # SSE real-time stream
│   │   │   └── system.ts    # Diagnostics + health
│   │   ├── services/        # Business logic
│   │   │   ├── team-manager.ts      # Spawn/stop/resume via child_process
│   │   │   ├── event-collector.ts   # Process incoming hook events
│   │   │   ├── github-poller.ts     # Poll GitHub via gh CLI (30s)
│   │   │   ├── stuck-detector.ts    # Detect idle/stuck teams (60s)
│   │   │   ├── sse-broker.ts        # Server-Sent Events broadcaster
│   │   │   ├── usage-tracker.ts      # Usage % tracking
│   │   │   ├── startup-recovery.ts  # Recover state on restart
│   │   │   └── issue-fetcher.ts     # Fetch issues from GitHub
│   │   └── middleware/
│   │       └── error-handler.ts     # Global error handling
│   ├── client/              # React SPA (dark theme)
│   │   ├── main.tsx         # Client entry point
│   │   ├── App.tsx          # Router + layout
│   │   ├── components/      # Reusable UI components
│   │   ├── views/           # Page-level views
│   │   ├── context/         # React context (FleetContext)
│   │   └── hooks/           # Custom hooks (useSSE, useApi)
│   └── shared/
│       └── types.ts         # Shared TypeScript interfaces + enums
├── hooks/                   # Bash hook scripts (installed into target repos)
├── scripts/                 # Install/uninstall scripts
├── mcp/                     # MCP server (fleet_status tool)
├── tests/                   # Test suites (server, client, e2e, integration)
├── docs/                    # Design documents
└── CLAUDE.md                # Agent reference guide
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4680` | Dashboard server port |
| `FLEET_SERVER_URL` | `http://localhost:4680` | Dashboard API base URL (used by hooks) |
| `FLEET_TEAM_ID` | *(auto-detected)* | Override team ID detection in hooks |
| `FLEET_COMMANDER_OFF` | *(unset)* | Set to `1` to disable hook event sending |
| `FLEET_TIMEOUT_MS` | `5000` | HTTP timeout for MCP-to-dashboard API calls |

## Architecture

```
Browser --> React SPA (dark theme, Tailwind CSS)
  |  SSE (real-time updates) + REST API
  v
Fastify Server (port 4680)
  |-- Projects Manager (multi-repo project registry)
  |-- Team Manager     (per-project child_process.spawn)
  |-- Event Collector  (receives hook POST events)
  |-- GitHub Poller    (per-project, gh CLI, every 30s)
  |-- Stuck Detector   (60s check for idle/stuck teams)
  |-- Usage Tracker    (% of plan limits)
  |-- Startup Recovery (reconstruct state on restart)
  v
SQLite (fleet.db, WAL mode, better-sqlite3)
```

Fleet Commander is a standalone application managing multiple repositories. Each project stores its repo path and GitHub remote. Teams are scoped to a project.

Hook events flow from Claude Code instances via `curl POST` to `/api/events`. The dashboard independently polls GitHub via `gh` CLI for PR and CI status. State can be reconstructed from git and GitHub if events are lost.

## API Overview

| Group | Endpoints | Description |
|-------|-----------|-------------|
| **Projects** | `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects`, `PUT /api/projects/:id`, `DELETE /api/projects/:id` | Multi-repo project management |
| **Teams** | `GET /api/teams`, `GET /api/teams/:id`, `POST /api/teams/launch`, `POST /api/teams/launch-batch`, `POST /api/teams/:id/stop`, `POST /api/teams/:id/resume`, `POST /api/teams/:id/restart`, `POST /api/teams/stop-all`, `POST /api/teams/:id/send-message`, `POST /api/teams/:id/set-phase`, `POST /api/teams/:id/acknowledge`, `GET /api/teams/:id/output` | Team lifecycle and intervention (launch/batch-launch require `project_id`) |
| **Events** | `POST /api/events`, `GET /api/events` | Hook event ingestion and query |
| **PRs** | `GET /api/prs`, `GET /api/prs/:number`, `POST /api/prs/refresh`, `POST /api/prs/:number/auto-merge`, `POST /api/prs/:number/update-branch`, `POST /api/prs/:number/retry-ci` | Pull request management |
| **Issues** | `GET /api/issues`, `GET /api/issues/next`, `GET /api/issues/available`, `POST /api/issues/refresh` | GitHub issue tracking (per-project) |
| **Usage** | `GET /api/usage`, `GET /api/usage/by-team`, `GET /api/usage/by-day`, `GET /api/usage/current` | Usage tracking (% of plan limits) |
| **Diagnostics** | `GET /api/diagnostics/stuck`, `GET /api/diagnostics/blocked`, `GET /api/diagnostics/health`, `GET /api/status` | Fleet health and diagnostics |
| **Stream** | `GET /api/stream` | SSE real-time event stream |

## Troubleshooting

**Port 4680 already in use**
```bash
PORT=4681 npm run dev
```

**`gh` not authenticated**
```bash
gh auth login
gh auth status   # verify
```

**Git Bash path issues on Windows**
Use forward slashes in all paths. Avoid backslashes in scripts and configuration.

**Database locked**
Ensure only one server instance is running. Fleet Commander uses SQLite in WAL mode, which supports concurrent reads but only one writer.

**Worktree issues**
```bash
git worktree list          # see all worktrees
git worktree prune         # clean up stale entries
```

**No projects configured**
Add at least one project via the UI or `POST /api/projects` before launching teams. Each project needs a local repo path and GitHub remote (e.g., `itsg-global-agentic/itsg-kea`).

**Hook events not arriving**
- Verify the server is running on the expected port
- Check that `FLEET_COMMANDER_OFF` is not set to `1`
- Hooks are fire-and-forget; if the server was down, events are dropped

## Design Documents

| Document | Description |
|----------|-------------|
| [PRD](docs/prd.md) | Full product requirements, architecture, API spec, UI wireframes |
| [State Machines](docs/state-machines.md) | 5 FSMs: team status, phase, PR lifecycle, issue board, event pipeline |
| [Data Model](docs/data-model.sql) | SQLite schema (tables, views, indexes) |
| [Type Definitions](docs/types.ts) | TypeScript interfaces and enum types |
| [Hook Architecture](hooks/DESIGN.md) | Hook design, payload format, edge cases |
| [MCP Server](mcp/DESIGN.md) | MCP server design, `fleet_status` tool, auto-detection |
