// =============================================================================
// Fleet Commander — SSE Broker Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to isolate each test from the singleton. We import the module
// and work with a fresh instance by resetting the module cache.
// Since SSEBroker is not exported as a class, we work with the singleton
// via the module, but reset state between tests.

// The broker is a singleton exported from sse-broker.ts. We import it fresh
// for each test suite. To test in isolation we create mock FastifyReply objects.

// ---------------------------------------------------------------------------
// Mock FastifyReply
// ---------------------------------------------------------------------------

interface MockRaw {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

interface MockReply {
  raw: MockRaw;
}

function createMockReply(): MockReply {
  return {
    raw: {
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — we import the broker fresh for the test module
// ---------------------------------------------------------------------------

// Import the singleton
import { sseBroker } from '../../src/server/services/sse-broker.js';

// Since it's a singleton, we need to make sure we clean up between tests
beforeEach(() => {
  sseBroker.stop(); // clears all clients and heartbeat
});

afterEach(() => {
  sseBroker.stop();
});

// =============================================================================
// Client add/remove
// =============================================================================

describe('Client add/remove', () => {
  it('adds a client and returns a unique id', () => {
    const reply = createMockReply();
    const id = sseBroker.addClient(reply as any);

    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(sseBroker.getClientCount()).toBe(1);
  });

  it('adds multiple clients with unique ids', () => {
    const reply1 = createMockReply();
    const reply2 = createMockReply();
    const id1 = sseBroker.addClient(reply1 as any);
    const id2 = sseBroker.addClient(reply2 as any);

    expect(id1).not.toBe(id2);
    expect(sseBroker.getClientCount()).toBe(2);
  });

  it('removes a client by id', () => {
    const reply = createMockReply();
    const id = sseBroker.addClient(reply as any);

    expect(sseBroker.getClientCount()).toBe(1);

    sseBroker.removeClient(id);
    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('removing a nonexistent client is a no-op', () => {
    expect(() => sseBroker.removeClient('nonexistent')).not.toThrow();
    expect(sseBroker.getClientCount()).toBe(0);
  });
});

// =============================================================================
// Broadcast to all clients
// =============================================================================

describe('Broadcast to all clients', () => {
  it('broadcasts to all connected clients', () => {
    const reply1 = createMockReply();
    const reply2 = createMockReply();

    sseBroker.addClient(reply1 as any);
    sseBroker.addClient(reply2 as any);

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 42 });

    expect(reply1.raw.write).toHaveBeenCalledTimes(1);
    expect(reply2.raw.write).toHaveBeenCalledTimes(1);
  });

  it('sends correct SSE frame format', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);

    sseBroker.broadcast('team_event', { team_id: 1 });

    const writtenData = reply.raw.write.mock.calls[0][0] as string;
    expect(writtenData).toContain('event: team_event\n');
    expect(writtenData).toContain('data: ');
    expect(writtenData).toContain('"type":"team_event"');
    expect(writtenData).toContain('"team_id":1');
    expect(writtenData.endsWith('\n\n')).toBe(true);
  });

  it('enriches data with type field', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);

    sseBroker.broadcast('heartbeat', { timestamp: '2025-01-01T00:00:00Z' });

    const writtenData = reply.raw.write.mock.calls[0][0] as string;
    const dataLine = writtenData.split('\n').find((l: string) => l.startsWith('data: '));
    expect(dataLine).toBeTruthy();
    const parsed = JSON.parse(dataLine!.replace('data: ', ''));
    expect(parsed.type).toBe('heartbeat');
    expect(parsed.timestamp).toBe('2025-01-01T00:00:00Z');
  });

  it('does not error when broadcasting to zero clients', () => {
    expect(() => {
      sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });
    }).not.toThrow();
  });

  it('removes client on write error', () => {
    const reply = createMockReply();
    reply.raw.write.mockImplementation(() => {
      throw new Error('Connection reset');
    });

    sseBroker.addClient(reply as any);
    expect(sseBroker.getClientCount()).toBe(1);

    // Broadcast should not throw, but should remove the broken client
    sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });
    expect(sseBroker.getClientCount()).toBe(0);
  });
});

// =============================================================================
// Filtered broadcast (team filter)
// =============================================================================

