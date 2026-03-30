// =============================================================================
// Fleet Commander -- GitHubSourceDialog Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock fetch for test-connection and credentials
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// Import component
import { GitHubSourceDialog } from '../../src/client/components/GitHubSourceDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectId: 1,
    provider: 'github',
    label: 'My GitHub',
    configJson: JSON.stringify({ owner: 'octocat', repo: 'hello-world', authMode: 'gh-cli' }),
    hasCredentials: false,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubSourceDialog', () => {
  it('does not render when open is false', () => {
    const { container } = render(
      <GitHubSourceDialog open={false} projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('renders create mode with empty fields and correct title', () => {
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText('Add GitHub Source')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. octocat')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. hello-world')).toBeInTheDocument();
  });

  it('renders edit mode with pre-populated fields and correct title', () => {
    const source = makeSource();
    render(
      <GitHubSourceDialog open projectId={1} source={source} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText('Edit GitHub Source')).toBeInTheDocument();
    expect(screen.getByDisplayValue('octocat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('hello-world')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My GitHub')).toBeInTheDocument();
  });

  it('auth mode toggle switches between gh-cli and PAT modes', () => {
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    // Default is gh-cli - PAT field should not be visible
    expect(screen.queryByPlaceholderText('ghp_xxxxxxxxxxxx')).not.toBeInTheDocument();
    expect(screen.getByText(/no credentials needed/i)).toBeInTheDocument();

    // Switch to PAT
    fireEvent.click(screen.getByLabelText('Personal Access Token'));
    expect(screen.getByPlaceholderText('ghp_xxxxxxxxxxxx')).toBeInTheDocument();
    expect(screen.queryByText(/no credentials needed/i)).not.toBeInTheDocument();

    // Switch back to gh-cli
    fireEvent.click(screen.getByLabelText('gh CLI (default)'));
    expect(screen.queryByPlaceholderText('ghp_xxxxxxxxxxxx')).not.toBeInTheDocument();
    expect(screen.getByText(/no credentials needed/i)).toBeInTheDocument();
  });

  it('gh-cli mode hides PAT field and shows no credentials note', () => {
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.queryByPlaceholderText('ghp_xxxxxxxxxxxx')).not.toBeInTheDocument();
    expect(screen.getByText(/no credentials needed/i)).toBeInTheDocument();
  });

  it('PAT mode shows PAT field', () => {
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('Personal Access Token'));
    expect(screen.getByPlaceholderText('ghp_xxxxxxxxxxxx')).toBeInTheDocument();
  });

  it('shows validation error when owner is empty on save', async () => {
    const onSave = vi.fn();
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(screen.getByText('Owner is required')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows validation error when repo is empty on save', async () => {
    const onSave = vi.fn();
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'myowner' },
    });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(screen.getByText('Repository is required')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows validation error when PAT is empty in PAT mode', async () => {
    const onSave = vi.fn();
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'myowner' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hello-world'), {
      target: { value: 'myrepo' },
    });
    fireEvent.click(screen.getByLabelText('Personal Access Token'));
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(screen.getByText('Personal Access Token is required')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with correct payload in gh-cli mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'myowner' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hello-world'), {
      target: { value: 'myrepo' },
    });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        provider: 'github',
        label: null,
        configJson: JSON.stringify({ owner: 'myowner', repo: 'myrepo', authMode: 'gh-cli' }),
        credentialsJson: '',
        enabled: true,
      });
    });
  });

  it('calls onSave with correct payload in PAT mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'myowner' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hello-world'), {
      target: { value: 'myrepo' },
    });
    fireEvent.click(screen.getByLabelText('Personal Access Token'));
    fireEvent.change(screen.getByPlaceholderText('ghp_xxxxxxxxxxxx'), {
      target: { value: 'ghp_abc123' },
    });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        provider: 'github',
        label: null,
        configJson: JSON.stringify({ owner: 'myowner', repo: 'myrepo', authMode: 'pat' }),
        credentialsJson: JSON.stringify({ pat: 'ghp_abc123' }),
        enabled: true,
      });
    });
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <GitHubSourceDialog open projectId={1} onClose={onClose} onSave={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows test connection success result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, repoName: 'octocat/hello-world' }),
    });
    globalThis.fetch = mockFetch;

    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'octocat' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hello-world'), {
      target: { value: 'hello-world' },
    });

    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => {
      expect(screen.getByText(/Connected successfully/)).toBeInTheDocument();
      expect(screen.getByText(/octocat\/hello-world/)).toBeInTheDocument();
    });
  });

  it('shows test connection error result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'Repository not found' }),
    });
    globalThis.fetch = mockFetch;

    render(
      <GitHubSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. octocat'), {
      target: { value: 'octocat' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. hello-world'), {
      target: { value: 'nonexistent' },
    });

    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => {
      expect(screen.getByText('Repository not found')).toBeInTheDocument();
    });
  });

  it('renders edit mode with PAT auth and fetches credentials', async () => {
    const source = makeSource({
      configJson: JSON.stringify({ owner: 'myorg', repo: 'myrepo', authMode: 'pat' }),
      hasCredentials: true,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ credentialsJson: JSON.stringify({ pat: 'ghp_fetched' }) }),
    });
    globalThis.fetch = mockFetch;

    render(
      <GitHubSourceDialog open projectId={1} source={source} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    expect(screen.getByText('Edit GitHub Source')).toBeInTheDocument();
    expect(screen.getByDisplayValue('myorg')).toBeInTheDocument();
    expect(screen.getByDisplayValue('myrepo')).toBeInTheDocument();

    // Credentials should be fetched
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/projects/1/issue-sources/1/credentials');
    });
  });

  it('defaults authMode to gh-cli when configJson has no authMode', () => {
    const source = makeSource({
      configJson: JSON.stringify({ owner: 'legacy-owner', repo: 'legacy-repo' }),
    });
    render(
      <GitHubSourceDialog open projectId={1} source={source} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    // Should show gh-cli mode (no credentials needed note visible)
    expect(screen.getByText(/no credentials needed/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('legacy-owner')).toBeInTheDocument();
    expect(screen.getByDisplayValue('legacy-repo')).toBeInTheDocument();
  });
});
