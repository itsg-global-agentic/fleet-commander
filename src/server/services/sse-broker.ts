import { FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// SSE Event Types
// ---------------------------------------------------------------------------

/** All SSE event types supported by the broker */
export type SSEEventType =
  | 'team_status_changed'
  | 'team_event'
  | 'pr_updated'
  | 'team_launched'
  | 'team_stopped'
  | 'cost_updated'
  | 'heartbeat';

/** Payload shapes for each event type */
export interface SSEEventPayloads {
  team_status_changed: { team_id: number; status: string; previous_status: string };
  team_event: { team_id: number; event_type: string; event_id: number };
  pr_updated: { pr_number: number; team_id: number; ci_status: string; merge_status: string };
  team_launched: { team_id: number; issue_number: number };
  team_stopped: { team_id: number };
  cost_updated: { team_id: number; total_cost_usd: number };
  heartbeat: { timestamp: string };
}

// ---------------------------------------------------------------------------
// SSE Client
// ---------------------------------------------------------------------------

interface SSEClient {
  id: string;
  reply: FastifyReply;
  teamFilter: number[] | null; // null = all teams
}

// ---------------------------------------------------------------------------
// SSE Broker
// ---------------------------------------------------------------------------

class SSEBroker {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Start the heartbeat timer. Sends a heartbeat event to all connected
   * clients at the given interval (default 30 000 ms).
   */
  start(intervalMs: number = 30_000): void {
    if (this.heartbeatInterval) {
      return; // already running
    }

    this.heartbeatInterval = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: new Date().toISOString() });
    }, intervalMs);

    // Allow the Node.js process to exit even if the interval is active
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * Stop the heartbeat timer and close every connected client.
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    for (const [id, client] of this.clients) {
      try {
        client.reply.raw.end();
      } catch {
        // Client may already be disconnected — ignore
      }
      this.clients.delete(id);
    }
  }

  /**
   * Register a new SSE client. Returns the generated client id.
   *
   * @param reply   The Fastify reply object (must NOT have been sent yet)
   * @param teamFilter  Optional array of team IDs to subscribe to.
   *                    When omitted or empty, the client receives all events.
   */
  addClient(reply: FastifyReply, teamFilter?: number[]): string {
    const id = randomUUID();
    const client: SSEClient = {
      id,
      reply,
      teamFilter: teamFilter && teamFilter.length > 0 ? teamFilter : null,
    };
    this.clients.set(id, client);
    return id;
  }

  /**
   * Remove a client by id (e.g. on disconnect).
   */
  removeClient(id: string): void {
    this.clients.delete(id);
  }

  /**
   * Broadcast an SSE event to all connected (and matching) clients.
   *
   * @param eventType  The SSE event name
   * @param data       Payload to JSON-serialize into the `data:` field
   * @param teamId     Optional team id — when provided, only clients that
   *                   either have no filter OR include this team will receive
   *                   the event.
   */
  broadcast(eventType: string, data: unknown, teamId?: number): void {
    // Include the event type in the data payload so clients using
    // EventSource.onmessage (unnamed events) can also determine the type.
    const enrichedData = typeof data === 'object' && data !== null
      ? { type: eventType, ...data }
      : data;
    const frame = `event: ${eventType}\ndata: ${JSON.stringify(enrichedData)}\n\n`;

    for (const [id, client] of this.clients) {
      // If the event is scoped to a team, check the client's filter
      if (teamId !== undefined && client.teamFilter !== null) {
        if (!client.teamFilter.includes(teamId)) {
          continue;
        }
      }

      try {
        const ok = client.reply.raw.write(frame);
        if (ok === false) {
          // Back-pressure — stream buffer full; unlikely for SSE but handle it
          // We keep the client; the kernel buffer will drain eventually.
        }
      } catch {
        // Write failed — client is gone. Clean up.
        this.clients.delete(id);
      }
    }
  }

  /**
   * Return the number of currently connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

// Singleton instance — importable from anywhere in the server
export const sseBroker = new SSEBroker();
