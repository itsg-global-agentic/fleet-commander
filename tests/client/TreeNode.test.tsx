// =============================================================================
// Fleet Commander — TreeNode Component Tests
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TreeNode, type IssueNode } from '../../src/client/components/TreeNode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: 100,
    title: 'Test issue',
    state: 'open',
    labels: [],
    url: 'https://github.com/user/repo/issues/100',
    children: [],
    activeTeam: null,
    ...overrides,
  };
}

const defaultProps = {
  depth: 0,
  onLaunch: vi.fn().mockResolvedValue(undefined),
  launchingIssues: new Set<number>(),
  launchErrors: new Map<number, string>(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TreeNode', () => {
  it('renders issue number and title', () => {
    render(<TreeNode node={makeNode({ number: 42, title: 'Fix bug' })} {...defaultProps} />);
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Fix bug')).toBeInTheDocument();
  });

  it('renders issue number as a link to the issue URL', () => {
    render(<TreeNode node={makeNode({ number: 42, url: 'https://github.com/org/repo/issues/42' })} {...defaultProps} />);
    const link = screen.getByText('#42');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/issues/42');
  });

  it('renders expand/collapse arrow for nodes with children', () => {
    const parent = makeNode({
      number: 1,
      children: [makeNode({ number: 2, title: 'Child issue' })],
    });
    render(<TreeNode node={parent} {...defaultProps} />);
    const expandBtns = screen.getAllByLabelText('Collapse');
    // At least one visible Collapse button for the parent
    expect(expandBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('hides arrow for leaf nodes', () => {
    render(<TreeNode node={makeNode({ children: [] })} {...defaultProps} />);
    // Arrow button should be invisible (present but invisible class)
    const buttons = screen.getAllByRole('button');
    const arrowBtn = buttons.find(b => b.classList.contains('invisible'));
    expect(arrowBtn).toBeDefined();
  });

  it('does not render children (flat row renderer)', () => {
    const parent = makeNode({
      number: 1,
      title: 'Parent',
      children: [makeNode({ number: 2, title: 'Child issue' })],
    });
    render(<TreeNode node={parent} {...defaultProps} depth={0} collapsedNodes={new Set()} onToggleCollapse={vi.fn()} />);
    // TreeNode no longer renders children — only the parent row
    expect(screen.queryByText('Child issue')).not.toBeInTheDocument();
  });

  it('renders Play button for open leaf issues without active team', () => {
    render(<TreeNode node={makeNode({ state: 'open', children: [], activeTeam: null })} {...defaultProps} />);
    const playBtn = screen.getByTitle(/Launch team for #100/);
    expect(playBtn).toBeInTheDocument();
  });

  it('does not render Play button for closed issues', () => {
    render(<TreeNode node={makeNode({ state: 'closed', children: [] })} {...defaultProps} />);
    expect(screen.queryByTitle(/Launch team/)).not.toBeInTheDocument();
  });

  it('does not render Play button for issues with active team', () => {
    render(<TreeNode node={makeNode({ activeTeam: { id: 1, status: 'running' } })} {...defaultProps} />);
    expect(screen.queryByTitle(/Launch team/)).not.toBeInTheDocument();
  });

  it('does not render Play button for parent nodes (with children)', () => {
    const parent = makeNode({
      children: [makeNode({ number: 2 })],
    });
    render(<TreeNode node={parent} {...defaultProps} />);
    expect(screen.queryByTitle(/Launch team for #100/)).not.toBeInTheDocument();
  });

  it('calls onLaunch when Play button is clicked', async () => {
    const onLaunch = vi.fn().mockResolvedValue(undefined);
    render(
      <TreeNode
        node={makeNode({ number: 50, title: 'Launch me' })}
        {...defaultProps}
        onLaunch={onLaunch}
      />,
    );
    fireEvent.click(screen.getByTitle('Launch team for #50'));
    expect(onLaunch).toHaveBeenCalledWith(50, 'Launch me', undefined, undefined, undefined);
  });

  it('shows "Launching..." indicator when issue is launching', () => {
    render(
      <TreeNode
        node={makeNode({ number: 100 })}
        {...defaultProps}
        launchingIssues={new Set([100])}
      />,
    );
    expect(screen.getByText('Launching...')).toBeInTheDocument();
  });

  it('shows launch error inline', () => {
    render(
      <TreeNode
        node={makeNode({ number: 100 })}
        {...defaultProps}
        launchErrors={new Map([[100, 'Slot unavailable']])}
      />,
    );
    expect(screen.getByText('Slot unavailable')).toBeInTheDocument();
  });

  it('renders StatusBadge for issues with active team', () => {
    render(
      <TreeNode
        node={makeNode({ activeTeam: { id: 1, status: 'running' } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('applies closed styling (line-through) for closed issues', () => {
    render(<TreeNode node={makeNode({ state: 'closed', title: 'Done task' })} {...defaultProps} />);
    const titleEl = screen.getByText('Done task');
    expect(titleEl.className).toContain('line-through');
  });

  it('renders sub-issue progress bar when subIssueSummary is present', () => {
    render(
      <TreeNode
        node={makeNode({ subIssueSummary: { total: 10, completed: 7, percentCompleted: 70 } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('7/10')).toBeInTheDocument();
  });

  it('renders blocked badge for issues with unresolved dependencies', () => {
    render(
      <TreeNode
        node={makeNode({
          dependencies: {
            blockedBy: [{ owner: 'org', repo: 'repo', number: 50, state: 'open', title: 'Dep' }],
            resolved: false,
            openCount: 1,
          },
        })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('blocked by')).toBeInTheDocument();
    expect(screen.getByText('#50')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Closed parent styling (Issue #348 fix)
  // -------------------------------------------------------------------------

  it('renders closed parent with correct styling', () => {
    const closedParent = makeNode({
      number: 5,
      title: 'Closed epic',
      state: 'closed',
      children: [
        makeNode({ number: 10, title: 'Open sub-issue A', state: 'open' }),
      ],
    });
    render(
      <TreeNode
        node={closedParent}
        {...defaultProps}
        depth={0}
        collapsedNodes={new Set()}
        onToggleCollapse={vi.fn()}
      />,
    );

    // Parent should have closed styling
    const parentTitle = screen.getByText('Closed epic');
    expect(parentTitle.className).toContain('line-through');

    // TreeNode no longer renders children — only the parent row
    expect(screen.queryByText('Open sub-issue A')).not.toBeInTheDocument();

    // No Play button for the closed parent (it also has children)
    expect(screen.queryByTitle('Launch team for #5')).not.toBeInTheDocument();
  });

  it('does not render Play button for closed parent even without children', () => {
    render(<TreeNode node={makeNode({ number: 5, state: 'closed', children: [] })} {...defaultProps} />);
    expect(screen.queryByTitle(/Launch team for #5/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Controlled collapse state (Issue #349)
  // -------------------------------------------------------------------------

  it('shows expand arrow when node is not in collapsedNodes (expanded)', () => {
    const collapsedNodes = new Set<string>();
    const onToggleCollapse = vi.fn();
    const parent = makeNode({
      number: 1,
      title: 'Parent',
      children: [makeNode({ number: 2, title: 'Child issue' })],
    });

    render(
      <TreeNode
        node={parent}
        {...defaultProps}
        depth={0}
        collapsedNodes={collapsedNodes}
        onToggleCollapse={onToggleCollapse}
      />,
    );
    // Arrow should show Collapse label since node is expanded
    expect(screen.getByLabelText('Collapse')).toBeInTheDocument();
  });

  it('shows collapse arrow when node is in collapsedNodes set', () => {
    const collapsedNodes = new Set<string>(['1']);
    const onToggleCollapse = vi.fn();
    const parent = makeNode({
      number: 1,
      title: 'Parent',
      children: [makeNode({ number: 2, title: 'Child issue' })],
    });

    render(
      <TreeNode
        node={parent}
        {...defaultProps}
        depth={0}
        collapsedNodes={collapsedNodes}
        onToggleCollapse={onToggleCollapse}
      />,
    );
    // Arrow should show Expand label since node is collapsed
    expect(screen.getByLabelText('Expand')).toBeInTheDocument();
  });

  it('calls onToggleCollapse with nodeId when arrow is clicked', () => {
    const collapsedNodes = new Set<string>();
    const onToggleCollapse = vi.fn();
    const parent = makeNode({
      number: 42,
      title: 'Parent',
      children: [makeNode({ number: 2, title: 'Child' })],
    });

    render(
      <TreeNode
        node={parent}
        {...defaultProps}
        depth={0}
        collapsedNodes={collapsedNodes}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    const collapseBtn = screen.getByLabelText('Collapse');
    fireEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledWith('42');
  });

  it('caps paddingLeft for deeply nested rows', () => {
    const deepNode = makeNode({ number: 99, title: 'Deep node' });
    const { container } = render(
      <TreeNode
        node={deepNode}
        {...defaultProps}
        depth={15}
        collapsedNodes={new Set()}
        onToggleCollapse={vi.fn()}
      />,
    );
    // depth 15 * 20 = 300, capped at 200, plus 8 = 208px
    const row = container.querySelector('.flex.items-center.gap-2') as HTMLElement;
    expect(row.style.paddingLeft).toBe('208px');
  });

  // -------------------------------------------------------------------------
  // Provider display (Issue #597)
  // -------------------------------------------------------------------------

  it('renders Jira issue key when issueProvider is jira', () => {
    render(
      <TreeNode
        node={makeNode({ number: 123, title: 'Jira task', issueProvider: 'jira', issueKey: 'PROJ-123' })}
        {...defaultProps}
      />,
    );
    // Should display the Jira key (PROJ-123) instead of #123
    expect(screen.getByText('PROJ-123')).toBeInTheDocument();
  });

  it('renders GitHub issue number when issueProvider is github', () => {
    render(
      <TreeNode
        node={makeNode({ number: 42, title: 'GH bug', issueProvider: 'github', issueKey: '42' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('#42')).toBeInTheDocument();
  });
});
