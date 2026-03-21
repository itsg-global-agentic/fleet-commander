# Fleet Commander API Reference

Complete reference for the Fleet Commander REST API (71 endpoints) and SSE stream (16 event types).

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Rate Limits](#rate-limits)
- [Error Response Format](#error-response-format)
- [Quick Reference Table](#quick-reference-table)
- [Teams (22 endpoints)](#teams)
  - [POST /api/teams/launch](#post-apiteamslaunch)
  - [POST /api/teams/launch-batch](#post-apiteamslaunch-batch)
  - [POST /api/teams/stop-all](#post-apiteamsstop-all)
  - [POST /api/teams/:id/stop](#post-apiteamsidstop)
  - [POST /api/teams/:id/force-launch](#post-apiteamsidforce-launch)
  - [POST /api/teams/:id/resume](#post-apiteamsidresume)
  - [POST /api/teams/:id/restart](#post-apiteamsidrestart)
  - [GET /api/teams](#get-apiteams)
  - [GET /api/teams/:id](#get-apiteamsid)
  - [GET /api/teams/:id/status](#get-apiteamsidstatus)
  - [GET /api/teams/:id/output](#get-apiteamsidoutput)
  - [GET /api/teams/:id/stream-events](#get-apiteamsidstream-events)
  - [GET /api/teams/:id/timeline](#get-apiteamsidtimeline)
  - [GET /api/teams/:id/export](#get-apiteamsidexport)
  - [GET /api/teams/:id/events](#get-apiteamsidevents)
  - [POST /api/teams/:id/send-message](#post-apiteamsidsend-message)
  - [POST /api/teams/:id/set-phase](#post-apiteamsidset-phase)
  - [GET /api/teams/:id/roster](#get-apiteamsidroster)
  - [GET /api/teams/:id/transitions](#get-apiteamsidtransitions)
  - [POST /api/teams/:id/acknowledge](#post-apiteamsidacknowledge)
  - [GET /api/teams/:id/messages](#get-apiteamsidmessages)
  - [GET /api/teams/:id/messages/summary](#get-apiteamsidmessagessummary)
- [Projects (11 endpoints)](#projects)
  - [GET /api/projects](#get-apiprojects)
  - [POST /api/projects](#post-apiprojects)
  - [GET /api/projects/:id](#get-apiprojectsid)
  - [PUT /api/projects/:id](#put-apiprojectsid)
  - [DELETE /api/projects/:id](#delete-apiprojectsid)
  - [POST /api/projects/:id/install](#post-apiprojectsidinstall)
  - [GET /api/projects/:id/teams](#get-apiprojectsidteams)
  - [GET /api/projects/:id/cleanup-preview](#get-apiprojectsidcleanup-preview)
  - [POST /api/projects/:id/cleanup](#post-apiprojectsidcleanup)
  - [GET /api/projects/:id/prompt](#get-apiprojectsidprompt)
  - [PUT /api/projects/:id/prompt](#put-apiprojectsidprompt)
- [Project Groups (5 endpoints)](#project-groups)
  - [GET /api/project-groups](#get-apiproject-groups)
  - [POST /api/project-groups](#post-apiproject-groups)
  - [GET /api/project-groups/:id](#get-apiproject-groupsid)
  - [PUT /api/project-groups/:id](#put-apiproject-groupsid)
  - [DELETE /api/project-groups/:id](#delete-apiproject-groupsid)
- [Issues (8 endpoints)](#issues)
  - [GET /api/issues](#get-apiissues)
  - [GET /api/issues/next](#get-apiissuesnext)
  - [GET /api/issues/available](#get-apiissuesavailable)
  - [GET /api/issues/:number](#get-apiissuesnumber)
  - [GET /api/issues/:number/dependencies](#get-apiissuesnumberdependencies)
  - [GET /api/projects/:projectId/issues](#get-apiprojectsprojectidissues)
  - [GET /api/projects/:projectId/issues/dependencies](#get-apiprojectsprojectidissuesdependencies)
  - [POST /api/issues/refresh](#post-apiissuesrefresh)
- [Pull Requests (6 endpoints)](#pull-requests)
  - [GET /api/prs](#get-apiprs)
  - [GET /api/prs/:number](#get-apiprsnumber)
  - [POST /api/prs/refresh](#post-apiprsrefresh)
  - [POST /api/prs/:number/enable-auto-merge](#post-apiprsnumberenable-auto-merge)
  - [POST /api/prs/:number/disable-auto-merge](#post-apiprsnumberdisable-auto-merge)
  - [POST /api/prs/:number/update-branch](#post-apiprsnumberupdate-branch)
- [Events (2 endpoints)](#events)
  - [POST /api/events](#post-apievents)
  - [GET /api/events](#get-apievents)
- [Usage (3 endpoints)](#usage)
  - [GET /api/usage](#get-apiusage)
  - [GET /api/usage/history](#get-apiusagehistory)
  - [POST /api/usage](#post-apiusage)
- [State Machine and Message Templates (3 endpoints)](#state-machine-and-message-templates)
  - [GET /api/state-machine](#get-apistate-machine)
  - [GET /api/message-templates](#get-apimessage-templates)
  - [PUT /api/message-templates/:id](#put-apimessage-templatesid)
- [Query (1 endpoint)](#query)
  - [POST /api/query/:queryName](#post-apiqueryqueryname)
- [System and Diagnostics (9 endpoints)](#system-and-diagnostics)
  - [GET /api/health](#get-apihealth)
  - [GET /api/status](#get-apistatus)
  - [GET /api/settings](#get-apisettings)
  - [GET /api/diagnostics/stuck](#get-apidiagnosticsstuck)
  - [GET /api/diagnostics/blocked](#get-apidiagnosticsblocked)
  - [GET /api/diagnostics/health](#get-apidiagnosticshealth)
  - [GET /api/debug/teams](#get-apidebugteams)
  - [GET /api/system/browse-dirs](#get-apisystembrowse-dirs)
  - [POST /api/system/factory-reset](#post-apisystemfactory-reset)
- [SSE Stream](#sse-stream)
  - [GET /api/stream](#get-apistream)
  - [Connection Setup](#connection-setup)
  - [Initial Snapshot](#initial-snapshot)
  - [Heartbeat](#heartbeat)
  - [Event Types (16)](#event-types)
- [Workflow Examples](#workflow-examples)
  - [Launch a Team and Monitor Progress](#launch-a-team-and-monitor-progress)
  - [Send a Message to a Running Team](#send-a-message-to-a-running-team)
  - [Monitor Fleet via SSE](#monitor-fleet-via-sse)
- [TypeScript Types Reference](#typescript-types-reference)

---

## Overview

| Property | Value |
|----------|-------|
| Base URL | `http://localhost:4680` |
| Content-Type | `application/json` (unless otherwise noted) |
| Authentication | None (local-only tool) |
| Rate Limiting | None |
| Real-time Updates | Server-Sent Events at `GET /api/stream` |
| API Prefix | All endpoints are under `/api/` |

Fleet Commander is a local-only orchestration tool. It does not require authentication or enforce rate limits. All requests and responses use JSON unless explicitly stated otherwise (e.g., SSE stream, file exports).

---

## Authentication

Fleet Commander runs as a local tool on `localhost`. There is no authentication mechanism. All endpoints are accessible without credentials.

---

## Rate Limits

No rate limits are enforced. The server is designed for local use by a single operator.

---

## Error Response Format

All error responses return a JSON object with `error` and `message` fields:

```json
{
  "error": "Not Found",
  "message": "Team 42 not found"
}
```

Some endpoints include additional fields:

```json
{
  "error": "Blocked by Dependencies",
  "message": "Issue #15 is blocked by open dependencies: #10, #12",
  "hint": "Set force: true to bypass dependency check"
}
```

The server uses a `ServiceError` class that maps business logic errors to HTTP status codes:

| Status Code | Error Code | Meaning |
|-------------|-----------|---------|
| 400 | `VALIDATION` | Invalid input (missing fields, wrong types) |
| 404 | `NOT_FOUND` | Resource does not exist |
| 409 | `CONFLICT` | Duplicate or state conflict |
| 410 | `Gone` | Resource existed but is permanently unavailable |
| 422 | `Unprocessable Entity` | Valid JSON but business rule violation |
| 500 | `Internal Server Error` | Unexpected server error |
| 502 | `EXTERNAL_ERROR` | External tool/CLI failure (e.g., `gh` CLI) |

---

## Quick Reference Table

### Teams

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams/launch` | Launch a new team for an issue |
| POST | `/api/teams/launch-batch` | Launch multiple teams at once |
| POST | `/api/teams/stop-all` | Stop all active teams |
| POST | `/api/teams/:id/stop` | Stop a specific team |
| POST | `/api/teams/:id/force-launch` | Force-launch a queued team |
| POST | `/api/teams/:id/resume` | Resume a stopped team |
| POST | `/api/teams/:id/restart` | Restart a team (stop + relaunch) |
| GET | `/api/teams` | List all teams with dashboard data |
| GET | `/api/teams/:id` | Full team detail |
| GET | `/api/teams/:id/status` | Compact status (MCP-compatible) |
| GET | `/api/teams/:id/output` | Rolling stdout output buffer |
| GET | `/api/teams/:id/stream-events` | Parsed NDJSON stream events |
| GET | `/api/teams/:id/timeline` | Unified timeline (stream + hook events) |
| GET | `/api/teams/:id/export` | Export team logs as file |
| GET | `/api/teams/:id/events` | Hook events for this team |
| POST | `/api/teams/:id/send-message` | Send a PM message to a team |
| POST | `/api/teams/:id/set-phase` | Manually set team phase |
| GET | `/api/teams/:id/roster` | Team member roster from events |
| GET | `/api/teams/:id/transitions` | State transition history |
| POST | `/api/teams/:id/acknowledge` | Clear stuck/failed alert |
| GET | `/api/teams/:id/messages` | Agent messages for this team |
| GET | `/api/teams/:id/messages/summary` | Aggregated message counts |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects with team counts |
| POST | `/api/projects` | Create a new project |
| GET | `/api/projects/:id` | Project detail |
| PUT | `/api/projects/:id` | Update project settings |
| DELETE | `/api/projects/:id` | Remove a project |
| POST | `/api/projects/:id/install` | Install hooks, settings, prompt |
| GET | `/api/projects/:id/teams` | Teams belonging to this project |
| GET | `/api/projects/:id/cleanup-preview` | Preview cleanup (dry run) |
| POST | `/api/projects/:id/cleanup` | Execute cleanup |
| GET | `/api/projects/:id/prompt` | Read project prompt file |
| PUT | `/api/projects/:id/prompt` | Update project prompt file |

### Project Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/project-groups` | List all groups with project counts |
| POST | `/api/project-groups` | Create a new group |
| GET | `/api/project-groups/:id` | Group detail with projects |
| PUT | `/api/project-groups/:id` | Update group name/description |
| DELETE | `/api/project-groups/:id` | Delete group (unlinks projects) |

### Issues

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/issues` | Full issue hierarchy tree (all projects) |
| GET | `/api/issues/next` | Suggest next issue to work on |
| GET | `/api/issues/available` | Issues with no active team |
| GET | `/api/issues/:number` | Single issue detail |
| GET | `/api/issues/:number/dependencies` | Dependencies for a single issue |
| GET | `/api/projects/:projectId/issues` | Per-project issue tree |
| GET | `/api/projects/:projectId/issues/dependencies` | Dependencies for all project issues |
| POST | `/api/issues/refresh` | Force re-fetch from GitHub |

### Pull Requests

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/prs` | List all tracked PRs |
| GET | `/api/prs/:number` | Single PR detail with checks |
| POST | `/api/prs/refresh` | Trigger immediate GitHub poll |
| POST | `/api/prs/:number/enable-auto-merge` | Enable auto-merge via gh CLI |
| POST | `/api/prs/:number/disable-auto-merge` | Disable auto-merge via gh CLI |
| POST | `/api/prs/:number/update-branch` | Update PR branch from base |

### Events

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/events` | Receive a hook event from Claude Code |
| GET | `/api/events` | Query events with filters |

### Usage

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/usage` | Latest usage snapshot |
| GET | `/api/usage/history` | Recent usage snapshots |
| POST | `/api/usage` | Manually submit usage data |

### State Machine and Message Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state-machine` | State machine definition (transitions) |
| GET | `/api/message-templates` | All PM message templates |
| PUT | `/api/message-templates/:id` | Upsert a message template |

### Query

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/query/:queryName` | Execute a CC structured query |

### System and Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Server info (uptime, teams, SSE) |
| GET | `/api/settings` | Current runtime config |
| GET | `/api/diagnostics/stuck` | Teams that are idle or stuck |
| GET | `/api/diagnostics/blocked` | Teams blocked by CI failures |
| GET | `/api/diagnostics/health` | Fleet health summary |
| GET | `/api/debug/teams` | Raw database state for debugging |
| GET | `/api/system/browse-dirs` | List subdirectories for path picker |
| POST | `/api/system/factory-reset` | Wipe all data and re-seed defaults |

### SSE Stream

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stream` | Server-Sent Events stream |

---

## Teams

### POST /api/teams/launch

Launch a new team to work on a GitHub issue. Creates a git worktree, spawns a Claude Code process, and begins working on the specified issue.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | number | Yes | ID of the project (repository) |
| `issueNumber` | number | Yes | GitHub issue number to work on |
| `issueTitle` | string | No | Title of the issue (stored for display) |
| `prompt` | string | No | Custom prompt to override the default |
| `headless` | boolean | No | Run without terminal window (default: false) |
| `force` | boolean | No | Bypass dependency check (default: false) |

**Response:** `201 Created`

Returns a `Team` object.

```json
{
  "id": 1,
  "issueNumber": 42,
  "issueTitle": "Fix login page layout",
  "projectId": 1,
  "status": "queued",
  "phase": "init",
  "pid": null,
  "sessionId": null,
  "worktreeName": "my-project-42",
  "branchName": "feat/42-fix-login-page-layout",
  "prNumber": null,
  "customPrompt": null,
  "headless": false,
  "totalInputTokens": 0,
  "totalOutputTokens": 0,
  "totalCacheCreationTokens": 0,
  "totalCacheReadTokens": 0,
  "totalCostUsd": 0,
  "launchedAt": null,
  "stoppedAt": null,
  "lastEventAt": null,
  "createdAt": "2026-03-21T10:00:00.000Z",
  "updatedAt": "2026-03-21T10:00:00.000Z"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing required fields |
| 409 | Team already active for this issue, or blocked by dependencies |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/launch \
  -H "Content-Type: application/json" \
  -d '{"projectId": 1, "issueNumber": 42, "issueTitle": "Fix login page layout"}'
```

---

### POST /api/teams/launch-batch

Launch multiple teams for different issues in a single request. Teams are launched sequentially with an optional delay between each.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | number | Yes | ID of the project |
| `issues` | array | Yes | Array of `{ number: number, title?: string }` |
| `prompt` | string | No | Custom prompt for all teams |
| `delayMs` | number | No | Delay in ms between each launch |
| `headless` | boolean | No | Run all teams headless |

**Response:** `201 Created`

```json
{
  "launched": [
    { "issueNumber": 42, "teamId": 1, "status": "queued" }
  ],
  "failed": [
    { "issueNumber": 43, "error": "Team already active for this issue" }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing required fields |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/launch-batch \
  -H "Content-Type: application/json" \
  -d '{"projectId": 1, "issues": [{"number": 42}, {"number": 43, "title": "Add tests"}]}'
```

---

### POST /api/teams/stop-all

Stop all currently active teams. Sends termination signals to all running Claude Code processes.

**Request Body:** None

**Response:** `200 OK`

Returns an array of stopped `Team` objects.

```json
[
  { "id": 1, "status": "done", "worktreeName": "my-project-42" },
  { "id": 2, "status": "done", "worktreeName": "my-project-43" }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/stop-all
```

---

### POST /api/teams/:id/stop

Stop a specific team by ID.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:** None

**Response:** `200 OK`

Returns the stopped `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/stop
```

---

### POST /api/teams/:id/force-launch

Force-launch a queued team, bypassing slot limits and dependency checks.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:** None

**Response:** `200 OK`

Returns the updated `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 409 | Team is not in queued status |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/force-launch
```

---

### POST /api/teams/:id/resume

Resume a stopped (failed/stuck) team. Re-spawns the Claude Code process in the existing worktree.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:** None

**Response:** `200 OK`

Returns the resumed `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 409 | Cannot resume a completed (done) team |
| 410 | Worktree no longer exists |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/resume
```

---

### POST /api/teams/:id/restart

Restart a team by stopping it and relaunching with a fresh Claude Code session. Optionally provide a new prompt.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | No | New prompt for the restarted session |

**Response:** `200 OK`

Returns the restarted `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 409 | Cannot restart a completed (done) team |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/restart \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Focus on fixing the failing tests first"}'
```

---

### GET /api/teams

List all teams with dashboard data from the `v_team_dashboard` view. Returns aggregated rows with project info, PR status, and computed duration/idle metrics.

**Query Parameters:** None

**Response:** `200 OK`

Returns a `TeamDashboardRow[]` array.

```json
[
  {
    "id": 1,
    "issueNumber": 42,
    "issueTitle": "Fix login page layout",
    "projectId": 1,
    "projectName": "my-project",
    "model": "opus",
    "status": "running",
    "phase": "implementing",
    "worktreeName": "my-project-42",
    "branchName": "feat/42-fix-login-page-layout",
    "prNumber": 101,
    "launchedAt": "2026-03-21T10:00:00.000Z",
    "lastEventAt": "2026-03-21T10:30:00.000Z",
    "durationMin": 30,
    "idleMin": 0.5,
    "totalInputTokens": 50000,
    "totalOutputTokens": 12000,
    "totalCacheCreationTokens": 8000,
    "totalCacheReadTokens": 25000,
    "totalCostUsd": 0.45,
    "githubRepo": "owner/my-project",
    "prState": "open",
    "ciStatus": "passing",
    "mergeStatus": "clean"
  }
]
```

```bash
curl -s http://localhost:4680/api/teams
```

---

### GET /api/teams/:id

Full team detail including PR info, recent events, and output tail. Returns a `TeamDetail` object.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Response:** `200 OK`

```json
{
  "id": 1,
  "issueNumber": 42,
  "issueTitle": "Fix login page layout",
  "model": "opus",
  "githubRepo": "owner/my-project",
  "status": "running",
  "phase": "implementing",
  "pid": 12345,
  "sessionId": "abc-def-123",
  "worktreeName": "my-project-42",
  "branchName": "feat/42-fix-login-page-layout",
  "prNumber": 101,
  "launchedAt": "2026-03-21T10:00:00.000Z",
  "stoppedAt": null,
  "lastEventAt": "2026-03-21T10:30:00.000Z",
  "durationMin": 30,
  "idleMin": 0.5,
  "totalInputTokens": 50000,
  "totalOutputTokens": 12000,
  "totalCacheCreationTokens": 8000,
  "totalCacheReadTokens": 25000,
  "totalCostUsd": 0.45,
  "pr": {
    "number": 101,
    "state": "open",
    "mergeStatus": "clean",
    "ciStatus": "passing",
    "ciFailCount": 0,
    "checks": [
      { "name": "build", "status": "completed", "conclusion": "success" },
      { "name": "test", "status": "completed", "conclusion": "success" }
    ],
    "autoMerge": false
  },
  "recentEvents": [
    {
      "id": 500,
      "teamId": 1,
      "eventType": "post_tool_use",
      "sessionId": "abc-def-123",
      "toolName": "Edit",
      "agentName": "dev",
      "payload": null,
      "createdAt": "2026-03-21T10:28:00.000Z"
    }
  ],
  "outputTail": "[10:30:00] Completed editing src/components/Login.tsx"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1
```

---

### GET /api/teams/:id/status

Compact team status suitable for MCP tools and quick polling. Accepts both numeric IDs and worktree names.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Team ID (number) or worktree name (string) |

**Response:** `200 OK`

```json
{
  "id": 1,
  "issueNumber": 42,
  "worktreeName": "my-project-42",
  "status": "running",
  "phase": "implementing",
  "pid": 12345,
  "prNumber": 101,
  "lastEventAt": "2026-03-21T10:30:00.000Z",
  "pm_message": "Please focus on the failing test in auth.spec.ts",
  "pending_commands": [
    {
      "id": 10,
      "message": "Please focus on the failing test in auth.spec.ts",
      "createdAt": "2026-03-21T10:25:00.000Z"
    }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1/status
```

```bash
curl -s http://localhost:4680/api/teams/my-project-42/status
```

---

### GET /api/teams/:id/output

Retrieve the rolling stdout output buffer from the Claude Code process.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lines` | number | No | Number of lines to return (default: all) |

**Response:** `200 OK`

```json
{
  "teamId": 1,
  "lines": [
    "[10:28:00] Reading file src/components/Login.tsx",
    "[10:29:00] Editing file src/components/Login.tsx",
    "[10:30:00] Running npm test"
  ],
  "count": 3
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/teams/1/output?lines=50"
```

---

### GET /api/teams/:id/stream-events

Retrieve parsed NDJSON stream events from the Claude Code process stdout. These are the structured JSON objects from `--output-format stream-json`.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Response:** `200 OK`

Returns a `StreamEvent[]` array.

```json
[
  {
    "type": "assistant",
    "timestamp": "2026-03-21T10:28:00.000Z",
    "message": {
      "content": [{ "type": "text", "text": "I'll fix the login layout..." }]
    }
  },
  {
    "type": "tool_use",
    "timestamp": "2026-03-21T10:29:00.000Z",
    "name": "Edit",
    "input": { "file_path": "/src/components/Login.tsx" }
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1/stream-events
```

---

### GET /api/teams/:id/timeline

Unified timeline merging Claude Code stream events and hook events into a single chronological list.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum entries to return (default: 500) |

**Response:** `200 OK`

Returns a `TimelineEntry[]` array (discriminated union of `StreamTimelineEntry` and `HookTimelineEntry`).

```json
[
  {
    "id": "stream-0",
    "source": "stream",
    "timestamp": "2026-03-21T10:28:00.000Z",
    "teamId": 1,
    "streamType": "assistant",
    "message": {
      "content": [{ "type": "text", "text": "Starting implementation..." }]
    },
    "agentName": "dev"
  },
  {
    "id": "hook-500",
    "source": "hook",
    "timestamp": "2026-03-21T10:29:00.000Z",
    "teamId": 1,
    "eventType": "post_tool_use",
    "toolName": "Edit",
    "agentName": "dev"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/teams/1/timeline?limit=100"
```

---

### GET /api/teams/:id/export

Download team logs as a file. Supports JSON and plain text formats.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | string | No | `json` (default) or `txt` |

**Response:** `200 OK`

For `format=json`, returns `Content-Type: application/json`:

```json
{
  "team": { "id": 1, "worktreeName": "my-project-42", "status": "done" },
  "events": [],
  "streamEvents": [],
  "output": ["line1", "line2"]
}
```

For `format=txt`, returns `Content-Type: text/plain`:

```
# Team my-project-42 - Export
Issue: #42 Fix login page layout
Status: done
Launched: 2026-03-21T10:00:00.000Z

## Stream Events
[10:28:00] assistant Starting implementation...

## Raw Output
line1
line2
```

Both formats include a `Content-Disposition` header for file download.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/teams/1/export?format=json" -o export.json
```

---

### GET /api/teams/:id/events

Retrieve hook events for a specific team.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum events to return (default: 100) |

**Response:** `200 OK`

Returns an `Event[]` array.

```json
[
  {
    "id": 500,
    "teamId": 1,
    "eventType": "post_tool_use",
    "sessionId": "abc-def-123",
    "toolName": "Edit",
    "agentName": "dev",
    "payload": null,
    "createdAt": "2026-03-21T10:28:00.000Z"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/teams/1/events?limit=50"
```

---

### POST /api/teams/:id/send-message

Send a PM (project manager) message to a running team. The message is written to a `.fleet-pm-message` file in the worktree and delivered via stdin if the team is running. The message is always recorded in the database regardless of delivery status.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The message text to send |

**Response:** `201 Created` (if delivered)

```json
{
  "id": 10,
  "teamId": 1,
  "targetAgent": null,
  "message": "Please focus on the failing test in auth.spec.ts",
  "status": "delivered",
  "createdAt": "2026-03-21T10:25:00.000Z",
  "deliveredAt": "2026-03-21T10:25:00.100Z"
}
```

**Response:** `422 Unprocessable Entity` (if team not running)

```json
{
  "error": "Unprocessable Entity",
  "message": "Team is not running \u2014 message not delivered"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID or empty message |
| 404 | Team not found |
| 422 | Team is not running (message recorded but not delivered) |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Please focus on the failing test in auth.spec.ts"}'
```

---

### POST /api/teams/:id/set-phase

Manually set the domain phase for a team. Phases track what stage of work the team is in (analyzing, implementing, reviewing, etc.).

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | string | Yes | One of: `init`, `analyzing`, `implementing`, `reviewing`, `pr`, `done`, `blocked` |
| `reason` | string | No | Reason for the phase change |

**Response:** `200 OK`

Returns the updated `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID or invalid phase |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/set-phase \
  -H "Content-Type: application/json" \
  -d '{"phase": "reviewing", "reason": "PR created, waiting for review"}'
```

---

### GET /api/teams/:id/roster

Get the team member roster derived from hook events. Shows subagents that have been active in this team's session.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Response:** `200 OK`

Returns a `TeamMember[]` array.

```json
[
  {
    "name": "team-lead",
    "role": "lead",
    "isActive": true,
    "firstSeen": "2026-03-21T10:00:00.000Z",
    "lastSeen": "2026-03-21T10:30:00.000Z",
    "toolUseCount": 45,
    "errorCount": 1
  },
  {
    "name": "dev",
    "role": "developer",
    "isActive": true,
    "firstSeen": "2026-03-21T10:02:00.000Z",
    "lastSeen": "2026-03-21T10:29:00.000Z",
    "toolUseCount": 120,
    "errorCount": 3
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1/roster
```

---

### GET /api/teams/:id/transitions

Get the state transition history for a team. Shows every status change with timestamps and triggers.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Response:** `200 OK`

Returns a `TeamTransition[]` array.

```json
[
  {
    "id": 1,
    "teamId": 1,
    "fromStatus": "queued",
    "toStatus": "launching",
    "trigger": "system",
    "reason": "Slot available, spawn begins",
    "createdAt": "2026-03-21T10:00:00.000Z"
  },
  {
    "id": 2,
    "teamId": 1,
    "fromStatus": "launching",
    "toStatus": "running",
    "trigger": "hook",
    "reason": "First event received",
    "createdAt": "2026-03-21T10:00:30.000Z"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1/transitions
```

---

### POST /api/teams/:id/acknowledge

Clear a stuck or failed alert for a team. Resets the alert state so the team no longer appears in diagnostics.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Request Body:** None

**Response:** `200 OK`

Returns the updated `Team` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/teams/1/acknowledge
```

---

### GET /api/teams/:id/messages

Get agent-to-agent messages routed through this team. These are messages captured from `SendMessage` tool use events between subagents.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum messages to return (default: all) |

**Response:** `200 OK`

Returns an `AgentMessage[]` array.

```json
[
  {
    "id": 1,
    "teamId": 1,
    "eventId": 510,
    "sender": "planner",
    "recipient": "team-lead",
    "summary": "Implementation plan ready",
    "content": "Here is the plan for issue #42...",
    "sessionId": "abc-def-123",
    "createdAt": "2026-03-21T10:05:00.000Z"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/teams/1/messages?limit=20"
```

---

### GET /api/teams/:id/messages/summary

Get aggregated message counts for this team. Shows communication edges between agents (sender -> recipient) with counts.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Team ID |

**Response:** `200 OK`

Returns a `MessageEdge[]` array.

```json
[
  {
    "sender": "planner",
    "recipient": "team-lead",
    "count": 3,
    "lastSummary": "Implementation plan updated"
  },
  {
    "sender": "team-lead",
    "recipient": "dev",
    "count": 5,
    "lastSummary": "Please fix the test failure"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team ID |
| 404 | Team not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/teams/1/messages/summary
```

---

## Projects

### GET /api/projects

List all projects with team counts and install status.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `active` or `archived` |

**Response:** `200 OK`

Returns a `ProjectSummary[]` array.

```json
[
  {
    "id": 1,
    "name": "my-project",
    "repoPath": "C:/Git/my-project",
    "githubRepo": "owner/my-project",
    "groupId": null,
    "status": "active",
    "hooksInstalled": true,
    "maxActiveTeams": 5,
    "promptFile": "prompts/default-prompt.md",
    "model": null,
    "createdAt": "2026-03-20T08:00:00.000Z",
    "updatedAt": "2026-03-21T10:00:00.000Z",
    "teamCount": 3,
    "activeTeamCount": 2,
    "queuedTeamCount": 1,
    "installStatus": {
      "hooks": { "installed": true, "total": 10, "found": 10, "files": [] },
      "prompt": { "installed": true, "files": [] },
      "agents": { "installed": true, "files": [] },
      "settings": { "name": "settings.json", "exists": true }
    }
  }
]
```

```bash
curl -s "http://localhost:4680/api/projects?status=active"
```

---

### POST /api/projects

Create a new project (register a git repository).

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name for the project |
| `repoPath` | string | Yes | Absolute path to the git repository |
| `githubRepo` | string | No | GitHub slug (e.g., `owner/repo`) |
| `maxActiveTeams` | number | No | Max concurrent teams (default: 5) |
| `model` | string | No | Default Claude model to use |

**Response:** `201 Created`

Returns the created `Project` object.

```json
{
  "id": 1,
  "name": "my-project",
  "repoPath": "C:/Git/my-project",
  "githubRepo": "owner/my-project",
  "groupId": null,
  "status": "active",
  "hooksInstalled": false,
  "maxActiveTeams": 5,
  "promptFile": null,
  "model": null,
  "createdAt": "2026-03-21T10:00:00.000Z",
  "updatedAt": "2026-03-21T10:00:00.000Z"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing or invalid fields |
| 409 | A project with this repo path already exists |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project", "repoPath": "C:/Git/my-project", "githubRepo": "owner/my-project"}'
```

---

### GET /api/projects/:id

Get project detail with team counts and install status.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Response:** `200 OK`

Returns a `ProjectSummary` object (same shape as list items).

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/projects/1
```

---

### PUT /api/projects/:id

Update project settings. All fields are optional; only provided fields are updated.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | New display name |
| `status` | string | No | `active` or `archived` |
| `githubRepo` | string or null | No | GitHub slug |
| `groupId` | number or null | No | Project group ID |
| `hooksInstalled` | boolean | No | Whether hooks are installed |
| `maxActiveTeams` | number | No | Max concurrent teams (1-50) |
| `promptFile` | string or null | No | Path to prompt file |
| `model` | string or null | No | Default Claude model |

**Response:** `200 OK`

Returns the updated `Project` object. Also broadcasts a `project_updated` SSE event.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID, invalid status, or invalid maxActiveTeams |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s -X PUT http://localhost:4680/api/projects/1 \
  -H "Content-Type: application/json" \
  -d '{"maxActiveTeams": 10, "model": "opus"}'
```

---

### DELETE /api/projects/:id

Remove a project. Uninstalls hooks and cleans up associated data.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Response:** `200 OK`

```json
{
  "success": true
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |
| 409 | Project has active teams |
| 500 | Internal server error |

```bash
curl -s -X DELETE http://localhost:4680/api/projects/1
```

---

### POST /api/projects/:id/install

Install (or re-install) hooks, settings, and prompt files for a project. Deploys Fleet Commander hook scripts to the project's `.claude/hooks/` directory.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Request Body:** None

**Response:** `200 OK`

Returns an install result object with details about what was installed.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/projects/1/install
```

---

### GET /api/projects/:id/teams

List all teams belonging to a specific project.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Response:** `200 OK`

Returns a `Team[]` array.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/projects/1/teams
```

---

### GET /api/projects/:id/cleanup-preview

Preview what would be cleaned up for a project (dry run). Returns worktrees, signal files, stale branches, and optionally team records that can be removed.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resetTeams` | string | No | `"true"` to include team record reset in preview |

**Response:** `200 OK`

Returns a `CleanupPreview` object.

```json
{
  "projectId": 1,
  "projectName": "my-project",
  "items": [
    {
      "type": "worktree",
      "name": "my-project-42",
      "path": "C:/Git/my-project/.claude/worktrees/my-project-42",
      "reason": "Team is in done status"
    },
    {
      "type": "stale_branch",
      "name": "feat/42-fix-login",
      "path": "feat/42-fix-login",
      "reason": "No active team using this branch"
    }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/projects/1/cleanup-preview?resetTeams=true"
```

---

### POST /api/projects/:id/cleanup

Execute cleanup for confirmed items. Only removes items whose paths are provided in the request body. Broadcasts a `project_cleanup` SSE event.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | string[] | Yes | Array of item paths to remove (from cleanup-preview) |
| `resetTeams` | boolean | No | Whether to reset associated team records |

**Response:** `200 OK`

Returns a `CleanupResult` object.

```json
{
  "removed": [
    "C:/Git/my-project/.claude/worktrees/my-project-42",
    "feat/42-fix-login"
  ],
  "failed": [
    { "name": "my-project-43", "error": "Permission denied" }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID or no items provided |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/projects/1/cleanup \
  -H "Content-Type: application/json" \
  -d '{"items": ["C:/Git/my-project/.claude/worktrees/my-project-42"], "resetTeams": true}'
```

---

### GET /api/projects/:id/prompt

Read the contents of the project's prompt file.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Response:** `200 OK`

```json
{
  "promptFile": "prompts/default-prompt.md",
  "content": "You are working on issue #{{ISSUE_NUMBER}}..."
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found or prompt file not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/projects/1/prompt
```

---

### PUT /api/projects/:id/prompt

Update the contents of the project's prompt file.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Project ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | New prompt file contents |

**Response:** `200 OK`

```json
{
  "promptFile": "prompts/default-prompt.md",
  "content": "Updated prompt content..."
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID or missing content |
| 404 | Project not found |
| 500 | Internal server error |

```bash
curl -s -X PUT http://localhost:4680/api/projects/1/prompt \
  -H "Content-Type: application/json" \
  -d '{"content": "You are working on issue #{{ISSUE_NUMBER}}.\n\nPlease implement the feature as described."}'
```

---

## Project Groups

### GET /api/project-groups

List all project groups with project counts.

**Response:** `200 OK`

```json
[
  {
    "id": 1,
    "name": "Frontend",
    "description": "Frontend applications",
    "createdAt": "2026-03-20T08:00:00.000Z",
    "updatedAt": "2026-03-20T08:00:00.000Z",
    "projectCount": 3
  }
]
```

```bash
curl -s http://localhost:4680/api/project-groups
```

---

### POST /api/project-groups

Create a new project group.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Group name (must be unique) |
| `description` | string | No | Group description |

**Response:** `201 Created`

Returns the created `ProjectGroup` object.

```json
{
  "id": 1,
  "name": "Frontend",
  "description": "Frontend applications",
  "createdAt": "2026-03-21T10:00:00.000Z",
  "updatedAt": "2026-03-21T10:00:00.000Z"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing or empty name |
| 409 | A group with this name already exists |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/project-groups \
  -H "Content-Type: application/json" \
  -d '{"name": "Frontend", "description": "Frontend applications"}'
```

---

### GET /api/project-groups/:id

Get a project group with its projects.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Group ID |

**Response:** `200 OK`

```json
{
  "id": 1,
  "name": "Frontend",
  "description": "Frontend applications",
  "createdAt": "2026-03-20T08:00:00.000Z",
  "updatedAt": "2026-03-20T08:00:00.000Z",
  "projects": [
    { "id": 1, "name": "my-project", "status": "active" }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid group ID |
| 404 | Group not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/project-groups/1
```

---

### PUT /api/project-groups/:id

Update a project group's name or description.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Group ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | New group name |
| `description` | string or null | No | New description |

**Response:** `200 OK`

Returns the updated `ProjectGroup` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid group ID or empty name |
| 404 | Group not found |
| 409 | A group with this name already exists |
| 500 | Internal server error |

```bash
curl -s -X PUT http://localhost:4680/api/project-groups/1 \
  -H "Content-Type: application/json" \
  -d '{"description": "All frontend web applications"}'
```

---

### DELETE /api/project-groups/:id

Delete a project group. Projects assigned to this group will have their `groupId` set to null.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | Yes | Group ID |

**Response:** `200 OK`

```json
{
  "success": true
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid group ID |
| 404 | Group not found |
| 500 | Internal server error |

```bash
curl -s -X DELETE http://localhost:4680/api/project-groups/1
```

---

## Issues

### GET /api/issues

Get the full issue hierarchy tree for all projects. Returns a merged tree for backward compatibility and grouped trees per project. Issues are enriched with active team info from the database.

**Response:** `200 OK`

```json
{
  "tree": [
    {
      "number": 42,
      "title": "Fix login page layout",
      "state": "open",
      "labels": ["bug"],
      "children": [],
      "teamId": 1,
      "teamStatus": "running"
    }
  ],
  "groups": [
    {
      "projectId": 1,
      "projectName": "my-project",
      "tree": [],
      "cachedAt": "2026-03-21T10:00:00.000Z",
      "count": 15
    }
  ],
  "cachedAt": "2026-03-21T10:00:00.000Z",
  "count": 15
}
```

```bash
curl -s http://localhost:4680/api/issues
```

---

### GET /api/issues/next

Suggest the next issue to work on. Returns the highest-priority Ready issue that has no active team assigned.

**Response:** `200 OK`

```json
{
  "issue": {
    "number": 43,
    "title": "Add user profile page",
    "state": "open",
    "labels": ["feature", "Ready"],
    "children": []
  },
  "reason": "Highest priority Ready issue with no active team"
}
```

If no issues are available:

```json
{
  "issue": null,
  "reason": "No available Ready issues found without an active team"
}
```

```bash
curl -s http://localhost:4680/api/issues/next
```

---

### GET /api/issues/available

Get all open leaf issues that have no team currently working on them.

**Response:** `200 OK`

```json
{
  "issues": [
    {
      "number": 43,
      "title": "Add user profile page",
      "state": "open",
      "labels": ["feature"],
      "children": []
    }
  ],
  "count": 5
}
```

```bash
curl -s http://localhost:4680/api/issues/available
```

---

### GET /api/issues/:number

Get a single issue from the cache, enriched with team info.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | GitHub issue number |

**Response:** `200 OK`

Returns the issue object with team enrichment.

```json
{
  "number": 42,
  "title": "Fix login page layout",
  "state": "open",
  "labels": ["bug"],
  "children": [],
  "teamId": 1,
  "teamStatus": "running"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid issue number |
| 404 | Issue not found in cache |

```bash
curl -s http://localhost:4680/api/issues/42
```

---

### GET /api/issues/:number/dependencies

Get dependency info for a single issue. Requires a `projectId` query parameter to resolve the GitHub repository.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | GitHub issue number |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | Yes | Project ID for GitHub repo resolution |

**Response:** `200 OK`

Returns an `IssueDependencyInfo` object.

```json
{
  "issueNumber": 42,
  "blockedBy": [
    {
      "number": 10,
      "owner": "owner",
      "repo": "my-project",
      "state": "open",
      "title": "Refactor auth module"
    }
  ],
  "resolved": false,
  "openCount": 1
}
```

If no dependencies are found:

```json
{
  "issueNumber": 42,
  "blockedBy": [],
  "resolved": true,
  "openCount": 0
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid issue number or missing/invalid projectId |
| 404 | Project not found |

```bash
curl -s "http://localhost:4680/api/issues/42/dependencies?projectId=1"
```

---

### GET /api/projects/:projectId/issues

Get the issue hierarchy tree for a specific project.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | Yes | Project ID |

**Response:** `200 OK`

```json
{
  "projectId": 1,
  "projectName": "my-project",
  "tree": [
    {
      "number": 42,
      "title": "Fix login page layout",
      "state": "open",
      "labels": ["bug"],
      "children": []
    }
  ],
  "cachedAt": "2026-03-21T10:00:00.000Z",
  "count": 15
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID |
| 404 | Project not found |

```bash
curl -s http://localhost:4680/api/projects/1/issues
```

---

### GET /api/projects/:projectId/issues/dependencies

Get dependency info for all issues in a project.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | Yes | Project ID |

**Response:** `200 OK`

```json
{
  "projectId": 1,
  "dependencies": {
    "42": {
      "issueNumber": 42,
      "blockedBy": [
        { "number": 10, "owner": "owner", "repo": "my-project", "state": "closed", "title": "Refactor auth" }
      ],
      "resolved": true,
      "openCount": 0
    },
    "43": {
      "issueNumber": 43,
      "blockedBy": [],
      "resolved": true,
      "openCount": 0
    }
  }
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid project ID or no GitHub repo configured |
| 404 | Project not found |

```bash
curl -s http://localhost:4680/api/projects/1/issues/dependencies
```

---

### POST /api/issues/refresh

Force re-fetch the issue hierarchy from GitHub for all projects. Clears the cache and fetches fresh data.

**Request Body:** None

**Response:** `200 OK`

```json
{
  "refreshedAt": "2026-03-21T10:05:00.000Z",
  "issueCount": 25,
  "tree": []
}
```

```bash
curl -s -X POST http://localhost:4680/api/issues/refresh
```

---

## Pull Requests

### GET /api/prs

List all tracked pull requests.

**Response:** `200 OK`

Returns a `PullRequest[]` array.

```json
[
  {
    "prNumber": 101,
    "teamId": 1,
    "title": "Fix login page layout",
    "state": "open",
    "mergeStatus": "clean",
    "ciStatus": "passing",
    "ciFailCount": 0,
    "checksJson": "[{\"name\":\"build\",\"status\":\"completed\",\"conclusion\":\"success\"}]",
    "autoMerge": false,
    "mergedAt": null,
    "updatedAt": "2026-03-21T10:30:00.000Z"
  }
]
```

```bash
curl -s http://localhost:4680/api/prs
```

---

### GET /api/prs/:number

Get a single PR with parsed CI checks.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |

**Response:** `200 OK`

Returns the `PullRequest` object with an additional `checks` array (parsed from `checksJson`).

```json
{
  "prNumber": 101,
  "teamId": 1,
  "title": "Fix login page layout",
  "state": "open",
  "mergeStatus": "clean",
  "ciStatus": "passing",
  "ciFailCount": 0,
  "checksJson": "[{\"name\":\"build\",\"status\":\"completed\",\"conclusion\":\"success\"}]",
  "autoMerge": false,
  "mergedAt": null,
  "updatedAt": "2026-03-21T10:30:00.000Z",
  "checks": [
    { "name": "build", "status": "completed", "conclusion": "success" }
  ]
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid PR number |
| 404 | PR not found |
| 500 | Internal server error |

```bash
curl -s http://localhost:4680/api/prs/101
```

---

### POST /api/prs/refresh

Trigger an immediate GitHub poller poll. The poll runs asynchronously; this endpoint returns immediately.

**Request Body:** None

**Response:** `200 OK`

```json
{
  "ok": true,
  "message": "GitHub poller poll triggered"
}
```

```bash
curl -s -X POST http://localhost:4680/api/prs/refresh
```

---

### POST /api/prs/:number/enable-auto-merge

Enable auto-merge for a PR using the `gh` CLI. When CI passes, the PR will be automatically merged.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |

**Request Body:** None

**Response:** `200 OK`

Returns a result object confirming auto-merge was enabled.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid PR number |
| 404 | PR not found |
| 502 | GitHub CLI error |

```bash
curl -s -X POST http://localhost:4680/api/prs/101/enable-auto-merge
```

---

### POST /api/prs/:number/disable-auto-merge

Disable auto-merge for a PR using the `gh` CLI.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |

**Request Body:** None

**Response:** `200 OK`

Returns a result object confirming auto-merge was disabled.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid PR number |
| 404 | PR not found |
| 502 | GitHub CLI error |

```bash
curl -s -X POST http://localhost:4680/api/prs/101/disable-auto-merge
```

---

### POST /api/prs/:number/update-branch

Update a PR branch by merging the base branch (e.g., `main`) into it using the GitHub API.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | PR number |

**Request Body:** None

**Response:** `200 OK`

Returns a result object confirming the branch was updated.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid PR number |
| 404 | PR not found |
| 502 | GitHub CLI error |

```bash
curl -s -X POST http://localhost:4680/api/prs/101/update-branch
```

---

## Events

### POST /api/events

Receive a hook event from a Claude Code instance. Supports two payload formats: the new `cc_stdin` format (where the shell sends the raw CC stdin JSON) and the legacy format (where the shell extracts fields individually).

**Request Body (new format with `cc_stdin`):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | Yes | Hook event type (e.g., `session_start`, `post_tool_use`, `stop`) |
| `team` | string | Yes | Worktree name identifying the team |
| `timestamp` | string | No | ISO timestamp |
| `cc_stdin` | string | Yes | Raw JSON string from Claude Code stdin |

```json
{
  "event": "post_tool_use",
  "team": "my-project-42",
  "timestamp": "2026-03-21T10:28:00.000Z",
  "cc_stdin": "{\"session_id\":\"abc-def-123\",\"tool_name\":\"Edit\",\"agent_type\":\"subagent\",\"teammate_name\":\"dev\"}"
}
```

**Request Body (legacy format):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | Yes | Hook event type |
| `team` | string | Yes | Worktree name |
| `timestamp` | string | No | ISO timestamp |
| `session_id` | string | No | Claude Code session ID |
| `tool_name` | string | No | Tool that was used |
| `agent_type` | string | No | Agent type (e.g., `subagent`) |
| `teammate_name` | string | No | Subagent name |
| `message` | string | No | Notification message |
| `error` | string | No | Error message |
| `tool_use_id` | string | No | Tool use ID |
| `tool_input` | string | No | Tool input (stringified JSON) |
| `error_details` | string | No | Detailed error info |
| `last_assistant_message` | string | No | Last message from the assistant |
| `worktree_root` | string | No | Worktree root path |
| `msg_to` | string | No | SendMessage recipient |
| `msg_summary` | string | No | SendMessage summary |

**Response:** `200 OK`

Returns the processed event result.

```json
{
  "ok": true,
  "eventId": 500,
  "teamId": 1
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing required fields (event, team) |
| 404 | Team not found for the given worktree name |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/events \
  -H "Content-Type: application/json" \
  -d '{"event": "post_tool_use", "team": "my-project-42", "session_id": "abc-123", "tool_name": "Edit"}'
```

---

### GET /api/events

Query events with optional filters.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `team_id` | number | No | Filter by team ID |
| `type` | string | No | Filter by event type |
| `since` | string | No | ISO timestamp; return events after this time |
| `limit` | number | No | Maximum events to return (default: 100) |

**Response:** `200 OK`

Returns an `Event[]` array.

```json
[
  {
    "id": 500,
    "teamId": 1,
    "eventType": "post_tool_use",
    "sessionId": "abc-def-123",
    "toolName": "Edit",
    "agentName": "dev",
    "payload": null,
    "createdAt": "2026-03-21T10:28:00.000Z"
  }
]
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid team_id or limit |
| 500 | Internal server error |

```bash
curl -s "http://localhost:4680/api/events?team_id=1&type=post_tool_use&limit=50"
```

---

## Usage

### GET /api/usage

Get the latest usage snapshot with zone info and red thresholds.

**Response:** `200 OK`

```json
{
  "id": 100,
  "teamId": null,
  "projectId": null,
  "sessionId": null,
  "dailyPercent": 45.2,
  "weeklyPercent": 23.1,
  "sonnetPercent": 12.5,
  "extraPercent": 0,
  "dailyResetsAt": "2026-03-22T00:00:00.000Z",
  "weeklyResetsAt": "2026-03-24T00:00:00.000Z",
  "rawOutput": null,
  "recordedAt": "2026-03-21T10:30:00.000Z",
  "zone": "green",
  "redThresholds": {
    "daily": 80,
    "weekly": 80,
    "sonnet": 80,
    "extra": 80
  }
}
```

If no usage data exists, returns zeros with a `recordedAt` of `null`.

```bash
curl -s http://localhost:4680/api/usage
```

---

### GET /api/usage/history

Get recent usage snapshots.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Number of snapshots (default: 50, max: 1000) |

**Response:** `200 OK`

```json
{
  "count": 50,
  "snapshots": [
    {
      "id": 100,
      "dailyPercent": 45.2,
      "weeklyPercent": 23.1,
      "sonnetPercent": 12.5,
      "extraPercent": 0,
      "recordedAt": "2026-03-21T10:30:00.000Z"
    }
  ]
}
```

```bash
curl -s "http://localhost:4680/api/usage/history?limit=100"
```

---

### POST /api/usage

Manually submit usage data (primarily for testing). Processes the snapshot and stores it in the database.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamId` | number | No | Associated team ID |
| `projectId` | number | No | Associated project ID |
| `sessionId` | string | No | Associated session ID |
| `dailyPercent` | number | No | Daily usage percentage |
| `weeklyPercent` | number | No | Weekly usage percentage |
| `sonnetPercent` | number | No | Sonnet usage percentage |
| `extraPercent` | number | No | Extra usage percentage |
| `rawOutput` | string | No | Raw output text from CC |

**Response:** `201 Created`

Returns the stored `UsageSnapshot` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Request body is required |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/usage \
  -H "Content-Type: application/json" \
  -d '{"dailyPercent": 50, "weeklyPercent": 25}'
```

---

## State Machine and Message Templates

### GET /api/state-machine

Get the team lifecycle state machine definition including all states and transitions.

**Response:** `200 OK`

```json
{
  "states": [
    { "id": "queued", "label": "Queued", "color": "#8B949E" },
    { "id": "launching", "label": "Launching", "color": "#58A6FF" },
    { "id": "running", "label": "Running", "color": "#3FB950" },
    { "id": "idle", "label": "Idle", "color": "#D29922" },
    { "id": "stuck", "label": "Stuck", "color": "#F85149" },
    { "id": "done", "label": "Done", "color": "#A371F7" },
    { "id": "failed", "label": "Failed", "color": "#F85149" }
  ],
  "transitions": [
    {
      "id": "queued-blocked",
      "from": "queued",
      "to": "queued",
      "trigger": "system",
      "triggerLabel": "Queue processor skips blocked team",
      "description": "Queue processor checks dependencies...",
      "condition": "Issue has unresolved dependencies",
      "hookEvent": null
    }
  ]
}
```

```bash
curl -s http://localhost:4680/api/state-machine
```

---

### GET /api/message-templates

Get all PM message templates with defaults and user-edited overrides. Templates define messages sent to teams during state transitions.

**Response:** `200 OK`

Returns a `MessageTemplate[]` array enriched with default info.

```json
[
  {
    "id": "idle-nudge",
    "template": "You have been idle for {{IDLE_MINUTES}} minutes. Please continue working on issue #{{ISSUE_NUMBER}}.",
    "enabled": true,
    "updatedAt": "2026-03-20T08:00:00.000Z"
  }
]
```

```bash
curl -s http://localhost:4680/api/message-templates
```

---

### PUT /api/message-templates/:id

Create or update a message template. Templates use `{{PLACEHOLDER}}` syntax for variable substitution.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Template ID (e.g., `idle-nudge`) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `template` | string | No | Template text with `{{PLACEHOLDER}}` variables |
| `enabled` | boolean | No | Whether the template is active |

**Response:** `200 OK`

Returns the upserted `MessageTemplate` object.

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Invalid template ID |
| 500 | Internal server error |

```bash
curl -s -X PUT http://localhost:4680/api/message-templates/idle-nudge \
  -H "Content-Type: application/json" \
  -d '{"template": "Hey team, you have been idle for {{IDLE_MINUTES}} min. Keep going!", "enabled": true}'
```

---

## Query

### POST /api/query/:queryName

Execute a structured query using Claude Code. This is a polymorphic endpoint that dispatches to different query handlers based on the `queryName` parameter.

**URL Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `queryName` | string | Yes | One of: `prioritizeIssues`, `estimateComplexity`, `suggestAssignmentOrder` |

**Valid query names and their request bodies:**

#### `prioritizeIssues`

Ask Claude Code to prioritize a list of issues.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issues` | array | Yes | Array of `{ number: number, title: string }` |

**Response:** `200 OK`

Returns a `CCQueryResult<PrioritizedIssue[]>`.

```json
{
  "success": true,
  "data": [
    {
      "number": 42,
      "title": "Fix login page layout",
      "priority": 2,
      "category": "bug",
      "reason": "User-facing bug affecting login flow"
    }
  ],
  "costUsd": 0.02,
  "durationMs": 5000
}
```

```bash
curl -s -X POST http://localhost:4680/api/query/prioritizeIssues \
  -H "Content-Type: application/json" \
  -d '{"issues": [{"number": 42, "title": "Fix login page layout"}, {"number": 43, "title": "Add tests"}]}'
```

#### `estimateComplexity`

Estimate the complexity of a single issue.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueTitle` | string | Yes | Issue title |
| `issueBody` | string | Yes | Issue body/description |

**Response:** `200 OK`

Returns a `CCQueryResult<ComplexityEstimate>`.

```json
{
  "success": true,
  "data": {
    "complexity": "medium",
    "estimatedHours": 4,
    "reason": "Requires changes to 3 components and test updates",
    "risks": ["May break existing layout", "Needs cross-browser testing"]
  },
  "costUsd": 0.01,
  "durationMs": 3000
}
```

```bash
curl -s -X POST http://localhost:4680/api/query/estimateComplexity \
  -H "Content-Type: application/json" \
  -d '{"issueTitle": "Fix login page layout", "issueBody": "The login form is not centered on mobile devices..."}'
```

#### `suggestAssignmentOrder`

Suggest the optimal order for assigning issues to teams.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issues` | array | Yes | Array of `{ number: number, title: string, labels: string[] }` |
| `constraints` | object | Yes | `{ maxConcurrent: number, preferredOrder?: "priority" \| "complexity" \| "fifo" }` |

**Response:** `200 OK`

Returns a `CCQueryResult<AssignmentPlan>`.

```json
{
  "success": true,
  "data": {
    "order": [
      { "number": 42, "reason": "Critical bug, should be fixed first" },
      { "number": 43, "reason": "Feature with no dependencies" }
    ],
    "estimatedTotalHours": 8
  },
  "costUsd": 0.03,
  "durationMs": 7000
}
```

```bash
curl -s -X POST http://localhost:4680/api/query/suggestAssignmentOrder \
  -H "Content-Type: application/json" \
  -d '{"issues": [{"number": 42, "title": "Fix login", "labels": ["bug"]}, {"number": 43, "title": "Add tests", "labels": ["test"]}], "constraints": {"maxConcurrent": 3}}'
```

**Error Responses (all query variants):**

| Code | Description |
|------|-------------|
| 400 | Invalid queryName, missing body, or missing required fields |
| 500 | CC query execution failed |

---

## System and Diagnostics

### GET /api/health

Simple health check endpoint.

**Response:** `200 OK`

```json
{
  "status": "ok"
}
```

```bash
curl -s http://localhost:4680/api/health
```

---

### GET /api/status

Server status including uptime, active team count, SSE connection count, and database size.

**Response:** `200 OK`

```json
{
  "status": "ok",
  "uptime": {
    "seconds": 3600,
    "formatted": "1h 0m 0s"
  },
  "activeTeams": 3,
  "sseConnections": 2,
  "dbSizeBytes": 524288,
  "serverStartedAt": "2026-03-21T09:00:00.000Z",
  "version": "1.0.0"
}
```

```bash
curl -s http://localhost:4680/api/status
```

---

### GET /api/settings

Get current runtime configuration (read-only). Returns non-sensitive configuration values.

**Response:** `200 OK`

```json
{
  "host": "0.0.0.0",
  "port": 4680,
  "idleThresholdMin": 3,
  "stuckThresholdMin": 5,
  "launchTimeoutMin": 5,
  "maxUniqueCiFailures": 3,
  "earlyCrashThresholdSec": 120,
  "earlyCrashMinTools": 5,
  "githubPollIntervalMs": 30000,
  "issuePollIntervalMs": 60000,
  "stuckCheckIntervalMs": 60000,
  "usagePollIntervalMs": 300000,
  "sseHeartbeatMs": 30000,
  "outputBufferLines": 1000,
  "claudeCmd": "claude",
  "resolvedClaudeCmd": "C:/Users/user/AppData/Roaming/npm/claude.cmd",
  "enableAgentTeams": true,
  "fleetCommanderRoot": "C:/Git/fleet-commander",
  "dbPath": "./fleet.db"
}
```

```bash
curl -s http://localhost:4680/api/settings
```

---

### GET /api/diagnostics/stuck

Get teams that are idle or stuck based on configured thresholds.

**Response:** `200 OK`

```json
{
  "idleThresholdMin": 3,
  "stuckThresholdMin": 5,
  "count": 2,
  "teams": [
    {
      "id": 1,
      "worktreeName": "my-project-42",
      "status": "idle",
      "lastEventAt": "2026-03-21T10:20:00.000Z"
    }
  ]
}
```

```bash
curl -s http://localhost:4680/api/diagnostics/stuck
```

---

### GET /api/diagnostics/blocked

Get teams blocked by CI failures (exceeding the configured max unique CI failure count).

**Response:** `200 OK`

Returns a diagnostics result with blocked team details.

```bash
curl -s http://localhost:4680/api/diagnostics/blocked
```

---

### GET /api/diagnostics/health

Get a fleet health summary with team counts grouped by status.

**Response:** `200 OK`

Returns aggregated counts and health metrics.

```bash
curl -s http://localhost:4680/api/diagnostics/health
```

---

### GET /api/debug/teams

Raw database state for debugging. Returns teams from multiple query perspectives.

**Response:** `200 OK`

```json
{
  "rawTeams": [],
  "dashboardTeams": [],
  "activeTeams": [],
  "teamCount": 10,
  "dashboardCount": 10,
  "activeCount": 3
}
```

```bash
curl -s http://localhost:4680/api/debug/teams
```

---

### GET /api/system/browse-dirs

List subdirectories for the UI path picker. Used when adding a new project to browse the filesystem.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory path to list (default: `C:/Git` on Windows, `$HOME/projects` on Linux) |

**Response:** `200 OK`

```json
{
  "parentPath": "C:/Git",
  "dirs": [
    { "name": "my-project", "path": "C:/Git/my-project", "isGitRepo": true },
    { "name": "another-repo", "path": "C:/Git/another-repo", "isGitRepo": true },
    { "name": "docs", "path": "C:/Git/docs", "isGitRepo": false }
  ]
}
```

Git repositories are sorted first, then alphabetically.

```bash
curl -s "http://localhost:4680/api/system/browse-dirs?path=C:/Git"
```

---

### POST /api/system/factory-reset

Wipe all data and re-seed defaults. Requires a confirmation string in the body to prevent accidental invocation.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confirm` | string | Yes | Must be `"FACTORY_RESET"` to proceed |

**Response:** `200 OK`

```json
{
  "success": true,
  "message": "All data cleared and defaults re-seeded"
}
```

**Error Responses:**

| Code | Description |
|------|-------------|
| 400 | Missing or incorrect confirmation string |
| 500 | Internal server error |

```bash
curl -s -X POST http://localhost:4680/api/system/factory-reset \
  -H "Content-Type: application/json" \
  -d '{"confirm": "FACTORY_RESET"}'
```

---

## SSE Stream

### GET /api/stream

Server-Sent Events (SSE) endpoint for real-time updates. The connection is long-lived and the server pushes events as they occur.

### Connection Setup

Connect using the standard `EventSource` API or any HTTP client that supports SSE.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `teams` | string | No | Comma-separated team IDs to filter events (e.g., `1,2,3`). Omit to receive all events. |

**Response Headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Connection Example:**

```javascript
const source = new EventSource('http://localhost:4680/api/stream');

source.addEventListener('team_status_changed', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Team ${data.team_id} status: ${data.status}`);
});

source.addEventListener('heartbeat', () => {
  console.log('Connection alive');
});

source.onerror = () => {
  console.log('SSE connection error, will auto-reconnect');
};
```

**Filtered Connection (specific teams):**

```javascript
const source = new EventSource('http://localhost:4680/api/stream?teams=1,2');
```

```bash
curl -s -N http://localhost:4680/api/stream
```

### Initial Snapshot

When a client connects, the server immediately sends:

1. A comment `:ok` to confirm the connection is live
2. A `snapshot` event containing the current dashboard state (all teams)

This allows the client to render the current state before incremental updates arrive.

### Heartbeat

A `heartbeat` event is sent every 30 seconds (configurable via `FLEET_SSE_HEARTBEAT_MS`) to keep the connection alive and detect stale connections.

### Event Types

The SSE broker emits 16 event types. Each event is sent as an SSE frame:

```
event: <event_type>
data: {"type": "<event_type>", ...payload}
```

The `type` field in the data payload always matches the SSE event name.

---

#### `team_status_changed`

Fired when a team's operational status changes (e.g., running -> idle).

**Trigger:** State machine transition

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |
| `status` | string | New status |
| `previous_status` | string | Previous status |
| `phase` | string | Current phase (optional) |
| `previous_phase` | string | Previous phase (optional) |
| `reason` | string | Reason for transition (optional) |
| `idle_minutes` | number | Minutes idle (optional) |
| `tokens` | object | Token usage (optional): `{ input, output, cacheCreation, cacheRead, costUsd }` |

```json
{
  "type": "team_status_changed",
  "team_id": 1,
  "status": "idle",
  "previous_status": "running",
  "idle_minutes": 3.5
}
```

---

#### `team_event`

Fired when a hook event is received and stored for a team.

**Trigger:** POST /api/events

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |
| `event_type` | string | Hook event type (e.g., `post_tool_use`) |
| `event_id` | number | Database event ID |
| `session_id` | string or null | Session ID (optional) |
| `agent_name` | string or null | Agent name (optional) |
| `tool_name` | string or null | Tool name (optional) |
| `timestamp` | string | Event timestamp (optional) |

```json
{
  "type": "team_event",
  "team_id": 1,
  "event_type": "post_tool_use",
  "event_id": 500,
  "tool_name": "Edit",
  "agent_name": "dev"
}
```

---

#### `team_output`

Fired when new stdout output is received from a Claude Code process.

**Trigger:** Claude Code stdout stream

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |
| `event` | StreamEvent | The parsed JSON event from CC stdout |

```json
{
  "type": "team_output",
  "team_id": 1,
  "event": {
    "type": "assistant",
    "message": { "content": [{ "type": "text", "text": "Implementing..." }] }
  }
}
```

---

#### `pr_updated`

Fired when a pull request status changes (state, CI, merge status, auto-merge).

**Trigger:** GitHub poller or PR action endpoints

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `pr_number` | number | PR number |
| `team_id` | number | Associated team ID |
| `state` | string | PR state (optional) |
| `ci_status` | string | CI status (optional) |
| `merge_status` | string | Merge readiness (optional) |
| `auto_merge` | boolean | Auto-merge enabled (optional) |
| `ci_fail_count` | number | CI failure count (optional) |
| `action` | string | Action performed (optional) |

```json
{
  "type": "pr_updated",
  "pr_number": 101,
  "team_id": 1,
  "state": "open",
  "ci_status": "passing",
  "merge_status": "clean"
}
```

---

#### `team_launched`

Fired when a team is successfully launched.

**Trigger:** Team launch

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |
| `issue_number` | number | GitHub issue number |
| `project_id` | number or null | Project ID (optional) |

```json
{
  "type": "team_launched",
  "team_id": 1,
  "issue_number": 42,
  "project_id": 1
}
```

---

#### `team_stopped`

Fired when a team is stopped (manually or due to process exit).

**Trigger:** Team stop or process exit

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |

```json
{
  "type": "team_stopped",
  "team_id": 1
}
```

---

#### `usage_updated`

Fired when a new usage snapshot is processed.

**Trigger:** Usage poller or manual submission

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `daily_percent` | number | Daily usage percentage |
| `weekly_percent` | number | Weekly usage percentage |
| `sonnet_percent` | number | Sonnet usage percentage |
| `extra_percent` | number | Extra usage percentage |
| `zone` | string | Usage zone: `green` or `red` |

```json
{
  "type": "usage_updated",
  "daily_percent": 45.2,
  "weekly_percent": 23.1,
  "sonnet_percent": 12.5,
  "extra_percent": 0,
  "zone": "green"
}
```

---

#### `project_added`

Fired when a new project is created.

**Trigger:** POST /api/projects

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `project_id` | number | Project ID |
| `name` | string | Project name |
| `repo_path` | string | Repository path |

```json
{
  "type": "project_added",
  "project_id": 1,
  "name": "my-project",
  "repo_path": "C:/Git/my-project"
}
```

---

#### `project_updated`

Fired when a project is updated.

**Trigger:** PUT /api/projects/:id

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `project_id` | number | Project ID |
| `name` | string | Project name |
| `status` | string | Project status |

```json
{
  "type": "project_updated",
  "project_id": 1,
  "name": "my-project",
  "status": "active"
}
```

---

#### `project_removed`

Fired when a project is deleted.

**Trigger:** DELETE /api/projects/:id

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `project_id` | number | Project ID |

```json
{
  "type": "project_removed",
  "project_id": 1
}
```

---

#### `project_cleanup`

Fired when a project cleanup operation completes.

**Trigger:** POST /api/projects/:id/cleanup

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `project_id` | number | Project ID |
| `removed_count` | number | Number of items removed |
| `failed_count` | number | Number of items that failed to remove |

```json
{
  "type": "project_cleanup",
  "project_id": 1,
  "removed_count": 3,
  "failed_count": 0
}
```

---

#### `snapshot`

Sent once on initial SSE connection. Contains the full dashboard state so the client can render immediately.

**Trigger:** Client connects to SSE stream

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `teams` | TeamDashboardRow[] | Full dashboard state |

```json
{
  "type": "snapshot",
  "teams": [
    {
      "id": 1,
      "issueNumber": 42,
      "status": "running",
      "projectName": "my-project"
    }
  ]
}
```

---

#### `heartbeat`

Sent every 30 seconds to keep the connection alive.

**Trigger:** Timer (configurable via `FLEET_SSE_HEARTBEAT_MS`)

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO timestamp |

```json
{
  "type": "heartbeat",
  "timestamp": "2026-03-21T10:30:00.000Z"
}
```

---

#### `dependency_resolved`

Fired when all blockers for a previously-blocked issue are closed.

**Trigger:** GitHub poller detects blocker closure

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `issue_number` | number | Issue that is now unblocked |
| `project_id` | number | Project ID |
| `previously_blocked_by` | number[] | Issue numbers that were blocking |

```json
{
  "type": "dependency_resolved",
  "issue_number": 42,
  "project_id": 1,
  "previously_blocked_by": [10, 12]
}
```

---

#### `team_thinking_start`

Fired when a team enters a thinking/processing phase (no tool use, model is generating).

**Trigger:** Claude Code stream event

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |

```json
{
  "type": "team_thinking_start",
  "team_id": 1
}
```

---

#### `team_thinking_stop`

Fired when a team exits the thinking phase.

**Trigger:** Claude Code stream event

**Payload:**

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | number | Team ID |
| `duration_ms` | number | How long the thinking phase lasted |

```json
{
  "type": "team_thinking_stop",
  "team_id": 1,
  "duration_ms": 5200
}
```

---

## Workflow Examples

### Launch a Team and Monitor Progress

This example launches a team for issue #42 and polls its status.

```bash
# 1. Launch a team
curl -s -X POST http://localhost:4680/api/teams/launch \
  -H "Content-Type: application/json" \
  -d '{"projectId": 1, "issueNumber": 42, "issueTitle": "Fix login page layout"}'

# Response: {"id": 1, "status": "queued", ...}

# 2. Check team status (poll or use SSE)
curl -s http://localhost:4680/api/teams/1/status

# 3. View team output
curl -s "http://localhost:4680/api/teams/1/output?lines=20"

# 4. View team detail with PR info
curl -s http://localhost:4680/api/teams/1

# 5. View the unified timeline
curl -s "http://localhost:4680/api/teams/1/timeline?limit=50"

# 6. Export team logs when done
curl -s "http://localhost:4680/api/teams/1/export?format=json" -o team-42-export.json
```

### Send a Message to a Running Team

This example sends a message to guide a running team, then checks the message was delivered.

```bash
# 1. Send a message
curl -s -X POST http://localhost:4680/api/teams/1/send-message \
  -H "Content-Type: application/json" \
  -d '{"message": "Please focus on fixing the failing test in auth.spec.ts before continuing."}'

# Response (201): {"status": "delivered", "deliveredAt": "..."}
# Response (422): {"error": "Unprocessable Entity", "message": "Team is not running"}

# 2. View team messages
curl -s http://localhost:4680/api/teams/1/messages

# 3. Check team status to see if it picked up the message
curl -s http://localhost:4680/api/teams/1/status
```

### Monitor Fleet via SSE

This example uses JavaScript to monitor the fleet in real-time.

```javascript
const source = new EventSource('http://localhost:4680/api/stream');

// Handle initial snapshot
source.addEventListener('snapshot', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Fleet snapshot: ${data.teams.length} teams`);
  data.teams.forEach((team) => {
    console.log(`  #${team.issueNumber} [${team.status}] ${team.projectName}`);
  });
});

// Monitor status changes
source.addEventListener('team_status_changed', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Team ${data.team_id}: ${data.previous_status} -> ${data.status}`);
});

// Monitor PR updates
source.addEventListener('pr_updated', (event) => {
  const data = JSON.parse(event.data);
  console.log(`PR #${data.pr_number}: CI=${data.ci_status}, merge=${data.merge_status}`);
});

// Monitor launches and stops
source.addEventListener('team_launched', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Team ${data.team_id} launched for issue #${data.issue_number}`);
});

source.addEventListener('team_stopped', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Team ${data.team_id} stopped`);
});

// Monitor usage
source.addEventListener('usage_updated', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Usage: daily=${data.daily_percent}%, zone=${data.zone}`);
});

// Heartbeat
source.addEventListener('heartbeat', () => {
  console.log('Connection alive');
});

// Error handling (EventSource auto-reconnects)
source.onerror = () => {
  console.log('SSE error, reconnecting...');
};
```

---

## TypeScript Types Reference

Key interfaces from `src/shared/types.ts` used throughout the API:

### TeamStatus

```typescript
type TeamStatus = 'queued' | 'launching' | 'running' | 'idle' | 'stuck' | 'done' | 'failed';
```

### TeamPhase

```typescript
type TeamPhase = 'init' | 'analyzing' | 'implementing' | 'reviewing' | 'pr' | 'done' | 'blocked';
```

### PRState

```typescript
type PRState = 'draft' | 'open' | 'merged' | 'closed';
```

### CIStatus

```typescript
type CIStatus = 'none' | 'pending' | 'passing' | 'failing';
```

### MergeStatus

```typescript
type MergeStatus = 'unknown' | 'clean' | 'behind' | 'blocked' | 'dirty' | 'unstable' | 'has_hooks' | 'draft';
```

### ProjectStatus

```typescript
type ProjectStatus = 'active' | 'archived';
```

### UsageZone

```typescript
type UsageZone = 'green' | 'red';
```

### Team

```typescript
interface Team {
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  launchedAt: string | null;
  stoppedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Project

```typescript
interface Project {
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
  createdAt: string;
  updatedAt: string;
}
```

### PullRequest

```typescript
interface PullRequest {
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
```

### Event

```typescript
interface Event {
  id: number;
  teamId: number;
  eventType: string;
  sessionId: string | null;
  toolName: string | null;
  agentName: string | null;
  payload: string | null;
  createdAt: string;
}
```

### TeamDashboardRow

```typescript
interface TeamDashboardRow {
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  githubRepo: string | null;
  prState: PRState | null;
  ciStatus: CIStatus | null;
  mergeStatus: MergeStatus | null;
}
```

### TeamDetail

```typescript
interface TeamDetail {
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
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
```

### UsageSnapshot

```typescript
interface UsageSnapshot {
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
```

### MessageTemplate

```typescript
interface MessageTemplate {
  id: string;
  template: string;
  enabled: boolean;
  updatedAt: string;
}
```

### SSEEventType

```typescript
type SSEEventType =
  | 'team_status_changed'
  | 'team_event'
  | 'team_output'
  | 'pr_updated'
  | 'team_launched'
  | 'team_stopped'
  | 'usage_updated'
  | 'project_added'
  | 'project_updated'
  | 'project_removed'
  | 'project_cleanup'
  | 'snapshot'
  | 'heartbeat'
  | 'dependency_resolved'
  | 'team_thinking_start'
  | 'team_thinking_stop';
```
