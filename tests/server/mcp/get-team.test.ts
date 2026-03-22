// =============================================================================
// Fleet Commander — MCP get-team Tool Tests
// =============================================================================
// Smoke tests for the fleet_get_team MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockTeamDetail = {
  id: 1,
  issueNumber: 42,
  issueTitle: 'Add feature X',
  model: 'opus',
  githubRepo: 'owner/repo',
  status: 'running',
  phase: 'implementing',
  pid: 1234,
  sessionId: 'sess-abc',
  worktreeName: 'repo-42',
  branchName: 'feat/42-add-feature-x',
  prNumber: 100,
  launchedAt: '2025-01-01T00:00:00Z',
  stoppedAt: null,
  lastEventAt: '2025-01-01T01:00:00Z',
  durationMin: 60,
  idleMin: 5,
  totalInputTokens: 10000,
  totalOutputTokens: 5000,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalCostUsd: 1.5,
  pr: { number: 100, state: 'open', mergeStatus: 'unknown', ciStatus: 'pass', ciFailCount: 0, checks: [], autoMerge: false },
  recentEvents: [],
  outputTail: 'some output',
};

const mockGetTeamDetail = vi.fn().mockReturnValue(mockTeamDetail);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    getTeamDetail: mockGetTeamDetail,
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

const { registerGetTeamTool } = await import(
  '../../../src/server/mcp/tools/get-team.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_get_team MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerGetTeamTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_get_team');
  });

  it('registers with a description', () => {
    registerGetTeamTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid team detail JSON', async () => {
    registerGetTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockTeamDetail);
  });

  it('handler passes teamId to service', async () => {
    registerGetTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 42 });

    expect(mockGetTeamDetail).toHaveBeenCalledWith(42);
  });

  it('handler returns isError on ServiceError', async () => {
    mockGetTeamDetail.mockImplementationOnce(() => {
      throw new ServiceError('Team 999 not found', 'NOT_FOUND', 404);
    });

    registerGetTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 999 })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Team 999 not found');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockGetTeamDetail.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    registerGetTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ teamId: 1 })).rejects.toThrow('unexpected');
  });

  it('handler returns properly formatted JSON with indentation', async () => {
    registerGetTeamTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 1 })) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]!.text;
    expect(text).toContain('\n');
    expect(text).toContain('  ');
    expect(text).toBe(JSON.stringify(mockTeamDetail, null, 2));
  });
});
