/**
 * Task dedup — soft dedup for the TaskCreated hook vs stream-event fallback.
 *
 * CC 2.1.143+ fires a native `TaskCreated` hook with stable `task_id`,
 * `subject`, `description`, `status`, and `owner` fields. The legacy
 * stream-event parser in `team-manager.ts` still extracts the same task
 * data from `TodoWrite` tool_use blocks for older CC versions.
 *
 * During the transitional period (CC 2.1.143+ but both paths active),
 * both signals may fire for the same task. The hook is the canonical
 * source — when it fires first, `recordHookTaskId` is called after a
 * successful upsert, and the stream-event parser checks
 * `wasTaskSeenByHook` and skips the redundant upsert + SSE broadcast.
 *
 * This is a soft dedup, not a hard guarantee:
 *   - Module-level in-memory state, lost on server restart (acceptable —
 *     the database upsert is idempotent via ON CONFLICT DO UPDATE).
 *   - Set-per-team capped at 256 entries; over-cap entries are dropped
 *     oldest-first by recreating the Set (Set preserves insertion order).
 *   - Cleared per team on terminal-state transition via
 *     `clearHookTaskIdsForTeam` to bound memory.
 *
 * Keyed by numeric `teamId` (not worktree name) because the stream-event
 * fallback in `team-manager.ts` only has `teamId` in scope.
 */

/** Max task_ids tracked per team before dropping oldest. */
const MAX_TASK_IDS_PER_TEAM = 256;

/** Per-team set of task_ids seen via the TaskCreated hook. */
const hookSeenTaskIds = new Map<number, Set<string>>();

/**
 * Record that a `task_id` was successfully upserted via the TaskCreated hook.
 * Subsequent stream-event TodoWrite events for the same `(teamId, taskId)`
 * will be skipped by `wasTaskSeenByHook`.
 */
export function recordHookTaskId(teamId: number, taskId: string): void {
  let set = hookSeenTaskIds.get(teamId);
  if (!set) {
    set = new Set<string>();
    hookSeenTaskIds.set(teamId, set);
  }

  set.add(taskId);

  // Drop oldest entries when over cap. Set preserves insertion order, so we
  // recreate it from the last MAX_TASK_IDS_PER_TEAM values.
  if (set.size > MAX_TASK_IDS_PER_TEAM) {
    const values = Array.from(set);
    const trimmed = new Set(values.slice(values.length - MAX_TASK_IDS_PER_TEAM));
    hookSeenTaskIds.set(teamId, trimmed);
  }
}

/**
 * Returns true if `recordHookTaskId` was previously called for this
 * `(teamId, taskId)` pair (and not since cleared).
 */
export function wasTaskSeenByHook(teamId: number, taskId: string): boolean {
  const set = hookSeenTaskIds.get(teamId);
  return set ? set.has(taskId) : false;
}

/**
 * Drop the entire dedup set for a team. Called when the team enters a
 * terminal status so its slot in the map is freed.
 */
export function clearHookTaskIdsForTeam(teamId: number): void {
  hookSeenTaskIds.delete(teamId);
}

/**
 * Reset all dedup state. Intended for use in tests only.
 */
export function resetTaskDedupState(): void {
  hookSeenTaskIds.clear();
}
