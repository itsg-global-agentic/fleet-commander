// =============================================================================
// Fleet Commander — CIChecks Component Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CIChecks } from '../../src/client/components/CIChecks';
import type { CICheck } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CIChecks', () => {
  it('renders "No CI checks available" when checks array is empty', () => {
    render(<CIChecks checks={[]} />);
    expect(screen.getByText('No CI checks available')).toBeInTheDocument();
  });

  it('renders a check with success conclusion', () => {
    const checks: CICheck[] = [{ name: 'Build', status: 'completed', conclusion: 'success' }];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    // Green checkmark
    expect(screen.getByText('\u2713')).toBeInTheDocument();
  });

  it('renders a check with failure conclusion', () => {
    const checks: CICheck[] = [{ name: 'Tests', status: 'completed', conclusion: 'failure' }];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('Tests')).toBeInTheDocument();
    // Red X
    expect(screen.getByText('\u2715')).toBeInTheDocument();
  });

  it('renders a check with cancelled conclusion', () => {
    const checks: CICheck[] = [{ name: 'Lint', status: 'completed', conclusion: 'cancelled' }];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('Lint')).toBeInTheDocument();
    // Grey dash
    expect(screen.getByText('\u2015')).toBeInTheDocument();
  });

  it('renders a check with pending status (in_progress)', () => {
    const checks: CICheck[] = [{ name: 'Deploy', status: 'in_progress', conclusion: null }];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    // Amber circle
    expect(screen.getByText('\u25CB')).toBeInTheDocument();
  });

  it('renders a check with queued status', () => {
    const checks: CICheck[] = [{ name: 'E2E', status: 'queued', conclusion: null }];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('E2E')).toBeInTheDocument();
    expect(screen.getByText('\u25CB')).toBeInTheDocument();
  });

  it('renders multiple checks', () => {
    const checks: CICheck[] = [
      { name: 'Build', status: 'completed', conclusion: 'success' },
      { name: 'Tests', status: 'completed', conclusion: 'failure' },
      { name: 'Lint', status: 'queued', conclusion: null },
    ];
    render(<CIChecks checks={checks} />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Tests')).toBeInTheDocument();
    expect(screen.getByText('Lint')).toBeInTheDocument();
  });

  it('applies correct icon color for success check', () => {
    const checks: CICheck[] = [{ name: 'Build', status: 'completed', conclusion: 'success' }];
    const { container } = render(<CIChecks checks={checks} />);
    const icon = container.querySelector('.font-bold');
    expect(icon).toHaveStyle({ color: '#3FB950' });
  });

  it('applies correct icon color for failure check', () => {
    const checks: CICheck[] = [{ name: 'Tests', status: 'completed', conclusion: 'failure' }];
    const { container } = render(<CIChecks checks={checks} />);
    const icon = container.querySelector('.font-bold');
    expect(icon).toHaveStyle({ color: '#F85149' });
  });

  it('sets title attribute to check name for truncated display', () => {
    const checks: CICheck[] = [{ name: 'very-long-check-name', status: 'completed', conclusion: 'success' }];
    render(<CIChecks checks={checks} />);
    const badge = screen.getByTitle('very-long-check-name');
    expect(badge).toBeInTheDocument();
  });
});
