// =============================================================================
// Fleet Commander — MCP list-projects Tool Tests
// =============================================================================
// Tests for the fleet_list_projects MCP tool registration, handler, and error
// paths.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockProjects = [
  { id: 1, name: 'project-alpha', repoPath: '/repos/alpha', teamCount: 3 },
  { id: 2, name: 'project-beta', repoPath: '/repos/beta', teamCount: 1 },
];

const mockListProjects = vi.fn().mockReturnValue(mockProjects);

vi.mock('../../../src/server/services/project-service.js', () => ({
  getProjectService: () => ({
    listProjects: mockListProjects,
  }),
}));

// ---------------------------------------------------------------------------
// Capture tool registrations via a mock McpServer
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description: string;
  handler: (...args: unknown[]) => Promise<unknown>;
}

const registeredTools: RegisteredTool[] = [];

const mockMcpServer = {
  tool: vi.fn((...args: unknown[]) => {
    // server.tool(name, description, handler) — 3-arg form
    const name = args[0] as string;
    const description = args[1] as string;
    const handler = args[2] as (...a: unknown[]) => Promise<unknown>;
    registeredTools.push({ name, description, handler });
  }),
};

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { registerListProjectsTool } = await import(
  '../../../src/server/mcp/tools/list-projects.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_list_projects MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListProjects.mockReturnValue(mockProjects);
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerListProjectsTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_list_projects');
  });

  it('registers with a description', () => {
    registerListProjectsTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid projects JSON', async () => {
    registerListProjectsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockProjects);
  });

  it('handler returns properly formatted JSON with indentation', async () => {
    registerListProjectsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]!.text;
    // Verify it's pretty-printed (contains newlines and indentation)
    expect(text).toContain('\n');
    expect(text).toContain('  ');
    // Verify it matches JSON.stringify with indent=2
    expect(text).toBe(JSON.stringify(mockProjects, null, 2));
  });

  it('handler returns empty array when no projects exist', async () => {
    mockListProjects.mockReturnValue([]);
    registerListProjectsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual([]);
  });

  it('handler propagates service errors (no try/catch in zero-arg tool)', async () => {
    mockListProjects.mockImplementationOnce(() => {
      throw new Error('DB connection lost');
    });

    registerListProjectsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler()).rejects.toThrow('DB connection lost');
  });

  it('handler calls listProjects exactly once per invocation', async () => {
    registerListProjectsTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler();
    await handler();

    expect(mockListProjects).toHaveBeenCalledTimes(2);
  });
});
