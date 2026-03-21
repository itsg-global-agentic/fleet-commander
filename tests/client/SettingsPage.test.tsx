// =============================================================================
// Fleet Commander — SettingsPage Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();

// Stable API reference — SettingsPage uses `api` as a useCallback dependency
const mockApi = {
  get: mockGet,
  post: mockPost,
  put: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Import after mocks
import { SettingsPage } from '../../src/client/views/SettingsPage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings() {
  return {
    host: '0.0.0.0',
    port: 4681,
    idleThresholdMin: 3,
    stuckThresholdMin: 5,
    launchTimeoutMin: 5,
    maxUniqueCiFailures: 3,
    earlyCrashThresholdSec: 120,
    earlyCrashMinTools: 5,
    githubPollIntervalMs: 30000,
    issuePollIntervalMs: 60000,
    stuckCheckIntervalMs: 60000,
    usagePollIntervalMs: 30000,
    sseHeartbeatMs: 30000,
    outputBufferLines: 200,
    claudeCmd: 'claude',
    resolvedClaudeCmd: '/usr/bin/claude',
    enableAgentTeams: false,
    fleetCommanderRoot: '/home/user/fleet',
    dbPath: './fleet.db',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SettingsPage />);
    expect(screen.getByText('Loading settings...')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    mockGet.mockRejectedValue(new Error('Connection failed'));
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load settings')).toBeInTheDocument();
      expect(screen.getByText('Connection failed')).toBeInTheDocument();
    });
  });

  it('renders Settings heading after data loads', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  it('renders setting group headings', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Server')).toBeInTheDocument();
      expect(screen.getByText('Thresholds')).toBeInTheDocument();
      expect(screen.getByText('Polling Intervals')).toBeInTheDocument();
      expect(screen.getByText('Paths')).toBeInTheDocument();
    });
  });

  it('renders setting labels', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Host')).toBeInTheDocument();
      expect(screen.getByText('Port')).toBeInTheDocument();
      expect(screen.getByText('Idle Threshold')).toBeInTheDocument();
      expect(screen.getByText('Claude Command')).toBeInTheDocument();
    });
  });

  it('renders setting values', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('0.0.0.0')).toBeInTheDocument();
      expect(screen.getByText('4681')).toBeInTheDocument();
      expect(screen.getByText('3 min')).toBeInTheDocument();
    });
  });

  it('renders env variable references', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('FLEET_HOST')).toBeInTheDocument();
      expect(screen.getByText('PORT')).toBeInTheDocument();
      expect(screen.getByText('FLEET_IDLE_THRESHOLD_MIN')).toBeInTheDocument();
    });
  });

  it('formats poll intervals in seconds', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      // 60000ms => "60s (1min)" appears for multiple settings, 30000ms => "30s"
      const minuteValues = screen.getAllByText('60s (1min)');
      expect(minuteValues.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders Danger Zone with Factory Reset button', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Danger Zone')).toBeInTheDocument();
      expect(screen.getByText('Factory Reset')).toBeInTheDocument();
    });
  });

  it('renders Launch Prompt section', async () => {
    mockGet.mockResolvedValue(makeSettings());
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Launch Prompt')).toBeInTheDocument();
    });
  });
});
