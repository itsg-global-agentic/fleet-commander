// =============================================================================
// Fleet Commander — UsageChart Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver for jsdom (required by recharts ResponsiveContainer)
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() { /* noop */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
    };
  }
});

// ---------------------------------------------------------------------------
// Mock recharts — jsdom lacks SVG layout support
// ---------------------------------------------------------------------------

vi.mock('recharts', () => {
  const MockResponsiveContainer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  );
  const MockLineChart = ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-testid="line-chart" data-point-count={data.length}>{children}</div>
  );
  const MockLine = ({ dataKey }: { dataKey: string }) => (
    <div data-testid={`line-${dataKey}`} />
  );
  const MockXAxis = () => <div data-testid="x-axis" />;
  const MockYAxis = () => <div data-testid="y-axis" />;
  const MockTooltip = () => <div data-testid="tooltip" />;
  const MockCartesianGrid = () => <div data-testid="cartesian-grid" />;
  const MockReferenceLine = ({ y }: { y: number }) => (
    <div data-testid="reference-line" data-y={y} />
  );

  return {
    ResponsiveContainer: MockResponsiveContainer,
    LineChart: MockLineChart,
    Line: MockLine,
    XAxis: MockXAxis,
    YAxis: MockYAxis,
    Tooltip: MockTooltip,
    CartesianGrid: MockCartesianGrid,
    ReferenceLine: MockReferenceLine,
  };
});

// Import after mocks
import { UsageChart } from '../../src/client/components/UsageChart';
import type { UsageSnapshot } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    id: 1,
    teamId: null,
    projectId: null,
    sessionId: null,
    dailyPercent: 45,
    weeklyPercent: 30,
    sonnetPercent: 20,
    extraPercent: 5,
    dailyResetsAt: null,
    weeklyResetsAt: null,
    rawOutput: null,
    recordedAt: new Date().toISOString(), // within the 7-day window
    ...overrides,
  };
}

const DEFAULT_THRESHOLDS = { daily: 85, weekly: 95 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UsageChart', () => {
  it('renders empty state when no snapshots are provided', () => {
    render(<UsageChart snapshots={[]} redThresholds={DEFAULT_THRESHOLDS} />);
    expect(screen.getByText('No usage data in the last 7 days')).toBeInTheDocument();
  });

  it('renders empty state when all snapshots are older than 7 days', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10); // 10 days ago
    const snapshot = makeSnapshot({ recordedAt: oldDate.toISOString() });

    render(<UsageChart snapshots={[snapshot]} redThresholds={DEFAULT_THRESHOLDS} />);
    expect(screen.getByText('No usage data in the last 7 days')).toBeInTheDocument();
  });

  it('renders chart when snapshots are within 7-day window', () => {
    const snapshot = makeSnapshot();

    render(<UsageChart snapshots={[snapshot]} redThresholds={DEFAULT_THRESHOLDS} />);
    expect(screen.queryByText('No usage data in the last 7 days')).not.toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('renders all four usage lines', () => {
    const snapshot = makeSnapshot();

    render(<UsageChart snapshots={[snapshot]} redThresholds={DEFAULT_THRESHOLDS} />);
    expect(screen.getByTestId('line-dailyPercent')).toBeInTheDocument();
    expect(screen.getByTestId('line-weeklyPercent')).toBeInTheDocument();
    expect(screen.getByTestId('line-sonnetPercent')).toBeInTheDocument();
    expect(screen.getByTestId('line-extraPercent')).toBeInTheDocument();
  });

  it('renders threshold reference lines', () => {
    const snapshot = makeSnapshot();

    render(<UsageChart snapshots={[snapshot]} redThresholds={{ daily: 80, weekly: 90 }} />);
    const refLines = screen.getAllByTestId('reference-line');
    expect(refLines.length).toBe(2);
    expect(refLines[0]).toHaveAttribute('data-y', '80');
    expect(refLines[1]).toHaveAttribute('data-y', '90');
  });

  it('renders chart axes and grid', () => {
    const snapshot = makeSnapshot();

    render(<UsageChart snapshots={[snapshot]} redThresholds={DEFAULT_THRESHOLDS} />);
    expect(screen.getByTestId('x-axis')).toBeInTheDocument();
    expect(screen.getByTestId('y-axis')).toBeInTheDocument();
    expect(screen.getByTestId('cartesian-grid')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
  });

  it('filters out old snapshots and only passes recent ones to chart', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const recentDate = new Date();

    const snapshots = [
      makeSnapshot({ id: 1, recordedAt: oldDate.toISOString() }),
      makeSnapshot({ id: 2, recordedAt: recentDate.toISOString() }),
    ];

    render(<UsageChart snapshots={snapshots} redThresholds={DEFAULT_THRESHOLDS} />);
    // The chart should render with only the recent snapshot
    const chart = screen.getByTestId('line-chart');
    expect(chart).toHaveAttribute('data-point-count', '1');
  });

  it('renders multiple recent snapshots', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    const snapshots = [
      makeSnapshot({ id: 1, recordedAt: twoDaysAgo.toISOString(), dailyPercent: 20 }),
      makeSnapshot({ id: 2, recordedAt: yesterday.toISOString(), dailyPercent: 40 }),
      makeSnapshot({ id: 3, recordedAt: now.toISOString(), dailyPercent: 60 }),
    ];

    render(<UsageChart snapshots={snapshots} redThresholds={DEFAULT_THRESHOLDS} />);
    const chart = screen.getByTestId('line-chart');
    expect(chart).toHaveAttribute('data-point-count', '3');
  });
});
