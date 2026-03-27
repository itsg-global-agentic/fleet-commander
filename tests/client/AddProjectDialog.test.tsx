// =============================================================================
// Fleet Commander — AddProjectDialog Component Tests
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
import { AddProjectDialog } from '../../src/client/components/AddProjectDialog';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AddProjectDialog', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <AddProjectDialog open={false} onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('renders the dialog title when open', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Add Project' })).toBeInTheDocument();
  });

  it('renders all form fields', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByPlaceholderText('my-project')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('C:/Git/my-repo')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('org/repo (auto-detected)')).toBeInTheDocument();
  });

  it('renders Cancel and Add Project buttons', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<AddProjectDialog open onClose={onClose} onAdded={vi.fn()} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows validation error when name is empty', async () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() => {
      expect(screen.getByText('Project name is required')).toBeInTheDocument();
    });
  });

  it('shows validation error when repo path is empty', async () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test-project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() => {
      expect(screen.getByText('Repository path is required')).toBeInTheDocument();
    });
  });

  it('calls api.post with form data on submit', async () => {
    mockPost.mockResolvedValue({});
    const onAdded = vi.fn();
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.change(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test-project' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:/Git/my-repo'), {
      target: { value: '/home/user/repos/test' },
    });
    fireEvent.change(screen.getByPlaceholderText('org/repo (auto-detected)'), {
      target: { value: 'user/test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('projects', {
        name: 'test-project',
        repoPath: '/home/user/repos/test',
        githubRepo: 'user/test',
        maxActiveTeams: 5,
        model: undefined,
        issueProvider: 'github',
      });
    });
  });

  it('calls onAdded after successful submit', async () => {
    mockPost.mockResolvedValue({});
    const onAdded = vi.fn();
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.change(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:/Git/my-repo'), {
      target: { value: '/path/to/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledTimes(1);
    });
  });

  it('shows error when api.post fails', async () => {
    mockPost.mockRejectedValue(new Error('Project already exists'));
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:/Git/my-repo'), {
      target: { value: '/path/to/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => {
      expect(screen.getByText('Project already exists')).toBeInTheDocument();
    });
  });

  it('shows "Adding..." while loading', async () => {
    mockPost.mockReturnValue(new Promise(() => {})); // never resolves
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('my-project'), {
      target: { value: 'test' },
    });
    fireEvent.change(screen.getByPlaceholderText('C:/Git/my-repo'), {
      target: { value: '/path/to/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => {
      expect(screen.getByText('Adding...')).toBeInTheDocument();
    });
  });

  it('closes dialog on Escape key', () => {
    const onClose = vi.fn();
    render(<AddProjectDialog open onClose={onClose} onAdded={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders max teams field with default value of 5', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    const maxTeamsInput = screen.getByDisplayValue('5');
    expect(maxTeamsInput).toBeInTheDocument();
  });

  it('renders model input field', () => {
    render(<AddProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByPlaceholderText(/opus, sonnet/)).toBeInTheDocument();
  });
});
