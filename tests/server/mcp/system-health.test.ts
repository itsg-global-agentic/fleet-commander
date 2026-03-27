// =============================================================================
// Fleet Commander — MCP system-health Tool Tests
// =============================================================================
// Tests for the fleet_system_health MCP tool registration, handler, and error
// paths.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';
import type { HealthSummary } from '../../../src/server/services/diagnostics-service.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockHealthSummary: HealthSummary = {
  totalTeams: 5,
  activeTeams: 3,
  stuckOrIdle: 1,
  byStatus: { running: 2, idle: 1, done: 2 },
  byPhase: { implementing: 2, reviewing: 1, done: 2 },
};

const mockGetHealthSummary = vi.fn().mockReturnValue(mockHealthSummary);

vi.mock('../../../src/server/services/diagnostics-service.js', () => ({
  getDiagnosticsService: () => ({
    getHealthSummary: mockGetHealthSummary,
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

const { registerSystemHealthTool } = await import(
  '../../../src/server/mcp/tools/system-health.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_system_health MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHealthSummary.mockReturnValue(mockHealthSummary);
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerSystemHealthTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_system_health');
  });

  it('registers with a description', () => {
    registerSystemHealthTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid HealthSummary JSON', async () => {
    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockHealthSummary);
  });

  it('handler returns properly formatted JSON with indentation', async () => {
    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]!.text;
    // Verify it's pretty-printed (contains newlines and indentation)
    expect(text).toContain('\n');
    expect(text).toContain('  ');
    // Verify it matches JSON.stringify with indent=2
    expect(text).toBe(JSON.stringify(mockHealthSummary, null, 2));
  });

  it('handler returns zeroed health summary when no teams exist', async () => {
    const emptyHealth: HealthSummary = {
      totalTeams: 0,
      activeTeams: 0,
      stuckOrIdle: 0,
      byStatus: {},
      byPhase: {},
    };
    mockGetHealthSummary.mockReturnValue(emptyHealth);
    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.totalTeams).toBe(0);
    expect(parsed.activeTeams).toBe(0);
    expect(parsed.stuckOrIdle).toBe(0);
    expect(parsed.byStatus).toEqual({});
    expect(parsed.byPhase).toEqual({});
  });

  it('handler returns isError on ServiceError', async () => {
    mockGetHealthSummary.mockImplementationOnce(() => {
      throw new ServiceError('diagnostics unavailable', 'EXTERNAL_ERROR', 502);
    });

    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('diagnostics unavailable');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockGetHealthSummary.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler()).rejects.toThrow('unexpected');
  });

  it('handler includes byStatus and byPhase breakdowns', async () => {
    registerSystemHealthTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.byStatus).toHaveProperty('running', 2);
    expect(parsed.byStatus).toHaveProperty('idle', 1);
    expect(parsed.byPhase).toHaveProperty('implementing', 2);
  });
});
