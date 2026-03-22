// =============================================================================
// Fleet Commander — MCP stop-team Tool Tests
// =============================================================================
// Smoke tests for the fleet_stop_team MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockStoppedTeam = {
  id: 42,
  teamSlug: 'my-repo-123',
  status: 'done',
};

const mockStopTeam = vi.fn().mockResolvedValue(mockStoppedTeam);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    stopTeam: mockStopTeam,
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

const { registerStopTeamTool } = await import(
  '../../../src/server/mcp/tools/stop-team.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_stop_team MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerStopTeamTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_stop_team');
  });

  it('registers with a description', () => {
    registerStopTeamTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid JSON result', async () => {
    registerStopTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 42 })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockStoppedTeam);
  });

  it('handler passes teamId to stopTeam', async () => {
    registerStopTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 42 });

    expect(mockStopTeam).toHaveBeenCalledWith(42);
  });

  it('handler returns isError on ServiceError', async () => {
    mockStopTeam.mockRejectedValueOnce(
      new ServiceError('Team not found', 'NOT_FOUND', 404),
    );

    registerStopTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 999 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Team not found');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockStopTeam.mockRejectedValueOnce(new Error('unexpected'));

    registerStopTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ teamId: 42 })).rejects.toThrow('unexpected');
  });
});
