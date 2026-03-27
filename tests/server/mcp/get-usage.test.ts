// =============================================================================
// Fleet Commander — MCP get-usage Tool Tests
// =============================================================================
// Tests for the fleet_get_usage MCP tool registration, handler, and error
// paths.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockUsageData = {
  dailyPercent: 42,
  weeklyPercent: 18,
  sonnetPercent: 65,
  extraPercent: 3,
  recordedAt: '2026-03-23T12:00:00Z',
  zone: 'green',
  redThresholds: { daily: 80, weekly: 80, sonnet: 80, extra: 80 },
};

const mockGetLatest = vi.fn().mockReturnValue(mockUsageData);

vi.mock('../../../src/server/services/usage-service.js', () => ({
  getUsageService: () => ({
    getLatest: mockGetLatest,
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

const { registerGetUsageTool } = await import(
  '../../../src/server/mcp/tools/get-usage.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_get_usage MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatest.mockReturnValue(mockUsageData);
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerGetUsageTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_get_usage');
  });

  it('registers with a description', () => {
    registerGetUsageTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid usage JSON', async () => {
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockUsageData);
  });

  it('handler returns usage data with zone indicator', async () => {
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.zone).toBe('green');
  });

  it('handler returns usage data with redThresholds', async () => {
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.redThresholds).toEqual({ daily: 80, weekly: 80, sonnet: 80, extra: 80 });
  });

  it('handler returns properly formatted JSON with indentation', async () => {
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = result.content[0]!.text;
    // Verify it's pretty-printed (contains newlines and indentation)
    expect(text).toContain('\n');
    expect(text).toContain('  ');
    // Verify it matches JSON.stringify with indent=2
    expect(text).toBe(JSON.stringify(mockUsageData, null, 2));
  });

  it('handler returns null usage when no snapshots exist', async () => {
    mockGetLatest.mockReturnValue(null);
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toBeNull();
  });

  it('handler returns isError on ServiceError', async () => {
    mockGetLatest.mockImplementationOnce(() => {
      throw new ServiceError('DB read failure', 'EXTERNAL_ERROR', 502);
    });

    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('DB read failure');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockGetLatest.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler()).rejects.toThrow('unexpected');
  });

  it('handler serializes all percentage fields in output', async () => {
    const zeroUsage = {
      dailyPercent: 0,
      weeklyPercent: 0,
      sonnetPercent: 0,
      extraPercent: 0,
      recordedAt: '2026-03-25T00:00:00Z',
      zone: 'green',
      redThresholds: { daily: 80, weekly: 80, sonnet: 80, extra: 80 },
    };
    mockGetLatest.mockReturnValue(zeroUsage);
    registerGetUsageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler()) as {
      content: Array<{ type: string; text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.dailyPercent).toBe(0);
    expect(parsed.weeklyPercent).toBe(0);
    expect(parsed.sonnetPercent).toBe(0);
    expect(parsed.extraPercent).toBe(0);
  });
});
