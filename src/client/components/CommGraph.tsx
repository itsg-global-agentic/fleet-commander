import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import ForceGraph from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
// d3-force-3d is a transitive dep of react-force-graph-2d (no type declarations)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — d3-force-3d has no type declarations
import { forceCollide, forceY } from 'd3-force-3d';
import type { MessageEdge, TeamMember } from '../../shared/types';
import { agentColor } from '../utils/constants';

// ---------------------------------------------------------------------------
// Name normalization — client-side defense for historical data
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.startsWith('fleet-')) n = n.slice(6);
  return n;
}

// ---------------------------------------------------------------------------
// Graph node and link types
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  name: string;
  role: string;
  color: string;
  isActive: boolean;
  isTL: boolean;
  fx?: number;
  fy?: number;
}

interface GraphLink {
  source: string;
  target: string;
  count: number;
  isSpawn: boolean;
  lastSummary: string | null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CommGraphProps {
  edges: MessageEdge[];
  agents: TeamMember[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_RADIUS = 16;
const ACTIVE_DOT_RADIUS = 4;
const FONT_SIZE_INITIAL = 14;
const FONT_SIZE_LABEL = 10;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommGraph({ edges, agents }: CommGraphProps) {
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink>>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 500, height: 380 });
  const prevEdgesRef = useRef<MessageEdge[]>([]);

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
    // Set initial dimensions
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setDimensions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    }

