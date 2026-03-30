// =============================================================================
// Fleet Commander — Wave Computation (Dependency-resolved execution plan)
// =============================================================================
// Pure logic module for computing execution waves from issue dependency DAGs.
// Uses a modified Kahn's topological sort to assign issues to waves while
// respecting maxActiveTeams slot limits.
//
// Shared between server (API response computation) and client (optimistic
// updates on SSE events).
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An issue enriched with dependency and team info for wave computation */
export interface WaveIssue {
  /** Issue number (e.g. 42) */
  issueNumber: number;
  /** Universal issue key (e.g. "42" for GitHub, "PROJ-123" for Jira) */
  issueKey?: string;
  /** Issue title */
  title: string;
  /** Issue state */
  state: 'open' | 'closed';
  /** Associated team ID (if a team exists for this issue) */
  teamId?: number;
  /** Current team status (if a team exists) */
  teamStatus?: string;
  /** Issue numbers that block this issue (open blockers only) */
  blockedBy: number[];
  /** URL to the issue in its provider's UI */
  url: string;
  /** Whether this issue is part of a circular dependency */
  isCircularDep?: boolean;
}

/** A single execution wave — a group of issues that can run in parallel */
export interface Wave {
  /** Zero-based wave index */
  waveIndex: number;
  /** Human-readable label for the wave */
  label: string;
  /** Issues in this wave */
  issues: WaveIssue[];
  /** Whether this wave contains currently active teams */
  isActive: boolean;
}

/** The full execution plan for a project */
export interface ExecutionPlan {
  /** Ordered list of execution waves */
  waves: Wave[];
  /** Total number of queued issues */
  totalQueued: number;
  /** Max concurrent active teams for the project */
  maxActiveTeams: number;
  /** Detected circular dependency cycles (each is a list of issue numbers) */
  circularDeps: number[][];
  /** Project ID this plan belongs to */
  projectId: number;
  /** Project name for display */
  projectName: string;
}

// ---------------------------------------------------------------------------
// Circular dependency detection
// ---------------------------------------------------------------------------

/**
 * Detect all circular dependencies in the issue graph.
 * Returns an array of cycles, each represented as an array of issue numbers.
 *
 * Uses DFS with path tracking. Each cycle is returned once (not duplicated
 * for each node in the cycle).
 */
