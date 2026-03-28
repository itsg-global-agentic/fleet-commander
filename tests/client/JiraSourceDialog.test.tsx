// =============================================================================
// Fleet Commander -- JiraSourceDialog Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock fetch for test-connection
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
import { JiraSourceDialog } from '../../src/client/components/JiraSourceDialog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectId: 1,
    provider: 'jira',
    label: 'My Jira',
    configJson: JSON.stringify({ jiraUrl: 'https://test.atlassian.net', projectKey: 'PROJ' }),
    credentialsJson: JSON.stringify({ email: 'user@example.com', apiToken: 'token123' }),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JiraSourceDialog', () => {
  it('does not render when open is false', () => {
    const { container } = render(
      <JiraSourceDialog open={false} projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
  });

  it('renders create mode with empty fields', () => {
    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText('Add Jira Source')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://your-domain.atlassian.net')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. PROJ')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@company.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jira API token')).toBeInTheDocument();
  });

  it('renders edit mode with pre-populated fields', () => {
    const source = makeSource();
    render(
      <JiraSourceDialog open projectId={1} source={source} onClose={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText('Edit Jira Source')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://test.atlassian.net')).toBeInTheDocument();
    expect(screen.getByDisplayValue('PROJ')).toBeInTheDocument();
    expect(screen.getByDisplayValue('user@example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('token123')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My Jira')).toBeInTheDocument();
  });

  it('shows validation error when Jira URL is empty on save', async () => {
    const onSave = vi.fn();
    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(screen.getByText('Jira URL is required')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows validation error when URL does not start with https://', async () => {
    const onSave = vi.fn();
    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://your-domain.atlassian.net'), {
      target: { value: 'http://example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. PROJ'), {
      target: { value: 'PROJ' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Jira API token'), {
      target: { value: 'token' },
    });

    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(screen.getByText('Jira URL must start with https://')).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with correct payload on valid submit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://your-domain.atlassian.net'), {
      target: { value: 'https://test.atlassian.net/' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. PROJ'), {
      target: { value: 'MYPROJ' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Jira API token'), {
      target: { value: 'my-token' },
    });

    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        provider: 'jira',
        label: null,
        configJson: JSON.stringify({ jiraUrl: 'https://test.atlassian.net', projectKey: 'MYPROJ' }),
        credentialsJson: JSON.stringify({ email: 'user@test.com', apiToken: 'my-token' }),
        enabled: true,
      });
    });
  });

  it('strips trailing slash from Jira URL', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://your-domain.atlassian.net'), {
      target: { value: 'https://example.atlassian.net///' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. PROJ'), {
      target: { value: 'X' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'a@b.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Jira API token'), {
      target: { value: 't' },
    });

    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
      const call = onSave.mock.calls[0][0];
      const config = JSON.parse(call.configJson);
      expect(config.jiraUrl).toBe('https://example.atlassian.net');
    });
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <JiraSourceDialog open projectId={1} onClose={onClose} onSave={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows test connection success result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, projectName: 'Test Project' }),
    });
    globalThis.fetch = mockFetch;

    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://your-domain.atlassian.net'), {
      target: { value: 'https://test.atlassian.net' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. PROJ'), {
      target: { value: 'PROJ' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Jira API token'), {
      target: { value: 'token' },
    });

    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => {
      expect(screen.getByText(/Connected successfully/)).toBeInTheDocument();
      expect(screen.getByText(/Test Project/)).toBeInTheDocument();
    });
  });

  it('shows test connection error result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'Authentication failed' }),
    });
    globalThis.fetch = mockFetch;

    render(
      <JiraSourceDialog open projectId={1} onClose={vi.fn()} onSave={vi.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText('https://your-domain.atlassian.net'), {
      target: { value: 'https://test.atlassian.net' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. PROJ'), {
      target: { value: 'PROJ' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'user@test.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Jira API token'), {
      target: { value: 'token' },
    });

    fireEvent.click(screen.getByText('Test Connection'));
    await waitFor(() => {
      expect(screen.getByText('Authentication failed')).toBeInTheDocument();
    });
  });
});
