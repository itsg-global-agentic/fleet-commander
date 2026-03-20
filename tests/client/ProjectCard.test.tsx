// =============================================================================
// Fleet Commander — ProjectCard Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// We need to test the ProjectCard which is not directly exported.
// We test via the ProjectsPage by mocking the API responses.
// However, since ProjectCard is an internal component, we test the
// overall page behavior and card rendering.

// Mock the useApi hook
vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => ({
    get: vi.fn().mockImplementation((path: string) => {
      if (path === 'projects') {
        return Promise.resolve([
          {
            id: 1,
            name: 'test-project',
            repoPath: '/home/user/repos/test',
            githubRepo: 'user/test',
            groupId: null,
            status: 'active',
            hooksInstalled: true,
            maxActiveTeams: 5,
            promptFile: '/path/to/prompt.md',
            model: 'claude-sonnet',
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-01T00:00:00Z',
            teamCount: 3,
            activeTeamCount: 2,
            queuedTeamCount: 1,
            installStatus: {
              hooks: { installed: true, found: 10, total: 10, files: [{ name: 'on_session_start.sh', exists: true }] },
              prompt: { installed: true, files: [{ name: 'workflow.md', exists: true }] },
              agents: { installed: true, files: [{ name: 'agent.yml', exists: true }] },
              settings: { exists: true },
            },
          },
          {
            id: 2,
            name: 'partial-project',
            repoPath: '/home/user/repos/partial',
            githubRepo: 'user/partial',
            groupId: null,
            status: 'active',
            hooksInstalled: false,
            maxActiveTeams: 3,
            promptFile: null,
            model: null,
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-01T00:00:00Z',
            teamCount: 0,
            activeTeamCount: 0,
            queuedTeamCount: 0,
            installStatus: {
              hooks: { installed: false, found: 0, total: 10, files: [] },
              prompt: { installed: false, files: [] },
              agents: { installed: false, files: [] },
              settings: { exists: false },
            },
          },
        ]);
      }
      if (path === 'project-groups') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue({}),
  }),
}));

// Must import after mocks
import { ProjectsPage } from '../../src/client/views/ProjectsPage';

describe('ProjectCard (via ProjectsPage)', () => {
  it('renders project names', async () => {
    render(<ProjectsPage />);
    // Wait for the API call to resolve
    expect(await screen.findByText('test-project')).toBeInTheDocument();
    expect(await screen.findByText('partial-project')).toBeInTheDocument();
  });

  it('renders status badges', async () => {
    render(<ProjectsPage />);
    const badges = await screen.findAllByText('active');
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it('renders compact team stats on tier 1', async () => {
    render(<ProjectsPage />);
    // test-project: 2/5 active with 1 queued
    expect(await screen.findByText(/2\/5 active/)).toBeInTheDocument();
  });

  it('renders queued count when queued count > 0', async () => {
    render(<ProjectsPage />);
    // queued count is embedded in the team stats string: "2/5 active · 1 queued"
    expect(await screen.findByText(/1 queued/)).toBeInTheDocument();
  });

  it('renders install health dot', async () => {
    render(<ProjectsPage />);
    await screen.findByText('test-project');
    // Health dots are present (green for fully installed, red for not installed)
    const dots = document.querySelectorAll('.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(2);
  });

  it('renders Reinstall button', async () => {
    render(<ProjectsPage />);
    const reinstallButtons = await screen.findAllByText('Reinstall');
    expect(reinstallButtons.length).toBe(2); // One per project
  });

  it('does not show details by default (collapsed state)', async () => {
    render(<ProjectsPage />);
    await screen.findByText('test-project');
    // Repository section should not be visible until expanded
    expect(screen.queryByText('Repository')).not.toBeInTheDocument();
    expect(screen.queryByText('Configuration')).not.toBeInTheDocument();
  });

  it('expands to show tier 2 details on click', async () => {
    render(<ProjectsPage />);
    const projectName = await screen.findByText('test-project');
    // Click the row to expand
    const row = projectName.closest('[class*="cursor-pointer"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    // Should now show tier 2 sections
    expect(await screen.findByText('Repository')).toBeInTheDocument();
    expect(await screen.findByText('Configuration')).toBeInTheDocument();
    expect(await screen.findByText('Install Health')).toBeInTheDocument();
  });

  it('shows repo path and github slug in expanded details', async () => {
    render(<ProjectsPage />);
    const projectName = await screen.findByText('test-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    fireEvent.click(row!);

    expect(await screen.findByText('/home/user/repos/test')).toBeInTheDocument();
    expect(await screen.findByText('user/test')).toBeInTheDocument();
  });

  it('shows model and max teams in configuration section', async () => {
    render(<ProjectsPage />);
    const projectName = await screen.findByText('test-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    fireEvent.click(row!);

    expect(await screen.findByText(/claude-sonnet/)).toBeInTheDocument();
    expect(await screen.findByText(/Max teams: 5/)).toBeInTheDocument();
  });

  it('shows prompt section when promptFile exists', async () => {
    render(<ProjectsPage />);
    const projectName = await screen.findByText('test-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    fireEvent.click(row!);

    expect(await screen.findByText('Prompt')).toBeInTheDocument();
    expect(await screen.findByText('/path/to/prompt.md')).toBeInTheDocument();
  });

  it('does not show prompt section when promptFile is null', async () => {
    render(<ProjectsPage />);
    const projectName = await screen.findByText('partial-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    fireEvent.click(row!);

    // partial-project has no promptFile, so no Prompt heading in its card
    // But test-project could also have been expanded, so we check more carefully
    const promptHeadings = screen.queryAllByText('Prompt');
    // Before expanding test-project, only partial-project expanded: no Prompt section
    expect(promptHeadings.length).toBe(0);
  });
});
