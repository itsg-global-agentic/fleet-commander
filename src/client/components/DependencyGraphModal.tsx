// ---------------------------------------------------------------------------
// DependencyGraphModal — Full-screen modal overlay for the dependency graph
// ---------------------------------------------------------------------------

import { useEffect, useCallback } from 'react';
import { DependencyGraph } from './DependencyGraph';
import type { IssueNode } from './TreeNode';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DependencyGraphModalProps {
  issues: IssueNode[];
  projectName: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DependencyGraphModal({ issues, projectName, onClose }: DependencyGraphModalProps) {
  // Close on Escape key press
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Count issues for the header
  const issueCount = countIssues(issues);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="w-[90vw] h-[80vh] max-w-[1400px] bg-dark-surface border border-dark-border rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-border shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-dark-text">
              Dependency Graph: {projectName}
            </h2>
            <span className="text-xs text-dark-muted">
              {issueCount} issue{issueCount !== 1 ? 's' : ''}
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-dark-muted hover:text-dark-text hover:bg-dark-hover transition-colors"
            aria-label="Close dependency graph"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Graph body */}
        <div className="flex-1 min-h-0">
          <DependencyGraph
            issues={issues}
            projectName={projectName}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively count all issues in the tree */
function countIssues(nodes: IssueNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children.length > 0) count += countIssues(node.children);
  }
  return count;
}