describe('Filtered broadcast (team filter)', () => {
  it('sends to client subscribed to matching team', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any, [1, 2]);

    sseBroker.broadcast('team_event', { team_id: 1 }, 1);

    expect(reply.raw.write).toHaveBeenCalledTimes(1);
  });

  it('does NOT send to client that is NOT subscribed to the team', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any, [3, 4]);

    sseBroker.broadcast('team_event', { team_id: 1 }, 1);

    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it('sends to client with no filter (receives all teams)', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any); // no filter = all teams

    sseBroker.broadcast('team_event', { team_id: 1 }, 1);

    expect(reply.raw.write).toHaveBeenCalledTimes(1);
  });

  it('sends to all clients when no teamId specified', () => {
    const reply1 = createMockReply();
    const reply2 = createMockReply();

    sseBroker.addClient(reply1 as any, [1]); // subscribes only to team 1
    sseBroker.addClient(reply2 as any, [2]); // subscribes only to team 2

    // Broadcast without teamId — should go to everyone
    sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });

    expect(reply1.raw.write).toHaveBeenCalledTimes(1);
    expect(reply2.raw.write).toHaveBeenCalledTimes(1);
  });

  it('correctly filters mixed subscribers', () => {
    const replyAll = createMockReply();    // no filter
    const replyTeam1 = createMockReply();  // [1]
    const replyTeam2 = createMockReply();  // [2]
    const replyBoth = createMockReply();   // [1, 2]

    sseBroker.addClient(replyAll as any);
    sseBroker.addClient(replyTeam1 as any, [1]);
    sseBroker.addClient(replyTeam2 as any, [2]);
    sseBroker.addClient(replyBoth as any, [1, 2]);

    sseBroker.broadcast('team_event', { team_id: 1 }, 1);

    expect(replyAll.raw.write).toHaveBeenCalledTimes(1);    // no filter -> receives
    expect(replyTeam1.raw.write).toHaveBeenCalledTimes(1);  // [1] -> receives
    expect(replyTeam2.raw.write).not.toHaveBeenCalled();    // [2] -> does not receive
    expect(replyBoth.raw.write).toHaveBeenCalledTimes(1);   // [1,2] -> receives
  });

  it('treats empty filter array as no filter', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any, []); // empty = all teams

    sseBroker.broadcast('team_event', { team_id: 999 }, 999);

    expect(reply.raw.write).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Heartbeat timer start/stop
// =============================================================================

describe('Heartbeat timer', () => {
  it('starts heartbeat timer without error', () => {
    expect(() => sseBroker.start(1000)).not.toThrow();
    sseBroker.stop();
  });

  it('calling start twice is idempotent', () => {
    sseBroker.start(1000);
    sseBroker.start(1000); // should be a no-op
    sseBroker.stop();
  });

  it('stop clears heartbeat and closes clients', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);
    sseBroker.start(1000);

    expect(sseBroker.getClientCount()).toBe(1);

    sseBroker.stop();

    expect(sseBroker.getClientCount()).toBe(0);
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('sends heartbeat events at interval', async () => {
    vi.useFakeTimers();
    try {
      const reply = createMockReply();
      sseBroker.addClient(reply as any);

      sseBroker.start(100); // 100ms interval for fast testing

      // Advance time by 100ms — should trigger one heartbeat
      vi.advanceTimersByTime(100);

      expect(reply.raw.write).toHaveBeenCalledTimes(1);
      const writtenData = reply.raw.write.mock.calls[0][0] as string;
      expect(writtenData).toContain('event: heartbeat');

      // Advance by another 100ms — should trigger another heartbeat
      vi.advanceTimersByTime(100);
      expect(reply.raw.write).toHaveBeenCalledTimes(2);
    } finally {
      sseBroker.stop();
      vi.useRealTimers();
    }
  });

  it('stop is safe when no heartbeat running', () => {
    expect(() => sseBroker.stop()).not.toThrow();
  });
});

// =============================================================================
// Client count
// =============================================================================

describe('Client count', () => {
  it('returns 0 when no clients', () => {
    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('tracks correct count after adds and removes', () => {
    const r1 = createMockReply();
    const r2 = createMockReply();
    const r3 = createMockReply();

    const id1 = sseBroker.addClient(r1 as any);
    const id2 = sseBroker.addClient(r2 as any);
    sseBroker.addClient(r3 as any);

    expect(sseBroker.getClientCount()).toBe(3);

    sseBroker.removeClient(id1);
    expect(sseBroker.getClientCount()).toBe(2);

    sseBroker.removeClient(id2);
    expect(sseBroker.getClientCount()).toBe(1);
  });

  it('resets to 0 after stop', () => {
    const r1 = createMockReply();
    sseBroker.addClient(r1 as any);
    sseBroker.addClient(createMockReply() as any);

    expect(sseBroker.getClientCount()).toBe(2);

    sseBroker.stop();
    expect(sseBroker.getClientCount()).toBe(0);
  });
});
