// =============================================================================
// Fleet Commander -- DependencyGraphModal Component Tests
// =============================================================================

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { IssueNode } from '../../src/client/components/TreeNode';

// Polyfill ResizeObserver for jsdom (not available by default)
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() { /* noop */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
    };
  }
});

// Mock react-force-graph-2d since it uses canvas (not available in jsdom)
vi.mock('react-force-graph-2d', () => ({
  default: vi.fn(() => null),
}));

// Import after mock is set up
import { DependencyGraphModal } from '../../src/client/components/DependencyGraphModal';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: 1,
    title: 'Test issue',
    state: 'open',
    labels: [],
    url: 'https://github.com/test/repo/issues/1',
    children: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DependencyGraphModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it('renders modal with project name and close button', () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];

    render(
      <DependencyGraphModal issues={issues} projectName="my-project" onClose={onClose} />,
    );

    expect(screen.getByText('Dependency Graph: my-project')).toBeInTheDocument();
    expect(screen.getByText('2 issues')).toBeInTheDocument();
    expect(screen.getByLabelText('Close dependency graph')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const issues = [makeIssue({ number: 1 })];

    render(
      <DependencyGraphModal issues={issues} projectName="my-project" onClose={onClose} />,
    );

    fireEvent.click(screen.getByLabelText('Close dependency graph'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const issues = [makeIssue({ number: 1 })];

    render(
      <DependencyGraphModal issues={issues} projectName="my-project" onClose={onClose} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('displays singular issue count for one issue', () => {
    const issues = [makeIssue({ number: 1 })];

    render(
      <DependencyGraphModal issues={issues} projectName="my-project" onClose={onClose} />,
    );

    expect(screen.getByText('1 issue')).toBeInTheDocument();
  });

  it('counts nested children in issue count', () => {
    const child = makeIssue({ number: 2, title: 'Child' });
    const parent = makeIssue({ number: 1, title: 'Parent', children: [child] });

    render(
      <DependencyGraphModal issues={[parent]} projectName="my-project" onClose={onClose} />,
    );

    expect(screen.getByText('2 issues')).toBeInTheDocument();
  });
});
