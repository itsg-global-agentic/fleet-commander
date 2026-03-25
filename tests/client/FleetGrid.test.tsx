// =============================================================================
// Fleet Commander — FleetGrid Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FleetGrid } from '../../src/client/components/FleetGrid';
import { makeTeam } from './test-utils';

// ---------------------------------------------------------------------------
// Mock useThinking — FleetGrid uses it to pass isThinking to each TeamRow
// ---------------------------------------------------------------------------

vi.mock('../../src/client/context/FleetContext', () => ({
  useThinking: () => ({
    isThinking: () => false,
  }),
}));

// ---------------------------------------------------------------------------
// Mock TeamRow — FleetGrid delegates rendering to TeamRow
// ---------------------------------------------------------------------------

vi.mock('../../src/client/components/TeamRow', () => ({
  TeamRow: ({ team, selected, onSelect, isThinking }: { team: { id: number; issueTitle: string }; selected: boolean; onSelect: (id: number) => void; isThinking: boolean }) => (
    <tr data-testid={`team-row-${team.id}`} data-selected={selected} data-thinking={isThinking} onClick={() => onSelect(team.id)}>
      <td>{team.issueTitle}</td>
    </tr>
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FleetGrid', () => {
  it('renders column headers', () => {
    render(<FleetGrid teams={[]} selectedTeamId={null} onSelectTeam={() => {}} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Issue')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('PR')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders a TeamRow for each team', () => {
    const teams = [
      makeTeam({ id: 1, issueTitle: 'Issue A' }),
      makeTeam({ id: 2, issueTitle: 'Issue B' }),
    ];
    render(<FleetGrid teams={teams} selectedTeamId={null} onSelectTeam={() => {}} />);
    expect(screen.getByTestId('team-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('team-row-2')).toBeInTheDocument();
  });

  it('renders empty table body when no teams', () => {
    const { container } = render(<FleetGrid teams={[]} selectedTeamId={null} onSelectTeam={() => {}} />);
    const tbody = container.querySelector('tbody');
    expect(tbody?.children).toHaveLength(0);
  });

  it('passes selected=true for the selected team', () => {
    const teams = [
      makeTeam({ id: 1, issueTitle: 'Issue A' }),
      makeTeam({ id: 2, issueTitle: 'Issue B' }),
    ];
    render(<FleetGrid teams={teams} selectedTeamId={1} onSelectTeam={() => {}} />);
    expect(screen.getByTestId('team-row-1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('team-row-2')).toHaveAttribute('data-selected', 'false');
  });

  it('calls onSelectTeam when a row is clicked', () => {
    const onSelect = vi.fn();
    const teams = [makeTeam({ id: 5, issueTitle: 'Issue C' })];
    render(<FleetGrid teams={teams} selectedTeamId={null} onSelectTeam={onSelect} />);
    fireEvent.click(screen.getByTestId('team-row-5'));
    expect(onSelect).toHaveBeenCalledWith(5);
  });
});
