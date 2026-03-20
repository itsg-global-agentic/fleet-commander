// =============================================================================
// Fleet Commander — AgentFilterBar Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentFilterBar } from '../../src/client/components/AgentFilterBar';
import type { TeamMember } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal TeamMember for testing */
function member(name: string): TeamMember {
  return {
    name,
    role: name,
    isActive: true,
    firstSeen: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-01T01:00:00Z',
    toolUseCount: 10,
    errorCount: 0,
  };
}

const NOOP = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentFilterBar', () => {
  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  describe('visibility', () => {
    it('returns null when only TL exists and no user/FC entries', () => {
      const { container } = render(
        <AgentFilterBar
          roster={[]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders when subagents exist', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
        />,
      );
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('TL')).toBeInTheDocument();
      expect(screen.getByText('Dev')).toBeInTheDocument();
    });

    it('renders when only TL exists but hasUserEntries is true', () => {
      render(
        <AgentFilterBar
          roster={[]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
        />,
      );
      expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('renders when only TL exists but hasFcEntries is true', () => {
      render(
        <AgentFilterBar
          roster={[]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasFcEntries={true}
        />,
      );
      expect(screen.getByText('FC')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // "You" pill (PM sentinel)
  // -------------------------------------------------------------------------

  describe('"You" pill', () => {
    it('renders when hasUserEntries is true', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
        />,
      );
      expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('does not render when hasUserEntries is false', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={false}
        />,
      );
      expect(screen.queryByText('You')).toBeNull();
    });

    it('does not render when hasUserEntries is undefined', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
        />,
      );
      expect(screen.queryByText('You')).toBeNull();
    });

    it('uses the correct color (#3FB950)', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
        />,
      );
      const pill = screen.getByText('You').closest('button')!;
      // When allActive, the pill color should be #3FB950
      expect(pill).toHaveStyle({ color: '#3FB950' });
    });
  });

  // -------------------------------------------------------------------------
  // "FC" pill (Fleet Commander sentinel)
  // -------------------------------------------------------------------------

  describe('"FC" pill', () => {
    it('renders when hasFcEntries is true', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasFcEntries={true}
        />,
      );
      expect(screen.getByText('FC')).toBeInTheDocument();
    });

    it('does not render when hasFcEntries is false', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasFcEntries={false}
        />,
      );
      // "FC" should not appear as a pill (note: there is no other element with text "FC")
      expect(screen.queryByText('FC')).toBeNull();
    });

    it('uses the correct color (#D29922)', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasFcEntries={true}
        />,
      );
      const pill = screen.getByText('FC').closest('button')!;
      expect(pill).toHaveStyle({ color: '#D29922' });
    });
  });

  // -------------------------------------------------------------------------
  // Both pills together
  // -------------------------------------------------------------------------

  describe('both pills together', () => {
    it('renders both "You" and "FC" pills when both flags are true', () => {
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
          hasFcEntries={true}
        />,
      );
      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('FC')).toBeInTheDocument();
    });

    it('places sentinel pills after roster pills', () => {
      const { container } = render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
          hasFcEntries={true}
        />,
      );
      const buttons = container.querySelectorAll('button');
      // Order: All, TL, Dev, You, FC
      const labels = Array.from(buttons).map((b) => b.textContent);
      expect(labels).toEqual(['All', 'TL', 'Dev', 'You', 'FC']);
    });
  });

  // -------------------------------------------------------------------------
  // Toggle behavior
  // -------------------------------------------------------------------------

  describe('toggle behavior', () => {
    it('clicking "You" pill when all active selects only __pm__', () => {
      const onChange = vi.fn();
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={onChange}
          hasUserEntries={true}
        />,
      );
      fireEvent.click(screen.getByText('You'));
      expect(onChange).toHaveBeenCalledWith(new Set(['__pm__']));
    });

    it('clicking "FC" pill when all active selects only __fc__', () => {
      const onChange = vi.fn();
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={onChange}
          hasFcEntries={true}
        />,
      );
      fireEvent.click(screen.getByText('FC'));
      expect(onChange).toHaveBeenCalledWith(new Set(['__fc__']));
    });

    it('toggling sentinel pill off reverts to "All" when it is the last filter', () => {
      const onChange = vi.fn();
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set(['__pm__'])}
          onFiltersChange={onChange}
          hasUserEntries={true}
        />,
      );
      fireEvent.click(screen.getByText('You'));
      // Removing the only filter should revert to empty set (all)
      expect(onChange).toHaveBeenCalledWith(new Set());
    });

    it('clicking "All" clears all filters', () => {
      const onChange = vi.fn();
      render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set(['__pm__'])}
          onFiltersChange={onChange}
          hasUserEntries={true}
        />,
      );
      fireEvent.click(screen.getByText('All'));
      expect(onChange).toHaveBeenCalledWith(new Set());
    });
  });

  // -------------------------------------------------------------------------
  // Dot color correctness
  // -------------------------------------------------------------------------

  describe('dot colors', () => {
    it('"You" pill dot has correct background color when active', () => {
      const { container } = render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasUserEntries={true}
        />,
      );
      // Find the "You" button and its inner dot
      const youButton = screen.getByText('You').closest('button')!;
      const dot = youButton.querySelector('.rounded-full');
      expect(dot).toHaveStyle({ backgroundColor: '#3FB950' });
    });

    it('"FC" pill dot has correct background color when active', () => {
      const { container } = render(
        <AgentFilterBar
          roster={[member('dev')]}
          activeFilters={new Set()}
          onFiltersChange={NOOP}
          hasFcEntries={true}
        />,
      );
      const fcButton = screen.getByText('FC').closest('button')!;
      const dot = fcButton.querySelector('.rounded-full');
      expect(dot).toHaveStyle({ backgroundColor: '#D29922' });
    });
  });
});
