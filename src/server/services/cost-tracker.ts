/**
 * Cost Tracking Service — Extracts and records cost data from session events
 *
 * Processes cost information (tokens, USD) from Claude Code session events,
 * inserts cost_entries rows into SQLite, and broadcasts cost_updated SSE events
 * so the dashboard can display real-time spend data per team.
 *
 * Integration note:
 *   This function should be called from the event processing pipeline when a
 *   "session_end" (SessionEnd) event arrives. In the current architecture,
 *   the natural call site is inside processEvent() in event-collector.ts,
 *   after the event has been inserted and before the SSE broadcast — e.g.:
 *
 *     if (eventType === 'SessionEnd') {
 *       processCostFromEvent(teamId, payload.session_id, payload);
 *     }
 *
 *   Since event-collector.ts uses dependency injection (EventCollectorDb),
 *   an alternative is to call processCostFromEvent from the route handler
 *   in the API layer after processEvent() returns successfully.
 */

import { getDatabase } from '../db.js';
import { sseBroker } from './sse-broker.js';

/**
 * Extract cost data from an event payload and persist it.
 *
 * SessionEnd events may contain cost fields at the top level or nested
 * inside a `usage` object. This function checks both locations and
 * gracefully no-ops when no cost data is present.
 *
 * @param teamId    - The database ID of the team
 * @param sessionId - The Claude Code session UUID (may be undefined)
 * @param payload   - The raw event payload object
 */
export function processCostFromEvent(
  teamId: number,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): void {
  // Extract cost data from top-level fields
  const inputTokens = typeof payload.input_tokens === 'number' ? payload.input_tokens : null;
  const outputTokens = typeof payload.output_tokens === 'number' ? payload.output_tokens : null;
  const costUsd = typeof payload.cost_usd === 'number' ? payload.cost_usd : null;

  // Also check nested `usage` structure (some event formats nest cost data)
  const usage = payload.usage as Record<string, unknown> | undefined;
  const finalInputTokens = inputTokens ?? (typeof usage?.input_tokens === 'number' ? usage.input_tokens : null);
  const finalOutputTokens = outputTokens ?? (typeof usage?.output_tokens === 'number' ? usage.output_tokens : null);
  const finalCostUsd = costUsd ?? (typeof usage?.cost_usd === 'number' ? usage.cost_usd : null);

  // If no cost data was found at all, skip silently
  if (finalInputTokens === null && finalOutputTokens === null && finalCostUsd === null) {
    return;
  }

  // Persist the cost entry
  const db = getDatabase();
  db.insertCostEntry({
    teamId,
    sessionId: sessionId || 'unknown',
    inputTokens: finalInputTokens ?? 0,
    outputTokens: finalOutputTokens ?? 0,
    costUsd: finalCostUsd ?? 0,
  });

  // Broadcast updated team cost totals via SSE
  const teamCost = db.getCostByTeam(teamId);
  sseBroker.broadcast('cost_updated', {
    team_id: teamId,
    total_cost_usd: teamCost.totalCostUsd,
    total_input_tokens: teamCost.totalInputTokens,
    total_output_tokens: teamCost.totalOutputTokens,
  }, teamId);
}
