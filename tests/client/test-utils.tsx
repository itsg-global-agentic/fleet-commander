// =============================================================================
// Fleet Commander — Client Test Utilities
// =============================================================================

import { render, type RenderOptions } from '@testing-library/react';
import { createContext, useContext, type ReactNode, type ReactElement } from 'react';
import type { TeamDashboardRow } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Mock FleetContext — mirrors the real FleetContext interface without SSE
// ---------------------------------------------------------------------------

interface FleetContextValue {
  teams: TeamDashboardRow[];
  selectedTeamId: number | null;
  setSelectedTeamId: (id: number | null) => void;
  connected: boolean;
  lastEvent: Date | null;
  lastEventTeamId: number | null;
  isThinking: (teamId: number) => boolean;
}

/**
 * We recreate the context here so tests don't trigger the real FleetProvider,
 * which depends on useSSE and EventSource (not available in jsdom).
 *
 * The context symbol must match the one in the real FleetContext module, so
 * instead we mock the module — see the vi.mock() call below the helpers.
 */
const MockFleetContext = createContext<FleetContextValue | null>(null);

// ---------------------------------------------------------------------------
// Mock data factory
// ---------------------------------------------------------------------------

/** Creates a realistic TeamDashboardRow with sensible defaults */
export function makeTeam(overrides: Partial<TeamDashboardRow> = {}): TeamDashboardRow {
  return {
    id: 1,
    issueNumber: 100,
    issueTitle: 'Test issue',
    status: 'running',
    phase: 'implementing',
    worktreeName: 'kea-100',
    prNumber: null,
    launchedAt: '2025-01-01T00:00:00Z',
    lastEventAt: '2025-01-01T00:05:00Z',
    durationMin: 5,
    idleMin: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUsd: 0,
    retryCount: 0,
    prState: null,
    ciStatus: null,
    mergeStatus: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wrapper component
// ---------------------------------------------------------------------------

interface MockFleetProviderProps {
  children: ReactNode;
  teams?: TeamDashboardRow[];
  selectedTeamId?: number | null;
  connected?: boolean;
  lastEvent?: Date | null;
  lastEventTeamId?: number | null;
  isThinking?: (teamId: number) => boolean;
}

export function MockFleetProvider({
  children,
  teams = [],
  selectedTeamId = null,
  connected = true,
  lastEvent = null,
  lastEventTeamId = null,
  isThinking = () => false,
}: MockFleetProviderProps) {
  const value: FleetContextValue = {
    teams,
    selectedTeamId,
    setSelectedTeamId: () => {},
    connected,
    lastEvent,
    lastEventTeamId,
    isThinking,
  };

  return (
    <MockFleetContext.Provider value={value}>
      {children}
    </MockFleetContext.Provider>
  );
}

/** Hook that reads from the mock context — used via the module mock below */
export function useMockFleet(): FleetContextValue {
  const ctx = useContext(MockFleetContext);
  if (!ctx) {
    throw new Error('useMockFleet must be used within a MockFleetProvider');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Custom render that wraps in MockFleetProvider
// ---------------------------------------------------------------------------

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  teams?: TeamDashboardRow[];
  selectedTeamId?: number | null;
  connected?: boolean;
}

export function renderWithFleet(
  ui: ReactElement,
  { teams, selectedTeamId, connected, ...renderOptions }: CustomRenderOptions = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MockFleetProvider teams={teams} selectedTeamId={selectedTeamId} connected={connected}>
        {children}
      </MockFleetProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
