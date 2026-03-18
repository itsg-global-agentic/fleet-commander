import { useState, useMemo, useCallback } from 'react';
import type { MessageEdge, TeamMember } from '../../shared/types';

// ---------------------------------------------------------------------------
// Color helper — same hash-to-palette approach as TeamDetail roster
// ---------------------------------------------------------------------------

const AGENT_PALETTE = [
  '#58A6FF', '#3FB950', '#D29922', '#A371F7', '#F778BA',
  '#79C0FF', '#7EE787', '#E3B341', '#D2A8FF', '#FF7B72',
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

interface NodePosition {
  name: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  isActive: boolean;
  messageCount: number;
}

/** Determine edge thickness class from message count */
function edgeWidth(count: number): number {
  if (count >= 9) return 3.5;
  if (count >= 4) return 2;
  return 1;
}

function edgeOpacity(count: number): number {
  if (count >= 9) return 1;
  if (count >= 4) return 0.7;
  return 0.4;
}

/** Place nodes in hub-and-spoke: hub at center, spokes radially */
function layoutNodes(
  agents: TeamMember[],
  edges: MessageEdge[],
  cx: number,
  cy: number,
  orbitRadius: number,
): NodePosition[] {
  // Build total message counts per agent for sizing
  const msgCounts = new Map<string, number>();
  for (const e of edges) {
    msgCounts.set(e.sender, (msgCounts.get(e.sender) ?? 0) + e.count);
    msgCounts.set(e.recipient, (msgCounts.get(e.recipient) ?? 0) + e.count);
  }

  // Identify the hub: prefer "team-lead" or "coordinator", else pick the agent
  // with the most messages. Fallback to first agent.
  const hubCandidates = agents.filter(
    (a) => a.name === 'team-lead' || a.name === 'coordinator',
  );
  let hub: TeamMember | undefined = hubCandidates[0];
  if (!hub) {
    // Pick the agent with highest message volume
    let maxCount = -1;
    for (const a of agents) {
      const c = msgCounts.get(a.name) ?? 0;
      if (c > maxCount) {
        maxCount = c;
        hub = a;
      }
    }
  }
  if (!hub) hub = agents[0];

  const maxMsg = Math.max(1, ...Array.from(msgCounts.values()));

  const hubName = hub.name;
  const spokes = agents.filter((a) => a.name !== hubName);

  const positions: NodePosition[] = [];

  // Radius: scale between 14 and 24 based on message volume
  const nodeRadius = (name: string) => {
    const count = msgCounts.get(name) ?? 0;
    return 14 + (count / maxMsg) * 10;
  };

  // Hub
  positions.push({
    name: hubName,
    x: cx,
    y: cy,
    radius: nodeRadius(hubName),
    color: agentColor(hubName),
    isActive: hub.isActive,
    messageCount: msgCounts.get(hubName) ?? 0,
  });

  // Spokes
  const angleStep = (2 * Math.PI) / Math.max(spokes.length, 1);
  const startAngle = -Math.PI / 2; // Start from top
  spokes.forEach((agent, i) => {
    const angle = startAngle + i * angleStep;
    positions.push({
      name: agent.name,
      x: cx + orbitRadius * Math.cos(angle),
      y: cy + orbitRadius * Math.sin(angle),
      radius: nodeRadius(agent.name),
      color: agentColor(agent.name),
      isActive: agent.isActive,
      messageCount: msgCounts.get(agent.name) ?? 0,
    });
  });

  return positions;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CommGraphProps {
  edges: MessageEdge[];
  agents: TeamMember[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommGraph({ edges, agents }: CommGraphProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ sender: string; recipient: string } | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // SVG viewBox dimensions
  const vw = 500;
  const vh = 380;
  const cx = vw / 2;
  const cy = vh / 2;
  const orbitRadius = Math.min(cx, cy) * 0.6;

  const nodes = useMemo(
    () => layoutNodes(agents, edges, cx, cy, orbitRadius),
    [agents, edges, cx, cy, orbitRadius],
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, NodePosition>();
    for (const n of nodes) map.set(n.name, n);
    return map;
  }, [nodes]);

  // Filter edges when a node is selected
  const visibleEdges = useMemo(() => {
    if (!selectedNode) return edges;
    return edges.filter(
      (e) => e.sender === selectedNode || e.recipient === selectedNode,
    );
  }, [edges, selectedNode]);

  const handleNodeClick = useCallback((name: string) => {
    setSelectedNode((prev) => (prev === name ? null : name));
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Empty state
  if (agents.length < 2 || edges.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-dark-muted text-sm">
        {agents.length < 2
          ? 'Waiting for multiple agents to communicate...'
          : 'No communication data available'}
      </div>
    );
  }

  // Arrowhead marker ID
  const markerId = 'comm-arrow';

  return (
    <div className="relative w-full h-full min-h-[300px]">
      <svg
        viewBox={`0 0 ${vw} ${vh}`}
        className="w-full h-full"
        style={{ maxHeight: '100%' }}
        onClick={handleBackgroundClick}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 7"
            refX="10"
            refY="3.5"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#8B949E" />
          </marker>
        </defs>

        {/* Edges */}
        {visibleEdges.map((edge) => {
          const from = nodeMap.get(edge.sender);
          const to = nodeMap.get(edge.recipient);
          if (!from || !to) return null;

          // Shorten line to stop at node border (radius + gap)
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) return null;

          const ux = dx / dist;
          const uy = dy / dist;
          const startGap = from.radius + 3;
          const endGap = to.radius + 6; // extra for arrowhead

          const x1 = from.x + ux * startGap;
          const y1 = from.y + uy * startGap;
          const x2 = to.x - ux * endGap;
          const y2 = to.y - uy * endGap;

          const isHovered =
            hoveredEdge?.sender === edge.sender &&
            hoveredEdge?.recipient === edge.recipient;

          const dimmed =
            selectedNode !== null &&
            edge.sender !== selectedNode &&
            edge.recipient !== selectedNode;

          const key = `${edge.sender}->${edge.recipient}`;

          return (
            <line
              key={key}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={isHovered ? '#E6EDF3' : agentColor(edge.sender)}
              strokeWidth={edgeWidth(edge.count)}
              strokeOpacity={dimmed ? 0.12 : edgeOpacity(edge.count)}
              markerEnd={`url(#${markerId})`}
              className="cursor-pointer transition-all duration-150"
              onMouseEnter={(e) => {
                e.stopPropagation();
                setHoveredEdge({ sender: edge.sender, recipient: edge.recipient });
              }}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setMousePos({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseLeave={() => setHoveredEdge(null)}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const dimmed =
            selectedNode !== null && selectedNode !== node.name;
          const isSelected = selectedNode === node.name;

          return (
            <g
              key={node.name}
              onClick={(e) => {
                e.stopPropagation();
                handleNodeClick(node.name);
              }}
              className="cursor-pointer"
              opacity={dimmed ? 0.35 : 1}
            >
              {/* Selection ring */}
              {isSelected && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius + 4}
                  fill="none"
                  stroke={node.color}
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  opacity={0.6}
                />
              )}
              {/* Node circle */}
              <circle
                cx={node.x}
                cy={node.y}
                r={node.radius}
                fill={node.color + '20'}
                stroke={node.isActive ? node.color : '#484F58'}
                strokeWidth={2}
              />
              {/* Active/stopped indicator dot */}
              <circle
                cx={node.x + node.radius * 0.65}
                cy={node.y - node.radius * 0.65}
                r={4}
                fill={node.isActive ? '#3FB950' : '#484F58'}
                stroke="#0D1117"
                strokeWidth={1.5}
              />
              {/* Agent initial */}
              <text
                x={node.x}
                y={node.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={node.isActive ? node.color : '#484F58'}
                fontSize={node.radius * 0.85}
                fontWeight="bold"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.name.charAt(0).toUpperCase()}
              </text>
              {/* Agent name below */}
              <text
                x={node.x}
                y={node.y + node.radius + 13}
                textAnchor="middle"
                fill={dimmed ? '#484F58' : '#8B949E'}
                fontSize={10}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.name.length > 12 ? node.name.slice(0, 11) + '\u2026' : node.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip for hovered edge */}
      {hoveredEdge && (() => {
        const edge = edges.find(
          (e) => e.sender === hoveredEdge.sender && e.recipient === hoveredEdge.recipient,
        );
        if (!edge) return null;
        return (
          <div
            className="absolute px-2.5 py-1.5 bg-dark-surface border border-dark-border rounded text-[11px] text-dark-text shadow-lg pointer-events-none z-20"
            style={{
              left: mousePos.x + 12,
              top: mousePos.y - 8,
              maxWidth: 260,
            }}
          >
            <div className="font-semibold">
              <span style={{ color: agentColor(edge.sender) }}>{edge.sender}</span>
              {' \u2192 '}
              <span style={{ color: agentColor(edge.recipient) }}>{edge.recipient}</span>
            </div>
            <div className="text-dark-muted mt-0.5">
              {edge.count} message{edge.count !== 1 ? 's' : ''}
            </div>
            {edge.lastSummary && (
              <div className="text-dark-muted mt-0.5 italic truncate">
                {edge.lastSummary}
              </div>
            )}
          </div>
        );
      })()}

      {/* Legend */}
      {selectedNode && (
        <div className="absolute top-2 right-2 text-[10px] text-dark-muted bg-dark-surface/80 border border-dark-border/50 rounded px-2 py-1">
          Filtering: <span className="text-dark-text font-medium">{selectedNode}</span>
          <span className="ml-1 opacity-60">(click to clear)</span>
        </div>
      )}
    </div>
  );
}
