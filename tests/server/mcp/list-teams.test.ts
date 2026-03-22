// =============================================================================
// Fleet Commander — MCP list-teams Tool Tests
// =============================================================================
// Smoke tests for the fleet_list_teams MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockTeams = [
  { id: 1, project_id: 1, issue_number: 10, status: 'running', worktree_name: 'proj-10' },
  { id: 2, project_id: 1, issue_number: 20, status: 'done', worktree_name: 'proj-20' },
  { id: 3, project_id: 2, issue_number: 30, status: 'running', worktree_name: 'other-30' },
  { id: 4, project_id: 2, issue_number: 40, status: 'idle', worktree_name: 'other-40' },
];

const mockListTeams = vi.fn().mockReturnValue(mockTeams);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    listTeams: mockListTeams,
  }),
}));

// ---------------------------------------------------------------------------
// Capture tool registrations via a mock McpServer
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  handler: (...args: unknown[]) => Promise<unknown>;
}

const registeredTools: RegisteredTool[] = [];

const mockMcpServer = {
  tool: vi.fn((...args: unknown[]) => {
    // server.tool(name, description, schema, handler) — 4-arg form
    const name = args[0] as string;
    const description = args[1] as string;
    const schema = args[2];
    const handler = args[3] as (...a: unknown[]) => Promise<unknown>;
    registeredTools.push({ name, description, schema, handler });
  }),
};

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { registerListTeamsTool } = await import(
  '../../../src/server/mcp/tools/list-teams.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_list_teams MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerListTeamsTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_list_teams');
  });

  it('registers with a description', () => {
    registerListTeamsTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns all teams when no filters are provided', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: undefined, status: undefined })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockTeams);
  });

  it('handler filters by projectId', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 2, status: undefined })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].project_id).toBe(2);
    expect(parsed[1].project_id).toBe(2);
  });

  it('handler filters by status', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: undefined, status: 'running' })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((t: Record<string, unknown>) => t.status === 'running')).toBe(true);
  });

  it('handler filters by both projectId and status', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 1, status: 'running' })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(1);
    expect(parsed[0].project_id).toBe(1);
    expect(parsed[0].status).toBe('running');
  });

  it('handler returns empty array when no teams match filters', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 99, status: undefined })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual([]);
  });

  it('handler returns properly formatted JSON with indentation', async () => {
    registerListTeamsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: undefined, status: undefined })) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]!.text;
    expect(text).toContain('\n');
    expect(text).toContain('  ');
    expect(text).toBe(JSON.stringify(mockTeams, null, 2));
  });
});
