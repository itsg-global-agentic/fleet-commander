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
      schema.sql            # 15 tables: projects, project_groups, project_issue_sources, teams, pull_requests, events, commands, usage_snapshots, schema_version, message_templates, team_transitions, agent_messages, stream_events, team_tasks, team_subworktrees
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
        issue-fetcher.ts    # GraphQL issue fetch with 5min cache
        stuck-detector.ts   # Idle (5min) and stuck (10min) detection
        sse-broker.ts       # SSE connection management, 17 event types, 30s heartbeat
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
        TeamTimeline.tsx    # Gantt-style timeline
        LaunchDialog.tsx    # Issue selection and team launch
        AddProjectDialog.tsx # New project form
        PRBadge.tsx         # PR status pill
        PRDetail.tsx        # PR popover with CI checks
        CIChecks.tsx        # CI check list
        CommandInput.tsx    # Send message to running agent
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
    send_event.sh           # Fire-and-forget POST to Fleet Commander (legacy bash mode)
    run-hook.sh             # Generic hook runner (delegates to send_event.sh)
    on_session_start.sh
    on_session_end.sh
    on_stop.sh
    on_notification.sh
    on_post_tool_use.sh
    on_tool_error.sh
    on_pre_compact.sh
    on_subagent_start.sh
    on_subagent_stop.sh
    on_stop_failure.sh
    on_teammate_idle.sh
    on_task_created.sh
    settings.json.example       # Settings template for legacy bash hooks
    settings.json.http.example  # Settings template for native HTTP hooks (CC 2.1.62+, default)
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
| `src/server/schema.sql` | Full database schema (15 tables + 1 view) |
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
npm test             # Server tests only (default, lightweight)
npm run test:server  # Server tests only (explicit alias)
npm run test:client  # Client tests only (jsdom, sequential, 4GB heap)
npm run test:all     # Server + client tests combined (4GB heap)
npm run test:watch   # Watch mode (all projects)
npm run test:e2e     # End-to-end smoke test
npm run launch       # Full launch: install + build + open browser
```

## Database

SQLite with WAL mode, 15 tables:

| Table | Purpose |
|-------|---------|
| `projects` | Registered repositories (path, GitHub slug, max teams, prompt file) |
| `project_groups` | Logical grouping of projects |
| `project_issue_sources` | Multiple issue providers per project (provider, config, credentials) |
| `teams` | Agent team instances (status, phase, PID, session, PR link) |
| `pull_requests` | PR tracking (state, CI status, merge state, auto-merge flag) |
| `events` | Hook events from CC sessions (type, tool name, payload JSON) |
| `commands` | Messages sent from dashboard to running agents |
| `usage_snapshots` | Usage percentage snapshots (daily, weekly, Sonnet, extra) |
| `schema_version` | Migration tracking |
| `message_templates` | Editable PM->TL message templates |
| `team_transitions` | State machine transition audit log |
| `agent_messages` | Inter-agent message tracking |
| `stream_events` | Raw CC stream events for output replay |
| `team_tasks` | Task tracking per team (from TaskCreated hooks) |
| `team_subworktrees` | CC-initiated subworktrees per team (path, branch, created_via, removed_at) from WorktreeCreate/WorktreeRemove hooks |

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
| `idle` -> `stuck` | No events for 10 minutes |
| `stuck` -> `running` | New event received |

Team ID format: `{project_slug}-{sanitized_issue_key}` (used as worktree name). For GitHub issues, the key is the issue number (e.g. `my-project-42`). For Jira/Linear, the key is sanitized (e.g. `my-project-proj-123` from `PROJ-123`).

## SSE Event Types

The SSE broker emits 18 event types:

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
15. `team_thinking_start`
16. `team_thinking_stop`
17. `task_updated`
18. `usage_override_changed`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4680` | Server port |
| `FLEET_HOST` | `0.0.0.0` | Network interface to bind to |
| `FLEET_DB_PATH` | (platform data dir) | Database file location. Defaults to platform user data dir |
| `FLEET_COMMANDER_ROOT` | (auto-detected) | Fleet Commander installation root. Auto-detected from package.json location or git root |
| `FLEET_BROWSE_ROOT` | (user home dir) | Root directory for filesystem browsing |
| `FLEET_TERMINAL` | `auto` | Windows terminal preference (`auto`/`wt`/`cmd`) |
| `FLEET_CLAUDE_CMD` | `claude` | Claude Code CLI command |
| `FLEET_SKIP_PERMISSIONS` | `true` | Skip CC permission prompts (`true`/`false`) |
| `FLEET_ENABLE_AGENT_TEAMS` | `true` | Enable agent teams feature (`true`/`false`) |
| `FLEET_PROMPT_CACHE_1H` | `true` | When `true`, set `ENABLE_PROMPT_CACHING_1H=1` on spawned CC processes for 1-hour prompt cache TTL. Set to `false` to use the default 5-minute TTL. |
| `FLEET_DEBUG_RAW_ISSUE_BODY` | `false` | When `true`, write `.fleet-issue-body-raw.md` next to `.fleet-issue-context.md` containing the unmodified GitHub issue body, for debugging image-preservation discrepancies. |
| `LOG_LEVEL` | `info` | Server log level |
| `FLEET_GITHUB_POLL_MS` | `60000` | GitHub PR/CI/merge poll interval (ms) |
| `FLEET_ISSUE_POLL_MS` | `600000` | Issue list poll interval (ms, default 10min) |
| `FLEET_ISSUE_UPDATE_POLL_MS` | `60000` | Issue update (comments, labels, body) poll interval (ms) |
| `FLEET_STUCK_CHECK_MS` | `60000` | Stuck/idle detection check interval (ms) |
| `FLEET_USAGE_POLL_MS` | `900000` | Usage percentage poll interval (ms, default 15min) |
| `FLEET_MAP_CLEANUP_MS` | `3600000` | In-memory map cleanup interval (ms, default 1hr) |
| `FLEET_IDLE_THRESHOLD_MIN` | `5` | Minutes before idle status |
| `FLEET_STUCK_THRESHOLD_MIN` | `10` | Minutes before stuck status |
| `FLEET_SUBAGENT_STUCK_THRESHOLD_MIN` | `3` | Minutes a subagent (planner/dev/reviewer) may be silent during an in-progress task before FC sends `subagent_stuck` to the TL with respawn instructions (issue #689). Set to `0` to disable. |
| `FLEET_LAUNCH_TIMEOUT_MIN` | `5` | Minutes before a launching team is marked failed |
| `FLEET_MAX_CI_FAILURES` | `3` | Unique CI failures before blocking |
| `FLEET_EARLY_CRASH_THRESHOLD_SEC` | `120` | Seconds before a SubagentStop is considered an early crash |
| `FLEET_EARLY_CRASH_MIN_TOOLS` | `5` | Minimum tool-use events for a subagent to be considered healthy |
| `FLEET_MAX_PR_POLL_CALLS` | `5` | Max gh pr view/checks calls per team per 10-minute window before sending a poll_warning |
| `FLEET_MERGE_SHUTDOWN_GRACE_MS` | `600000` | Grace period (ms) after PR merge before stopping the team |
| `FLEET_DEFAULT_MODEL` | `opus` | Default model name shown when neither the team nor the project specifies a model |
| `FLEET_DEFAULT_EFFORT` | (unset) | Default adaptive-reasoning effort level (`low\|medium\|high\|xhigh`) applied when a project has no `effort` set. Unset = let CC decide. Claude Code removed the legacy `max` level in 2.1.68 (`xhigh`, added in 2.1.111, is the new top tier and Opus 4.7 default); existing `effort='max'` project rows are auto-migrated to `xhigh` on startup. |
| `FLEET_CC_QUERY_MODEL` | `sonnet` | Claude model for CC query operations (e.g. `sonnet`, `opus`) |
| `FLEET_CC_QUERY_TIMEOUT_MS` | `30000` | Timeout (ms) for individual CC query calls |
| `FLEET_CC_QUERY_PRIORITIZE_TIMEOUT_MS` | `300000` | Timeout (ms) for AI issue prioritization |
| `FLEET_CC_QUERY_MAX_RETRIES` | `2` | Max retries for CC query calls |
| `FLEET_CC_QUERY_MAX_TURNS` | `4` | Max conversation turns for CC query calls |
| `FLEET_EVENTS_RETENTION_DAYS` | `90` | Days to retain hook events before cleanup |
| `FLEET_USAGE_RETENTION_DAYS` | `30` | Days to retain usage snapshots before cleanup |
| `FLEET_USAGE_RED_DAILY_PCT` | `85` | Daily usage percentage threshold for red warning |
| `FLEET_USAGE_RED_WEEKLY_PCT` | `95` | Weekly usage percentage threshold for red warning |
| `FLEET_USAGE_RED_SONNET_PCT` | `95` | Sonnet usage percentage threshold for red warning |
| `FLEET_USAGE_RED_EXTRA_PCT` | `95` | Extra usage percentage threshold for red warning |
| `FLEET_USAGE_HARD_EXTRA_PCT` | `90` | Extra usage % that triggers non-overridable hard pause |
| `FLEET_HOOK_LOG` | (platform data dir) | Path to hook execution log file. Defaults to `hooks.log` in platform data dir |
| `FLEET_ENCRYPTION_KEY` | (auto-generated) | Hex-encoded 32-byte encryption key for provider credentials. Auto-generated if not set |
| `FLEET_ENCRYPTION_KEY_OLD` | `null` | Previous encryption key (hex) for key rotation. Set alongside `FLEET_ENCRYPTION_KEY` to re-encrypt |

## Rules for AI Agents

1. **Read the PRD** -- `docs/prd.md` (in worktree archives) has full specifications.
2. **Projects are per-repo, teams are per-issue** -- one project = one git repository, one team = one issue being worked on.
3. **Team ID = `{project_slug}-{sanitized_issue_key}`** -- this is the worktree name and must be unique. For GitHub, the key is the issue number. For other providers (Jira, Linear), the key is sanitized (e.g. `PROJ-123` becomes `proj-123`).
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

## Hook Deployment Modes (issue #735)

Claude Code 2.1.62+ supports native HTTP hooks (`{"type": "http", "url": "..."}`)
that POST a hook's stdin JSON directly to a URL, eliminating the bash + curl
subshell startup cost (significant on Windows). FC supports both modes:

| Mode | Template | Transport | When to use |
|------|----------|-----------|------------|
| `http` (default) | `hooks/settings.json.http.example` | CC POSTs directly to `POST /api/hooks/:eventType` | New installs (CC 2.1.62+). Lower latency, fewer moving parts. |
| `bash` (legacy) | `hooks/settings.json.example` | CC spawns `bash run-hook.sh ... → send_event.sh → curl → POST /api/events` | CC < 2.1.62 or when you need the bash hook scripts to do custom pre-processing. |

- **New projects** default to `http` (see `ProjectService.createProject`).
- **Existing projects** can flip modes via the **Mode picker + Reinstall** button
  in `/projects` (or `POST /api/projects/:id/install` with `{ "mode": "http" | "bash" }`).
- **Reinstall is idempotent and exclusive** — install.sh first strips any prior
  FC entries (both bash and http) from `.claude/settings.json` and then adds
  the entries for the requested mode, so the two never coexist.
- The selected mode is recorded on `projects.hook_mode` (DB schema v24) and
  shown as an "HTTP / Bash / Unknown" badge in the install health row.
- The HTTP endpoint is `localhost`-only by default and has no auth — see
  issue #736 if you need to harden it for remote scenarios.

`install.sh --mode http --port 4680` substitutes `{{FLEET_PORT}}` in the http
template at install time. The `--port` flag falls back to the `FLEET_PORT`
environment variable (default 4680).

The `POST /api/hooks/:eventType` route lives in `src/server/routes/hooks.ts`
and reuses the same `event-collector` pipeline as the legacy `POST /api/events`
route via the shared `buildEventPayloadFromCc` helper. PascalCase hook names
(e.g. `SessionStart`, `PostToolUse`) are mapped to snake_case event types
(`session_start`, `tool_use`) inside the route.

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

## CC Auto-Memory & Spawned Teams

Claude Code 2.1.59+ ships an auto-memory feature that stores per-project notes under `~/.claude/projects/<cwd-derived>/memory/` and silently injects them into the system prompt at session start.

**Fleet Commander teams do NOT participate in auto-memory.** Every CC process Fleet Commander spawns — headless team agents, interactive terminal windows, and one-shot `-p` query calls — has auto-memory disabled unconditionally via both `autoMemoryEnabled: false` in the worktree's `.claude/settings.json` (deployed from `hooks/settings.json.example` by `team-manager.copyFCFiles`) and the `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` environment variable set in `src/server/utils/cc-spawn.ts` (`buildEnv()`).

Two reasons this is always-off and not configurable:
- FC teams are ephemeral single-issue workers — persistent context belongs in `CLAUDE.md`, the GitHub issue body, and the workflow prompt (`templates/workflow.md`), not in user-scoped memory.
- Memory files written by one team's session would be silently injected into unrelated teams running later in the same worktree-path hash, leaking facts across issues.

Configuration locations (defense-in-depth):
- `hooks/settings.json.example` — template copied to every worktree's `.claude/settings.json` on team launch. Carries the top-level `"autoMemoryEnabled": false` key.
- `src/server/utils/cc-spawn.ts` — the `buildEnv()` helper sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on every spawned CC process. On Windows interactive launches, the var is also written into the temp `.cmd` launcher file by `writeLauncherCmdFile()` (which forwards every `CLAUDE_CODE_*` env key).

## CC Subagent Worktree Isolation

Claude Code 2.1.49+ supports `isolation: "worktree"` in subagent frontmatter (and as an Agent tool flag) to run a subagent inside a temporary git worktree. CC creates the worktree at subagent start and removes it at subagent exit when there are no uncommitted changes / new commits; on a clean exit the worktree is fully torn down. WorktreeCreate / WorktreeRemove hooks fire on both events (issue #731).

**Fleet Commander's Diamond subagents (planner, dev, reviewer) do NOT use `isolation: "worktree"`.** Concrete reasons:

- The Diamond workflow is strictly sequential (planner → dev → reviewer; see `templates/workflow.md`). No two FC subagents ever edit the same files concurrently, so the isolation flag's parallelism benefit is zero for the default workflow.
- The planner and reviewer are read-only — they only write their handoff files (`plan.md`, `review.md`) into the team's main worktree and never edit source. Isolating them would just add a worktree create/destroy round-trip with no upside.
- The dev is the only writer, and isolating the dev actively breaks it. CC's subagent worktrees branch from `origin/HEAD` (default branch) unless `worktree.baseRef: "head"` is set in CC settings. The dev's commits would end up on the wrong branch in a different directory, and the TL's Phase 4 rebase / push runs in the team's main worktree which would never see those commits. (See `worktree.baseRef` discussion in `https://code.claude.com/docs/en/worktrees`.)

**When isolation IS useful (and permitted):** A TL may spawn multiple **read-only** research subagents in parallel via the `Agent` tool with `isolation: "worktree"` — for example, three subagents scanning different subtrees of a large repository. Each runs in its own throwaway worktree, no concurrent edits hit shared files, and CC tears the worktrees down automatically. This pattern is documented in `templates/workflow.md` under "Parallel research subagents (optional)". Do not use isolation for any subagent that needs to see uncommitted or unpushed work from a sibling subagent — the subworktree starts from `origin/HEAD` and is blind to in-flight changes elsewhere.

**FC tracking and cleanup:**

- Issue #731 added `WorktreeCreate` / `WorktreeRemove` hooks (`hooks/on_worktree_create.sh`, `hooks/on_worktree_remove.sh`) plus the `team_subworktrees` DB table. Every CC-initiated subworktree is recorded with `createdVia = 'cc'`; clean teardown sets `removed_at`.
- Issue #737 added automatic cleanup of orphan CC subworktrees when a team transitions to `done` or `failed`. The function `cleanupTeamCcSubworktrees(teamId)` in `src/server/services/cleanup.ts` runs `git worktree remove --force` (with `fs.rmSync` fallback) for any active CC subworktree row, then marks `removed_at` so retries are bounded. It is invoked from `team-manager.ts` `stop()` and `handleProcessExit()` after the terminal-state DB transition.
- The team's main worktree (the one FC itself created) is NOT auto-removed. That remains a manual operation via the Projects → Cleanup UI.

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
