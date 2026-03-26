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

import { EventEmitter } from 'events';

interface MockRaw extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockReply {
  raw: MockRaw;
}

function createMockReply(): MockReply {
  const emitter = new EventEmitter();
  const raw = Object.assign(emitter, {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroy: vi.fn(),
  }) as MockRaw;
  return { raw };
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

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 1 });

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

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 1 }, 1);

    expect(reply.raw.write).toHaveBeenCalledTimes(1);
  });

  it('does NOT send to client that is NOT subscribed to the team', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any, [3, 4]);

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 1 }, 1);

    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it('sends to client with no filter (receives all teams)', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any); // no filter = all teams

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 1 }, 1);

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

    sseBroker.broadcast('team_event', { team_id: 1, event_type: 'ToolUse', event_id: 1 }, 1);

    expect(replyAll.raw.write).toHaveBeenCalledTimes(1);    // no filter -> receives
    expect(replyTeam1.raw.write).toHaveBeenCalledTimes(1);  // [1] -> receives
    expect(replyTeam2.raw.write).not.toHaveBeenCalled();    // [2] -> does not receive
    expect(replyBoth.raw.write).toHaveBeenCalledTimes(1);   // [1,2] -> receives
  });

  it('treats empty filter array as no filter', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any, []); // empty = all teams

    sseBroker.broadcast('team_event', { team_id: 999, event_type: 'ToolUse', event_id: 1 }, 999);

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
    expect(reply.raw.destroy).toHaveBeenCalled();
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

// =============================================================================
// Client lifecycle and error handling
// =============================================================================

describe('Client lifecycle and error handling', () => {
  it('registers close and error listeners on reply.raw during addClient', () => {
    const reply = createMockReply();
    const onSpy = vi.spyOn(reply.raw, 'on');

    sseBroker.addClient(reply as any);

    expect(onSpy).toHaveBeenCalledWith('close', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('removes client when reply.raw emits close', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);

    expect(sseBroker.getClientCount()).toBe(1);

    reply.raw.emit('close');

    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('removes client when reply.raw emits error', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);

    expect(sseBroker.getClientCount()).toBe(1);

    reply.raw.emit('error', new Error('Connection reset'));

    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('removes listeners from reply.raw during removeClient', () => {
    const reply = createMockReply();
    const id = sseBroker.addClient(reply as any);

    // Before removal, listeners should be registered
    expect(reply.raw.listenerCount('close')).toBe(1);
    expect(reply.raw.listenerCount('error')).toBe(1);

    sseBroker.removeClient(id);

    expect(reply.raw.listenerCount('close')).toBe(0);
    expect(reply.raw.listenerCount('error')).toBe(0);
  });

  it('double removal is idempotent and does not throw', () => {
    const reply = createMockReply();
    const id = sseBroker.addClient(reply as any);

    sseBroker.removeClient(id);
    expect(sseBroker.getClientCount()).toBe(0);

    // Second removal should be a no-op
    expect(() => sseBroker.removeClient(id)).not.toThrow();
    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('handles both close and error firing for the same client', () => {
    const reply = createMockReply();
    sseBroker.addClient(reply as any);

    expect(sseBroker.getClientCount()).toBe(1);

    reply.raw.emit('close');
    expect(sseBroker.getClientCount()).toBe(0);

    // After removeClient, our cleanup listener is gone. In a real
    // http.ServerResponse (a Writable), error events are handled internally.
    // In our bare EventEmitter mock, unhandled error events throw by default.
    // Add a no-op listener to mimic real ServerResponse behavior.
    reply.raw.on('error', () => { /* no-op — mimics Writable internals */ });
    expect(() => reply.raw.emit('error', new Error('late error'))).not.toThrow();
    expect(sseBroker.getClientCount()).toBe(0);
  });

  it('stop removes listeners before destroying sockets', () => {
    const reply = createMockReply();
    const removeListenerSpy = vi.spyOn(reply.raw, 'removeListener');

    sseBroker.addClient(reply as any);
    sseBroker.stop();

    expect(removeListenerSpy).toHaveBeenCalledWith('close', expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));
    expect(reply.raw.destroy).toHaveBeenCalled();
  });

  it('broadcast uses removeClient (not direct delete) on write error', () => {
    const reply = createMockReply();
    reply.raw.write.mockImplementation(() => {
      throw new Error('Connection reset');
    });

    sseBroker.addClient(reply as any);
    expect(sseBroker.getClientCount()).toBe(1);

    sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });
    expect(sseBroker.getClientCount()).toBe(0);

    // Listeners should have been cleaned up via removeClient
    expect(reply.raw.listenerCount('close')).toBe(0);
    expect(reply.raw.listenerCount('error')).toBe(0);
  });
});

// =============================================================================
// Back-pressure eviction
// =============================================================================

describe('Back-pressure eviction', () => {
  it('starts eviction timer when write returns false', () => {
    vi.useFakeTimers();
    try {
      const reply = createMockReply();
      reply.raw.write.mockReturnValue(false); // simulate back-pressure

      sseBroker.addClient(reply as any);
      sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });

      // Client should still be present (timer not yet fired)
      expect(sseBroker.getClientCount()).toBe(1);

      // Advance past the 30s eviction timeout
      vi.advanceTimersByTime(30_000);

      // Client should now be evicted
      expect(sseBroker.getClientCount()).toBe(0);
      expect(reply.raw.destroy).toHaveBeenCalled();
    } finally {
      sseBroker.stop();
      vi.useRealTimers();
    }
  });

  it('cancels eviction timer when drain fires', () => {
    vi.useFakeTimers();
    try {
      const reply = createMockReply();
      reply.raw.write.mockReturnValue(false);

      sseBroker.addClient(reply as any);
      sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });

      expect(sseBroker.getClientCount()).toBe(1);

      // Simulate buffer drain before timeout
      reply.raw.emit('drain');

      // Advance past the 30s eviction timeout
      vi.advanceTimersByTime(30_000);

      // Client should still be present (drain cancelled eviction)
      expect(sseBroker.getClientCount()).toBe(1);
      expect(reply.raw.destroy).not.toHaveBeenCalled();
    } finally {
      sseBroker.stop();
      vi.useRealTimers();
    }
  });

  it('does not start duplicate timers on repeated back-pressure', () => {
    vi.useFakeTimers();
    try {
      const reply = createMockReply();
      reply.raw.write.mockReturnValue(false);

      sseBroker.addClient(reply as any);

      // Two broadcasts, both with back-pressure
      sseBroker.broadcast('heartbeat', { timestamp: '2025-01-01T00:00:00Z' });
      sseBroker.broadcast('heartbeat', { timestamp: '2025-01-01T00:00:01Z' });

      // Client should still be present
      expect(sseBroker.getClientCount()).toBe(1);

      // Only one drain listener should be registered (from the first back-pressure)
      expect(reply.raw.listenerCount('drain')).toBe(1);

      // Advance past eviction timeout
      vi.advanceTimersByTime(30_000);
      expect(sseBroker.getClientCount()).toBe(0);
    } finally {
      sseBroker.stop();
      vi.useRealTimers();
    }
  });

  it('stop clears back-pressure timers', () => {
    vi.useFakeTimers();
    try {
      const reply = createMockReply();
      reply.raw.write.mockReturnValue(false);

      sseBroker.addClient(reply as any);
      sseBroker.broadcast('heartbeat', { timestamp: new Date().toISOString() });

      // Stop should clear the timer and remove the client
      sseBroker.stop();
      expect(sseBroker.getClientCount()).toBe(0);

      // Advancing time should not cause errors
      vi.advanceTimersByTime(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
