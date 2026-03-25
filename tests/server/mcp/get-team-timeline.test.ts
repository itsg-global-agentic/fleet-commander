// =============================================================================
// Fleet Commander — MCP get-team-timeline Tool Tests
// =============================================================================
// Smoke tests for the fleet_get_team_timeline MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockTimeline = [
  { ts: '2025-01-01T00:00:00Z', type: 'tool_use', tool: 'Read', source: 'stream' },
  { ts: '2025-01-01T00:01:00Z', type: 'session_start', source: 'hook' },
];

const mockGetTeamTimeline = vi.fn().mockReturnValue(mockTimeline);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    getTeamTimeline: mockGetTeamTimeline,
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

const { registerGetTeamTimelineTool } = await import(
  '../../../src/server/mcp/tools/get-team-timeline.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_get_team_timeline MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_get_team_timeline');
  });

  it('registers with a description', () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid timeline JSON', async () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockTimeline);
  });

  it('handler passes teamId and limit to service', async () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 42, limit: 100 });

    expect(mockGetTeamTimeline).toHaveBeenCalledWith(42, 100);
  });

  it('handler passes teamId without limit when limit is undefined', async () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 7 });

    expect(mockGetTeamTimeline).toHaveBeenCalledWith(7, undefined);
  });

  it('handler returns isError on ServiceError', async () => {
    mockGetTeamTimeline.mockImplementationOnce(() => {
      throw new ServiceError('Team 999 not found', 'NOT_FOUND', 404);
    });

    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 999 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Team 999 not found');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockGetTeamTimeline.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ teamId: 1 })).rejects.toThrow('unexpected');
  });

  it('handler returns empty array when team has no events', async () => {
    mockGetTeamTimeline.mockReturnValueOnce([]);
    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual([]);
  });

  it('handler passes default undefined limit when limit is omitted', async () => {
    registerGetTeamTimelineTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 5, limit: undefined });

    expect(mockGetTeamTimeline).toHaveBeenCalledWith(5, undefined);
  });
});
