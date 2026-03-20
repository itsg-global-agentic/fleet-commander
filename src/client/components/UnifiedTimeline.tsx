import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import type { TimelineEntry, StreamTimelineEntry, HookTimelineEntry, TeamMember } from '../../shared/types';
import { agentColor } from '../utils/constants';
import { AgentFilterBar } from './AgentFilterBar';
import { SettingsIcon } from './Icons';

// ---------------------------------------------------------------------------
// Helpers — agent name display
// ---------------------------------------------------------------------------

/** Canonical display name for an agent (capitalise first letter) */
function agentDisplayName(name: string | undefined): string {
  if (!name || name === 'team-lead' || name === 'tl') return 'TL';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// Helpers — stream event rendering
// ---------------------------------------------------------------------------

const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  assistant:        { color: '#58A6FF', label: 'TL' },
  user:             { color: '#3FB950', label: 'You' },
  fc:               { color: '#D29922', label: 'FC' },
  system:           { color: '#8B949E', label: 'system' },
  tool_use:         { color: '#D29922', label: 'tool' },
  tool_result:      { color: '#A371F7', label: 'result' },
  result:           { color: '#3FB950', label: 'done' },
  rate_limit_event: { color: '#D29922', label: 'rate-limit' },
};

function getStreamStyle(type: string) {
  return TYPE_STYLES[type] ?? { color: '#8B949E', label: type };
}

const FC_SUBTYPE_LABELS: Record<string, string> = {
  initial_prompt:     'prompt',
  origin_sync:        'sync',
  idle_nudge:         'idle',
  stuck_nudge:        'nudge',
  ci_green:           'CI pass',
  ci_red:             'CI fail',
  ci_blocked:         'CI blocked',
  pr_merged_shutdown: 'shutdown',
  subagent_crash:     'crash',
};

function getSubtypeLabel(subtype: string | undefined): string | null {
  if (!subtype) return null;
  return FC_SUBTYPE_LABELS[subtype] ?? subtype;
}

/** Text types that render inline message content */
const TEXT_TYPES = new Set(['assistant', 'user', 'fc']);