export function detectCircularDeps(
  issues: Map<number, number[]>,
): number[][] {
  const cycles: number[][] = [];
  const visited = new Set<number>();
  const inStack = new Set<number>();
  const cycleMembers = new Set<number>();

  function dfs(node: number, path: number[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        const cycle = path.slice(cycleStart);
        // Only record this cycle if we haven't seen its members before
        const key = [...cycle].sort((a, b) => a - b).join(',');
        const alreadySeen = cycles.some((c) => {
          const ck = [...c].sort((a, b) => a - b).join(',');
          return ck === key;
        });
        if (!alreadySeen) {
          cycles.push(cycle);
          for (const n of cycle) cycleMembers.add(n);
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = issues.get(node) ?? [];
    for (const dep of deps) {
      dfs(dep, path);
    }

    inStack.delete(node);
    path.pop();
  }

  for (const node of issues.keys()) {
    dfs(node, []);
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Wave computation (modified Kahn's topological sort)
// ---------------------------------------------------------------------------

/**
 * Compute execution waves from a set of issues with dependency info.
 *
 * Algorithm:
 * 1. Build in-degree map from dependency edges.
 * 2. Separate currently active issues into Wave 0.
 * 3. Detect and handle circular dependencies (treat as unblocked).
 * 4. Use Kahn's algorithm to assign remaining issues to waves, respecting
 *    maxActiveTeams per wave.
 *
 * @param issues - All issues to include in the plan (open, with dependency info)
 * @param maxActiveTeams - Max concurrent teams for the project
 * @param activeCount - Number of currently active (non-queued) teams
 * @returns Computed waves and detected circular dependency cycles
 */
export function computeWaves(
  issues: WaveIssue[],
  maxActiveTeams: number,
  activeCount: number,
): { waves: Wave[]; circularDeps: number[][] } {
  if (issues.length === 0) {
    return { waves: [], circularDeps: [] };
  }

  // Build lookup maps
  const issueMap = new Map<number, WaveIssue>();
  for (const issue of issues) {
    issueMap.set(issue.issueNumber, issue);
  }

  // Separate active issues (currently running/launching/idle/stuck) from queued
  const activeStatuses = new Set(['launching', 'running', 'idle', 'stuck']);
  const activeIssues: WaveIssue[] = [];
  const queuedIssues: WaveIssue[] = [];

  for (const issue of issues) {
    if (issue.teamStatus && activeStatuses.has(issue.teamStatus)) {
      activeIssues.push(issue);
    } else {
      queuedIssues.push(issue);
    }
  }

  // Build dependency graph for queued issues only (active ones are already running)
  // Only consider edges where both source and target are in the queued set
  const queuedSet = new Set(queuedIssues.map((i) => i.issueNumber));
  const depGraph = new Map<number, number[]>();

  for (const issue of queuedIssues) {
    // Only include blockers that are also queued (not resolved/active)
    const relevantBlockers = issue.blockedBy.filter((b) => queuedSet.has(b));
    depGraph.set(issue.issueNumber, relevantBlockers);
  }

  // Detect circular dependencies
  const circularDeps = detectCircularDeps(depGraph);
  const circularNodes = new Set<number>();
  for (const cycle of circularDeps) {
    for (const n of cycle) circularNodes.add(n);
  }

  // Mark circular dep issues
  for (const issue of queuedIssues) {
    if (circularNodes.has(issue.issueNumber)) {
      issue.isCircularDep = true;
    }
  }

  // Build in-degree map (ignoring edges from/to circular dep nodes)
  const inDegree = new Map<number, number>();
  for (const issue of queuedIssues) {
    inDegree.set(issue.issueNumber, 0);
  }

  for (const issue of queuedIssues) {
    const blockers = depGraph.get(issue.issueNumber) ?? [];
    for (const blocker of blockers) {
      // If both this issue and its blocker are in a cycle, treat as no edge
      if (circularNodes.has(issue.issueNumber) && circularNodes.has(blocker)) {
        continue;
      }
      // Only count edges from issues that are in our queued set
      if (queuedSet.has(blocker)) {
        inDegree.set(issue.issueNumber, (inDegree.get(issue.issueNumber) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm: assign issues to waves
  const waves: Wave[] = [];

  // Wave 0: currently active issues
  if (activeIssues.length > 0) {
    waves.push({
      waveIndex: 0,
      label: 'Active',
      issues: activeIssues,
      isActive: true,
    });
  }

  // Remaining queued issues via topological sort
  const assigned = new Set<number>();
  let slotsAvailable = Math.max(0, maxActiveTeams - activeCount);

  // Start from issues with in-degree 0 (no open queued blockers)
  let currentReady: number[] = [];
  for (const [num, deg] of inDegree.entries()) {
    if (deg === 0 && !assigned.has(num)) {
      currentReady.push(num);
    }
  }

  while (currentReady.length > 0 || assigned.size < queuedIssues.length) {
    if (currentReady.length === 0) {
      // All remaining issues have unresolved dependencies — they form a
      // never-reachable wave (possibly due to external blockers not in our set)
      const remaining = queuedIssues.filter((i) => !assigned.has(i.issueNumber));
      if (remaining.length === 0) break;

      waves.push({
        waveIndex: waves.length,
        label: `Blocked`,
        issues: remaining,
        isActive: false,
      });
      break;
    }

    // Sort ready issues for deterministic order (by issue number)
    currentReady.sort((a, b) => a - b);

    // Split into wave-sized chunks based on available slots
    const waveSize = maxActiveTeams > 0 ? Math.min(currentReady.length, Math.max(slotsAvailable, maxActiveTeams)) : currentReady.length;
    const waveIssues = currentReady.slice(0, waveSize).map((num) => issueMap.get(num)!);
    const overflow = currentReady.slice(waveSize);

    const waveIndex = waves.length;
    waves.push({
      waveIndex,
      label: waveIndex === 0 && activeIssues.length === 0 ? 'Next' : `Wave ${waveIndex}`,
      issues: waveIssues,
      isActive: false,
    });

    // Mark these issues as assigned
    for (const issue of waveIssues) {
      assigned.add(issue.issueNumber);
    }

    // After the first queued wave, reset slots to full maxActiveTeams
    slotsAvailable = maxActiveTeams;

    // Find next ready issues: reduce in-degree for dependents
    const nextReady = [...overflow];
    for (const issue of waveIssues) {
      // Find all queued issues that depend on this one
      for (const [num, blockers] of depGraph.entries()) {
        if (assigned.has(num)) continue;
        if (blockers.includes(issue.issueNumber)) {
          // Decrement effective in-degree
          const newDeg = (inDegree.get(num) ?? 1) - 1;
          inDegree.set(num, newDeg);
          if (newDeg <= 0 && !nextReady.includes(num)) {
            nextReady.push(num);
          }
        }
      }
    }

    currentReady = nextReady;
  }

  return { waves, circularDeps };
}
