// =============================================================================
// Fleet Commander — CleanupModal Component Tests
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
import { CleanupModal } from '../../src/client/components/CleanupModal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreview(items: Array<{ type: string; name: string; path: string; reason: string }> = []) {
  return {
    projectName: 'test-project',
    items,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CleanupModal', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <CleanupModal projectId={1} open={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('shows loading state when modal opens', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText('Scanning for items to clean up...')).toBeInTheDocument();
  });

  it('shows "Nothing to clean up" when preview has no items', async () => {
    mockGet.mockResolvedValue(makePreview([]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Nothing to clean up!')).toBeInTheDocument();
    });
  });

  it('renders cleanup items grouped by type', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale worktree' },
      { type: 'stale_branch', name: 'branch-1', path: 'refs/heads/branch-1', reason: 'Old branch' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('wt-1')).toBeInTheDocument();
      expect(screen.getByText('branch-1')).toBeInTheDocument();
    });
  });

  it('shows group headings', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Worktrees/)).toBeInTheDocument();
    });
  });

  it('shows selection count', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
      { type: 'worktree', name: 'wt-2', path: '/path/wt-2', reason: 'Stale' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    });
  });

  it('renders Select All and Deselect All buttons', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Select All')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });
  });

  it('deselects all items when Deselect All is clicked', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
      { type: 'worktree', name: 'wt-2', path: '/path/wt-2', reason: 'Stale' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Deselect All'));
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();
  });

  it('renders Cancel and Remove Selected buttons', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
    ]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Remove Selected (1)')).toBeInTheDocument();
    });
  });

  it('calls onClose when Cancel is clicked', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
    ]));
    const onClose = vi.fn();
    render(<CleanupModal projectId={1} open onClose={onClose} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows result after confirm', async () => {
    mockGet.mockResolvedValue(makePreview([
      { type: 'worktree', name: 'wt-1', path: '/path/wt-1', reason: 'Stale' },
    ]));
    mockPost.mockResolvedValue({
      removed: ['wt-1'],
      failed: [],
    });
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Remove Selected (1)')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Remove Selected (1)'));
    await waitFor(() => {
      expect(screen.getByText(/Removed 1 item/)).toBeInTheDocument();
    });
  });

  it('shows error state when preview API fails', async () => {
    mockGet.mockRejectedValue(new Error('Preview failed'));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Preview failed')).toBeInTheDocument();
    });
  });

  it('closes on Escape key', async () => {
    mockGet.mockResolvedValue(makePreview([]));
    const onClose = vi.fn();
    render(<CleanupModal projectId={1} open onClose={onClose} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Nothing to clean up!')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders project name in header', async () => {
    mockGet.mockResolvedValue(makePreview([]));
    render(<CleanupModal projectId={1} open onClose={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/test-project/)).toBeInTheDocument();
    });
  });
});
