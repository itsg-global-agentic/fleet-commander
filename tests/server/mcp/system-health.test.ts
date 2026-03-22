// =============================================================================
// Fleet Commander — MCP system-health Tool Tests
// =============================================================================
// Smoke tests for the fleet_system_health MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

vi.mock('../../../src/server/services/diagnostics-service.js', () => ({
  getDiagnosticsService: () => ({
    getHealthSummary: () => mockHealthSummary,
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
});
