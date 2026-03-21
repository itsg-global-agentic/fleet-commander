import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import dagre from 'dagre';
import { useApi } from '../hooks/useApi';
import { ZapIcon, SettingsIcon, RefreshCwIcon, UserIcon, ClockIcon } from '../components/Icons';
import type { StateMachineTransition, StateMachineState } from '../../shared/state-machine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StateNode = StateMachineState;
type Transition = StateMachineTransition;

interface StateMachineResponse {
  states: StateNode[];
  transitions: Transition[];
}

interface MessageTemplateData {
  id: string;
  template: string;
  enabled: boolean;
  description: string;
  placeholders: string[];
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// PM message card definitions — maps template IDs to display labels
// ---------------------------------------------------------------------------

const PM_MESSAGE_CARDS: Array<{
  id: string;
  eventName: string;
  description: string;
}> = [
  { id: 'ci_green', eventName: 'CI Passed', description: 'When CI checks pass on a PR' },
  { id: 'ci_red', eventName: 'CI Failed', description: 'When CI checks fail on a PR' },
  { id: 'pr_merged', eventName: 'PR Merged', description: 'When a PR is merged' },
  { id: 'ci_blocked', eventName: 'CI Blocked', description: 'When CI failure count exceeds threshold' },
  { id: 'stuck_nudge', eventName: 'Stuck Nudge', description: 'When a team has been idle too long' },
  { id: 'nudge_progress', eventName: 'Nudge Progress', description: 'Ask TL for a status update' },
  { id: 'ask_for_pr', eventName: 'Ask for PR', description: 'Request TL to open a pull request' },
  { id: 'check_ci', eventName: 'Check CI', description: 'Tell TL to fix failing CI' },
  { id: 'wrap_up', eventName: 'Wrap Up', description: 'Tell TL to finish and push' },
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 130;
const NODE_HEIGHT = 50;

// ---------------------------------------------------------------------------
// Trigger icon components
// ---------------------------------------------------------------------------

function TriggerIcon({ trigger, size = 14, className }: { trigger: string; size?: number; className?: string }) {
  switch (trigger) {
    case 'hook':
      return <ZapIcon size={size} className={className} />;
    case 'timer':
      return <ClockIcon size={size} className={className} />;
    case 'poller':
      return <RefreshCwIcon size={size} className={className} />;
    case 'pm_action':
      return <UserIcon size={size} className={className} />;
    case 'system':
      return <SettingsIcon size={size} className={className} />;
    default:
      return null;
  }
}

// Inline SVG paths for rendering trigger icons inside the diagram SVG.
function triggerIconSvgPaths(trigger: string, x: number, y: number, size: number, color: string, opacity: number): ReactNode {
  const scale = size / 24;
  const tx = x - size / 2;
  const ty = y - size / 2;
  const commonProps = {
    fill: 'none',
    stroke: color,
    strokeWidth: 2 / scale,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    opacity,
  };

  switch (trigger) {
    case 'hook':
      return (
        <g transform={`translate(${tx},${ty}) scale(${scale})`} {...commonProps}>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </g>
      );
    case 'timer':
      return (
        <g transform={`translate(${tx},${ty}) scale(${scale})`} {...commonProps}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </g>
      );
    case 'poller':
      return (
        <g transform={`translate(${tx},${ty}) scale(${scale})`} {...commonProps}>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </g>
      );
    case 'pm_action':
      return (
        <g transform={`translate(${tx},${ty}) scale(${scale})`} {...commonProps}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </g>
      );
    case 'system':
      return (
        <g transform={`translate(${tx},${ty}) scale(${scale})`} {...commonProps}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </g>
      );
    default:
      return null;
  }
}

const TRIGGER_LABELS: Record<string, string> = {
  hook: 'Hook event',
  timer: 'Timer (stuck detector)',
  poller: 'Poller (GitHub)',
  pm_action: 'PM action (API call)',
  system: 'System (queue, recovery)',
};

// ---------------------------------------------------------------------------
// Transition preprocessing pipeline
// ---------------------------------------------------------------------------

interface PreprocessResult {
  /** Cleaned transitions ready for chart rendering */
  transitions: Transition[];
  /** All transitions (expanded, deduped) for the table — "ALL" patterns show from:'*' */
  tableTransitions: Transition[];
}

/**
 * Preprocesses raw transitions: expand wildcards, deduplicate, re-collapse ALL patterns.
 */
function preprocessTransitions(
  states: StateNode[],
  rawTransitions: Transition[],
): PreprocessResult {
  const stateIds = states.map((s) => s.id as Transition['from']);

  // Step 1: Expand wildcards — replace from:'*' with one transition per state
  const expanded: Transition[] = rawTransitions.flatMap((t) => {
    if (t.from === '*') {
      return stateIds.map((s) => ({
        ...t,
        from: s,
        id: `${t.id}-${s}`,
      }));
    }
    return [t];
  });

  // Step 2: Deduplicate by (from + trigger + to).
  // Keep the more specific one (original definition) over wildcard-expanded.
  const seen = new Map<string, Transition>();
  for (const t of expanded) {
    const key = `${t.from}|${t.trigger}|${t.to}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, t);
    } else {
      // Prefer the specific (non-wildcard-expanded) transition — its id won't contain a dash suffix from expansion
      const existingIsExpanded = existing.id.includes(`-${existing.from}`);
      const currentIsExpanded = t.id.includes(`-${t.from}`);
      if (existingIsExpanded && !currentIsExpanded) {
        seen.set(key, t);
      }
    }
  }
  const unique = [...seen.values()];

  // Step 3: Detect "ALL" patterns — if a (trigger, to) pair has transitions from
  // every state, collapse back into a single from:'*' transition.
  const groupKey = (t: Transition) => `${t.trigger}|${t.to}`;
  const groups = new Map<string, Transition[]>();
  for (const t of unique) {
    const k = groupKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }

  const collapsed: Transition[] = [];
  for (const [, group] of groups) {
    const fromStates = new Set(group.map((t) => t.from));
    const coversAll = stateIds.every((s) => fromStates.has(s));
    if (coversAll && group.length >= stateIds.length) {
      // Use the first transition as template, restore from:'*'
      const representative = group[0];
      // Find the original wildcard transition id (strip the state suffix)
      const baseId = representative.id.replace(/-[^-]+$/, '');
      collapsed.push({
        ...representative,
        from: '*',
        id: baseId,
      });
    } else {
      collapsed.push(...group);
    }
  }

  // Build table transitions: same as collapsed but sorted for readability
  const tableTransitions = [...collapsed].sort((a, b) => {
    // "ALL" transitions first, then alphabetical by from
    if (a.from === '*' && b.from !== '*') return -1;
    if (a.from !== '*' && b.from === '*') return 1;
    if (a.from < b.from) return -1;
    if (a.from > b.from) return 1;
    if (a.to < b.to) return -1;
    if (a.to > b.to) return 1;
    return 0;
  });

  return { transitions: collapsed, tableTransitions };
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

interface ValidationWarning {
  type: 'duplicate' | 'orphan' | 'unreachable';
  message: string;
}

function validateTransitions(
  states: StateNode[],
  rawTransitions: Transition[],
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const stateIds = states.map((s) => s.id);

  // Check for duplicate transitions (same from+to+trigger in the raw data)
  const dupCheck = new Map<string, Transition[]>();
  for (const t of rawTransitions) {
    // Skip wildcards for dup check — they are by design broad
    if (t.from === '*') continue;
    const key = `${t.id}|${t.from}|${t.to}|${t.trigger}`;
    if (!dupCheck.has(key)) dupCheck.set(key, []);
    dupCheck.get(key)!.push(t);
  }
  for (const [, group] of dupCheck) {
    if (group.length > 1) {
      const ids = group.map((t) => t.id).join(', ');
      warnings.push({
        type: 'duplicate',
        message: `Duplicate transition: ${group[0].from} -> ${group[0].to} (${group[0].trigger}) defined ${group.length} times [${ids}]`,
      });
    }
  }

  // Collect all froms and tos (expand wildcards for this check)
  const hasOutgoing = new Set<string>();
  const hasIncoming = new Set<string>();
  for (const t of rawTransitions) {
    if (t.from === '*') {
      // Wildcard means every state has this outgoing
      stateIds.forEach((s) => hasOutgoing.add(s));
    } else {
      hasOutgoing.add(t.from);
    }
    hasIncoming.add(t.to);
  }

  // Orphan states: no outgoing transitions (terminal states like 'done' are expected)
  const terminalStates = new Set(['done', 'failed']);
  for (const s of stateIds) {
    if (!hasOutgoing.has(s) && !terminalStates.has(s)) {
      warnings.push({
        type: 'orphan',
        message: `Orphan state: "${s}" has no outgoing transitions`,
      });
    }
  }

  // Unreachable states: no incoming transitions (except the initial state 'queued')
  const initialStates = new Set(['queued']);
  for (const s of stateIds) {
    if (!hasIncoming.has(s) && !initialStates.has(s)) {
      warnings.push({
        type: 'unreachable',
        message: `Unreachable state: "${s}" has no incoming transitions`,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Dagre layout computation
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutEdge {
  from: string;
  to: string;
  trigger: string;
  points: Array<{ x: number; y: number }>;
  transitions: Transition[];
}

interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

const ALL_NODE_WIDTH = 70;
const ALL_NODE_HEIGHT = 30;

function computeLayout(states: StateNode[], transitions: Transition[]): LayoutResult {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: 'LR',
    nodesep: 60,
    ranksep: 120,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const stateIds = new Set(states.map((s) => s.id));

  for (const s of states) {
    g.setNode(s.id, { label: s.id, width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Check if any transitions use wildcard; if so, add an "All" pseudo-node
  const hasWildcard = transitions.some((t) => t.from === '*');
  if (hasWildcard) {
    g.setNode('*', { label: 'All', width: ALL_NODE_WIDTH, height: ALL_NODE_HEIGHT });
  }

  // For wildcard transitions, route through the "All" pseudo-node instead of
  // expanding into one edge per real state (which creates spaghetti arrows).
  const edgeMap = new Map<string, Transition[]>();
  for (const t of transitions) {
    const from = t.from === '*' ? '*' : t.from;
    // Skip edges referencing unknown states (but allow the "*" pseudo-node)
    if (from !== '*' && !stateIds.has(from)) continue;
    if (!stateIds.has(t.to)) continue;
    const key = `${from}->${t.to}|${t.trigger}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key)!.push(t);
  }

  edgeMap.forEach((_trans, key) => {
    const [fromTo, trigger] = key.split('|');
    const [from, to] = fromTo.split('->');
    g.setEdge(from, to, {}, trigger);
  });

  dagre.layout(g);

  const nodes: LayoutNode[] = g.nodes().map((id) => {
    const node = g.node(id);
    return { id, x: node.x, y: node.y, width: node.width, height: node.height };
  });

  const edges: LayoutEdge[] = g.edges().map((e) => {
    const edge = g.edge(e);
    const key = `${e.v}->${e.w}|${e.name}`;
    return {
      from: e.v,
      to: e.w,
      trigger: e.name || '',
      points: edge.points || [],
      transitions: edgeMap.get(key) || [],
    };
  });

  const graphInfo = g.graph();
  const width = (graphInfo.width || 800) + 80;
  const height = (graphInfo.height || 400) + 80;

  return { nodes, edges, width, height };
}

// ---------------------------------------------------------------------------
// Tooltip popover for clicked edge
// ---------------------------------------------------------------------------

interface TooltipInfo {
  transitions: Transition[];
  x: number;
  y: number;
}

function EdgeTooltip({
  info,
  stateColorMap,
  onClose,
}: {
  info: TooltipInfo;
  stateColorMap: Record<string, string>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Auto-dismiss after 5 seconds
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  // Dismiss on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const first = info.transitions[0];
  if (!first) return null;

  return (
    <div
      ref={ref}
      className="absolute z-50 bg-[#161B22] border border-[#30363D] rounded-lg shadow-xl p-3 min-w-[240px] max-w-[340px]"
      style={{ left: info.x, top: info.y, transform: 'translate(-50%, -100%) translateY(-8px)' }}
    >
      {info.transitions.map((t, idx) => (
        <div key={t.id} className={idx > 0 ? 'mt-3 pt-3 border-t border-[#30363D]' : ''}>
          {/* From -> To badges */}
          <div className="flex items-center gap-2 mb-2">
            <span
              className="px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{
                backgroundColor: `${stateColorMap[t.from] || '#8B949E'}20`,
                color: stateColorMap[t.from] || '#8B949E',
                border: `1px solid ${stateColorMap[t.from] || '#8B949E'}40`,
              }}
            >
              {t.from === '*' ? 'All' : t.from}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B949E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
            <span
              className="px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{
                backgroundColor: `${stateColorMap[t.to] || '#8B949E'}20`,
                color: stateColorMap[t.to] || '#8B949E',
                border: `1px solid ${stateColorMap[t.to] || '#8B949E'}40`,
              }}
            >
              {t.to}
            </span>
          </div>
          {/* Trigger */}
          <div className="flex items-center gap-1.5 text-xs text-dark-text mb-1">
            <TriggerIcon trigger={t.trigger} size={12} className="text-[#8B949E]" />
            <span className="font-medium">{t.triggerLabel}</span>
          </div>
          {/* Description */}
          <p className="text-xs text-dark-muted mb-1">{t.description}</p>
          {/* Condition */}
          <p className="text-xs font-mono text-dark-muted bg-[#0D1117] px-1.5 py-0.5 rounded">
            {t.condition}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message template card component
// ---------------------------------------------------------------------------

function MessageCard({
  cardDef,
  templateData,
  onSave,
}: {
  cardDef: { id: string; eventName: string; description: string };
  templateData: MessageTemplateData | undefined;
  onSave: (id: string, template: string, enabled: boolean) => Promise<void>;
}) {
  const [editTemplate, setEditTemplate] = useState(templateData?.template ?? '');
  const [editEnabled, setEditEnabled] = useState(templateData?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Sync local state when templateData changes (e.g., after refetch)
  useEffect(() => {
    if (templateData) {
      setEditTemplate(templateData.template);
      setEditEnabled(templateData.enabled);
    }
  }, [templateData]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await onSave(cardDef.id, editTemplate, editEnabled);
      setSaveMessage('Saved successfully');
    } catch (err: unknown) {
      setSaveMessage(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [cardDef.id, editTemplate, editEnabled, onSave]);

  const placeholders = templateData?.placeholders ?? [];

  return (
    <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-4">
      {/* Header row */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-dark-text">{cardDef.eventName}</h3>
          <p className="text-xs text-dark-muted mt-0.5">{cardDef.description}</p>
          <p className="text-[10px] text-dark-muted font-mono mt-0.5">({cardDef.id})</p>
        </div>
        {/* Enable/disable toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={editEnabled}
          aria-label={`Toggle ${cardDef.eventName} message`}
          onClick={() => setEditEnabled(!editEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 mt-0.5 ${
            editEnabled ? 'bg-[#3FB950]' : 'bg-[#30363D]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              editEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>

      {/* Template textarea */}
      <textarea
        value={editTemplate}
        onChange={(e) => {
          setEditTemplate(e.target.value);
          setSaveMessage(null);
        }}
        rows={3}
        className={`w-full text-sm font-mono rounded px-3 py-2 resize-y bg-[#0D1117] border ${
          editEnabled
            ? 'border-[#30363D] text-dark-text'
            : 'border-[#30363D] text-dark-muted opacity-60'
        } focus:outline-none focus:ring-1 focus:ring-[#58A6FF]/50`}
      />

      {/* Placeholder badges */}
      {placeholders.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {placeholders.map((p) => (
            <code
              key={p}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[#30363D] text-[#58A6FF]"
            >
              {`{{${p}}}`}
            </code>
          ))}
        </div>
      )}

      {/* Save button row */}
      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1 text-xs font-medium rounded border border-[#58A6FF]/50 text-[#58A6FF] hover:bg-[#58A6FF]/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saveMessage && (
          <span
            className={`text-xs ${
              saveMessage.includes('success') ? 'text-[#3FB950]' : 'text-[#F85149]'
            }`}
          >
            {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StateMachinePage() {
  const api = useApi();

  // Tab state
  const [activeTab, setActiveTab] = useState<'diagram' | 'table' | 'messages'>('diagram');

  // State machine data (diagram)
  const [smData, setSmData] = useState<StateMachineResponse | null>(null);
  const [smLoading, setSmLoading] = useState(true);
  const [smError, setSmError] = useState<string | null>(null);

  // Message templates data
  const [templates, setTemplates] = useState<MessageTemplateData[]>([]);

  // Diagram interaction state
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);

  // Fetch state machine
  const fetchStateMachine = useCallback(async () => {
    try {
      const result = await api.get<StateMachineResponse>('state-machine');
      setSmData(result);
      setSmError(null);
    } catch (err: unknown) {
      setSmError(err instanceof Error ? err.message : String(err));
    } finally {
      setSmLoading(false);
    }
  }, [api]);

  // Fetch message templates
  const fetchTemplates = useCallback(async () => {
    try {
      const result = await api.get<MessageTemplateData[]>('message-templates');
      setTemplates(result);
    } catch {
      // Templates failing to load is non-fatal; cards will show defaults
    }
  }, [api]);

  useEffect(() => {
    fetchStateMachine();
    fetchTemplates();
  }, [fetchStateMachine, fetchTemplates]);

  // Preprocess transitions: expand wildcards, dedup, re-collapse ALL patterns
  const preprocessed = useMemo(() => {
    if (!smData) return null;
    return preprocessTransitions(smData.states, smData.transitions);
  }, [smData]);

  // Validate raw transitions for warnings
  const validationWarnings = useMemo(() => {
    if (!smData) return [];
    return validateTransitions(smData.states, smData.transitions);
  }, [smData]);

  // Compute layout using preprocessed (deduplicated) transitions
  const layout = useMemo<LayoutResult | null>(() => {
    if (!smData || !preprocessed) return null;
    return computeLayout(smData.states, preprocessed.transitions);
  }, [smData, preprocessed]);

  // Build state color map (includes the "All" pseudo-node)
  const stateColorMap = useMemo<Record<string, string>>(() => {
    if (!smData) return {};
    const map: Record<string, string> = { '*': '#8B949E' };
    for (const s of smData.states) {
      map[s.id] = s.color;
    }
    return map;
  }, [smData]);

  // Template map for quick lookup
  const templateMap = useMemo(() => {
    const map = new Map<string, MessageTemplateData>();
    for (const t of templates) {
      map.set(t.id, t);
    }
    return map;
  }, [templates]);

  // Handle edge click — show tooltip at click position relative to the SVG container
  const handleEdgeClick = useCallback(
    (e: React.MouseEvent, transitions: Transition[]) => {
      if (!svgContainerRef.current) return;
      const rect = svgContainerRef.current.getBoundingClientRect();
      setTooltip({
        transitions,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    [],
  );

  const closeTooltip = useCallback(() => setTooltip(null), []);

  // Save handler for message cards
  const handleSaveTemplate = useCallback(
    async (id: string, template: string, enabled: boolean) => {
      await api.put(`message-templates/${id}`, { template, enabled });
      await fetchTemplates();
    },
    [api, fetchTemplates],
  );

  // --- Render ---

  if (smLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-dark-muted text-sm">Loading state machine...</p>
      </div>
    );
  }

  if (smError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-[#F85149] text-sm mb-2">Failed to load state machine</p>
          <p className="text-dark-muted text-xs">{smError}</p>
        </div>
      </div>
    );
  }

  if (!smData || !layout) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-dark-border shrink-0">
        <h1 className="text-xl font-semibold text-dark-text">Lifecycle</h1>
        <p className="text-dark-muted text-sm mt-1">
          Team lifecycle transitions and PM message templates
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-[#30363D] shrink-0">
        <button
          onClick={() => setActiveTab('diagram')}
          className={`px-3 py-1.5 text-xs font-medium rounded ${
            activeTab === 'diagram'
              ? 'bg-[#58A6FF20] text-[#58A6FF] border border-[#58A6FF40]'
              : 'text-[#8B949E] hover:text-[#E6EDF3]'
          }`}
        >
          State Machine
        </button>
        <button
          onClick={() => setActiveTab('table')}
          className={`px-3 py-1.5 text-xs font-medium rounded ${
            activeTab === 'table'
              ? 'bg-[#58A6FF20] text-[#58A6FF] border border-[#58A6FF40]'
              : 'text-[#8B949E] hover:text-[#E6EDF3]'
          }`}
        >
          Transition Table
        </button>
        <button
          onClick={() => setActiveTab('messages')}
          className={`px-3 py-1.5 text-xs font-medium rounded ${
            activeTab === 'messages'
              ? 'bg-[#58A6FF20] text-[#58A6FF] border border-[#58A6FF40]'
              : 'text-[#8B949E] hover:text-[#E6EDF3]'
          }`}
        >
          PM Messages
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'diagram' ? (
          /* State Machine tab — full height diagram */
          <div className="flex flex-col h-full">
            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-dark-muted px-6 py-3 border-b border-dark-border shrink-0">
              {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <TriggerIcon trigger={key} size={14} className="text-[#8B949E]" />
                  <span>{label}</span>
                </div>
              ))}
            </div>

            {/* Diagram */}
            <div
              ref={svgContainerRef}
              className="relative flex-1 min-h-0 p-4 overflow-auto"
            >
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                className="w-full h-auto"
                style={{ minHeight: 300 }}
              >
                <defs>
                  <marker
                    id="arrowhead"
                    markerWidth="10"
                    markerHeight="7"
                    refX="10"
                    refY="3.5"
                    orient="auto"
                  >
                    <polygon points="0 0, 10 3.5, 0 7" fill="#8B949E" />
                  </marker>
                  <marker
                    id="arrowhead-hover"
                    markerWidth="10"
                    markerHeight="7"
                    refX="10"
                    refY="3.5"
                    orient="auto"
                  >
                    <polygon points="0 0, 10 3.5, 0 7" fill="#C9D1D9" />
                  </marker>
                </defs>

                {/* Transition edges */}
                {layout.edges.map((edge) => {
                  const edgeKey = `${edge.from}->${edge.to}|${edge.trigger}`;
                  const isHovered = edgeKey === hoveredEdge;
                  const points = edge.points;
                  if (points.length === 0) return null;

                  const d = points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                  const midIdx = Math.floor(points.length / 2);
                  const midPt = points[midIdx];

                  let strokeColor = '#30363D';
                  let strokeWidth = 1.5;
                  let markerEnd = 'url(#arrowhead)';

                  if (isHovered) {
                    strokeColor = '#C9D1D9';
                    strokeWidth = 2;
                    markerEnd = 'url(#arrowhead-hover)';
                  }

                  const transCount = edge.transitions.length;

                  return (
                    <g
                      key={edgeKey}
                      className="cursor-pointer"
                      onClick={(e) => handleEdgeClick(e, edge.transitions)}
                      onMouseEnter={() => setHoveredEdge(edgeKey)}
                      onMouseLeave={() => setHoveredEdge(null)}
                    >
                      <path d={d} fill="none" stroke="transparent" strokeWidth="16" />
                      <path
                        d={d}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        markerEnd={markerEnd}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      {midPt && edge.transitions.length > 0 && (
                        triggerIconSvgPaths(
                          edge.transitions[0].trigger,
                          midPt.x,
                          midPt.y - 12,
                          14,
                          isHovered ? '#C9D1D9' : '#8B949E',
                          1,
                        )
                      )}
                      {transCount > 1 && midPt && (
                        <g>
                          <rect
                            x={midPt.x + 6}
                            y={midPt.y - 22}
                            width={transCount >= 10 ? 30 : 18}
                            height={16}
                            rx={8}
                            fill="#30363D"
                          />
                          <text
                            x={midPt.x + 6 + (transCount >= 10 ? 15 : 9)}
                            y={midPt.y - 22 + 12}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={600}
                            fill="#8B949E"
                          >
                            {transCount}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {/* State boxes */}
                {layout.nodes.map((node) => {
                  const x = node.x - node.width / 2;
                  const y = node.y - node.height / 2;

                  // Render the "All" pseudo-node as a small dashed pill
                  if (node.id === '*') {
                    return (
                      <g key="all-node">
                        <rect
                          x={x} y={y}
                          width={node.width} height={node.height}
                          rx={15} ry={15}
                          fill="none" stroke="#8B949E" strokeWidth={1.5} strokeDasharray="4 2"
                        />
                        <text
                          x={node.x} y={node.y}
                          textAnchor="middle" dominantBaseline="central"
                          fill="#8B949E" fontSize={11} fontWeight={600}
                          className="select-none"
                        >
                          All
                        </text>
                      </g>
                    );
                  }

                  const color = stateColorMap[node.id] || '#8B949E';
                  const tintBg = `${color}18`;

                  return (
                    <g key={node.id}>
                      <rect x={x} y={y} width={node.width} height={node.height} rx={8} ry={8} fill="#0D1117" />
                      <rect x={x} y={y} width={node.width} height={node.height} rx={8} ry={8} fill={tintBg} />
                      <rect x={x} y={y} width={node.width} height={node.height} rx={8} ry={8} fill="none" stroke={color} strokeWidth={2} />
                      <text
                        x={node.x}
                        y={node.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={14}
                        fontWeight={700}
                        fill={color}
                        className="select-none"
                      >
                        {node.id}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {/* Tooltip popover */}
              {tooltip && (
                <EdgeTooltip
                  info={tooltip}
                  stateColorMap={stateColorMap}
                  onClose={closeTooltip}
                />
              )}
            </div>

            {/* Validation warnings */}
            {validationWarnings.length > 0 && (
              <div className="px-6 py-3 border-t border-dark-border shrink-0">
                <h3 className="text-sm font-medium text-[#D29922] mb-2">Validation Warnings</h3>
                <ul className="space-y-1">
                  {validationWarnings.map((w, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-xs">
                      <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded font-mono text-[10px] ${
                        w.type === 'duplicate'
                          ? 'bg-[#F8514920] text-[#F85149]'
                          : w.type === 'orphan'
                            ? 'bg-[#D2992220] text-[#D29922]'
                            : 'bg-[#58A6FF20] text-[#58A6FF]'
                      }`}>
                        {w.type}
                      </span>
                      <span className="text-dark-muted">{w.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : activeTab === 'table' ? (
          /* Transition Table tab */
          <div className="flex flex-col h-full">
            {preprocessed && (
              <div className="px-6 py-4 flex-1 min-h-0 overflow-auto">
                <h2 className="text-sm font-medium text-dark-text mb-3">
                  Transition Table ({preprocessed.tableTransitions.length} transitions)
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="text-left text-dark-muted border-b border-[#30363D]">
                        <th className="py-2 pr-4 font-medium">From</th>
                        <th className="py-2 pr-4 font-medium">To</th>
                        <th className="py-2 pr-4 font-medium">Trigger</th>
                        <th className="py-2 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preprocessed.tableTransitions.map((t) => (
                        <tr key={t.id} className="border-b border-[#30363D]/50 hover:bg-[#161B22]">
                          <td className="py-1.5 pr-4">
                            <span
                              className="px-2 py-0.5 rounded-full text-xs font-semibold"
                              style={{
                                backgroundColor: `${stateColorMap[t.from] || '#8B949E'}20`,
                                color: stateColorMap[t.from] || '#8B949E',
                                border: `1px solid ${stateColorMap[t.from] || '#8B949E'}40`,
                              }}
                            >
                              {t.from === '*' ? 'ALL' : t.from}
                            </span>
                          </td>
                          <td className="py-1.5 pr-4">
                            <span
                              className="px-2 py-0.5 rounded-full text-xs font-semibold"
                              style={{
                                backgroundColor: `${stateColorMap[t.to] || '#8B949E'}20`,
                                color: stateColorMap[t.to] || '#8B949E',
                                border: `1px solid ${stateColorMap[t.to] || '#8B949E'}40`,
                              }}
                            >
                              {t.to}
                            </span>
                          </td>
                          <td className="py-1.5 pr-4">
                            <div className="flex items-center gap-1.5">
                              <TriggerIcon trigger={t.trigger} size={12} className="text-[#8B949E]" />
                              <span className="text-dark-text">{t.triggerLabel}</span>
                            </div>
                          </td>
                          <td className="py-1.5 text-dark-muted">{t.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Validation warnings */}
            {validationWarnings.length > 0 && (
              <div className="px-6 py-3 border-t border-dark-border shrink-0">
                <h3 className="text-sm font-medium text-[#D29922] mb-2">Validation Warnings</h3>
                <ul className="space-y-1">
                  {validationWarnings.map((w, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-xs">
                      <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded font-mono text-[10px] ${
                        w.type === 'duplicate'
                          ? 'bg-[#F8514920] text-[#F85149]'
                          : w.type === 'orphan'
                            ? 'bg-[#D2992220] text-[#D29922]'
                            : 'bg-[#58A6FF20] text-[#58A6FF]'
                      }`}>
                        {w.type}
                      </span>
                      <span className="text-dark-muted">{w.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          /* PM Messages tab — full height message cards */
          <div className="px-6 py-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-dark-text">PM &rarr; Team Leader Messages</h2>
              <p className="text-dark-muted text-sm mt-0.5">
                Messages automatically sent to your team leads when events occur
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {PM_MESSAGE_CARDS.map((cardDef) => (
                <MessageCard
                  key={cardDef.id}
                  cardDef={cardDef}
                  templateData={templateMap.get(cardDef.id)}
                  onSave={handleSaveTemplate}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
