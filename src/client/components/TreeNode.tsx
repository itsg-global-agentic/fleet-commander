import React, { useState } from 'react';
import { StatusBadge } from './StatusBadge';
import { PRBadge } from './PRBadge';
import { PlayIcon, LockIcon } from './Icons';
import type { TeamStatus, PrioritizedIssue, IssueDependencyInfo, CIStatus } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types (mirrors IssueNode from the server issue-fetcher)
// ---------------------------------------------------------------------------

export interface IssueNode {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  url: string;
  boardStatus?: string;
  subIssueSummary?: { total: number; completed: number; percentCompleted: number };
  prReferences?: { number: number; state: string }[];
  children: IssueNode[];
  activeTeam?: { id: number; status: string } | null;
  dependencies?: IssueDependencyInfo;
}

// ---------------------------------------------------------------------------
// Sub-issue progress bar
// ---------------------------------------------------------------------------

function SubIssueProgress({ completed, total }: { completed: number; total: number }) {
  if (total <= 0) return null;

  const pct = Math.round((completed / total) * 100);
  const barColor = pct === 100 ? '#3FB950' : pct >= 50 ? '#D29922' : '#58A6FF';

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-dark-muted">
      <span className="relative w-16 h-1.5 bg-dark-border rounded-full overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </span>
      <span>{completed}/{total}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// State badge (open/closed)
// ---------------------------------------------------------------------------

function IssueStateBadge({ state }: { state: 'open' | 'closed' }) {
  if (state === 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-[#3FB950]">
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
        </svg>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-dark-muted">
      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z" />
        <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Blocked badge (dependency blocker indicator)
// ---------------------------------------------------------------------------

function BlockedBadge({ dependencies }: { dependencies: IssueDependencyInfo }) {
  if (!dependencies.blockedBy || dependencies.blockedBy.length === 0) return null;

  // Only show the badge when there are open (unresolved) blockers
  if (dependencies.resolved || dependencies.openCount === 0) return null;

  return (
    <span className="inline-flex items-center gap-1 text-xs text-dark-muted cursor-default flex-wrap">
      <LockIcon size={12} className="text-[#F85149] shrink-0" />
      <span>blocked by</span>
      {dependencies.blockedBy.map((dep, idx) => {
        const issueUrl = `https://github.com/${dep.owner}/${dep.repo}/issues/${dep.number}`;
        const isClosed = dep.state === 'closed';
        const tooltipText = dep.title
          ? `${dep.title} (${dep.state})`
          : `#${dep.number} (${dep.state})`;

        return (
          <span key={`${dep.owner}/${dep.repo}#${dep.number}`}>
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={tooltipText}
              className={`hover:text-dark-accent transition-colors ${
                isClosed ? 'line-through text-dark-muted/60' : 'text-dark-muted'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              #{dep.number}
            </a>
            {idx < dependencies.blockedBy.length - 1 && (
              <span className="text-dark-muted">,</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TreeNode component (recursive)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Priority badge component
// ---------------------------------------------------------------------------

function PriorityBadge({ data }: { data: PrioritizedIssue }) {
  let bgColor: string;
  let textColor: string;
  if (data.priority <= 3) {
    bgColor = 'rgba(248, 81, 73, 0.15)';
    textColor = '#F85149';
  } else if (data.priority <= 6) {
    bgColor = 'rgba(210, 153, 34, 0.15)';
    textColor = '#D29922';
  } else {
    bgColor = 'rgba(139, 148, 158, 0.15)';
    textColor = '#8B949E';
  }

  return (
    <span
      className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-xs font-medium cursor-default"
      style={{ backgroundColor: bgColor, color: textColor }}
      title={`Priority ${data.priority}/10 (${data.category}): ${data.reason}`}
    >
      P{data.priority}
    </span>
  );
}

interface TreeNodeProps {
  node: IssueNode;
  depth: number;
  onLaunch: (issueNumber: number, title: string, projectId?: number) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  forceExpand?: boolean;
  /** When set, the play button uses this project instead of requiring the user to select one. */
  projectId?: number;
  /** Map of issue number -> priority data from AI prioritization */
  priorityMap?: Map<number, PrioritizedIssue>;
  /** Set of checked issue numbers for batch launch */
  checkedIssues?: Set<number>;
  /** Callback when checkbox state changes */
  onCheckChange?: (issueNumber: number, checked: boolean) => void;
  /** Callback to prioritize a subtree (parent nodes only) */
  onPrioritizeSubtree?: (subtreeChildren: IssueNode[]) => Promise<void>;
  /** Whether a prioritization request is in progress */
  prioritizing?: boolean;
  /** Controlled collapse state: set of collapsed node IDs */
  collapsedNodes?: Set<string>;
  /** Callback when a node's collapse state is toggled (controlled mode) */
  onToggleCollapse?: (nodeId: string) => void;
}

export const TreeNode = React.memo(function TreeNode({ node, depth, onLaunch, launchingIssues, launchErrors, forceExpand, projectId, priorityMap, checkedIssues, onCheckChange, onPrioritizeSubtree, prioritizing, collapsedNodes, onToggleCollapse }: TreeNodeProps) {
  const nodeId = node.number.toString();
  const isControlled = collapsedNodes != null && onToggleCollapse != null;
  const [localExpanded, setLocalExpanded] = useState(depth < 2);
  const controlledExpanded = isControlled ? !collapsedNodes.has(nodeId) : localExpanded;
  const isExpanded = forceExpand || controlledExpanded;
  const hasChildren = node.children.length > 0;
  const hasActiveTeam = node.activeTeam != null;
  const isBlocked = !!(node.dependencies && !node.dependencies.resolved && node.dependencies.openCount > 0);
  const launching = launchingIssues.has(node.number);
  const launchError = launchErrors.get(node.number) ?? null;

  const handleLaunch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (launching) return;
    await onLaunch(node.number, node.title, projectId);
  };

  // Find first PR reference for PRBadge
  const firstPR = node.prReferences?.[0] ?? null;

  return (
    <div>
      {/* Node row */}
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded hover:bg-dark-surface/80 group transition-colors ${
          isBlocked ? 'opacity-60 border-l-2 border-[#F85149]' : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand/collapse arrow */}
        <button
          disabled={!hasChildren}
          onClick={() => {
            if (isControlled) {
              onToggleCollapse(nodeId);
            } else {
              setLocalExpanded(!isExpanded);
            }
          }}
          className={`w-4 h-4 flex items-center justify-center text-dark-muted shrink-0 transition-transform duration-150 ${
            hasChildren ? 'cursor-pointer hover:text-dark-text' : 'invisible'
          } ${isExpanded ? 'rotate-90' : ''}`}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          tabIndex={hasChildren ? 0 : -1}
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>

        {/* Checkbox for batch launch selection */}
        {onCheckChange && priorityMap && (
          <input
            type="checkbox"
            checked={checkedIssues?.has(node.number) ?? false}
            onChange={(e) => {
              e.stopPropagation();
              onCheckChange(node.number, e.target.checked);
            }}
            className="w-3.5 h-3.5 shrink-0 accent-dark-accent cursor-pointer"
            aria-label={`Select issue #${node.number}`}
          />
        )}

        {/* Issue state icon */}
        <IssueStateBadge state={node.state} />

        {/* Issue number */}
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-dark-muted hover:text-dark-accent transition-colors shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          #{node.number}
        </a>

        {/* Issue title */}
        <span className={`text-sm truncate ${node.state === 'closed' ? 'text-dark-muted line-through' : 'text-dark-text'}`}>
          {node.title}
        </span>

        {/* Priority badge from AI prioritization */}
        {priorityMap?.get(node.number) && (
          <span className="shrink-0 ml-1">
            <PriorityBadge data={priorityMap.get(node.number)!} />
          </span>
        )}

        {/* "Launching..." indicator next to title */}
        {launching && (
          <span className="shrink-0 ml-1 text-xs text-dark-accent/70 animate-pulse">
            Launching...
          </span>
        )}

        {/* StatusBadge for active team */}
        {hasActiveTeam && (
          <span className="shrink-0 ml-1">
            <StatusBadge status={node.activeTeam!.status as TeamStatus} />
          </span>
        )}

        {/* Blocked badge for unresolved dependencies */}
        {node.dependencies && !node.dependencies.resolved && (
          <span className="shrink-0 ml-1">
            <BlockedBadge dependencies={node.dependencies} />
          </span>
        )}

        {/* PR badge */}
        {firstPR && (
          <span className="shrink-0 ml-1">
            {/* ciStatus: map PR state to a CI-like indicator when available;
               null means no CI data is present on the issue-tree node */}
            <PRBadge prNumber={firstPR.number} ciStatus={(firstPR.state as CIStatus) ?? null} />
          </span>
        )}

        {/* Sub-issue progress */}
        {node.subIssueSummary && node.subIssueSummary.total > 0 && (
          <span className="shrink-0 ml-1">
            <SubIssueProgress
              completed={node.subIssueSummary.completed}
              total={node.subIssueSummary.total}
            />
          </span>
        )}

        {/* Prioritize button — only for parent nodes with children */}
        {hasChildren && onPrioritizeSubtree && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrioritizeSubtree(node.children);
            }}
            disabled={prioritizing}
            className={`ml-auto shrink-0 transition-opacity inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border border-[#A371F7]/50 text-[#A371F7] hover:bg-[#A371F7]/10 disabled:opacity-50 disabled:cursor-not-allowed ${
              prioritizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
            title={`Prioritize sub-issues under #${node.number}`}
          >
            {prioritizing ? (
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.823.9l4.584 4.584-7.636 7.636L.187 8.536 7.823.9ZM14.2 6.1l-1.3 1.3-4.584-4.584L9.6 1.5a1.5 1.5 0 012.122 0L14.2 3.978a1.5 1.5 0 010 2.122Z" />
              </svg>
            )}
            Prioritize
          </button>
        )}

        {/* Play button — only for leaf issues with no active team that are open */}
        {!hasActiveTeam && node.state === 'open' && !hasChildren && (
          <button
            onClick={handleLaunch}
            disabled={launching}
            className={`ml-auto shrink-0 transition-opacity px-1.5 py-0.5 text-xs rounded border disabled:opacity-70 disabled:cursor-not-allowed ${
              launching ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            } ${
              isBlocked
                ? 'border-[#D29922]/50 text-[#D29922] hover:text-[#D29922] hover:border-[#D29922]'
                : 'border-dark-border text-dark-muted hover:text-[#3FB950] hover:border-[#3FB950]/50'
            }`}
            title={isBlocked ? `Launch team for #${node.number} (blocked — will prompt for confirmation)` : `Launch team for #${node.number}`}
          >
            {launching ? (
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            ) : (
              <PlayIcon size={12} />
            )}
          </button>
        )}
      </div>

      {/* Inline launch error */}
      {launchError && (
        <div
          className="flex items-center gap-1.5 py-1 text-xs text-[#F85149]"
          style={{ paddingLeft: `${depth * 20 + 32}px` }}
        >
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2.343 13.657A8 8 0 1 1 13.657 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z" />
          </svg>
          <span>{launchError}</span>
        </div>
      )}

      {/* Children (recursive) */}
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.number}
              node={child}
              depth={depth + 1}
              onLaunch={onLaunch}
              launchingIssues={launchingIssues}
              launchErrors={launchErrors}
              forceExpand={forceExpand}
              projectId={projectId}
              priorityMap={priorityMap}
              checkedIssues={checkedIssues}
              onCheckChange={onCheckChange}
              onPrioritizeSubtree={onPrioritizeSubtree}
              prioritizing={prioritizing}
              collapsedNodes={collapsedNodes}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </div>
      )}
    </div>
  );
});
