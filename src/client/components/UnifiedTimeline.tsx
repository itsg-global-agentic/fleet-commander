import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import type { TimelineEntry, StreamTimelineEntry, HookTimelineEntry } from '../../shared/types';
import {
  PlayIcon,
  SquareIcon,
  CircleStopIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  AlertTriangleIcon,
  SettingsIcon,
  XCircleIcon,
  RefreshCwIcon,
  CircleDotIcon,
  ClockIcon,
} from './Icons';

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

const EVENT_ICONS: Record<string, React.ReactNode> = {
  SessionStart:  <PlayIcon size={14} />,
  SessionEnd:    <SquareIcon size={14} />,
  Stop:          <CircleStopIcon size={14} />,
  StopFailure:   <AlertTriangleIcon size={14} />,
  SubagentStart: <ArrowRightIcon size={14} />,
  SubagentStop:  <ArrowLeftIcon size={14} />,
  Notification:  <AlertTriangleIcon size={14} />,
  ToolError:     <XCircleIcon size={14} />,
  PreCompact:    <RefreshCwIcon size={14} />,
  ToolUse:       <SettingsIcon size={14} />,
  TeammateIdle:  <ClockIcon size={14} />,
};

function getEventIcon(eventType: string): React.ReactNode {
  return EVENT_ICONS[eventType] ?? <CircleDotIcon size={14} />;
}

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

// ---------------------------------------------------------------------------
// Sub-components for each entry type
// ---------------------------------------------------------------------------

function StreamEntryRow({ entry }: { entry: StreamTimelineEntry }) {
  const { color, label } = getStreamStyle(entry.streamType);
  const text = getStreamText(entry);
  const isMultiline = text.includes('\n');

  // Text messages (assistant, user, fc)
  if (TEXT_TYPES.has(entry.streamType) && text) {
    return (
      <div className="py-0.5 leading-relaxed">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        {' '}
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
    return (
      <div className="py-0.5 leading-relaxed flex items-center gap-1.5">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        <span style={{ color }} className="font-semibold">{label}</span>
        <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
          {entry.tool.name}
        </span>
      </div>
    );
  }

  // Result / tool_result — compact
  if (entry.streamType === 'result' || entry.streamType === 'tool_result') {
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

  // Lifecycle events — colored badge
  if (isLifecycle) {
    const lifecycleColor = entry.eventType === 'SessionStart' || entry.eventType === 'SubagentStart'
      ? '#3FB950'
      : '#8B949E';

    return (
      <div className="py-1 leading-relaxed flex items-center gap-1.5">
        <span className="text-dark-muted">
          {formatLocalTime(entry.timestamp)}
        </span>
        <span className="text-dark-muted shrink-0">
          {getEventIcon(entry.eventType)}
        </span>
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded"
          style={{ color: lifecycleColor, backgroundColor: lifecycleColor + '18' }}
        >
          {entry.eventType}
        </span>
        {entry.agentName && (
          <span className="text-xs text-dark-muted">{entry.agentName}</span>
        )}
      </div>
    );
  }

  // Error events — red
  if (isError) {
    return (
      <div className="py-1 leading-relaxed">
        <div className="flex items-center gap-1.5">
          <span className="text-dark-muted">
            {formatLocalTime(entry.timestamp)}
          </span>
          <span className="text-[#F85149] shrink-0">
            {getEventIcon(entry.eventType)}
          </span>
          <span className="text-xs font-medium text-[#F85149]">
            {entry.eventType}
          </span>
          {entry.toolName && (
            <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
              {entry.toolName}
            </span>
          )}
        </div>
        {errorMsg && (
          <div className="ml-[52px] text-xs text-[#F85149] mt-0.5 line-clamp-2">
            {errorMsg}
          </div>
        )}
      </div>
    );
  }

  // Generic hook event
  return (
    <div className="py-0.5 leading-relaxed flex items-center gap-1.5">
      <span className="text-dark-muted">
        {formatLocalTime(entry.timestamp)}
      </span>
      <span className="text-dark-muted shrink-0">
        {getEventIcon(entry.eventType)}
      </span>
      <span className="text-xs text-dark-text font-medium">
        {entry.eventType}
      </span>
      {entry.toolName && (
        <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
          {entry.toolName}
        </span>
      )}
      {entry.agentName && (
        <span className="text-xs text-dark-muted">
          {entry.agentName}
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
}

export function UnifiedTimeline({ teamId, teamStatus }: UnifiedTimelineProps) {
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
        const data = await api.get<TimelineEntry[]>(`teams/${teamId}/timeline?limit=200`);
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

  // Auto-scroll to bottom when new entries arrive (only if stuck to bottom)
  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries.length]);

  // Copy full text log to clipboard
  const handleCopy = useCallback(() => {
    const lines: string[] = [];
    for (const entry of entries) {
      const ts = formatLocalTime(entry.timestamp);
      if (entry.source === 'stream') {
        const text = getStreamText(entry);
        if (text) {
          const { label } = getStreamStyle(entry.streamType);
          const subtypeTag = entry.streamType === 'fc' && entry.subtype
            ? ` [${getSubtypeLabel(entry.subtype)}]`
            : '';
          lines.push(`[${ts}] ${label}${subtypeTag}: ${text}`);
        } else if (entry.streamType === 'tool_use' && entry.tool?.name) {
          lines.push(`[${ts}] tool: ${entry.tool.name}`);
        }
      } else {
        const hook = entry;
        let detail = hook.eventType;
        if (hook.toolName) detail += ` (${hook.toolName})`;
        if (hook.agentName) detail += ` [${hook.agentName}]`;
        lines.push(`[${ts}] hook: ${detail}`);
      }
    }

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    });
  }, [entries]);

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
    <div className="relative">
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
        className="font-mono text-xs overflow-y-auto bg-[#0D1117] p-2 rounded border border-dark-border custom-scrollbar"
      >
        {entries.map((entry) => {
          if (entry.source === 'stream') {
            return <StreamEntryRow key={entry.id} entry={entry} />;
          }
          return <HookEntryRow key={entry.id} entry={entry} />;
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
