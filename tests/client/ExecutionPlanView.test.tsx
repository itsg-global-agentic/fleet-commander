// =============================================================================
// Fleet Commander — ExecutionPlanView Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: mockGet,
    post: mockPost,
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  }),
}));

vi.mock('../../src/client/hooks/useFleetSSE', () => ({
  useFleetSSE: vi.fn(),
}));

// Import after mocks
import { ExecutionPlanView } from '../../src/client/views/ExecutionPlanView';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockProjects = [
  {
    id: 1,
    name: 'test-project',
    status: 'active',
    maxActiveTeams: 3,
    repoPath: '/test',
    githubRepo: 'test/repo',
    hooksInstalled: true,
    teamCount: 2,
    activeTeamCount: 1,
    queuedTeamCount: 1,
  },
];

const mockPlan = {
  waves: [
    {
      waveIndex: 0,
      label: 'Active',
      isActive: true,
      issues: [
        {
          issueNumber: 1,
          title: 'First issue',
          state: 'open',
          teamId: 10,
          teamStatus: 'running',
          blockedBy: [],
          url: 'https://github.com/test/repo/issues/1',
        },
      ],
    },
    {
      waveIndex: 1,
      label: 'Wave 1',
      isActive: false,
      issues: [
        {
          issueNumber: 2,
          title: 'Second issue',
          state: 'open',
          blockedBy: [1],
          url: 'https://github.com/test/repo/issues/2',
        },
        {
          issueNumber: 3,
          title: 'Third issue',
          state: 'open',
          blockedBy: [],
          url: 'https://github.com/test/repo/issues/3',
        },
      ],
    },
  ],
  totalQueued: 2,
  maxActiveTeams: 3,
  circularDeps: [],
  projectId: 1,
  projectName: 'test-project',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionPlanView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset();
  });

  it('should render the header', async () => {
    mockGet.mockResolvedValue([]);
    render(<ExecutionPlanView />);
    expect(screen.getByText('Execution Plan')).toBeInTheDocument();
  });

  it('should show empty state when no project is selected', async () => {
    mockGet.mockResolvedValue([]);
    render(<ExecutionPlanView />);
    await waitFor(() => {
      expect(screen.getByText('Select a project to view its execution plan.')).toBeInTheDocument();
    });
  });

  it('should auto-select single project and fetch plan', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument();
    });
  });

  it('should display wave labels', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      // "Active" appears in both the wave label and the legend, so check for multiple
      const activeElements = screen.getAllByText('Active');
      expect(activeElements.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Wave 1')).toBeInTheDocument();
    });
  });

  it('should display issue numbers', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
      expect(screen.getByText('#3')).toBeInTheDocument();
    });
  });

  it('should display issue titles', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('First issue')).toBeInTheDocument();
      expect(screen.getByText('Second issue')).toBeInTheDocument();
      expect(screen.getByText('Third issue')).toBeInTheDocument();
    });
  });

  it('should display team status for active issues', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  it('should display stats', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(mockPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('3 issues')).toBeInTheDocument();
      expect(screen.getByText('1 active')).toBeInTheDocument();
      expect(screen.getByText('max 3 concurrent')).toBeInTheDocument();
    });
  });

  it('should show circular dependency warning', async () => {
    const planWithCircular = {
      ...mockPlan,
      circularDeps: [[1, 2]],
    };

    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(planWithCircular);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('Circular dependencies detected')).toBeInTheDocument();
    });
  });

  it('should show empty wave state', async () => {
    const emptyPlan = {
      ...mockPlan,
      waves: [],
    };

    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.resolve(emptyPlan);
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('No queued or active issues for this project.')).toBeInTheDocument();
    });
  });

  it('should show error message on API failure', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === 'projects') return Promise.resolve(mockProjects);
      if (path.includes('execution-plan')) return Promise.reject(new Error('Network error'));
      return Promise.resolve([]);
    });

    render(<ExecutionPlanView />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });
});