function getStreamText(entry: StreamTimelineEntry): string {
  if (!TEXT_TYPES.has(entry.streamType)) return '';
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Helpers — hook event rendering
// ---------------------------------------------------------------------------

/** Hook event types that represent lifecycle transitions */
const LIFECYCLE_TYPES = new Set([
  'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop',
]);

/** Hook event types that represent errors */
const ERROR_TYPES = new Set(['ToolError', 'StopFailure']);

function extractPayloadError(payload: string | undefined): string | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'string'
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Malformed JSON
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

/** Resolve agent name for a stream entry, falling back to type-based label */
function resolveAgentLabel(entry: StreamTimelineEntry): { label: string; color: string } {
  // user and fc types always use their own labels
  if (entry.streamType === 'user') return { label: 'You', color: '#3FB950' };
  if (entry.streamType === 'fc') return { label: 'FC', color: '#D29922' };

  // For assistant and tool_use, use the agentName if available
  if (entry.agentName && (entry.streamType === 'assistant' || entry.streamType === 'tool_use')) {
    const name = agentDisplayName(entry.agentName);
    const color = agentColor(entry.agentName, entry.agentName);
    return { label: name, color };
  }

  // Fallback to type-based styles
  return getStreamStyle(entry.streamType);
}

/** Resolve agent label for a hook event entry */
function resolveHookAgentLabel(entry: HookTimelineEntry): { label: string; color: string } {
  if (entry.agentName) {
    const name = agentDisplayName(entry.agentName);
    const color = agentColor(entry.agentName, entry.agentName);
    return { label: name, color };
  }
  // Fallback when no agent name is present
  return { label: 'System', color: '#8B949E' };
}

// ---------------------------------------------------------------------------
// Sub-components for each entry type
// ---------------------------------------------------------------------------

function StreamEntryRow({ entry }: { entry: StreamTimelineEntry }) {
  const text = getStreamText(entry);
  const isMultiline = text.includes('\n');

  // System task_progress/task_notification — compact single-line entry
  if (entry.streamType === 'system' && (entry.subtype === 'task_progress' || entry.subtype === 'task_notification')) {
    const name = agentDisplayName(entry.agentName);
    const color = entry.agentName ? agentColor(entry.agentName, entry.agentName) : '#8B949E';
    const toolLabel = entry.lastToolName ?? entry.tool?.name;
    const desc = entry.description;

    return (
      <div className="py-0 leading-snug flex items-center gap-1.5 text-[10px] text-dark-muted">
        <span>{formatLocalTime(entry.timestamp)}</span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span style={{ color }} className="font-medium">{name}</span>
        {toolLabel && (
          <>
            <span className="text-dark-muted">
              <SettingsIcon size={10} />
            </span>
            <span className="text-dark-muted">{toolLabel}</span>
          </>
        )}
        {desc && (
          <span className="text-dark-muted truncate">{desc}</span>
        )}
      </div>
    );
  }

  // Text messages (assistant, user, fc)
  if (TEXT_TYPES.has(entry.streamType) && text) {
    const { label, color } = resolveAgentLabel(entry);
    return (
      <div className="py-0.5 leading-relaxed">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        {' '}
        <span
          className="inline-block w-1.5 h-1.5 rounded-full mr-0.5 align-middle"
          style={{ backgroundColor: color }}
        />
        <span style={{ color }} className="font-semibold">{label}</span>
        {entry.streamType === 'fc' && entry.subtype && (
          <span className="text-dark-muted text-[10px] ml-1">[{getSubtypeLabel(entry.subtype)}]</span>
        )}
        {' '}
        {isMultiline ? (
          <span className="text-dark-text whitespace-pre-wrap">{text}</span>
        ) : (
          <span className="text-dark-text">{text}</span>
        )}
      </div>
    );
  }

  // Tool use — compact badge
  if (entry.streamType === 'tool_use' && entry.tool?.name) {
    const { label, color } = resolveAgentLabel(entry);
    return (
      <div className="py-0.5 leading-relaxed flex items-center gap-1.5">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span style={{ color }} className="font-semibold">{label}</span>
        <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
          {entry.tool.name}
        </span>
      </div>
    );
  }

  // Result / tool_result — compact
  if (entry.streamType === 'result' || entry.streamType === 'tool_result') {
    const { color, label } = getStreamStyle(entry.streamType);
    return (
      <div className="py-0.5 leading-relaxed">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        {' '}
        <span style={{ color }} className="font-semibold">{label}</span>
      </div>
    );
  }

  // All other stream types — generic line
  if (text) {
    const { color, label } = getStreamStyle(entry.streamType);
    return (
      <div className="py-0.5 leading-relaxed">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        {' '}
        <span style={{ color }} className="font-semibold">{label}</span>
        {' '}
        <span className="text-dark-text">{text}</span>
      </div>
    );
  }

  // Fallback: skip entries with no displayable content
  return null;
}

function HookEntryRow({ entry }: { entry: HookTimelineEntry }) {
  const isLifecycle = LIFECYCLE_TYPES.has(entry.eventType);
  const isError = ERROR_TYPES.has(entry.eventType);
  const errorMsg = isError ? extractPayloadError(entry.payload) : null;
  const { label, color } = resolveHookAgentLabel(entry);

  // Lifecycle events — agent dot + name + event badge
  if (isLifecycle) {
    const lifecycleColor = entry.eventType === 'SessionStart' || entry.eventType === 'SubagentStart'
      ? '#3FB950'
      : '#8B949E';

    return (
      <div className="py-0 leading-snug flex items-center gap-1.5 text-[10px] text-dark-muted">
        <span>{formatLocalTime(entry.timestamp)}</span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span style={{ color }} className="font-medium">{label}</span>
        <span
          className="font-normal px-1.5 rounded"
          style={{ color: lifecycleColor, backgroundColor: lifecycleColor + '18' }}
        >
          {entry.eventType}
        </span>
      </div>
    );
  }

  // Error events — agent dot + name + red error info
  if (isError) {
    return (
      <div className="py-0 leading-snug text-[10px] text-dark-muted">
        <div className="flex items-center gap-1.5">
          <span>{formatLocalTime(entry.timestamp)}</span>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span style={{ color }} className="font-medium">{label}</span>
          <span className="font-normal text-[#F85149]">
            {entry.eventType}
          </span>
          {entry.toolName && (
            <span className="text-dark-muted bg-dark-border/30 px-1.5 rounded">
              {entry.toolName}
            </span>
          )}
        </div>
        {errorMsg && (
          <div className="ml-[52px] text-[#F85149] mt-0.5 line-clamp-2">
            {errorMsg}
          </div>
        )}
      </div>
    );
  }

  // Generic hook event — agent dot + name + event type + tool badge
  return (
    <div className="py-0 leading-snug flex items-center gap-1.5 text-[10px] text-dark-muted">
      <span>{formatLocalTime(entry.timestamp)}</span>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span style={{ color }} className="font-medium">{label}</span>
      <span className="text-dark-text font-normal">
        {entry.eventType}
      </span>
      {entry.toolName && (
        <span className="text-dark-muted bg-dark-border/30 px-1.5 rounded">
          {entry.toolName}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UnifiedTimelineProps {
  teamId: number;
  teamStatus?: string;
  isThinking?: boolean;
  /** Team roster for agent filter pills */
  roster?: TeamMember[];
  /** Currently active agent name filters (empty set = show all) */
  agentFilters?: Set<string>;
  /** Callback to update agent filters */
  onAgentFiltersChange?: (filters: Set<string>) => void;
}

/** Resolve the agent name for a timeline entry (for filtering purposes) */
function getEntryAgentName(entry: TimelineEntry): string | undefined {
  if (entry.source === 'stream') {
    // Map user/fc stream types to sentinel keys for filtering
    if (entry.streamType === 'user') return '__pm__';
    if (entry.streamType === 'fc') return '__fc__';
    return entry.agentName;
  }
  // Hook entries already have agentName
  return entry.agentName;
}

export function UnifiedTimeline({
  teamId,
  teamStatus,
  isThinking,
  roster,
  agentFilters,
  onAgentFiltersChange,
}: UnifiedTimelineProps) {
  const api = useApi();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Detect if user has scrolled up — disable auto-scroll in that case
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // "Stick to bottom" if scrolled within 40px of the bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
  }, []);

  // Poll for timeline data every 2 seconds
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const data = await api.get<TimelineEntry[]>(`teams/${teamId}/timeline?limit=500`);
        if (!cancelled) {
          setEntries(data);
        }
      } catch {
        // Ignore polling errors
      }
    }

    // Initial fetch
    poll();

    // Stop polling when team is in a terminal state
    if (teamStatus === 'done' || teamStatus === 'failed') {
      return () => { cancelled = true; };
    }

    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, teamId, teamStatus]);

  // Filter entries by active agent filters
  const filteredEntries = useMemo(() => {
    if (!agentFilters || agentFilters.size === 0) return entries;
    return entries.filter((entry) => {
      const name = getEntryAgentName(entry);
      // If entry has no agent name, always show it (lifecycle events, etc.)
      if (!name) return true;
      return agentFilters.has(name);
    });
  }, [entries, agentFilters]);

  // Auto-scroll to bottom when new entries arrive (only if stuck to bottom)
  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredEntries.length]);

  // Copy full text log to clipboard
  const handleCopy = useCallback(() => {
    const lines: string[] = [];
    for (const entry of filteredEntries) {
      const ts = formatLocalTime(entry.timestamp);
      if (entry.source === 'stream') {
        const text = getStreamText(entry);
        if (text) {
          const agent = entry.agentName ? agentDisplayName(entry.agentName) : getStreamStyle(entry.streamType).label;
          const subtypeTag = entry.streamType === 'fc' && entry.subtype
            ? ` [${getSubtypeLabel(entry.subtype)}]`
            : '';
          lines.push(`[${ts}] ${agent}${subtypeTag}: ${text}`);
        } else if (entry.streamType === 'tool_use' && entry.tool?.name) {
          const agent = entry.agentName ? agentDisplayName(entry.agentName) : 'tool';
          lines.push(`[${ts}] ${agent}: ${entry.tool.name}`);
        } else if (entry.streamType === 'system' && entry.description) {
          const agent = entry.agentName ? agentDisplayName(entry.agentName) : 'system';
          lines.push(`[${ts}] ${agent}: ${entry.lastToolName ?? ''} ${entry.description}`);
        }
      } else {
        const hook = entry;
        const agent = hook.agentName ? agentDisplayName(hook.agentName) : 'System';
        let detail = hook.eventType;
        if (hook.toolName) detail += ` (${hook.toolName})`;
        lines.push(`[${ts}] ${agent}: ${detail}`);
      }
    }

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    });
  }, [filteredEntries]);

  // Compute whether user (You) and FC entries exist in the timeline
  const hasUserEntries = useMemo(
    () => entries.some((e) => e.source === 'stream' && e.streamType === 'user'),
    [entries],
  );
  const hasFcEntries = useMemo(
    () => entries.some((e) => e.source === 'stream' && e.streamType === 'fc'),
    [entries],
  );

  if (entries.length === 0) {
    const isTerminal = teamStatus === 'done' || teamStatus === 'failed';
    return (
      <div className="text-xs text-dark-muted italic py-2">
        {isTerminal
          ? 'No session log captured.'
          : 'No events yet. Events appear when Claude Code is running.'}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Agent filter pills — only shown when roster has subagents or user/FC entries */}
      {roster && onAgentFiltersChange && (
        <AgentFilterBar
          roster={roster}
          activeFilters={agentFilters ?? new Set()}
          onFiltersChange={onAgentFiltersChange}
          hasUserEntries={hasUserEntries}
          hasFcEntries={hasFcEntries}
        />
      )}

      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="absolute top-1.5 right-1.5 z-10 px-2 py-0.5 text-[10px] rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted bg-[#0D1117] transition-colors"
        title="Copy full log to clipboard"
      >
        {copied ? 'Copied!' : copyFailed ? 'Failed' : 'Copy'}
      </button>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`flex-1 min-h-0 font-mono text-xs overflow-y-auto bg-[#0D1117] p-2 rounded border border-dark-border custom-scrollbar${isThinking ? ' thinking-glow' : ''}`}
      >
        {filteredEntries.map((entry) => {
          if (entry.source === 'stream') {
            return <StreamEntryRow key={entry.id} entry={entry} />;
          }
          return <HookEntryRow key={entry.id} entry={entry} />;
        })}
        {isThinking && (
          <div className="py-1 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#E8976C] animate-thinking-dot" />
            <span className="text-[#E8976C] text-[10px] italic">thinking...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
