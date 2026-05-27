// =============================================================================
// Fleet Commander — Task Dedup Service Unit Tests (issue #753)
// =============================================================================
// Covers the 8 documented invariants of `src/server/services/task-dedup.ts`:
// per-team isolation, idempotent record, FIFO cap eviction at 256,
// per-team clear, and global reset.
//
// Pure unit tests — no network, no database, no filesystem, no timers.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHookTaskId,
  wasTaskSeenByHook,
  clearHookTaskIdsForTeam,
  resetTaskDedupState,
} from '../../../src/server/services/task-dedup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mirrors MAX_TASK_IDS_PER_TEAM in src/server/services/task-dedup.ts.
// Keep in sync if the production cap changes.
const MAX = 256;

// ---------------------------------------------------------------------------
// Global reset between every test — module-level Map would otherwise leak.
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTaskDedupState();
});

// ---------------------------------------------------------------------------
// Invariant 1-3: basic record / lookup
// ---------------------------------------------------------------------------

describe('task-dedup — basic record / lookup', () => {
  it('should return false for a task that was never recorded', () => {
    expect(wasTaskSeenByHook(1, 'task-a')).toBe(false);
  });

  it('should return true after recordHookTaskId is called', () => {
    recordHookTaskId(1, 'task-a');
    expect(wasTaskSeenByHook(1, 'task-a')).toBe(true);
  });

  it('should be idempotent when the same (teamId, taskId) is recorded twice', () => {
    recordHookTaskId(1, 'task-a');
    recordHookTaskId(1, 'task-a');
    expect(wasTaskSeenByHook(1, 'task-a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: per-team isolation
// ---------------------------------------------------------------------------

describe('task-dedup — per-team isolation', () => {
  it('should not leak task ids across different teams', () => {
    recordHookTaskId(1, 'task-a');
    recordHookTaskId(2, 'task-b');

    expect(wasTaskSeenByHook(1, 'task-a')).toBe(true);
    expect(wasTaskSeenByHook(1, 'task-b')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-a')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5: clearHookTaskIdsForTeam
// ---------------------------------------------------------------------------

describe('task-dedup — clearHookTaskIdsForTeam', () => {
  it('should drop only the targeted team and leave other teams intact', () => {
    recordHookTaskId(1, 'task-a');
    recordHookTaskId(1, 'task-b');
    recordHookTaskId(2, 'task-c');

    clearHookTaskIdsForTeam(1);

    expect(wasTaskSeenByHook(1, 'task-a')).toBe(false);
    expect(wasTaskSeenByHook(1, 'task-b')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-c')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6-7: FIFO cap eviction at MAX_TASK_IDS_PER_TEAM
// ---------------------------------------------------------------------------

describe('task-dedup — FIFO cap eviction at MAX_TASK_IDS_PER_TEAM', () => {
  it('should evict the oldest entry when exceeding the cap by one', () => {
    // Insert MAX+1 distinct task ids; cap eviction triggers on > MAX,
    // dropping the first-inserted entry (task-0).
    for (let i = 0; i <= MAX; i++) {
      recordHookTaskId(1, `task-${i}`);
    }

    expect(wasTaskSeenByHook(1, 'task-0')).toBe(false);
    expect(wasTaskSeenByHook(1, 'task-1')).toBe(true);
    expect(wasTaskSeenByHook(1, `task-${MAX}`)).toBe(true);
  });

  it('should keep all surviving entries (task-1..task-MAX) after eviction', () => {
    for (let i = 0; i <= MAX; i++) {
      recordHookTaskId(1, `task-${i}`);
    }

    for (let i = 1; i <= MAX; i++) {
      expect(wasTaskSeenByHook(1, `task-${i}`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant 8: resetTaskDedupState
// ---------------------------------------------------------------------------

describe('task-dedup — resetTaskDedupState', () => {
  it('should clear state for every team after a global reset', () => {
    recordHookTaskId(1, 'task-a');
    recordHookTaskId(2, 'task-b');
    recordHookTaskId(3, 'task-c');

    resetTaskDedupState();

    expect(wasTaskSeenByHook(1, 'task-a')).toBe(false);
    expect(wasTaskSeenByHook(2, 'task-b')).toBe(false);
    expect(wasTaskSeenByHook(3, 'task-c')).toBe(false);
  });
});
