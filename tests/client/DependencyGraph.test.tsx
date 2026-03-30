// =============================================================================
// Fleet Commander -- DependencyGraph Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { IssueNode } from '../../src/client/components/TreeNode';

// Polyfill ResizeObserver for jsdom (not available by default)
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() { /* noop */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
    };
  }
});

// Mock react-force-graph-2d since it uses canvas (not available in jsdom)
const mockForceGraph = vi.fn(() => null);
vi.mock('react-force-graph-2d', () => ({
  default: vi.fn((props: Record<string, unknown>) => {
    mockForceGraph(props);
    return null;
  }),
}));

// Import after mock is set up
import { DependencyGraph } from '../../src/client/components/DependencyGraph';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: 1,
    title: 'Test issue',
    state: 'open',
    labels: [],
    url: 'https://github.com/test/repo/issues/1',
    children: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Graph data type for test assertions
// ---------------------------------------------------------------------------

interface TestGraphData {
  graphData: {
    nodes: Array<{ id: string; color: string; number: number }>;
    links: Array<{ source: string; target: string; type: string }>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DependencyGraph', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    mockForceGraph.mockClear();
    onClose.mockClear();
  });

  it('renders empty state when no issues provided', () => {
    render(
      <DependencyGraph issues={[]} projectName="test-project" onClose={onClose} />,
    );
    expect(screen.getByText('No issues to visualize for test-project')).toBeInTheDocument();
  });

  it('renders the force graph when issues are present', () => {
    const issues = [
      makeIssue({ number: 1, title: 'First' }),
      makeIssue({ number: 2, title: 'Second' }),
      makeIssue({ number: 3, title: 'Third' }),
    ];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    expect(screen.queryByText('No issues to visualize for test-project')).not.toBeInTheDocument();
    expect(mockForceGraph).toHaveBeenCalled();

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;
    expect(call.graphData.nodes).toHaveLength(3);
  });

  it('colors nodes correctly based on state', () => {
    const issues = [
      // Closed issue — should be green
      makeIssue({ number: 1, title: 'Closed one', state: 'closed' }),
      // Open issue with no blockers — should be yellow
      makeIssue({ number: 2, title: 'Open unblocked', state: 'open' }),
      // Open issue with open blockers — should be red
      makeIssue({
        number: 3,
        title: 'Open blocked',
        state: 'open',
        dependencies: {
          issueNumber: 3,
          blockedBy: [{ number: 99, owner: 'other', repo: 'repo', state: 'open', title: 'ext blocker' }],
          resolved: false,
          openCount: 1,
        },
      }),
    ];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;
    const nodes = call.graphData.nodes;

    const closedNode = nodes.find((n) => n.id === '1');
    const openNode = nodes.find((n) => n.id === '2');
    const blockedNode = nodes.find((n) => n.id === '3');

    expect(closedNode?.color).toBe('#3FB950');  // green
    expect(openNode?.color).toBe('#D29922');    // yellow
    expect(blockedNode?.color).toBe('#F85149'); // red
  });

  it('creates blockedBy edges between issues', () => {
    const issues = [
      makeIssue({ number: 1, title: 'Blocker' }),
      makeIssue({
        number: 2,
        title: 'Blocked',
        dependencies: {
          issueNumber: 2,
          blockedBy: [{ number: 1, owner: 'test', repo: 'repo', state: 'open', title: 'Blocker' }],
          resolved: false,
          openCount: 1,
        },
      }),
    ];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;
    const links = call.graphData.links;

    expect(links).toHaveLength(1);
    expect(links[0].source).toBe('1');
    expect(links[0].target).toBe('2');
    expect(links[0].type).toBe('blockedBy');
  });

  it('creates parent/child edges from tree structure', () => {
    const child1 = makeIssue({ number: 2, title: 'Child 1' });
    const child2 = makeIssue({ number: 3, title: 'Child 2' });
    const parent = makeIssue({ number: 1, title: 'Parent', children: [child1, child2] });

    render(
      <DependencyGraph issues={[parent]} projectName="test-project" onClose={onClose} />,
    );

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;
    const links = call.graphData.links;

    // Should have 2 parent->child edges
    const parentEdges = links.filter((l) => l.type === 'parent');
    expect(parentEdges).toHaveLength(2);
    expect(parentEdges.some((e) => e.source === '1' && e.target === '2')).toBe(true);
    expect(parentEdges.some((e) => e.source === '1' && e.target === '3')).toBe(true);
  });

  it('only creates edges where both endpoints exist in the issue set', () => {
    // Issue blocked by an external issue (number 99, not in the set)
    const issues = [
      makeIssue({
        number: 1,
        title: 'Blocked by external',
        dependencies: {
          issueNumber: 1,
          blockedBy: [{ number: 99, owner: 'other', repo: 'repo', state: 'open', title: 'External' }],
          resolved: false,
          openCount: 1,
        },
      }),
    ];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;

    // Node should exist but be red (blocked)
    expect(call.graphData.nodes).toHaveLength(1);
    expect(call.graphData.nodes[0].color).toBe('#F85149');

    // No edges should be created (external blocker is not in set)
    expect(call.graphData.links).toHaveLength(0);
  });

  it('renders the legend overlay', () => {
    const issues = [makeIssue({ number: 1, title: 'Test' })];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    expect(screen.getByText('Legend')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Open (unblocked)')).toBeInTheDocument();
    expect(screen.getByText('Open (blocked)')).toBeInTheDocument();
    expect(screen.getByText('Dependency (blocks)')).toBeInTheDocument();
    expect(screen.getByText('Parent / child')).toBeInTheDocument();
  });

  it('deduplicates issues when same number appears in multiple branches', () => {
    // Same issue number appears as both a root issue and a child
    const child = makeIssue({ number: 2, title: 'Duplicate' });
    const issues = [
      makeIssue({ number: 1, title: 'Parent', children: [child] }),
      makeIssue({ number: 2, title: 'Duplicate at root' }),
    ];

    render(
      <DependencyGraph issues={issues} projectName="test-project" onClose={onClose} />,
    );

    const call = mockForceGraph.mock.calls[0][0] as TestGraphData;
    // Should deduplicate — only 2 unique nodes
    expect(call.graphData.nodes).toHaveLength(2);
  });
});
