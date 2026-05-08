// =============================================================================
// Fleet Commander -- CommGraph Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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
import { CommGraph } from '../../src/client/components/CommGraph';
import type { MessageEdge, TeamMember } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    name: 'dev',
    role: 'developer',
    isActive: true,
    firstSeen: '2025-01-01T00:00:00Z',
    lastSeen: '2025-01-01T00:05:00Z',
    toolUseCount: 10,
    errorCount: 0,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<MessageEdge> = {}): MessageEdge {
  return {
    sender: 'team-lead',
    recipient: 'dev',
    count: 3,
    lastSummary: 'Review request',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommGraph', () => {
  beforeEach(() => {
    mockForceGraph.mockClear();
  });

  it('should render empty state when no agents are present', () => {
    render(<CommGraph edges={[]} agents={[]} />);
    expect(screen.getByText('Waiting for agents to join the team...')).toBeInTheDocument();
  });

  it('should render the force graph when agents are present', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];

    render(<CommGraph edges={[]} agents={agents} />);
    // Empty state should NOT be shown
    expect(screen.queryByText('Waiting for agents to join the team...')).not.toBeInTheDocument();
    // ForceGraph should have been called with graphData
    expect(mockForceGraph).toHaveBeenCalled();
  });

  it('should show nodes even with zero message edges', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'planner', role: 'planner' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];

    render(<CommGraph edges={[]} agents={agents} />);
    expect(mockForceGraph).toHaveBeenCalled();

    const call = mockForceGraph.mock.calls[0][0] as { graphData: { nodes: Array<{ id: string }>; links: Array<{ source: string }> } };
    const graphData = call.graphData;
    // Should have 3 nodes (one per agent)
    expect(graphData.nodes).toHaveLength(3);
    // No synthetic spawn edges — links come only from real message data
    expect(graphData.links).toHaveLength(0);
  });

  it('should create message edges from the edges prop', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];
    const edges = [
      makeEdge({ sender: 'team-lead', recipient: 'dev', count: 5 }),
    ];

    render(<CommGraph edges={edges} agents={agents} />);
    expect(mockForceGraph).toHaveBeenCalled();

    const call = mockForceGraph.mock.calls[0][0] as { graphData: { nodes: Array<{ id: string }>; links: Array<{ source: string; count: number }> } };
    const graphData = call.graphData;
    expect(graphData.nodes).toHaveLength(2);
    // All edges come from real message data
    expect(graphData.links).toHaveLength(1);
    expect(graphData.links[0].count).toBe(5);
  });

  it('should render a single agent without crashing', () => {
    const agents = [makeAgent({ name: 'team-lead', role: 'team-lead' })];

    render(<CommGraph edges={[]} agents={agents} />);
    expect(mockForceGraph).toHaveBeenCalled();

    const call = mockForceGraph.mock.calls[0][0] as { graphData: { nodes: Array<{ id: string }>; links: Array<{ source: string }> } };
    expect(call.graphData.nodes).toHaveLength(1);
    expect(call.graphData.links).toHaveLength(0);
  });

  it('should pin the team-lead node at a fixed position', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];

    render(<CommGraph edges={[]} agents={agents} />);
    const call = mockForceGraph.mock.calls[0][0] as { graphData: { nodes: Array<{ id: string; fx?: number; fy?: number }> } };
    const tlNode = call.graphData.nodes.find((n) => n.id === 'team-lead');
    expect(tlNode).toBeDefined();
    expect(tlNode!.fx).toBeDefined();
    expect(tlNode!.fy).toBeDefined();
  });

  it('should set non-TL nodes without fixed positions', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];

    render(<CommGraph edges={[]} agents={agents} />);
    const call = mockForceGraph.mock.calls[0][0] as { graphData: { nodes: Array<{ id: string; fx?: number; fy?: number }> } };
    const devNode = call.graphData.nodes.find((n) => n.id === 'dev');
    expect(devNode).toBeDefined();
    expect(devNode!.fx).toBeUndefined();
    expect(devNode!.fy).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Issue #713: onNodeClick + clickableAgents props
  // ---------------------------------------------------------------------------

  it('forwards onNodeClick prop to ForceGraph and invokes with agent id', () => {
    const agents = [
      makeAgent({ name: 'team-lead', role: 'team-lead' }),
      makeAgent({ name: 'dev', role: 'developer' }),
    ];
    const handler = vi.fn();

    render(<CommGraph edges={[]} agents={agents} onNodeClick={handler} />);
    expect(mockForceGraph).toHaveBeenCalled();

    const call = mockForceGraph.mock.calls[0][0] as { onNodeClick?: (node: { id: string }) => void };
    expect(typeof call.onNodeClick).toBe('function');

    // Simulate ForceGraph invoking the click handler with a graph node
    call.onNodeClick?.({ id: 'dev' });
    expect(handler).toHaveBeenCalledWith('dev');
  });

  it('passes a noop-style click handler when onNodeClick prop is omitted', () => {
    const agents = [makeAgent({ name: 'dev' })];
    render(<CommGraph edges={[]} agents={agents} />);
    const call = mockForceGraph.mock.calls[0][0] as { onNodeClick?: (node: { id: string }) => void };
    // Always wired (simplifies ForceGraph), but the inner handler short-circuits.
    expect(typeof call.onNodeClick).toBe('function');
    expect(() => call.onNodeClick?.({ id: 'dev' })).not.toThrow();
  });

  it('forwards a nodeLabel callback that includes a click hint when clickable', () => {
    const agents = [makeAgent({ name: 'dev', role: 'developer' })];
    const clickable = new Set<string>(['dev']);
    const handler = vi.fn();

    render(
      <CommGraph
        edges={[]}
        agents={agents}
        onNodeClick={handler}
        clickableAgents={clickable}
      />,
    );

    const call = mockForceGraph.mock.calls[0][0] as { nodeLabel?: (n: { id: string; name: string; role: string }) => string };
    const html = call.nodeLabel?.({ id: 'dev', name: 'dev', role: 'developer' }) ?? '';
    expect(html).toContain('click for spawn prompts');
  });

  it('omits the click hint from nodeLabel when the node is not clickable', () => {
    const agents = [makeAgent({ name: 'dev', role: 'developer' })];
    const clickable = new Set<string>(); // empty
    const handler = vi.fn();

    render(
      <CommGraph
        edges={[]}
        agents={agents}
        onNodeClick={handler}
        clickableAgents={clickable}
      />,
    );

    const call = mockForceGraph.mock.calls[0][0] as { nodeLabel?: (n: { id: string; name: string; role: string }) => string };
    const html = call.nodeLabel?.({ id: 'dev', name: 'dev', role: 'developer' }) ?? '';
    expect(html).not.toContain('click for spawn prompts');
  });
});
