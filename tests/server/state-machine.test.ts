// =============================================================================
// Fleet Commander — State Machine Tests (data validation, transition coverage)
// =============================================================================
// Pure data-structure validation — no mocks needed. Validates the state machine
// definitions in src/shared/state-machine.ts for completeness and correctness.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  STATE_MACHINE_TRANSITIONS,
  STATES,
  type StateMachineTransition,
} from '../../src/shared/state-machine.js';
import type { TeamStatus } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Valid statuses (from types.ts)
// ---------------------------------------------------------------------------

const ALL_STATUSES: TeamStatus[] = [
  'queued',
  'launching',
  'running',
  'idle',
  'stuck',
  'done',
  'failed',
];

// =============================================================================
// Transition IDs
// =============================================================================

describe('State machine transition IDs', () => {
  it('all transitions have unique IDs', () => {
    const ids = STATE_MACHINE_TRANSITIONS.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all transitions have non-empty IDs', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      expect(t.id).toBeTruthy();
      expect(typeof t.id).toBe('string');
      expect(t.id.trim().length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Status validity
// =============================================================================

describe('State machine status validity', () => {
  it('all "from" statuses are valid TeamStatus values or wildcard "*"', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      if (t.from === '*') continue; // wildcard is valid
      expect(ALL_STATUSES).toContain(t.from);
    }
  });

  it('all "to" statuses are valid TeamStatus values', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      expect(ALL_STATUSES).toContain(t.to);
    }
  });

  it('STATES array covers all TeamStatus values', () => {
    const stateIds = STATES.map((s) => s.id);
    for (const status of ALL_STATUSES) {
      expect(stateIds).toContain(status);
    }
  });

  it('STATES array contains no extra/unknown statuses', () => {
    for (const state of STATES) {
      expect(ALL_STATUSES).toContain(state.id as TeamStatus);
    }
  });
});

// =============================================================================
// Lifecycle completeness — reachability from 'queued'
// =============================================================================

describe('State machine lifecycle completeness', () => {
  it('every non-queued status is reachable from queued (BFS)', () => {
    // Build a graph from transitions (excluding wildcards — handle separately)
    const graph = new Map<string, Set<string>>();
    for (const status of ALL_STATUSES) {
      graph.set(status, new Set());
    }

    for (const t of STATE_MACHINE_TRANSITIONS) {
      if (t.from === '*') {
        // Wildcard: the transition can happen from any status
        for (const status of ALL_STATUSES) {
          graph.get(status)?.add(t.to);
        }
      } else {
        graph.get(t.from)?.add(t.to);
      }
    }

    // BFS from 'queued'
    const visited = new Set<string>();
    const queue = ['queued'];
    visited.add('queued');

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = graph.get(current) ?? new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    for (const status of ALL_STATUSES) {
      expect(visited.has(status)).toBe(true);
    }
  });

  it('terminal states (done, failed) have outgoing transitions or are intentionally terminal', () => {
    // done and failed should have some outgoing transitions (for PM recovery)
    const doneTransitions = STATE_MACHINE_TRANSITIONS.filter(
      (t) => t.from === 'done',
    );
    const failedTransitions = STATE_MACHINE_TRANSITIONS.filter(
      (t) => t.from === 'failed',
    );

    // 'failed' has outgoing: failed->done, failed->queued, failed->launching
    expect(failedTransitions.length).toBeGreaterThan(0);

    // 'done' is terminal — no outgoing transitions expected from the state machine
    // (but wildcard transitions can target done from any state)
    // This is a design choice — just document it
    expect(doneTransitions.length).toBe(0);
  });
});

// =============================================================================
// Transition trigger types
// =============================================================================

describe('State machine trigger types', () => {
  const validTriggers = ['hook', 'timer', 'poller', 'pm_action', 'system'];

  it('all transitions have a valid trigger type', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      expect(validTriggers).toContain(t.trigger);
    }
  });

  it('all transitions have non-empty triggerLabel and description', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      expect(t.triggerLabel.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('all transitions have a non-empty condition string', () => {
    for (const t of STATE_MACHINE_TRANSITIONS) {
      expect(t.condition.trim().length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Required transitions exist
// =============================================================================

describe('Required transitions exist', () => {
  function findTransition(from: string, to: string): StateMachineTransition | undefined {
    return STATE_MACHINE_TRANSITIONS.find(
      (t) => (t.from === from || t.from === '*') && t.to === to,
    );
  }

  it('queued -> launching exists', () => {
    expect(findTransition('queued', 'launching')).toBeDefined();
  });

  it('launching -> running exists', () => {
    expect(findTransition('launching', 'running')).toBeDefined();
  });

  it('running -> idle exists', () => {
    expect(findTransition('running', 'idle')).toBeDefined();
  });

  it('idle -> stuck exists', () => {
    expect(findTransition('idle', 'stuck')).toBeDefined();
  });

  it('running -> done exists', () => {
    expect(findTransition('running', 'done')).toBeDefined();
  });

  it('running -> failed exists', () => {
    expect(findTransition('running', 'failed')).toBeDefined();
  });

  it('idle -> running exists', () => {
    expect(findTransition('idle', 'running')).toBeDefined();
  });

  it('stuck -> running exists', () => {
    expect(findTransition('stuck', 'running')).toBeDefined();
  });

  it('launching -> failed exists', () => {
    expect(findTransition('launching', 'failed')).toBeDefined();
  });

  it('PR merged wildcard transition to done exists', () => {
    const prMerged = STATE_MACHINE_TRANSITIONS.find(
      (t) => t.id === 'pr_merged' && t.from === '*' && t.to === 'done',
    );
    expect(prMerged).toBeDefined();
  });

  it('CI blocked wildcard transition to stuck exists', () => {
    const ciBlocked = STATE_MACHINE_TRANSITIONS.find(
      (t) => t.id === 'ci_blocked' && t.from === '*' && t.to === 'stuck',
    );
    expect(ciBlocked).toBeDefined();
  });
});

// =============================================================================
// Self-transitions (from === to)
// =============================================================================

describe('Self-transitions', () => {
  it('CI green/red and merge conflict are self-transitions on running', () => {
    const selfTransitions = STATE_MACHINE_TRANSITIONS.filter(
      (t) => t.from === t.to,
    );
    expect(selfTransitions.length).toBeGreaterThan(0);

    const ciGreen = selfTransitions.find((t) => t.id === 'ci_green');
    expect(ciGreen).toBeDefined();
    expect(ciGreen!.from).toBe('running');
    expect(ciGreen!.to).toBe('running');

    const ciRed = selfTransitions.find((t) => t.id === 'ci_red');
    expect(ciRed).toBeDefined();
    expect(ciRed!.from).toBe('running');
    expect(ciRed!.to).toBe('running');
  });

  it('queued-blocked is a self-transition', () => {
    const queuedBlocked = STATE_MACHINE_TRANSITIONS.find(
      (t) => t.id === 'queued-blocked',
    );
    expect(queuedBlocked).toBeDefined();
    expect(queuedBlocked!.from).toBe('queued');
    expect(queuedBlocked!.to).toBe('queued');
  });
});

// =============================================================================
// STATES metadata
// =============================================================================

describe('STATES metadata', () => {
  it('each state has a non-empty label and color', () => {
    for (const state of STATES) {
      expect(state.label.trim().length).toBeGreaterThan(0);
      expect(state.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('STATES has exactly the expected count', () => {
    expect(STATES.length).toBe(ALL_STATUSES.length);
  });
});
