// =============================================================================
// Fleet Commander — GridFilterBar Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { GridFilterBar } from '../../src/client/components/GridFilterBar';
import type { TeamStatus } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP = () => {};

const DEFAULT_PROPS = {
  projectNames: ['alpha', 'beta', 'gamma'],
  selectedProject: null as string | null,
  onProjectChange: NOOP,
  selectedStatuses: new Set<TeamStatus>(),
  onStatusesChange: NOOP,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GridFilterBar', () => {
  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders the filter bar container', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      expect(screen.getByTestId('grid-filter-bar')).toBeInTheDocument();
    });

    it('renders a project dropdown with "All projects" plus project names', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      const select = screen.getByTestId('project-filter') as HTMLSelectElement;
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(4); // "All projects" + 3 projects
      expect(options[0].textContent).toBe('All projects');
      expect(options[1].textContent).toBe('alpha');
      expect(options[2].textContent).toBe('beta');
      expect(options[3].textContent).toBe('gamma');
    });

    it('renders "All" status pill', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      expect(screen.getByText('All')).toBeInTheDocument();
    });

    it('renders status pills for all statuses', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      expect(screen.getByText('Queued')).toBeInTheDocument();
      expect(screen.getByText('Launching')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Idle')).toBeInTheDocument();
      expect(screen.getByText('Stuck')).toBeInTheDocument();
      expect(screen.getByText('Done')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('renders with empty project names list', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} projectNames={[]} />);
      const select = screen.getByTestId('project-filter') as HTMLSelectElement;
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(1); // Only "All projects"
    });
  });

  // -------------------------------------------------------------------------
  // Project filter interaction
  // -------------------------------------------------------------------------

  describe('project filter', () => {
    it('calls onProjectChange with name when project is selected', () => {
      const onChange = vi.fn();
      render(<GridFilterBar {...DEFAULT_PROPS} onProjectChange={onChange} />);
      fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'beta' } });
      expect(onChange).toHaveBeenCalledWith('beta');
    });

    it('calls onProjectChange(null) when "All projects" is selected', () => {
      const onChange = vi.fn();
      render(<GridFilterBar {...DEFAULT_PROPS} selectedProject="beta" onProjectChange={onChange} />);
      fireEvent.change(screen.getByTestId('project-filter'), { target: { value: '' } });
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('shows selected project in the dropdown', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} selectedProject="gamma" />);
      const select = screen.getByTestId('project-filter') as HTMLSelectElement;
      expect(select.value).toBe('gamma');
    });
  });

  // -------------------------------------------------------------------------
  // Status filter interaction
  // -------------------------------------------------------------------------

  describe('status filter', () => {
    it('clicking a status pill when "All" is active selects only that status', () => {
      const onChange = vi.fn();
      render(<GridFilterBar {...DEFAULT_PROPS} onStatusesChange={onChange} />);
      fireEvent.click(screen.getByText('Running'));
      expect(onChange).toHaveBeenCalledWith(new Set(['running']));
    });

    it('clicking "All" pill clears status filters', () => {
      const onChange = vi.fn();
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={new Set<TeamStatus>(['running'])}
          onStatusesChange={onChange}
        />,
      );
      fireEvent.click(screen.getByText('All'));
      expect(onChange).toHaveBeenCalledWith(new Set());
    });

    it('clicking an active status pill removes it and reverts to "All" if last', () => {
      const onChange = vi.fn();
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={new Set<TeamStatus>(['running'])}
          onStatusesChange={onChange}
        />,
      );
      fireEvent.click(screen.getByText('Running'));
      // Removing the last filter should revert to empty set (all)
      expect(onChange).toHaveBeenCalledWith(new Set());
    });

    it('clicking an inactive status pill adds it to the set', () => {
      const onChange = vi.fn();
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={new Set<TeamStatus>(['running'])}
          onStatusesChange={onChange}
        />,
      );
      fireEvent.click(screen.getByText('Stuck'));
      expect(onChange).toHaveBeenCalledWith(new Set(['running', 'stuck']));
    });

    it('selecting all individual statuses reverts to "All" (empty set)', () => {
      const onChange = vi.fn();
      // 6 of 7 statuses already selected
      const sixStatuses = new Set<TeamStatus>(['queued', 'launching', 'running', 'idle', 'stuck', 'done']);
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={sixStatuses}
          onStatusesChange={onChange}
        />,
      );
      // Clicking the 7th should trigger "all selected" -> empty set
      fireEvent.click(screen.getByText('Failed'));
      expect(onChange).toHaveBeenCalledWith(new Set());
    });
  });

  // -------------------------------------------------------------------------
  // Visual states
  // -------------------------------------------------------------------------

  describe('visual states', () => {
    it('"All" pill is highlighted when no status filters are active', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      const allPill = screen.getByText('All');
      expect(allPill).toHaveStyle({ color: '#C9D1D9' });
    });

    it('"All" pill is muted when status filters are active', () => {
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={new Set<TeamStatus>(['running'])}
        />,
      );
      const allPill = screen.getByText('All');
      expect(allPill).toHaveStyle({ opacity: 0.7 });
    });

    it('active status pill has its status color', () => {
      render(
        <GridFilterBar
          {...DEFAULT_PROPS}
          selectedStatuses={new Set<TeamStatus>(['running'])}
        />,
      );
      const runningPill = screen.getByTestId('status-pill-running');
      // Running color is #3FB950
      expect(runningPill).toHaveStyle({ color: '#3FB950' });
    });

    it('inactive status pill has muted color', () => {
      render(<GridFilterBar {...DEFAULT_PROPS} />);
      const runningPill = screen.getByTestId('status-pill-running');
      expect(runningPill).toHaveStyle({ color: '#484F58', opacity: 0.5 });
    });
  });
});