    return () => observer.disconnect();
  }, []);

  // Find TL node
  const tlName = useMemo(() => {
    const tl = agents.find((a) => {
      const n = normalizeName(a.name);
      return n === 'team-lead' || n === 'coordinator' || n === 'tl';
    });
    return tl?.name ?? (agents.length > 0 ? agents[0].name : null);
  }, [agents]);

  // Build graph data
  const graphData = useMemo(() => {
    const nodes: GraphNode[] = agents.map((agent) => {
      const isTL = agent.name === tlName;
      return {
        id: agent.name,
        name: agent.name,
        role: agent.role,
        color: agentColor(agent.name, agent.role),
        isActive: agent.isActive,
        isTL,
        // Pin TL node near center-top
        ...(isTL ? { fx: 0, fy: -40 } : {}),
      };
    });

    const links: GraphLink[] = [];

    // Build a normalized name -> original name lookup for edge matching
    const nameMap = new Map<string, string>();
    for (const agent of agents) {
      nameMap.set(normalizeName(agent.name), agent.name);
    }

    // Spawn edges: TL -> every non-TL agent (dashed, no count)
    if (tlName) {
      for (const agent of agents) {
        if (agent.name !== tlName) {
          links.push({
            source: tlName,
            target: agent.name,
            count: 0,
            isSpawn: true,
            lastSummary: null,
          });
        }
      }
    }

    // Message edges from the edges prop
    for (const edge of edges) {
      // Resolve sender/recipient to roster names
      const senderResolved = nameMap.get(normalizeName(edge.sender)) ?? edge.sender;
      const recipientResolved = nameMap.get(normalizeName(edge.recipient)) ?? edge.recipient;

      // Skip if either end is not in the roster
      const senderInRoster = agents.some((a) => a.name === senderResolved);
      const recipientInRoster = agents.some((a) => a.name === recipientResolved);
      if (!senderInRoster || !recipientInRoster) continue;

      // Skip if this would duplicate a spawn edge in the same direction
      const isSpawnDuplicate =
        (senderResolved === tlName || recipientResolved === tlName) &&
        links.some(
          (l) =>
            l.isSpawn &&
            l.source === senderResolved &&
            l.target === recipientResolved,
        );
      if (isSpawnDuplicate) {
        // Update the spawn edge with message count instead
        const spawnEdge = links.find(
          (l) =>
            l.isSpawn &&
            l.source === senderResolved &&
            l.target === recipientResolved,
        );
        if (spawnEdge) {
          spawnEdge.count = edge.count;
          spawnEdge.isSpawn = false;
          spawnEdge.lastSummary = edge.lastSummary;
        }
        continue;
      }

      links.push({
        source: senderResolved,
        target: recipientResolved,
        count: edge.count,
        isSpawn: false,
        lastSummary: edge.lastSummary,
      });
    }

    return { nodes, links };
  }, [agents, edges, tlName]);

  // Emit particles for new or increased message edges (synapse animation)
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !edges.length) return;

    const prevEdges = prevEdgesRef.current;
    const prevMap = new Map<string, number>();
    for (const e of prevEdges) {
      prevMap.set(`${e.sender}->${e.recipient}`, e.count);
    }

    for (const edge of edges) {
      const key = `${edge.sender}->${edge.recipient}`;
      const prevCount = prevMap.get(key) ?? 0;
      if (edge.count > prevCount) {
        // Find the matching link in graphData
        const link = graphData.links.find(
          (l) => {
            const src = typeof l.source === 'object' ? (l.source as GraphNode).id : l.source;
            const tgt = typeof l.target === 'object' ? (l.target as GraphNode).id : l.target;
            return src === edge.sender && tgt === edge.recipient;
          },
        );
        if (link) {
          try {
            fg.emitParticle(link);
          } catch {
            // Silently ignore — particle emission is cosmetic
          }
        }
      }
    }

    prevEdgesRef.current = edges;
  }, [edges, graphData.links]);

  // Configure d3 forces for better node distribution
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || agents.length === 0) return;

    // Stronger charge repulsion to push nodes apart
    const charge = fg.d3Force('charge');
    if (charge && typeof charge.strength === 'function') {
      charge.strength(-200);
    }

    // Collision force prevents node overlap (NODE_RADIUS + padding)
    fg.d3Force('collide', forceCollide(NODE_RADIUS + 20));

    // Gentle y-force pushes non-pinned nodes below the TL
    fg.d3Force('y', forceY(60).strength(0.1));

    // Reheat the simulation so the new forces take effect
    fg.d3ReheatSimulation();
  }, [agents.length]);

  // Zoom to fit after data loads
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || agents.length === 0) return;
    const timer = setTimeout(() => {
      fg.zoomToFit(400, 60);
    }, 500);
    return () => clearTimeout(timer);
  }, [agents.length]);

  // Custom node rendering
  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = NODE_RADIUS;
      const fontSize = FONT_SIZE_INITIAL / globalScale;
      const labelFontSize = FONT_SIZE_LABEL / globalScale;

      // Node circle fill
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + '66';
      ctx.fill();

      // Node circle border
      ctx.strokeStyle = node.isActive ? node.color : '#484F58';
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();

      // Active/stopped indicator dot
      const dotX = x + r * 0.65;
      const dotY = y - r * 0.65;
      const dotR = ACTIVE_DOT_RADIUS / globalScale;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotR, 0, 2 * Math.PI);
      ctx.fillStyle = node.isActive ? '#3FB950' : '#484F58';
      ctx.fill();
      ctx.strokeStyle = '#0D1117';
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();

      // Agent initial
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = node.isActive ? node.color : '#484F58';
      ctx.fillText(node.name.charAt(0).toUpperCase(), x, y);

      // Full agent name below node
      ctx.font = `${labelFontSize}px sans-serif`;
      ctx.fillStyle = '#8B949E';
      ctx.fillText(node.name, x, y + r + 10 / globalScale);

      // Role label below name (smaller)
      if (node.role) {
        ctx.font = `${labelFontSize * 0.85}px sans-serif`;
        ctx.fillStyle = '#484F58';
        ctx.fillText(node.role, x, y + r + 20 / globalScale);
      }
    },
    [],
  );

  // Node pointer area for hover/click detection
  const nodePointerAreaPaint = useCallback(
    (node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  // Link width based on message count
  const linkWidth = useCallback((link: GraphLink) => {
    if (link.isSpawn) return 1;
    if (link.count >= 9) return 3.5;
    if (link.count >= 4) return 2;
    return 1;
  }, []);

  // Link color
  const linkColor = useCallback((link: GraphLink) => {
    if (link.isSpawn) return '#30363D';
    return '#8B949E';
  }, []);

  // Link dashed pattern: spawn edges are dashed, message edges are solid
  const linkLineDash = useCallback((link: GraphLink) => {
    return link.isSpawn ? [4, 4] : null;
  }, []);

  // Link label on hover
  const linkLabel = useCallback((link: GraphLink) => {
    if (link.isSpawn && link.count === 0) return '';
    const summary = link.lastSummary ? `<br/><i>${link.lastSummary}</i>` : '';
    return `<div style="padding:4px 8px;background:#161B22;border:1px solid #30363D;border-radius:4px;font-size:11px;color:#E6EDF3;">
      <b>${typeof link.source === 'object' ? (link.source as GraphNode).id : link.source}</b>
      &rarr;
      <b>${typeof link.target === 'object' ? (link.target as GraphNode).id : link.target}</b>
      <br/>${link.count} message${link.count !== 1 ? 's' : ''}${summary}
    </div>`;
  }, []);

  // Directional particles for message edges
  const linkDirectionalParticles = useCallback((link: GraphLink) => {
    if (link.isSpawn) return 0;
    if (link.count >= 6) return 3;
    if (link.count >= 3) return 2;
    return link.count > 0 ? 1 : 0;
  }, []);

  // Directional arrows for message edges
  const linkDirectionalArrowLength = useCallback((link: GraphLink) => {
    return link.isSpawn ? 0 : 6;
  }, []);

  // Empty state — show only when no agents at all
  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-dark-muted text-sm">
        Waiting for agents to join the team...
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
        linkWidth={linkWidth}
        linkColor={linkColor}
        linkLineDash={linkLineDash}
        linkLabel={linkLabel}
        linkDirectionalParticles={linkDirectionalParticles}
        linkDirectionalParticleWidth={3}
        linkDirectionalParticleSpeed={0.005}
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
        minZoom={0.5}
        maxZoom={4}
      />
    </div>
  );
}
