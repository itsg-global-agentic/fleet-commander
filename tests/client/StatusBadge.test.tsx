// =============================================================================
// Fleet Commander — StatusBadge Component Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StatusBadge } from '../../src/client/components/StatusBadge';
import type { TeamStatus } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Color / label expectations per status
// ---------------------------------------------------------------------------

const STATUS_EXPECTATIONS: Record<TeamStatus, { label: string; color: string }> = {
  running:   { label: 'Running',   color: '#3FB950' },
  stuck:     { label: 'Stuck',     color: '#F85149' },
  idle:      { label: 'Idle',      color: '#D29922' },
  done:      { label: 'Done',      color: '#A371F7' },
  failed:    { label: 'Failed',    color: '#F85149' },
  launching: { label: 'Launching', color: '#58A6FF' },
  queued:    { label: 'Queued',    color: '#8B949E' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusBadge', () => {
  const statuses = Object.keys(STATUS_EXPECTATIONS) as TeamStatus[];

  statuses.forEach((status) => {
    const { label, color } = STATUS_EXPECTATIONS[status];

    describe(`status="${status}"`, () => {
      it(`renders the label "${label}"`, () => {
        render(<StatusBadge status={status} />);
        expect(screen.getByText(label)).toBeInTheDocument();
      });

      it(`renders the label with the correct color (${color})`, () => {
        render(<StatusBadge status={status} />);
        const labelEl = screen.getByText(label);
        expect(labelEl).toHaveStyle({ color });
      });

      it('renders a dot indicator with the correct background color', () => {
        const { container } = render(<StatusBadge status={status} />);
        // The dot is the first child span with the rounded-full class
        const dot = container.querySelector('.rounded-full');
        expect(dot).not.toBeNull();
        expect(dot).toHaveStyle({ backgroundColor: color });
      });
    });
  });

  // Animation class tests
  describe('animation classes', () => {
    it('adds animate-pulse-stuck class for stuck status', () => {
      const { container } = render(<StatusBadge status="stuck" />);
      const dot = container.querySelector('.rounded-full');
      expect(dot).toHaveClass('animate-pulse-stuck');
    });

    it('adds animate-blink class for launching status', () => {
      const { container } = render(<StatusBadge status="launching" />);
      const dot = container.querySelector('.rounded-full');
      expect(dot).toHaveClass('animate-blink');
    });

    it('does not add animation class for running status', () => {
      const { container } = render(<StatusBadge status="running" />);
      const dot = container.querySelector('.rounded-full');
      expect(dot).not.toHaveClass('animate-pulse-stuck');
      expect(dot).not.toHaveClass('animate-blink');
    });

    it('does not add animation class for idle status', () => {
      const { container } = render(<StatusBadge status="idle" />);
      const dot = container.querySelector('.rounded-full');
      expect(dot).not.toHaveClass('animate-pulse-stuck');
      expect(dot).not.toHaveClass('animate-blink');
    });
  });
});
