// ---------------------------------------------------------------------------
// DependencyGraph — Force-directed graph of issue dependencies per project
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import ForceGraph from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
// d3-force-3d is a transitive dep of react-force-graph-2d (no type declarations)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — d3-force-3d has no type declarations
import { forceCollide } from 'd3-force-3d';
import type { IssueNode } from './TreeNode';

// ---------------------------------------------------------------------------
// Graph node and link types
// ---------------------------------------------------------------------------

interface DependencyGraphNode {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  isBlocked: boolean;
  color: string;
  x?: number;
  y?: number;
  url: string;
  issueKey?: string;
  issueProvider?: string;
}

interface DependencyGraphLink {
  source: string;
  target: string;
  type: 'blockedBy' | 'parent';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DependencyGraphProps {
  issues: IssueNode[];
  projectName: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_RADIUS = 20;
const FONT_SIZE_NUMBER = 14;
const FONT_SIZE_LABEL = 10;

const COLOR_RESOLVED = '#3FB950';
const COLOR_OPEN_UNBLOCKED = '#D29922';
const COLOR_OPEN_BLOCKED = '#F85149';
const COLOR_BORDER = '#484F58';
const COLOR_LABEL = '#8B949E';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively flatten an issue tree into a flat list */
function flattenTree(nodes: IssueNode[]): IssueNode[] {
  const result: IssueNode[] = [];
  function walk(items: IssueNode[]) {
    for (const item of items) {
      result.push(item);
      if (item.children.length > 0) walk(item.children);
    }
  }
  walk(nodes);
  return result;
}

/** Truncate text to a maximum number of characters */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

/** Collect parent-child edges from the tree structure */
function collectParentChildEdges(nodes: IssueNode[], issueSet: Set<string>): DependencyGraphLink[] {
  const edges: DependencyGraphLink[] = [];
  function walk(items: IssueNode[]) {
    for (const item of items) {
      for (const child of item.children) {
        const parentId = String(item.number);
        const childId = String(child.number);
        if (issueSet.has(parentId) && issueSet.has(childId)) {
          edges.push({ source: parentId, target: childId, type: 'parent' });
        }
      }
      if (item.children.length > 0) walk(item.children);
    }
  }
  walk(nodes);
  return edges;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DependencyGraph({ issues, projectName }: DependencyGraphProps) {
  const graphRef = useRef<ForceGraphMethods<DependencyGraphNode, DependencyGraphLink>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });

  // Track container size with ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });

    observer.observe(container);
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDimensions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    }

