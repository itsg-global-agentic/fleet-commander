import React, { useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TreeNode, type IssueNode } from './TreeNode';
import type { FlatTreeRow } from '../hooks/useVirtualizedTree';
import type { PrioritizedIssue } from '../../shared/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VirtualizedTreeListProps {
  rows: FlatTreeRow[];
  onLaunch: (issueNumber: number, title: string, projectId?: number) => Promise<void>;
  launchingIssues: Set<number>;
  launchErrors: Map<number, string>;
  projectId?: number;
  priorityMap?: Map<number, PrioritizedIssue>;
  checkedIssues?: Set<number>;
  onCheckChange?: (issueNumber: number, checked: boolean) => void;
  onPrioritizeSubtree?: (subtreeChildren: IssueNode[]) => Promise<void>;
  prioritizing?: boolean;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  /** Additional CSS class for the scrollable container */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ESTIMATED_ROW_HEIGHT = 32;
const OVERSCAN = 15;

export const VirtualizedTreeList = React.memo(function VirtualizedTreeList({
  rows,
  onLaunch,
  launchingIssues,
  launchErrors,
  projectId,
  priorityMap,
  checkedIssues,
  onCheckChange,
  onPrioritizeSubtree,
  prioritizing,
  collapsedNodes,
  onToggleCollapse,
  className,
}: VirtualizedTreeListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index].key,
  });

  const measureElement = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        virtualizer.measureElement(el);
      }
    },
    [virtualizer],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={`overflow-auto ${className ?? ''}`}
      style={{ contain: 'content' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={row.key}
              ref={measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <TreeNode
                node={row.node}
                depth={row.depth}
                onLaunch={onLaunch}
                launchingIssues={launchingIssues}
                launchErrors={launchErrors}
                projectId={projectId}
                priorityMap={priorityMap}
                checkedIssues={checkedIssues}
                onCheckChange={onCheckChange}
                onPrioritizeSubtree={onPrioritizeSubtree}
                prioritizing={prioritizing}
                collapsedNodes={collapsedNodes}
                onToggleCollapse={onToggleCollapse}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
