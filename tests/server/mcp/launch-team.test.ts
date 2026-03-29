// =============================================================================
// Fleet Commander — MCP launch-team Tool Tests
// =============================================================================
// Smoke tests for the fleet_launch_team MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockLaunchedTeam = {
  id: 7,
  teamSlug: 'my-repo-42',
  status: 'queued',
  issueNumber: 42,
};

const mockLaunchTeam = vi.fn().mockResolvedValue(mockLaunchedTeam);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    launchTeam: mockLaunchTeam,
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

const { registerLaunchTeamTool } = await import(
  '../../../src/server/mcp/tools/launch-team.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_launch_team MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerLaunchTeamTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_launch_team');
  });

  it('registers with a description', () => {
    registerLaunchTeamTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler launches a team with required params only', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 1, issueNumber: 42 })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockLaunchedTeam);

    expect(mockLaunchTeam).toHaveBeenCalledWith({
      projectId: 1,
      issueNumber: 42,
      headless: undefined,
      force: undefined,
    });
  });

  it('handler launches a team with all optional params', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({
      projectId: 2,
      issueNumber: 99,
      headless: true,
      force: true,
    })) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockLaunchedTeam);

    expect(mockLaunchTeam).toHaveBeenCalledWith({
      projectId: 2,
      issueNumber: 99,
      headless: true,
      force: true,
    });
  });

  it('handler returns isError on ServiceError', async () => {
    mockLaunchTeam.mockRejectedValueOnce(
      new ServiceError('Issue #42 is blocked by 2 unresolved dependencies', 'BLOCKED_BY_DEPENDENCIES', 409),
    );

    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 1, issueNumber: 42 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Issue #42 is blocked by 2 unresolved dependencies');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockLaunchTeam.mockRejectedValueOnce(new Error('unexpected'));

    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ projectId: 1, issueNumber: 42 })).rejects.toThrow('unexpected');
  });

  it('handler derives issueNumber=0 from non-numeric Jira issueKey', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ projectId: 1, issueKey: 'PROJ-123' });

    expect(mockLaunchTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        issueNumber: 0,
        issueKey: 'PROJ-123',
      }),
    );
  });

  it('handler derives issueNumber from purely numeric issueKey', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ projectId: 1, issueKey: '42' });

    expect(mockLaunchTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        issueNumber: 42,
        issueKey: '42',
      }),
    );
  });

  it('handler returns error when neither issueNumber nor issueKey provided', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ projectId: 1 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Either issueNumber or issueKey');
  });

  it('handler prefers explicit issueNumber over issueKey derivation', async () => {
    registerLaunchTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ projectId: 1, issueNumber: 99, issueKey: 'PROJ-123' });

    expect(mockLaunchTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        issueNumber: 99,
        issueKey: 'PROJ-123',
      }),
    );
  });
});