    return () => observer.disconnect();
  }, []);

  // Build graph data from issues
  const graphData = useMemo(() => {
    const flat = flattenTree(issues);
    const issueMap = new Map<number, IssueNode>();
    for (const issue of flat) {
      // Avoid duplicates — first occurrence wins
      if (!issueMap.has(issue.number)) {
        issueMap.set(issue.number, issue);
      }
    }

    const issueIdSet = new Set<string>(
      [...issueMap.keys()].map(String),
    );

    // Create nodes
    const nodes: DependencyGraphNode[] = [...issueMap.values()].map((issue) => {
      const hasOpenBlockers = issue.dependencies
        ? issue.dependencies.openCount > 0
        : false;

      let color: string;
      if (issue.state === 'closed') {
        color = COLOR_RESOLVED;
      } else if (hasOpenBlockers) {
        color = COLOR_OPEN_BLOCKED;
      } else {
        color = COLOR_OPEN_UNBLOCKED;
      }

      return {
        id: String(issue.number),
        number: issue.number,
        title: issue.title,
        state: issue.state,
        isBlocked: hasOpenBlockers,
        color,
        url: issue.url,
        issueKey: issue.issueKey,
        issueProvider: issue.issueProvider,
      };
    });

    // Create blockedBy edges (only where both endpoints exist in the graph)
    const links: DependencyGraphLink[] = [];
    const edgeKeys = new Set<string>();

    for (const issue of issueMap.values()) {
      if (!issue.dependencies) continue;
      for (const blocker of issue.dependencies.blockedBy) {
        const blockerId = String(blocker.number);
        const blockedId = String(issue.number);
        if (issueIdSet.has(blockerId) && issueIdSet.has(blockedId)) {
          const key = `blockedBy:${blockerId}->${blockedId}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            links.push({ source: blockerId, target: blockedId, type: 'blockedBy' });
          }
        }
      }
    }

    // Create parent-child edges
    const parentChildEdges = collectParentChildEdges(issues, issueIdSet);
    for (const edge of parentChildEdges) {
      const key = `parent:${edge.source}->${edge.target}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        links.push(edge);
      }
    }

    return { nodes, links };
  }, [issues]);

  // Configure d3 forces
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || graphData.nodes.length === 0) return;

    const charge = fg.d3Force('charge');
    if (charge && typeof charge.strength === 'function') {
      charge.strength(-300);
    }

    fg.d3Force('collide', forceCollide(NODE_RADIUS + 25));
    fg.d3ReheatSimulation();
  }, [graphData.nodes.length]);

  // Zoom to fit after initial render
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    const timer = setTimeout(() => {
      fg.zoomToFit(400, 60);
    }, 600);
    return () => clearTimeout(timer);
  }, [graphData.nodes.length]);

  // Custom node rendering
  const nodeCanvasObject = useCallback(
    (node: DependencyGraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = NODE_RADIUS;
      const fontSize = FONT_SIZE_NUMBER / globalScale;
      const labelFontSize = FONT_SIZE_LABEL / globalScale;

      // Filled circle with 40% opacity
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + '66';
      ctx.fill();

      // Border
      ctx.strokeStyle = COLOR_BORDER;
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();

      // Issue number centered inside
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#E6EDF3';
      ctx.fillText(`#${node.number}`, x, y);

      // Truncated title below
      ctx.font = `${labelFontSize}px sans-serif`;
      ctx.fillStyle = COLOR_LABEL;
      ctx.fillText(truncate(node.title, 22), x, y + r + 10 / globalScale);
    },
    [],
  );

  // Node pointer area for hover/click detection
  const nodePointerAreaPaint = useCallback(
    (node: DependencyGraphNode, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  // Node click — open issue in new tab
  const onNodeClick = useCallback((node: DependencyGraphNode) => {
    if (node.url) {
      window.open(node.url, '_blank');
    }
  }, []);

  // Link color by type
  const linkColor = useCallback((link: DependencyGraphLink) => {
    return link.type === 'blockedBy' ? COLOR_OPEN_BLOCKED : COLOR_BORDER;
  }, []);

  // Link width
  const linkWidth = useCallback((_link: DependencyGraphLink) => {
    return 1.5;
  }, []);

  // Link dashed pattern for parent/child edges
  const linkLineDash = useCallback((link: DependencyGraphLink) => {
    return link.type === 'parent' ? [5, 3] : null;
  }, []);

  // Directional arrows for blockedBy edges only
  const linkDirectionalArrowLength = useCallback((link: DependencyGraphLink) => {
    return link.type === 'blockedBy' ? 6 : 0;
  }, []);

  // Node label tooltip
  const nodeLabel = useCallback((node: DependencyGraphNode) => {
    const stateLabel = node.state === 'closed' ? 'Resolved' : (node.isBlocked ? 'Blocked' : 'Open');
    return `<div style="padding:4px 8px;background:#161B22;border:1px solid #30363D;border-radius:4px;font-size:11px;color:#E6EDF3;">
      <b>#${node.number}</b> ${node.title}<br/>
      <span style="color:${node.color}">${stateLabel}</span>
    </div>`;
  }, []);

  // Empty state
  if (graphData.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-dark-muted text-sm">
        No issues to visualize for {projectName}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[300px]">
      <ForceGraph
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="transparent"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        nodePointerAreaPaint={nodePointerAreaPaint}
        nodeLabel={nodeLabel}
        onNodeClick={onNodeClick}
        linkWidth={linkWidth}
        linkColor={linkColor}
        linkLineDash={linkLineDash}
        linkDirectionalArrowLength={linkDirectionalArrowLength}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={linkColor}
        linkCurvature={0.15}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        cooldownTicks={100}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        enableNodeDrag={true}
        minZoom={0.3}
        maxZoom={6}
      />

      {/* Legend overlay */}
      <div className="absolute bottom-3 right-3 bg-dark-surface/90 border border-dark-border rounded-lg px-3 py-2 text-xs text-dark-muted">
        <div className="font-semibold text-dark-text mb-1.5">Legend</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLOR_RESOLVED }} />
            <span>Resolved</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLOR_OPEN_UNBLOCKED }} />
            <span>Open (unblocked)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLOR_OPEN_BLOCKED }} />
            <span>Open (blocked)</span>
          </div>
          <div className="flex items-center gap-2 mt-1 pt-1 border-t border-dark-border/50">
            <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={COLOR_OPEN_BLOCKED} strokeWidth="2" /></svg>
            <span>Dependency (blocks)</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={COLOR_BORDER} strokeWidth="2" strokeDasharray="5,3" /></svg>
            <span>Parent / child</span>
          </div>
        </div>
      </div>
    </div>
  );
}
