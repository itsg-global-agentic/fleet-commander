// =============================================================================
// Fleet Commander — SideNav Component Tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { SideNav } from '../../src/client/components/SideNav';

// ---------------------------------------------------------------------------
// Helper — wrap in MemoryRouter for NavLink support
// ---------------------------------------------------------------------------

function renderNav(initialRoute = '/') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <SideNav />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SideNav', () => {
  it('renders without crashing', () => {
    const { container } = renderNav();
    expect(container.querySelector('nav')).toBeInTheDocument();
  });

  it('renders all 6 navigation links', () => {
    renderNav();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(6);
  });

  it('renders links with correct titles', () => {
    renderNav();
    expect(screen.getByTitle('Fleet Grid')).toBeInTheDocument();
    expect(screen.getByTitle('Issue Tree')).toBeInTheDocument();
    expect(screen.getByTitle('Usage View')).toBeInTheDocument();
    expect(screen.getByTitle('Projects')).toBeInTheDocument();
    expect(screen.getByTitle('Lifecycle')).toBeInTheDocument();
    expect(screen.getByTitle('Settings')).toBeInTheDocument();
  });

  it('renders links with correct href paths', () => {
    renderNav();
    expect(screen.getByTitle('Fleet Grid')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('Issue Tree')).toHaveAttribute('href', '/issues');
    expect(screen.getByTitle('Usage View')).toHaveAttribute('href', '/usage');
    expect(screen.getByTitle('Projects')).toHaveAttribute('href', '/projects');
    expect(screen.getByTitle('Lifecycle')).toHaveAttribute('href', '/lifecycle');
    expect(screen.getByTitle('Settings')).toHaveAttribute('href', '/settings');
  });

  it('renders SVG icons inside each link', () => {
    const { container } = renderNav();
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(6);
  });

  it('highlights the active link when on the root route', () => {
    renderNav('/');
    const fleetGridLink = screen.getByTitle('Fleet Grid');
    expect(fleetGridLink.className).toContain('text-dark-accent');
  });

  it('highlights the Issue Tree link when on /issues', () => {
    renderNav('/issues');
    const issueLink = screen.getByTitle('Issue Tree');
    expect(issueLink.className).toContain('text-dark-accent');
  });

  it('does not highlight Fleet Grid when on /issues', () => {
    renderNav('/issues');
    const fleetGridLink = screen.getByTitle('Fleet Grid');
    expect(fleetGridLink.className).not.toContain('text-dark-accent');
  });
});
