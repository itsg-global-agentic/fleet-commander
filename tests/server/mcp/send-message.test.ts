// =============================================================================
// Fleet Commander — MCP send-message Tool Tests
// =============================================================================
// Smoke tests for the fleet_send_message MCP tool registration and handler.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceError } from '../../../src/server/services/service-error.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockSendResult = {
  command: { id: 1, teamId: 42, message: 'Hello agent', deliveredAt: null },
  delivered: true,
};

const mockSendMessage = vi.fn().mockReturnValue(mockSendResult);

vi.mock('../../../src/server/services/team-service.js', () => ({
  getTeamService: () => ({
    sendMessage: mockSendMessage,
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

const { registerSendMessageTool } = await import(
  '../../../src/server/mcp/tools/send-message.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet_send_message MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
  });

  it('registers with the correct tool name', () => {
    registerSendMessageTool(mockMcpServer as any);

    expect(mockMcpServer.tool).toHaveBeenCalledOnce();
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]!.name).toBe('fleet_send_message');
  });

  it('registers with a description', () => {
    registerSendMessageTool(mockMcpServer as any);

    expect(registeredTools[0]!.description).toBeTruthy();
    expect(typeof registeredTools[0]!.description).toBe('string');
  });

  it('handler returns valid JSON result', async () => {
    registerSendMessageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 42, message: 'Hello agent' })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(mockSendResult);
  });

  it('handler passes teamId and message to sendMessage', async () => {
    registerSendMessageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await handler({ teamId: 42, message: 'Hello agent' });

    expect(mockSendMessage).toHaveBeenCalledWith(42, 'Hello agent');
  });

  it('handler returns isError on ServiceError', async () => {
    mockSendMessage.mockImplementationOnce(() => {
      throw new ServiceError('message is required and must be a non-empty string', 'VALIDATION', 400);
    });

    registerSendMessageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 42, message: '' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('message is required');
  });

  it('handler returns isError on not-found ServiceError', async () => {
    mockSendMessage.mockImplementationOnce(() => {
      throw new ServiceError('Team not found', 'NOT_FOUND', 404);
    });

    registerSendMessageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    const result = (await handler({ teamId: 999, message: 'hello' })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Team not found');
  });

  it('handler re-throws non-ServiceError exceptions', async () => {
    mockSendMessage.mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    registerSendMessageTool(mockMcpServer as any);

    const handler = registeredTools[0]!.handler;
    await expect(handler({ teamId: 42, message: 'hello' })).rejects.toThrow('unexpected');
  });
});
