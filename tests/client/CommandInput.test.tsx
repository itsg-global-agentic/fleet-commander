// =============================================================================
// Fleet Commander — CommandInput Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockPost = vi.fn();

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn(),
    post: mockPost,
    put: vi.fn(),
    del: vi.fn(),
  }),
  ApiError: class ApiError extends Error {
    status: number;
    statusText: string;
    constructor(status: number, statusText: string, message?: string) {
      super(message ?? `API error: ${status} ${statusText}`);
      this.name = 'ApiError';
      this.status = status;
      this.statusText = statusText;
    }
  },
}));

// Import after mocks
import { CommandInput } from '../../src/client/components/CommandInput';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandInput', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the input and send button', () => {
    render(<CommandInput teamId={1} />);
    expect(screen.getByPlaceholderText('Send message to team...')).toBeInTheDocument();
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('shows disabled placeholder when disabled', () => {
    render(<CommandInput teamId={1} disabled />);
    expect(screen.getByPlaceholderText('Team is not running')).toBeInTheDocument();
  });

  it('disables the send button when input is empty', () => {
    render(<CommandInput teamId={1} />);
    expect(screen.getByText('Send')).toBeDisabled();
  });

  it('enables the send button when input has text', () => {
    render(<CommandInput teamId={1} />);
    fireEvent.change(screen.getByPlaceholderText('Send message to team...'), {
      target: { value: 'Hello' },
    });
    expect(screen.getByText('Send')).not.toBeDisabled();
  });

  it('calls api.post with correct path and message on submit', async () => {
    render(<CommandInput teamId={42} />);
    const input = screen.getByPlaceholderText('Send message to team...');
    fireEvent.change(input, { target: { value: 'Test message' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('teams/42/send-message', { message: 'Test message' });
    });
  });

  it('clears input after successful send', async () => {
    render(<CommandInput teamId={1} />);
    const input = screen.getByPlaceholderText('Send message to team...');
    fireEvent.change(input, { target: { value: 'Hello world' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('shows success feedback after sending', async () => {
    render(<CommandInput teamId={1} />);
    const input = screen.getByPlaceholderText('Send message to team...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Message sent')).toBeInTheDocument();
    });
  });

  it('shows error feedback when api.post rejects', async () => {
    mockPost.mockRejectedValue(new Error('Network error'));
    render(<CommandInput teamId={1} />);
    const input = screen.getByPlaceholderText('Send message to team...');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('does not submit when message is whitespace only', async () => {
    render(<CommandInput teamId={1} />);
    const input = screen.getByPlaceholderText('Send message to team...');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);

    // Wait a tick — post should NOT have been called
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPost).not.toHaveBeenCalled();
  });
});
