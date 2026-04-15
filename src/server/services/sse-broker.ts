import { FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import type { UsageZone } from '../../shared/types.js';
import type { IssueRelations } from '../../shared/issue-provider.js';

// ---------------------------------------------------------------------------
// Stream Event — JSON objects from Claude Code's --output-format stream-json
// ---------------------------------------------------------------------------

export interface StreamEvent {
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SSE Event Types
// ---------------------------------------------------------------------------

/** All SSE event types supported by the broker */
export type SSEEventType =
  | 'team_status_changed'
  | 'team_event'
  | 'team_output'
  | 'pr_updated'
  | 'team_launched'
  | 'team_stopped'
  | 'usage_updated'
  | 'project_added'
  | 'project_updated'
  | 'project_removed'
  | 'project_cleanup'
  | 'snapshot'
  | 'heartbeat'
  | 'dependency_resolved'
  | 'team_thinking_start'
  | 'team_thinking_stop'
  | 'task_updated'
  | 'relations_updated'
  | 'team_handoff_file'
  | 'team_warning'
  | 'usage_override_changed';

/** Payload shapes for each event type */
export interface SSEEventPayloads {
  team_status_changed: { team_id: number; status: string; previous_status: string; phase?: string; previous_phase?: string; reason?: string; idle_minutes?: number; retry_count?: number; tokens?: { input: number; output: number; cacheCreation: number; cacheRead: number; costUsd: number } };
  team_event: { team_id: number; event_type: string; event_id: number; session_id?: string | null; agent_name?: string | null; tool_name?: string | null; timestamp?: string };
  team_output: { team_id: number; event: StreamEvent };
  pr_updated: { pr_number: number; team_id: number; state?: string; ci_status?: string; merge_status?: string; auto_merge?: boolean; ci_fail_count?: number; action?: string };
  team_launched: { team_id: number; issue_number: number; issue_key?: string; project_id?: number | null };
  team_stopped: { team_id: number };
  usage_updated: { daily_percent: number; weekly_percent: number; sonnet_percent: number; extra_percent: number; zone: UsageZone; overrideActive: boolean; hardPaused: boolean };
  project_added: { project_id: number; name: string; repo_path: string };
  project_updated: { project_id: number; name?: string; status?: string; reason?: string; issue_number?: number };
  project_removed: { project_id: number };
  project_cleanup: { project_id: number; removed_count: number; failed_count: number };
  snapshot: { teams: unknown[] };
  heartbeat: { timestamp: string };
  dependency_resolved: { issue_number: number; project_id: number; previously_blocked_by: number[] };
  team_thinking_start: { team_id: number };
  team_thinking_stop: { team_id: number; duration_ms: number };
  task_updated: { team_id: number; task_id: string; subject: string; status: string; owner: string };
  relations_updated: { project_id: number; issue_key: string; relations: IssueRelations };
  team_handoff_file: { team_id: number; file_type: string; agent_name: string | null; captured_at: string };
  team_warning: { team_id: number; warning_type: string; message: string; details?: Record<string, unknown> };
  usage_override_changed: { overrideActive: boolean; hardPaused: boolean };
}

// ---------------------------------------------------------------------------
// SSE Client
// ---------------------------------------------------------------------------

interface SSEClient {
  id: string;
  reply: FastifyReply;
  teamFilter: Set<number> | null; // null = all teams
  backPressureTimer: NodeJS.Timeout | null;
  cleanupBound: (() => void) | null;
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

    // Close all client connections — clear timers, remove listeners, then
    // destroy socket for immediate teardown.
    for (const [id, client] of this.clients) {
      if (client.backPressureTimer) {
        clearTimeout(client.backPressureTimer);
        client.backPressureTimer = null;
      }
      if (client.cleanupBound) {
        try {
          client.reply.raw.removeListener('close', client.cleanupBound);
          client.reply.raw.removeListener('error', client.cleanupBound);
        } catch {
          // Client may already be disconnected — ignore
        }
        client.cleanupBound = null;
      }
      try {
        client.reply.raw.destroy();
      } catch {
        // Client may already be disconnected — ignore
      }
      this.clients.delete(id);
    }
  }

  /**
   * Register a new SSE client. Returns the generated client id.
   *
   * Registers `close` and `error` listeners on `reply.raw` (the underlying
   * `http.ServerResponse` writable stream) so the client is automatically
   * removed when the connection drops, regardless of how it was lost.
   *
   * @param reply   The Fastify reply object (must NOT have been sent yet)
   * @param teamFilter  Optional array of team IDs to subscribe to.
   *                    When omitted or empty, the client receives all events.
   */
  addClient(reply: FastifyReply, teamFilter?: number[]): string {
    const id = randomUUID();

    const cleanup = (): void => {
      this.removeClient(id);
    };

    const client: SSEClient = {
      id,
      reply,
      teamFilter: teamFilter && teamFilter.length > 0 ? new Set(teamFilter) : null,
      backPressureTimer: null,
      cleanupBound: cleanup,
    };
    this.clients.set(id, client);

    // Listen on the response writable stream for disconnect/error
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    return id;
  }

  /**
   * Remove a client by id (e.g. on disconnect).
   *
   * Idempotent — safe to call multiple times for the same id (e.g. when
   * both `close` and `error` fire for the same connection). Clears any
   * active back-pressure eviction timer and removes event listeners from
   * `reply.raw` to prevent dangling references.
   */
  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;

    if (client.backPressureTimer) {
      clearTimeout(client.backPressureTimer);
      client.backPressureTimer = null;
    }

    if (client.cleanupBound) {
      try {
        client.reply.raw.removeListener('close', client.cleanupBound);
        client.reply.raw.removeListener('error', client.cleanupBound);
      } catch {
        // Socket may already be destroyed — ignore
      }
      client.cleanupBound = null;
    }

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
  broadcast<T extends SSEEventType>(eventType: T, data: SSEEventPayloads[T], teamId?: number): void {
    // Include the event type in the data payload so clients using
    // EventSource.onmessage (unnamed events) can also determine the type.
    const enrichedData = typeof data === 'object' && data !== null
      ? { type: eventType, ...data }
      : data;
    const frame = `event: ${eventType}\ndata: ${JSON.stringify(enrichedData)}\n\n`;

    for (const [id, client] of this.clients) {
      // If the event is scoped to a team, check the client's filter
      if (teamId !== undefined && client.teamFilter !== null) {
        if (!client.teamFilter.has(teamId)) {
          continue;
        }
      }

      try {
        const ok = client.reply.raw.write(frame);
        if (ok === false && !client.backPressureTimer) {
          // Back-pressure — stream buffer full. Start a 30s eviction timer.
          // If the buffer drains before timeout, cancel eviction.
          const drainHandler = (): void => {
            if (client.backPressureTimer) {
              clearTimeout(client.backPressureTimer);
              client.backPressureTimer = null;
            }
          };
          client.reply.raw.once('drain', drainHandler);

          client.backPressureTimer = setTimeout(() => {
            client.backPressureTimer = null;
            try {
              client.reply.raw.removeListener('drain', drainHandler);
            } catch {
              // Socket may already be destroyed — ignore
            }
            try {
              client.reply.raw.destroy();
            } catch {
              // Socket may already be destroyed — ignore
            }
            this.removeClient(id);
          }, 30_000);

          // Allow the Node.js process to exit even if the timer is active
          if (client.backPressureTimer.unref) {
            client.backPressureTimer.unref();
          }
        }
      } catch {
        // Write failed — client is gone. Clean up.
        this.removeClient(id);
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
