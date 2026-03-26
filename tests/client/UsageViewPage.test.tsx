// =============================================================================
// Fleet Commander — UsageViewPage Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGet = vi.fn();

// Stable API reference
const mockApi = {
  get: mockGet,
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

vi.mock('../../src/client/hooks/useFleetSSE', () => ({
  useFleetSSE: () => {},
}));

// Mock UsageChart since it depends on recharts (not installed)
vi.mock('../../src/client/components/UsageChart', () => ({
  UsageChart: () => <div data-testid="usage-chart">UsageChart</div>,
}));

// Import after mocks
import { UsageViewPage } from '../../src/client/views/UsageViewPage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage() {
  return {
    dailyPercent: 45,
    weeklyPercent: 30,
    sonnetPercent: 20,
    extraPercent: 5,
    dailyResetsAt: '2026-03-22T00:00:00Z',
    weeklyResetsAt: '2026-03-24T00:00:00Z',
    sampledAt: '2026-03-21T10:00:00Z',
    redThresholds: { daily: 85, weekly: 95, sonnet: 95, extra: 95 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsageViewPage', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<UsageViewPage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockGet.mockRejectedValue(new Error('Usage fetch failed'));
    render(<UsageViewPage />);
    await waitFor(() => {
      expect(screen.getByText(/usage fetch failed/i)).toBeInTheDocument();
    });
  });

  it('renders usage heading after data loads', async () => {
    mockGet.mockResolvedValue(makeUsage());
    render(<UsageViewPage />);
    await waitFor(() => {
      expect(screen.getByText('Usage Overview')).toBeInTheDocument();
    });
  });

  it('renders usage bar labels', async () => {
    mockGet.mockResolvedValue(makeUsage());
    render(<UsageViewPage />);
    await waitFor(() => {
      expect(screen.getByText('Daily Usage')).toBeInTheDocument();
      expect(screen.getByText('Weekly Usage')).toBeInTheDocument();
      expect(screen.getByText('Sonnet Usage')).toBeInTheDocument();
      expect(screen.getByText('Extra Usage')).toBeInTheDocument();
    });
  });

  it('renders usage percentages', async () => {
    mockGet.mockResolvedValue(makeUsage());
    render(<UsageViewPage />);
    await waitFor(() => {
      // Percentages are rendered with .toFixed(1) format: "45.0%"
      expect(screen.getByText(/45\.0/)).toBeInTheDocument();
      expect(screen.getByText(/30\.0/)).toBeInTheDocument();
      expect(screen.getByText(/20\.0/)).toBeInTheDocument();
      // Use exact match to avoid /5\.0/ also matching "45.0"
      expect(screen.getByText(/^5\.0/)).toBeInTheDocument();
    });
  });

  it('renders UsageChart component', async () => {
    mockGet.mockResolvedValue(makeUsage());
    render(<UsageViewPage />);
    await waitFor(() => {
      expect(screen.getByTestId('usage-chart')).toBeInTheDocument();
    });
  });
});
