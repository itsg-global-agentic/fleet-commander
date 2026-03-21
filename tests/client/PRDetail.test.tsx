// =============================================================================
// Fleet Commander — PRDetail Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: mockGet,
    post: mockPost,
    put: vi.fn(),
    del: vi.fn(),
  }),
}));

// Import after mocks
import { PRDetail } from '../../src/client/components/PRDetail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeamDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    issueNumber: 100,
    githubRepo: 'user/repo',
    pr: {
      number: 42,
      state: 'open',
      ciStatus: 'passing',
      mergeStatus: 'clean',
      autoMerge: false,
      ciFailCount: 0,
      checks: [
        { name: 'Build', status: 'completed', conclusion: 'success' },
        { name: 'Tests', status: 'completed', conclusion: 'success' },
      ],
      ...((overrides.pr as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PRDetail', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    expect(screen.getByText('Loading PR details...')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockGet.mockRejectedValue(new Error('Network failed'));
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Network failed')).toBeInTheDocument();
    });
  });

  it('renders PR number as header', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('PR #42')).toBeInTheDocument();
    });
  });

  it('renders PR number as link when githubRepo is available', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} githubRepo="user/repo" />);
    await waitFor(() => {
      const link = screen.getByText('PR #42');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://github.com/user/repo/pull/42');
    });
  });

  it('renders OPEN state badge for open PRs', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('OPEN')).toBeInTheDocument();
    });
  });

  it('renders MERGED state badge for merged PRs', async () => {
    mockGet.mockResolvedValue(makeTeamDetail({ pr: { state: 'merged' } }));
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('MERGED')).toBeInTheDocument();
    });
  });

  it('renders merge status badge for open PRs', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('CLEAN')).toBeInTheDocument();
    });
  });

  it('renders CI Checks section heading', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('CI Checks')).toBeInTheDocument();
    });
  });

  it('renders CI check items', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Build')).toBeInTheDocument();
      expect(screen.getByText('Tests')).toBeInTheDocument();
    });
  });

  it('shows failing count when CI checks fail', async () => {
    mockGet.mockResolvedValue(makeTeamDetail({
      pr: {
        state: 'open',
        ciFailCount: 2,
        checks: [
          { name: 'Build', status: 'completed', conclusion: 'failure' },
          { name: 'Lint', status: 'completed', conclusion: 'failure' },
        ],
      },
    }));
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('(2 failing)')).toBeInTheDocument();
    });
  });

  it('renders Enable Auto-merge button for open PRs without auto-merge', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Enable Auto-merge')).toBeInTheDocument();
    });
  });

  it('renders Disable Auto-merge button when autoMerge is true', async () => {
    mockGet.mockResolvedValue(makeTeamDetail({ pr: { state: 'open', autoMerge: true } }));
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Disable Auto-merge')).toBeInTheDocument();
    });
  });

  it('renders Update Branch button for open PRs', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Update Branch')).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    const onClose = vi.fn();
    render(<PRDetail prNumber={42} teamId={1} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTitle('Close')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape key', async () => {
    mockGet.mockResolvedValue(makeTeamDetail());
    const onClose = vi.fn();
    render(<PRDetail prNumber={42} teamId={1} onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('PR #42')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows "details not available" when PR is null', async () => {
    mockGet.mockResolvedValue({ id: 1, pr: null, githubRepo: 'user/repo' });
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('PR #42 details not available')).toBeInTheDocument();
    });
  });

  it('does not show action buttons for merged PRs', async () => {
    mockGet.mockResolvedValue(makeTeamDetail({ pr: { state: 'merged' } }));
    render(<PRDetail prNumber={42} teamId={1} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('MERGED')).toBeInTheDocument();
    });
    expect(screen.queryByText('Enable Auto-merge')).not.toBeInTheDocument();
    expect(screen.queryByText('Update Branch')).not.toBeInTheDocument();
  });
});
