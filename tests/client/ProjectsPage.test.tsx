// =============================================================================
// Fleet Commander — ProjectsPage View Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDel = vi.fn();

const mockApi = {
  get: mockGet,
  post: mockPost,
  put: mockPut,
  del: mockDel,
};

vi.mock('../../src/client/hooks/useApi', () => ({
  useApi: () => mockApi,
}));

// Import after mocks
import { ProjectsPage } from '../../src/client/views/ProjectsPage';
import type { ProjectSummary, ProjectGroup } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 1,
    name: 'test-project',
    repoPath: '/home/user/repos/test',
    githubRepo: 'user/test',
    groupId: null,
    status: 'active',
    hooksInstalled: true,
    maxActiveTeams: 5,
    promptFile: null,
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
    ...overrides,
  } as ProjectSummary;
}

interface ProjectGroupWithCount extends ProjectGroup {
  projectCount: number;
}

function makeGroup(overrides: Partial<ProjectGroupWithCount> = {}): ProjectGroupWithCount {
  return {
    id: 1,
    name: 'Backend',
    description: 'Backend services',
    sortOrder: 0,
    createdAt: '2025-01-01T00:00:00Z',
    projectCount: 1,
    ...overrides,
  };
}

/** Sets up mock API responses for standard page load */
function setupDefaultMocks(
  projects: ProjectSummary[] = [makeProject()],
  groups: ProjectGroupWithCount[] = [],
) {
  mockGet.mockImplementation((path: string) => {
    if (path === 'projects') return Promise.resolve(projects);
    if (path === 'project-groups') return Promise.resolve(groups);
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectsPage', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDel.mockReset();
    // Clear persisted expand state between tests to prevent cross-contamination
    localStorage.removeItem('fleet-projects-expanded');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Loading & empty states
  // -----------------------------------------------------------------------

  it('shows loading state initially', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ProjectsPage />);
    expect(screen.getByText('Loading projects...')).toBeInTheDocument();
  });

  it('shows empty state when no projects exist', async () => {
    setupDefaultMocks([], []);
    render(<ProjectsPage />);
    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeInTheDocument();
    });
    expect(screen.getByText('Add your first project to get started.')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Header & action buttons
  // -----------------------------------------------------------------------

  it('renders page heading and action buttons', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    await waitFor(() => {
      expect(screen.getByText('Projects')).toBeInTheDocument();
    });
    expect(screen.getByText('New Group')).toBeInTheDocument();
    expect(screen.getByText('Add Project')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Project rendering
  // -----------------------------------------------------------------------

  it('renders project names after data loads', async () => {
    setupDefaultMocks([
      makeProject({ id: 1, name: 'alpha-project' }),
      makeProject({ id: 2, name: 'beta-project' }),
    ]);
    render(<ProjectsPage />);
    expect(await screen.findByText('alpha-project')).toBeInTheDocument();
    expect(await screen.findByText('beta-project')).toBeInTheDocument();
  });

  it('renders project status badges', async () => {
    setupDefaultMocks([
      makeProject({ id: 1, name: 'my-project', status: 'active' }),
    ]);
    render(<ProjectsPage />);
    const badges = await screen.findAllByText('active');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('renders team stats with queued count', async () => {
    setupDefaultMocks([
      makeProject({ activeTeamCount: 3, maxActiveTeams: 8, queuedTeamCount: 2 }),
    ]);
    render(<ProjectsPage />);
    expect(await screen.findByText(/3\/8 active/)).toBeInTheDocument();
    expect(await screen.findByText(/2 queued/)).toBeInTheDocument();
  });

  it('renders Reinstall button for each project', async () => {
    setupDefaultMocks([
      makeProject({ id: 1, name: 'proj-a' }),
      makeProject({ id: 2, name: 'proj-b' }),
    ]);
    render(<ProjectsPage />);
    const buttons = await screen.findAllByText('Reinstall');
    expect(buttons.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Ungrouped section
  // -----------------------------------------------------------------------

  it('renders ungrouped projects under Ungrouped section', async () => {
    setupDefaultMocks([
      makeProject({ id: 1, name: 'ungrouped-proj', groupId: null }),
    ]);
    render(<ProjectsPage />);
    expect(await screen.findByText('Ungrouped')).toBeInTheDocument();
    expect(await screen.findByText('ungrouped-proj')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Grouped sections
  // -----------------------------------------------------------------------

  it('renders grouped sections with group names', async () => {
    const group = makeGroup({ id: 10, name: 'Backend Services' });
    setupDefaultMocks(
      [makeProject({ id: 1, name: 'api-server', groupId: 10 })],
      [group],
    );
    render(<ProjectsPage />);
    expect(await screen.findByText('Backend Services')).toBeInTheDocument();
    expect(await screen.findByText('api-server')).toBeInTheDocument();
  });

  it('shows empty message for groups with no projects', async () => {
    const group = makeGroup({ id: 10, name: 'Empty Group' });
    // Need at least one project to avoid the "No projects yet" empty state.
    // This ungrouped project causes the project list to render, including
    // the empty group section.
    setupDefaultMocks(
      [makeProject({ id: 1, name: 'ungrouped-proj', groupId: null })],
      [group],
    );
    render(<ProjectsPage />);
    expect(await screen.findByText('Empty Group')).toBeInTheDocument();
    expect(await screen.findByText('No projects in this group')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Add Project dialog
  // -----------------------------------------------------------------------

  it('opens Add Project dialog when button is clicked', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    await screen.findByText('Projects');
    fireEvent.click(screen.getByText('Add Project'));
    // AddProjectDialog renders a dialog with "Add Project" as heading
    await waitFor(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      expect(dialogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // New Group dialog
  // -----------------------------------------------------------------------

  it('opens New Group dialog when button is clicked', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    await screen.findByText('Projects');
    fireEvent.click(screen.getByText('New Group'));
    await waitFor(() => {
      expect(screen.getByText('New Group', { selector: 'h2' })).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Project card expand/collapse
  // -----------------------------------------------------------------------

  it('does not show details by default (collapsed state)', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    await screen.findByText('test-project');
    expect(screen.queryByText('Repository')).not.toBeInTheDocument();
    expect(screen.queryByText('Configuration')).not.toBeInTheDocument();
  });

  it('expands project card to show details on click', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    const projectName = await screen.findByText('test-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(await screen.findByText('Repository')).toBeInTheDocument();
    expect(await screen.findByText('Configuration')).toBeInTheDocument();
    expect(await screen.findByText('Install Health')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Update button removed (issue #463)
  // -----------------------------------------------------------------------

  it('does not render an Update button', async () => {
    setupDefaultMocks([
      makeProject({
        id: 1,
        name: 'outdated-proj',
        installStatus: {
          hooks: { installed: true, found: 10, total: 10, files: [{ name: 'on_session_start.sh', exists: true }] },
          prompt: { installed: true, files: [{ name: 'workflow.md', exists: true }] },
          agents: { installed: true, files: [{ name: 'agent.yml', exists: true }] },
          settings: { exists: true },
          outdatedCount: 3,
          currentVersion: '0.0.9',
        },
      } as Partial<ProjectSummary>),
    ]);
    render(<ProjectsPage />);
    await screen.findByText('outdated-proj');
    // "Update" as a standalone button should not exist
    expect(screen.queryByRole('button', { name: /^Update$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Updating\.\.\.$/i })).not.toBeInTheDocument();
  });

  it('shows outdated badge when outdatedCount > 0', async () => {
    setupDefaultMocks([
      makeProject({
        id: 1,
        name: 'badge-proj',
        installStatus: {
          hooks: { installed: true, found: 10, total: 10, files: [{ name: 'on_session_start.sh', exists: true }] },
          prompt: { installed: true, files: [{ name: 'workflow.md', exists: true }] },
          agents: { installed: true, files: [{ name: 'agent.yml', exists: true }] },
          settings: { exists: true },
          outdatedCount: 5,
          currentVersion: '0.0.9',
        },
      } as Partial<ProjectSummary>),
    ]);
    render(<ProjectsPage />);
    await screen.findByText('badge-proj');
    expect(screen.getByText('5 outdated')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // API calls
  // -----------------------------------------------------------------------

  it('fetches projects and groups on mount', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    await screen.findByText('test-project');
    expect(mockGet).toHaveBeenCalledWith('projects');
    expect(mockGet).toHaveBeenCalledWith('project-groups');
  });

  // -----------------------------------------------------------------------
  // Expand/collapse persistence (issue #630)
  // -----------------------------------------------------------------------

  it('persists project card expand state to localStorage', async () => {
    setupDefaultMocks([makeProject({ id: 1, name: 'persist-proj' })]);
    render(<ProjectsPage />);
    const projectName = await screen.findByText('persist-proj');
    const row = projectName.closest('[class*="cursor-pointer"]');
    expect(row).not.toBeNull();

    // Expand the project card
    fireEvent.click(row!);
    await screen.findByText('Repository');

    // Verify localStorage was written with the project key
    const stored = JSON.parse(localStorage.getItem('fleet-projects-expanded') || '[]');
    expect(stored).toContain('project:1');
  });

  it('restores expanded project state from localStorage on mount', async () => {
    // Pre-populate localStorage with an expanded project
    localStorage.setItem('fleet-projects-expanded', JSON.stringify(['project:1', 'group:ungrouped']));

    setupDefaultMocks([makeProject({ id: 1, name: 'restored-proj' })]);
    render(<ProjectsPage />);

    // Project details should be visible without clicking (restored from storage)
    expect(await screen.findByText('Repository')).toBeInTheDocument();
    expect(await screen.findByText('Configuration')).toBeInTheDocument();
  });

  it('persists group collapse state to localStorage', async () => {
    const group = makeGroup({ id: 5, name: 'Collapsible Group' });
    setupDefaultMocks(
      [makeProject({ id: 1, name: 'group-proj', groupId: 5 })],
      [group],
    );
    render(<ProjectsPage />);

    // Group should start expanded (default behavior)
    expect(await screen.findByText('group-proj')).toBeInTheDocument();

    // Collapse the group by clicking its header
    const groupButton = screen.getByText('Collapsible Group').closest('button');
    expect(groupButton).not.toBeNull();
    fireEvent.click(groupButton!);

    // Project inside group should no longer be visible
    await waitFor(() => {
      expect(screen.queryByText('group-proj')).not.toBeInTheDocument();
    });

    // Verify localStorage reflects the collapsed state (group:5 removed from expanded set)
    const stored = JSON.parse(localStorage.getItem('fleet-projects-expanded') || '[]');
    expect(stored).not.toContain('group:5');
  });

  it('survives page refresh by restoring from localStorage', async () => {
    const group = makeGroup({ id: 3, name: 'Persistent Group' });
    // Pre-populate localStorage: group:3 expanded, project:2 expanded
    localStorage.setItem(
      'fleet-projects-expanded',
      JSON.stringify(['group:3', 'project:2']),
    );

    setupDefaultMocks(
      [makeProject({ id: 2, name: 'expanded-proj', groupId: 3 })],
      [group],
    );
    render(<ProjectsPage />);

    // Group should be expanded (from localStorage)
    expect(await screen.findByText('expanded-proj')).toBeInTheDocument();

    // Project should be expanded (from localStorage) — check for detail content
    expect(await screen.findByText('Repository')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Issue Sources — provider-aware status badges (#631)
  // -----------------------------------------------------------------------

  it('shows "+ Add Issue Source" button text (not "+ Add Jira Source")', async () => {
    setupDefaultMocks();
    render(<ProjectsPage />);
    // Expand a project card first
    const projectName = await screen.findByText('test-project');
    const row = projectName.closest('[class*="cursor-pointer"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    await waitFor(() => {
      expect(screen.getByText('+ Add Issue Source')).toBeInTheDocument();
    });
    expect(screen.queryByText('+ Add Jira Source')).not.toBeInTheDocument();
  });
});
