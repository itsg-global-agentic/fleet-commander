# Fleet Commander MCP Reference

Documentation for the Fleet Commander Model Context Protocol (MCP) server: tool reference, architecture rationale, and developer guide.

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Core Tools Reference (12 tools)](#core-tools-reference)
  - [fleet_system_health](#fleet_system_health)
  - [fleet_list_teams](#fleet_list_teams)
  - [fleet_get_team](#fleet_get_team)
  - [fleet_launch_team](#fleet_launch_team)
  - [fleet_launch_batch](#fleet_launch_batch)
  - [fleet_stop_team](#fleet_stop_team)
  - [fleet_send_message](#fleet_send_message)
  - [fleet_list_issues](#fleet_list_issues)
  - [fleet_list_projects](#fleet_list_projects)
  - [fleet_get_usage](#fleet_get_usage)
  - [fleet_get_team_timeline](#fleet_get_team_timeline)
  - [fleet_cleanup_preview](#fleet_cleanup_preview)
- [Architecture Decision: Tool Selection](#architecture-decision-tool-selection)
  - [Why 12, Not 50](#why-12-not-50)
  - [Deferred Tools (38)](#deferred-tools-38)
  - [Promotion Path](#promotion-path)
- [Adding New Tools -- Developer Guide](#adding-new-tools----developer-guide)
  - [File Structure](#file-structure)
  - [Zero-Argument Tool Pattern](#zero-argument-tool-pattern)
  - [Parameterized Tool Pattern](#parameterized-tool-pattern)
  - [Registration](#registration)
  - [Testing](#testing)

---

## Overview

Fleet Commander exposes an MCP server that lets Claude Code (or any MCP-compatible client) interact with the fleet programmatically. Instead of clicking buttons in the dashboard UI or calling the REST API manually, an agent can check fleet health, launch teams, send messages, and inspect timelines through MCP tool calls.

| Property | Value |
|----------|-------|
| Transport | stdio (JSON-RPC over stdin/stdout) |
| Entry point | `node bin/fleet-commander-mcp.js` |
| Protocol | [Model Context Protocol](https://modelcontextprotocol.io/) |
| Tool prefix | `fleet_` |
| Core tools | 12 |
| Server name | `fleet-commander` |

The MCP server is a **separate process** from the Fastify HTTP server. It initializes the SQLite database and starts all background services (SSE broker, issue fetcher, stuck detector, GitHub poller, usage tracker) but does **not** bind an HTTP port. All logging goes to stderr since stdout is reserved for MCP JSON-RPC.

### Relationship to REST API and UI

The MCP server, REST API, and dashboard UI all share the same service layer and database:

```
Claude Code agent  --->  MCP server (stdio)  --->  Service layer  --->  SQLite
Browser            --->  Fastify HTTP + SSE   --->  Service layer  --->  SQLite
```

MCP tools are thin wrappers that call exactly one service method and return JSON. The REST API exposes the full 71-endpoint surface; the MCP server exposes only the 12 tools most useful for programmatic agent interaction.

---

## Quick Start

### Connect from Claude Code

**Option A: `claude mcp add`**

```bash
claude mcp add fleet-commander -- node bin/fleet-commander-mcp.js
```

**Option B: `.mcp.json` in your project root**

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

On Windows, use forward slashes or escaped backslashes in the `cwd` path.

### Basic Usage Examples

**Check fleet status:**

```
Use fleet_system_health to see how the fleet is doing.
```

Returns team counts by status and phase, plus stuck/idle count.

**Launch a team for an issue:**

```
Use fleet_launch_team with projectId 1 and issueNumber 42.
```

Spawns a Claude Code agent in a worktree for the given issue.

**Send a message to a running team:**

```
Use fleet_send_message with teamId 3 and message "Please prioritize the unit tests."
```

Delivers the message via stdin to the running agent process.

**View a team's activity timeline:**

```
Use fleet_get_team_timeline with teamId 3 to see recent events.
```

Returns a merged timeline of stream events and hook events.

---

## Core Tools Reference

All tools return `{ content: [{ type: "text", text: "<JSON>" }] }`. On error, tools return `{ content: [{ type: "text", text: "<error message>" }], isError: true }`.

### Quick Reference

| Tool | Parameters | Service Method |
|------|-----------|----------------|
| `fleet_system_health` | none | `DiagnosticsService.getHealthSummary()` |
| `fleet_list_teams` | none | `TeamService.listTeams()` |
| `fleet_get_team` | `teamId` | `TeamService.getTeamDetail(teamId)` |
| `fleet_launch_team` | `projectId`, `issueNumber`, ... | `TeamService.launchTeam(params)` |
| `fleet_launch_batch` | `projectId`, `issues`, ... | `TeamService.launchBatch(params)` |
| `fleet_stop_team` | `teamId` | `TeamService.stopTeam(teamId)` |
| `fleet_send_message` | `teamId`, `message` | `TeamService.sendMessage(teamId, message)` |
| `fleet_list_issues` | `projectId` | `IssueService.getProjectIssues(projectId)` |
| `fleet_list_projects` | none | `ProjectService.listProjects()` |
| `fleet_get_usage` | none | `UsageService.getLatest()` |
| `fleet_get_team_timeline` | `teamId`, `limit?` | `TeamService.getTeamTimeline(teamId, limit)` |
| `fleet_cleanup_preview` | `projectId`, `resetTeams?` | `ProjectService.getCleanupPreview(projectId, resetTeams)` |

---

### fleet_system_health

Returns a fleet health summary with team counts by status and phase.

| Property | Value |
|----------|-------|
| Parameters | none |
| Service method | `DiagnosticsService.getHealthSummary()` |
| Implemented | yes |

**Example response:**

```json
{
  "totalTeams": 5,
  "activeTeams": 3,
  "stuckOrIdle": 1,
  "byStatus": { "running": 2, "idle": 1, "done": 2 },
  "byPhase": { "implementing": 2, "reviewing": 1, "done": 2 }
}
```

**When to use:** First thing to call when checking on the fleet. Gives a quick snapshot of how many teams are running, stuck, or done.

---

### fleet_list_teams

Returns all teams with dashboard data (joined with project and PR info).

| Property | Value |
|----------|-------|
| Parameters | none |
| Service method | `TeamService.listTeams()` |
| Implemented | not yet |

**Input schema:** none

**Example response:**

```json
[
  {
    "id": 1,
    "issueNumber": 42,
    "issueTitle": "Add search feature",
    "status": "running",
    "phase": "implementing",
    "worktreeName": "my-project-42",
    "projectName": "my-project",
    "prNumber": 101,
    "launchedAt": "2025-01-15T10:00:00Z",
    "lastEventAt": "2025-01-15T10:30:00Z"
  }
]
```

**When to use:** Get a full list of all teams and their current state. Equivalent to the Fleet Grid view in the dashboard.

---

### fleet_get_team

Returns full detail for a single team including PR info, recent events, and output tail.

| Property | Value |
|----------|-------|
| Parameters | `teamId` (number, required) |
| Service method | `TeamService.getTeamDetail(teamId)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `teamId` | number | yes | The team ID |

**Example response:**

```json
{
  "id": 1,
  "issueNumber": 42,
  "issueTitle": "Add search feature",
  "model": "claude-sonnet-4-20250514",
  "status": "running",
  "phase": "implementing",
  "pid": 12345,
  "worktreeName": "my-project-42",
  "branchName": "feat/42-add-search",
  "prNumber": 101,
  "launchedAt": "2025-01-15T10:00:00Z",
  "durationMin": 30,
  "idleMin": 2.5,
  "pr": {
    "number": 101,
    "state": "open",
    "ciStatus": "passing",
    "mergeStatus": "clean"
  },
  "recentEvents": [],
  "outputTail": "..."
}
```

**When to use:** Drill into a specific team to see its full state, PR status, recent events, and output.

---

### fleet_launch_team

Launches a single team for an issue. Checks dependencies unless `force` is true.

| Property | Value |
|----------|-------|
| Parameters | `projectId`, `issueNumber`, `issueTitle?`, `prompt?`, `headless?`, `force?` |
| Service method | `TeamService.launchTeam(params)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | yes | The project ID to launch under |
| `issueNumber` | number | yes | The GitHub issue number |
| `issueTitle` | string | no | Issue title (for display) |
| `prompt` | string | no | Custom prompt override |
| `headless` | boolean | no | Run without a visible terminal (default false) |
| `force` | boolean | no | Bypass dependency check (default false) |

**Error cases:**

- `VALIDATION` -- invalid projectId or issueNumber
- `CONFLICT` -- issue is blocked by unresolved dependencies
- `CONFLICT` -- a team is already active for this issue

**When to use:** Start work on a specific issue. The team gets queued and launched when a slot is available.

---

### fleet_launch_batch

Launches multiple teams in a batch. Checks dependencies for each issue, separating blocked from launchable issues. Intra-batch dependencies are allowed.

| Property | Value |
|----------|-------|
| Parameters | `projectId`, `issues`, `prompt?`, `delayMs?`, `headless?` |
| Service method | `TeamService.launchBatch(params)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | yes | The project ID |
| `issues` | array | yes | Array of `{ number: number, title?: string }` |
| `prompt` | string | no | Custom prompt applied to all teams |
| `delayMs` | number | no | Delay between launches in milliseconds |
| `headless` | boolean | no | Run without visible terminals |

**Example response:**

```json
{
  "launched": [ { "id": 1, "issueNumber": 10 }, { "id": 2, "issueNumber": 11 } ],
  "blocked": [
    { "issueNumber": 12, "dependencies": { "resolved": false, "openCount": 1 } }
  ]
}
```

**When to use:** Launch multiple issues at once. Useful for kicking off a batch of related work items.

---

### fleet_stop_team

Stops a running team by sending SIGTERM to its Claude Code process.

| Property | Value |
|----------|-------|
| Parameters | `teamId` (number, required) |
| Service method | `TeamService.stopTeam(teamId)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `teamId` | number | yes | The team ID to stop |

**Error cases:**

- `VALIDATION` -- invalid teamId
- `NOT_FOUND` -- team does not exist

**When to use:** Stop a team that is stuck, misbehaving, or no longer needed.

---

### fleet_send_message

Sends a message to a running team via stdin and writes a `.fleet-pm-message` file in the worktree.

| Property | Value |
|----------|-------|
| Parameters | `teamId`, `message` |
| Service method | `TeamService.sendMessage(teamId, message)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `teamId` | number | yes | The team ID |
| `message` | string | yes | The message text to send |

**Example response:**

```json
{
  "command": { "id": 5, "teamId": 1, "message": "Focus on tests", "createdAt": "..." },
  "delivered": true
}
```

**Error cases:**

- `NOT_FOUND` -- team does not exist
- `VALIDATION` -- message is empty

**When to use:** Send instructions or feedback to a running agent. The message is delivered via stdin if the process is alive.

---

### fleet_list_issues

Returns the issue hierarchy for a specific project, enriched with active team info.

| Property | Value |
|----------|-------|
| Parameters | `projectId` (number, required) |
| Service method | `IssueService.getProjectIssues(projectId)` |
| Implemented | yes |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | yes | The project ID to list issues for |

**Example response:**

```json
{
  "projectId": 1,
  "projectName": "fleet-commander",
  "tree": [
    {
      "number": 100,
      "title": "Parent issue",
      "state": "open",
      "children": [
        { "number": 101, "title": "Child issue", "state": "open", "children": [] }
      ]
    }
  ],
  "cachedAt": "2025-01-15T10:00:00Z",
  "count": 2
}
```

**Error cases:**

- `VALIDATION` -- invalid projectId
- `NOT_FOUND` -- project does not exist

**When to use:** See the issue hierarchy for a project to decide what to work on next.

---

### fleet_list_projects

Returns all registered projects with team counts and hook install status.

| Property | Value |
|----------|-------|
| Parameters | none |
| Service method | `ProjectService.listProjects()` |
| Implemented | yes |

**Example response:**

```json
[
  {
    "id": 1,
    "name": "fleet-commander",
    "repoPath": "/repos/fleet-commander",
    "githubRepo": "owner/fleet-commander",
    "teamCount": 3,
    "installStatus": { "hooks": { "installed": true }, "prompt": { "installed": true } }
  }
]
```

**When to use:** List all registered repositories and their status. First step when deciding which project to launch teams for.

---

### fleet_get_usage

Returns the latest usage snapshot with zone and threshold info.

| Property | Value |
|----------|-------|
| Parameters | none |
| Service method | `UsageService.getLatest()` |
| Implemented | not yet |

**Example response:**

```json
{
  "dailyPercent": 45,
  "weeklyPercent": 30,
  "sonnetPercent": 60,
  "extraPercent": 0,
  "recordedAt": "2025-01-15T10:00:00Z",
  "zone": "green",
  "redThresholds": { "daily": 80, "weekly": 80, "sonnet": 80, "extra": 80 }
}
```

**When to use:** Check usage limits before launching new teams. If the zone is "red", the queue is gated and new launches may be delayed.

---

### fleet_get_team_timeline

Returns a unified timeline merging stream events and hook events for a team.

| Property | Value |
|----------|-------|
| Parameters | `teamId` (required), `limit` (optional) |
| Service method | `TeamService.getTeamTimeline(teamId, limit)` |
| Implemented | yes |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `teamId` | number | yes | The team ID to get the timeline for |
| `limit` | number | no | Maximum number of timeline entries (default 500) |

**Example response:**

```json
[
  { "ts": "2025-01-15T10:00:00Z", "type": "tool_use", "tool": "Read", "source": "stream" },
  { "ts": "2025-01-15T10:01:00Z", "type": "session_start", "source": "hook" }
]
```

**Error cases:**

- `NOT_FOUND` -- team does not exist

**When to use:** Inspect what a team has been doing. Shows both tool usage from the Claude Code stream and lifecycle events from hooks.

---

### fleet_cleanup_preview

Generates a cleanup dry-run preview for a project, showing worktrees and branches that would be removed.

| Property | Value |
|----------|-------|
| Parameters | `projectId` (required), `resetTeams` (optional) |
| Service method | `ProjectService.getCleanupPreview(projectId, resetTeams)` |
| Implemented | not yet |

**Input schema:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | number | yes | The project ID |
| `resetTeams` | boolean | no | Include team DB records in preview (default false) |

**Example response:**

```json
{
  "projectId": 1,
  "items": [
    { "type": "worktree", "path": "/repos/project/.claude/worktrees/project-42", "size": 1024 },
    { "type": "branch", "name": "feat/42-add-search" }
  ]
}
```

**Error cases:**

- `VALIDATION` -- invalid projectId
- `NOT_FOUND` -- project does not exist

**When to use:** Before cleaning up old worktrees and branches. Shows what would be removed without actually deleting anything.

---

## Architecture Decision: Tool Selection

This section documents why Fleet Commander exposes 12 MCP tools rather than wrapping all 71 REST endpoints. The analysis is based on the research in issue [#330](https://github.com/hubertciebiada/fleet-commander/issues/330).

### Why 12, Not 50

**1. Daily use frequency.** The 12 core tools cover the operations an agent performs most often: check health, list teams, launch work, send messages, inspect progress. The remaining endpoints handle infrequent CRUD, configuration, and debugging tasks better suited to the dashboard UI.

**2. Context budget.** MCP tool descriptions consume tokens in the agent's context window. 12 tools produce roughly 2K tokens of tool metadata. Exposing all 50+ operations would consume 6-8K tokens, reducing the space available for actual work. The goal is to keep the tool surface small enough that an agent can hold the entire tool list in context without it dominating the conversation.

**3. CLI vs UI appropriateness.** Many operations (project CRUD, PR branch updates, factory reset) involve complex UI confirmation flows, file browsing, or destructive actions that benefit from visual confirmation in the dashboard rather than blind MCP invocation.

**4. Composite tools over granular ones.** `fleet_get_team` returns a rich composite response (team status, PR detail, recent events, output tail) rather than requiring separate calls for each piece. This reduces round-trips and keeps agent workflows simple.

### Deferred Tools (38)

The following 38 tools were evaluated and deferred. They remain available through the REST API and dashboard UI. Each category lists the deferred operations and the reason for deferral.

#### Project CRUD (8 deferred)

| Operation | Why deferred |
|-----------|-------------|
| Get project detail | Low MCP frequency -- agents rarely need single-project metadata |
| Update project | Configuration change -- better suited to dashboard UI |
| Delete project | Destructive -- requires confirmation flow |
| Install hooks | One-time setup -- done via dashboard |
| Get project teams | Covered by `fleet_list_teams` with filtering |
| Get project prompt | Prompt editing is a UI workflow |
| Save project prompt | Prompt editing is a UI workflow |
| Execute cleanup | Destructive -- use `fleet_cleanup_preview` first, then confirm in UI |

#### Team Lifecycle Details (7 deferred)

| Operation | Why deferred |
|-----------|-------------|
| Stop all teams | Destructive batch operation -- dashboard confirmation preferred |
| Force-launch team | Edge case -- bypasses queue ordering |
| Resume team | Uncommon recovery operation |
| Restart team | Uncommon recovery operation |
| Set team phase | Internal state management -- agents set their own phase via hooks |
| Acknowledge alert | Dashboard workflow with visual confirmation |
| Get team roster | Niche debugging -- rarely needed programmatically |

#### Detailed Data (6 deferred)

| Operation | Why deferred |
|-----------|-------------|
| Get team output | Covered by `fleet_get_team` (includes `outputTail`) |
| Get team stream events | Covered by `fleet_get_team_timeline` |
| Get team hook events | Covered by `fleet_get_team_timeline` |
| Export team | Data export -- typically downloaded via browser |
| Get team transitions | Debugging aid -- covered by timeline |
| Get team messages | Included in team detail |

#### PR Operations (5 deferred)

| Operation | Why deferred |
|-----------|-------------|
| List PRs | Low MCP frequency -- PR info included in team data |
| Get PR detail | Low MCP frequency -- PR info included in `fleet_get_team` |
| Enable auto-merge | One-time action per PR -- dashboard workflow |
| Disable auto-merge | One-time action per PR -- dashboard workflow |
| Update PR branch | Infrequent -- dashboard workflow |

#### Issue Operations (6 deferred)

| Operation | Why deferred |
|-----------|-------------|
| Get all issues (cross-project) | `fleet_list_issues` covers per-project; cross-project is UI concern |
| Get next issue suggestion | Useful but low priority -- agents typically know their issue |
| Get available issues | Useful but low priority -- covered by `fleet_list_issues` |
| Get single issue | Low MCP frequency -- agents know their issue context |
| Get issue dependencies | Dependency data included in issue tree and launch error messages |
| Refresh issues | Cache management -- automatic polling handles this |

#### System / Maintenance (6 deferred)

| Operation | Why deferred |
|-----------|-------------|
| Get server status | Covered by `fleet_system_health` |
| Get settings / config | Read-only configuration -- dashboard view |
| Get stuck teams diagnostic | Covered by `fleet_system_health` (stuckOrIdle count) |
| Get blocked teams diagnostic | Niche diagnostic -- dashboard view |
| Debug teams | Internal debugging -- not for agent use |
| Factory reset | Destructive -- requires explicit confirmation |

### Promotion Path

If a deferred tool proves useful in daily agent workflows, it can be promoted to the core set:

1. Create the tool file in `src/server/mcp/tools/` following the existing pattern.
2. Register it in `src/server/mcp/index.ts`.
3. Add tests in `tests/server/mcp/`.
4. Update this document to move the tool from the deferred list to the core reference.
5. Monitor context budget impact -- keep total tool metadata under 4K tokens.

---

## Adding New Tools -- Developer Guide

### File Structure

```
src/server/mcp/
  index.ts                    # MCP server entry, registers all tools
  tools/
    system-health.ts          # fleet_system_health
    list-projects.ts          # fleet_list_projects
    list-issues.ts            # fleet_list_issues
    get-team-timeline.ts      # fleet_get_team_timeline
    add-project.ts            # fleet_add_project
```

**Naming convention:** kebab-case filename without the `fleet_` prefix. The tool name inside the file uses `fleet_` prefix with underscores (e.g., file `list-teams.ts` exports tool `fleet_list_teams`).

### Zero-Argument Tool Pattern

For tools that take no parameters, use the 3-argument `server.tool()` form:

```typescript
// src/server/mcp/tools/list-projects.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectService } from '../../services/project-service.js';

export function registerListProjectsTool(server: McpServer): void {
  server.tool(
    'fleet_list_projects',
    'Returns all registered projects with team counts and install status',
    async () => {
      const service = getProjectService();
      const projects = service.listProjects();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    },
  );
}
```

### Parameterized Tool Pattern

For tools with input parameters, use the 4-argument form with Zod schemas:

```typescript
// src/server/mcp/tools/get-team-timeline.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeamService } from '../../services/team-service.js';
import { ServiceError } from '../../services/service-error.js';

export function registerGetTeamTimelineTool(server: McpServer): void {
  server.tool(
    'fleet_get_team_timeline',
    'Returns a unified timeline of stream and hook events for a team',
    {
      teamId: z.number().describe('The team ID to get the timeline for'),
      limit: z.number().optional().describe('Maximum number of timeline entries (default 500)'),
    },
    async ({ teamId, limit }) => {
      try {
        const service = getTeamService();
        const timeline = service.getTeamTimeline(teamId, limit);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(timeline, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof ServiceError) {
          return {
            content: [{ type: 'text' as const, text: err.message }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
```

### Key Rules

1. **One service call per tool.** Each tool delegates to exactly one service method. No business logic in the tool handler.
2. **Export a single `register<ToolName>Tool(server)` function.** This is what `index.ts` calls during startup.
3. **Handle `ServiceError` gracefully.** Catch `ServiceError` and return `{ isError: true }` with the error message. Re-throw other errors.
4. **Return pretty-printed JSON.** Always use `JSON.stringify(result, null, 2)` for readability.
5. **Use `type: 'text' as const`** in the content array for TypeScript type narrowing.

### Registration

Import and call the register function in `src/server/mcp/index.ts`:

```typescript
import { registerListTeamsTool } from './tools/list-teams.js';

// Inside startMcpServer():
registerListTeamsTool(mcpServer);
```

### Testing

Create a test file at `tests/server/mcp/{tool-name}.test.ts`. The existing tests follow a consistent pattern:

1. **Mock the service** before importing the tool module.
2. **Create a mock McpServer** that captures `tool()` registrations.
3. **Test registration** -- tool name and description are correct.
4. **Test the handler** -- call it with mock parameters and verify the JSON response.
5. **Test error handling** -- throw a `ServiceError` from the mock and verify `isError: true`.

Example test structure:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// Mock the service
const mockServiceMethod = vi.fn().mockReturnValue({ /* mock data */ });
vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    listTeams: mockServiceMethod,
  }),
}));

// Mock MCP server to capture registrations
const registeredTools: Array<{ name: string; handler: Function }> = [];
const mockMcpServer = {
  tool: vi.fn((...args: unknown[]) => {
    registeredTools.push({
      name: args[0] as string,
      handler: args[args.length - 1] as Function,
    });
  }),
};

// Import after mocks
const { registerListTeamsTool } = await import(
  '../../../src/server/mcp/tools/list-teams.js'
);

describe('fleet_list_teams MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerListTeamsTool(mockMcpServer as any);
    expect(registeredTools[0]!.name).toBe('fleet_list_teams');
  });

  it('handler returns valid JSON', async () => {
    registerListTeamsTool(mockMcpServer as any);
    const result = await registeredTools[0]!.handler();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toBeDefined();
  });
});
```

Run tests with:

```bash
npm test -- tests/server/mcp/
```
