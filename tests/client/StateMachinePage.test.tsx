// =============================================================================
// Fleet Commander — StateMachinePage Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPut = vi.fn();

// Stable API reference — StateMachinePage uses `api` as a useCallback dependency
const mockApi = {
  get: mockGet,
  post: vi.fn(),
  put: mockPut,
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Mock dagre since it is not installed in the test environment.
// We build a minimal in-memory graph that satisfies the dagre API surface
// used by computeLayout in StateMachinePage.
vi.mock('dagre', () => {
  class MockGraph {
    private _nodes: Map<string, Record<string, unknown>> = new Map();
    private _edges: Array<{ v: string; w: string; name?: string; label: Record<string, unknown> }> = [];
    private _graphInfo: Record<string, unknown> = {};
    private _defaultEdgeLabel: () => Record<string, unknown> = () => ({});

    setGraph(info: Record<string, unknown>) { this._graphInfo = info; }
    graph() { return { ...this._graphInfo, width: 800, height: 400 }; }
    setDefaultEdgeLabel(fn: () => Record<string, unknown>) { this._defaultEdgeLabel = fn; }
    setNode(id: string, data: Record<string, unknown>) { this._nodes.set(id, { ...data, x: 100, y: 100 }); }
    setEdge(from: string, to: string, label?: Record<string, unknown>, name?: string) {
      this._edges.push({ v: from, w: to, name, label: label || this._defaultEdgeLabel() });
    }
    nodes() { return Array.from(this._nodes.keys()); }
    node(id: string) { return this._nodes.get(id) || { x: 0, y: 0, width: 130, height: 50 }; }
    edges() { return this._edges; }
    edge(e: { v: string; w: string; name?: string }) {
      return { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], ...e.v ? {} : {} };
    }
  }

  return {
    default: {
      graphlib: {
        Graph: MockGraph,
      },
      layout: () => {},
    },
  };
});

// Import after mocks
import { StateMachinePage } from '../../src/client/views/StateMachinePage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateMachineResponse() {
  return {
    states: [
      { id: 'queued', label: 'Queued', color: '#8B949E', description: 'Waiting for slot' },
      { id: 'launching', label: 'Launching', color: '#58A6FF', description: 'Spawning process' },
      { id: 'running', label: 'Running', color: '#3FB950', description: 'Active' },
      { id: 'idle', label: 'Idle', color: '#D29922', description: 'No recent events' },
      { id: 'stuck', label: 'Stuck', color: '#F85149', description: 'No events for extended period' },
      { id: 'done', label: 'Done', color: '#A371F7', description: 'Completed' },
      { id: 'failed', label: 'Failed', color: '#F85149', description: 'Crashed or error' },
    ],
    transitions: [
      {
        id: 'queued_to_launching',
        from: 'queued',
        to: 'launching',
        trigger: 'system',
        label: 'Slot available',
        description: 'A team slot becomes available',
      },
      {
        id: 'launching_to_running',
        from: 'launching',
        to: 'running',
        trigger: 'hook',
        label: 'First event received',
        description: 'CC process started and sent first event',
      },
      {
        id: 'running_to_done',
        from: 'running',
        to: 'done',
        trigger: 'hook',
        label: 'Session ends',
        description: 'CC session ends normally',
      },
    ],
  };
}

function makeTemplatesResponse() {
  return [
    {
      id: 'ci_green',
      template: 'CI passed. Good job.',
      enabled: true,
      description: 'When CI checks pass',
      placeholders: ['{{PR_NUMBER}}'],
      isDefault: true,
    },
    {
      id: 'ci_red',
      template: 'CI failed. Please fix.',
      enabled: true,
      description: 'When CI checks fail',
      placeholders: ['{{PR_NUMBER}}', '{{CI_FAILURES}}'],
      isDefault: false,
    },
  ];
}

function setupMockApi() {
  mockGet.mockImplementation((path: string) => {
    if (path === 'state-machine') return Promise.resolve(makeStateMachineResponse());
    if (path === 'message-templates') return Promise.resolve(makeTemplatesResponse());
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateMachinePage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<StateMachinePage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockGet.mockRejectedValue(new Error('State machine fetch failed'));
    render(<StateMachinePage />);
    await waitFor(() => {
      expect(screen.getByText(/state machine fetch failed/i)).toBeInTheDocument();
    });
  });

  it('renders Lifecycle heading after data loads', async () => {
    setupMockApi();
    render(<StateMachinePage />);
    await waitFor(() => {
      expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    });
  });

  it('renders tab buttons', async () => {
    setupMockApi();
    render(<StateMachinePage />);
    await waitFor(() => {
      expect(screen.getByText('State Machine')).toBeInTheDocument();
      expect(screen.getByText('Transition Table')).toBeInTheDocument();
      expect(screen.getByText('PM Messages')).toBeInTheDocument();
    });
  });

  it('renders subheading text', async () => {
    setupMockApi();
    render(<StateMachinePage />);
    await waitFor(() => {
      expect(screen.getByText(/Team lifecycle transitions and PM message templates/)).toBeInTheDocument();
    });
  });

  it('renders Failed to load message on error', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    render(<StateMachinePage />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load state machine')).toBeInTheDocument();
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
