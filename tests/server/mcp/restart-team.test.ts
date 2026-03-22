// =============================================================================
// Fleet Commander — MCP restart-team Tool Tests
// =============================================================================
// Smoke tests for the fleet_restart_team MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockRestartedTeam = {
  id: 42,
  teamSlug: 'my-repo-123',
  status: 'launching',
};

const mockRestartTeam = vi.fn().mockResolvedValue(mockRestartedTeam);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    restartTeam: mockRestartTeam,
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

const { registerRestartTeamTool } = await import(
  '../../../src/server/mcp/tools/restart-team.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_restart_team MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerRestartTeamTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_restart_team');
  });

  it('registers with a description', () => {
    registerRestartTeamTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid JSON result', async () => {
    registerRestartTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 42 })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockRestartedTeam);
  });

  it('handler passes teamId to restartTeam', async () => {
    registerRestartTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 42 });

    expect(mockRestartTeam).toHaveBeenCalledWith(42);
  });

  it('handler returns isError on ServiceError', async () => {
    mockRestartTeam.mockRejectedValueOnce(
      new ServiceError('Team not found', 'NOT_FOUND', 404),
    );

    registerRestartTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 999 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Team not found');
  });

  it('handler returns isError on conflict ServiceError', async () => {
    mockRestartTeam.mockRejectedValueOnce(
      new ServiceError('Team is already completed', 'CONFLICT', 409),
    );

    registerRestartTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 42 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already completed');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockRestartTeam.mockRejectedValueOnce(new Error('unexpected'));

    registerRestartTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ teamId: 42 })).rejects.toThrow('unexpected');
  });
});
