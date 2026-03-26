import { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';
import { useApi } from '../hooks/useApi';
import { useFleetSSE } from '../hooks/useFleetSSE';
import type { TimelineEntry, StreamTimelineEntry, HookTimelineEntry, TeamMember, TeamStatus } from '../../shared/types';
import { TERMINAL_STATUSES } from '../../shared/types';
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
// Helpers — tool detail extraction for expand/collapse
// ---------------------------------------------------------------------------

/** Maximum length for truncated strings in tool detail view */
const DETAIL_TRUNCATE = 120;

function truncate(s: string, max = DETAIL_TRUNCATE): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

/**
 * Extract a human-readable detail string from a tool_use entry's input.
 * Returns null if no meaningful detail can be extracted.
 */
function getToolDetail(entry: StreamTimelineEntry): string | null {
  if (entry.streamType !== 'tool_use' || !entry.tool?.name || !entry.tool.input) return null;
  const input = entry.tool.input as Record<string, unknown>;
  const name = entry.tool.name;

  switch (name) {
    case 'Bash': {
      const cmd = input.command;
      if (typeof cmd === 'string') return truncate(cmd);
      return null;
    }
    case 'Read': {
      const fp = input.file_path;
      if (typeof fp === 'string') return fp;
      return null;
    }
    case 'Write': {
      const fp = input.file_path;
      if (typeof fp === 'string') return fp;
      return null;
    }
    case 'Edit': {
      const fp = input.file_path;
      const old = input.old_string;
      const nw = input.new_string;
      const parts: string[] = [];
      if (typeof fp === 'string') parts.push(fp);
      if (typeof old === 'string' && typeof nw === 'string') {
        parts.push(truncate(old, 50) + ' -> ' + truncate(nw, 50));
      }
      return parts.length > 0 ? parts.join('  ') : null;
    }
    case 'Grep': {
      const pattern = input.pattern;
      const path = input.path;
      const parts: string[] = [];
      if (typeof pattern === 'string') parts.push(`/${pattern}/`);
      if (typeof path === 'string') parts.push(path);
      return parts.length > 0 ? parts.join(' in ') : null;
    }
    case 'Glob': {
      const pattern = input.pattern;
      if (typeof pattern === 'string') return pattern;
      return null;
    }
    case 'SendMessage': {
      const to = input.to;
      const msg = input.message;
      const parts: string[] = [];
      if (typeof to === 'string') parts.push(`to ${to}`);
      if (typeof msg === 'string') parts.push(truncate(msg, 80));
      return parts.length > 0 ? parts.join(': ') : null;
    }
    case 'Agent': {
      const agentName = input.name;
      const msg = input.message;
      const parts: string[] = [];
      if (typeof agentName === 'string') parts.push(agentName);
      if (typeof msg === 'string') parts.push(truncate(msg, 80));
      return parts.length > 0 ? parts.join(': ') : null;
    }
    default: {
      // For unknown tools, try to show a brief JSON summary of the input
      try {
        const json = JSON.stringify(input);
        if (json.length > 2) return truncate(json);
      } catch {
        // Ignore serialisation errors
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// SSE event → timeline entry converters
// ---------------------------------------------------------------------------

/** Shape of an SSE StreamEvent payload (from team_output events) */
interface SSEStreamEvent {
  type: string;
  timestamp?: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  tool?: { name?: string; input?: unknown };
  agentName?: string;
  description?: string;
  lastToolName?: string;
  [key: string]: unknown;
}

/**
 * Convert an SSE team_output StreamEvent into one or more StreamTimelineEntry objects.
 * Also extracts tool_use content blocks from assistant events (mirrors build-timeline.ts logic).
 */
function streamEventToEntries(
  teamId: number,
  event: SSEStreamEvent,
  seqId: number,
): StreamTimelineEntry[] {
  const timestamp = event.timestamp ?? new Date().toISOString();
  const base: StreamTimelineEntry = {
    id: `sse-stream-${seqId}`,
    source: 'stream',
    timestamp,
    teamId,
    streamType: event.type,
    subtype: event.subtype,
    message: event.message,
    tool: event.tool,
    ...(event.agentName ? { agentName: event.agentName } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.lastToolName ? { lastToolName: event.lastToolName } : {}),
  };

  const entries: StreamTimelineEntry[] = [base];

  // Extract tool_use content blocks from assistant events
  if (event.type === 'assistant' && event.message?.content) {
    for (let j = 0; j < event.message.content.length; j++) {
      const block = event.message.content[j];
      if (block.type === 'tool_use' && block.name) {
        entries.push({
          id: `sse-stream-${seqId}-tool-${j}`,
          source: 'stream',
          timestamp,
          teamId,
          streamType: 'tool_use',
          tool: { name: block.name, input: block.input },
          ...(event.agentName ? { agentName: event.agentName } : {}),
        });
      }
    }
  }

  return entries;
}

/** Shape of an SSE team_event payload */
interface SSEHookPayload {
  team_id: number;
  event_type: string;
  event_id: number;
  session_id?: string | null;
  agent_name?: string | null;
  tool_name?: string | null;
  timestamp?: string;
}

/**
 * Convert an SSE team_event payload into a HookTimelineEntry.
 */
function hookPayloadToEntry(teamId: number, payload: SSEHookPayload): HookTimelineEntry {
  return {
    id: `event-${payload.event_id}`,
    source: 'hook',
    timestamp: payload.timestamp ?? new Date().toISOString(),
    teamId,
    eventType: payload.event_type,
    toolName: payload.tool_name ?? undefined,
    agentName: payload.agent_name ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Timeline state reducer
// ---------------------------------------------------------------------------

/** High-frequency noise types that should be filtered from SSE events */
const NOISE_STREAM_TYPES = new Set([
  'stream_event',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
]);

/** Maximum number of entries before trimming oldest */
const MAX_ENTRIES = 600;
/** Number of entries to trim when cap is exceeded */
const TRIM_COUNT = 100;

interface TimelineState {
  entries: TimelineEntry[];
  idSet: Set<string>;
}

type TimelineAction =
  | { type: 'INIT'; entries: TimelineEntry[] }
  | { type: 'APPEND_STREAM'; entries: StreamTimelineEntry[] }
  | { type: 'APPEND_HOOK'; entry: HookTimelineEntry }
  | { type: 'SYNC'; entries: TimelineEntry[] };

function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case 'INIT': {
      const idSet = new Set(action.entries.map((e) => e.id));
      return { entries: action.entries, idSet };
    }
    case 'APPEND_STREAM': {
      const newEntries = action.entries.filter((e) => !state.idSet.has(e.id));
      if (newEntries.length === 0) return state;
      const idSet = new Set(state.idSet);
      for (const e of newEntries) idSet.add(e.id);
      let entries = [...state.entries, ...newEntries];
      // Memory cap: trim oldest entries if over limit
      if (entries.length > MAX_ENTRIES) {
        const trimmed = entries.slice(TRIM_COUNT);
        const trimmedIdSet = new Set(trimmed.map((e) => e.id));
        return { entries: trimmed, idSet: trimmedIdSet };
      }
      return { entries, idSet };
    }
    case 'APPEND_HOOK': {
      if (state.idSet.has(action.entry.id)) return state;
      const idSet = new Set(state.idSet);
      idSet.add(action.entry.id);
      let entries = [...state.entries, action.entry];
      // Memory cap: trim oldest entries if over limit
      if (entries.length > MAX_ENTRIES) {
        const trimmed = entries.slice(TRIM_COUNT);
        const trimmedIdSet = new Set(trimmed.map((e) => e.id));
        return { entries: trimmed, idSet: trimmedIdSet };
      }
      return { entries, idSet };
    }
    case 'SYNC': {
      // Full replacement on sync (fallback poll) — like INIT but called periodically
      const idSet = new Set(action.entries.map((e) => e.id));
      return { entries: action.entries, idSet };
    }
  }
}

const INITIAL_TIMELINE_STATE: TimelineState = { entries: [], idSet: new Set() };

// ---------------------------------------------------------------------------
// Sub-components for each entry type
// ---------------------------------------------------------------------------

function StreamEntryRow({ entry }: { entry: StreamTimelineEntry }) {
  const [expanded, setExpanded] = useState(false);
  const text = getStreamText(entry);
  const isMultiline = text.includes('\n');
  const detail = getToolDetail(entry);

  // System task_progress/task_notification — compact single-line entry
  if (entry.streamType === 'system' && (entry.subtype === 'task_progress' || entry.subtype === 'task_notification')) {
    const name = agentDisplayName(entry.agentName);
    const color = entry.agentName ? agentColor(entry.agentName, entry.agentName) : '#8B949E';
    const toolLabel = entry.lastToolName ?? entry.tool?.name;
    const desc = entry.description;

    return (
      <div className="py-0 leading-snug flex items-center gap-1.5 text-dark-muted">
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

  // Tool use — compact badge with optional expand/collapse for tool details
  if (entry.streamType === 'tool_use' && entry.tool?.name) {
    const { label, color } = resolveAgentLabel(entry);
    const hasDetail = detail !== null;

    return (
      <div>
        <div className="py-0 leading-snug flex items-center gap-1.5">
          <span className="text-dark-muted">
            {formatLocalTime(entry.timestamp)}
          </span>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span style={{ color }} className="font-semibold">{label}</span>
          <span
            className={`text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded${hasDetail ? ' cursor-pointer border-b border-dotted border-dark-border hover:bg-dark-border/50' : ''}`}
            onClick={hasDetail ? () => setExpanded((prev) => !prev) : undefined}
            onKeyDown={hasDetail ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((prev) => !prev); } } : undefined}
            role={hasDetail ? 'button' : undefined}
            tabIndex={hasDetail ? 0 : undefined}
            aria-expanded={hasDetail ? expanded : undefined}
          >
            {entry.tool.name}
          </span>
        </div>
        {expanded && detail && (
          <div className="text-dark-muted pl-6 pb-0.5 font-mono truncate" title={detail}>
            {detail}
          </div>
        )}
      </div>
    );
  }

  // Result / tool_result — compact
  if (entry.streamType === 'result' || entry.streamType === 'tool_result') {
    const { color, label } = getStreamStyle(entry.streamType);
    return (
      <div className="py-0 leading-snug text-dark-muted">
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
      <div className="py-0 leading-snug text-dark-muted">
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
  const [expanded, setExpanded] = useState(false);

  // Lifecycle events — agent dot + name + event badge
  if (isLifecycle) {
    const lifecycleColor = entry.eventType === 'SessionStart' || entry.eventType === 'SubagentStart'
      ? '#3FB950'
      : '#8B949E';

    return (
      <div className="py-0 leading-snug flex items-center gap-1.5 text-dark-muted">
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

  // Error events — collapsible, click error badge to expand/collapse
  if (isError) {
    const hasErrorDetail = errorMsg !== null;

    return (
      <div className="py-0 leading-snug text-dark-muted">
        <div className="flex items-center gap-1.5">
          <span>{formatLocalTime(entry.timestamp)}</span>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span style={{ color }} className="font-medium">{label}</span>
          <span
            className={`font-normal bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded${hasErrorDetail ? ' cursor-pointer border-b border-dotted border-red-400/40 hover:bg-red-500/30' : ''}`}
            onClick={hasErrorDetail ? () => setExpanded((prev) => !prev) : undefined}
            onKeyDown={hasErrorDetail ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((prev) => !prev); } } : undefined}
            role={hasErrorDetail ? 'button' : undefined}
            tabIndex={hasErrorDetail ? 0 : undefined}
            aria-expanded={hasErrorDetail ? expanded : undefined}
          >
            {entry.eventType}
          </span>
          {entry.toolName && (
            <span className="text-dark-muted bg-dark-border/30 px-1.5 rounded">
              {entry.toolName}
            </span>
          )}
        </div>
        {expanded && errorMsg && (
          <div className="ml-[52px] text-[#F85149] mt-0.5 line-clamp-2">
            {errorMsg}
          </div>
        )}
      </div>
    );
  }

  // Generic hook event — agent dot + name + event type + tool badge
  return (
    <div className="py-0 leading-snug flex items-center gap-1.5 text-dark-muted">
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

/** Fallback poll interval (60 seconds) — only used as safety net alongside SSE */
const FALLBACK_POLL_MS = 60_000;

export function UnifiedTimeline({
  teamId,
  teamStatus,
  isThinking,
  roster,
  agentFilters,
  onAgentFiltersChange,
}: UnifiedTimelineProps) {
  const api = useApi();
  const [state, dispatch] = useReducer(timelineReducer, INITIAL_TIMELINE_STATE);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Refs to avoid stale closures in SSE callback
  const teamIdRef = useRef(teamId);
  teamIdRef.current = teamId;
  const sseSeqRef = useRef(0);

  // Detect if user has scrolled up — disable auto-scroll in that case
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // "Stick to bottom" if scrolled within 40px of the bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottomRef.current = atBottom;
  }, []);

  // Initial fetch + 60-second fallback poll for non-terminal teams
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    // Reset SSE sequence counter on teamId change
    sseSeqRef.current = 0;

    async function fetchTimeline(isInit: boolean) {
      if (cancelled) return;
      try {
        const data = await api.get<TimelineEntry[]>(`teams/${teamId}/timeline?limit=500`);
        if (!cancelled) {
          dispatch({ type: isInit ? 'INIT' : 'SYNC', entries: data });
        }
      } catch {
        // Ignore fetch errors
      }
    }

    // Initial fetch
    fetchTimeline(true);

    // 60-second fallback poll for non-terminal teams
    if (!TERMINAL_STATUSES.has(teamStatus as TeamStatus)) {
      timer = setInterval(() => fetchTimeline(false), FALLBACK_POLL_MS);
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [api, teamId, teamStatus]);

  // Subscribe to SSE for real-time updates
  const handleSSEEvent = useCallback((type: string, data: unknown) => {
    if (type === 'team_output') {
      const payload = data as { team_id: number; event: SSEStreamEvent };
      if (payload.team_id !== teamIdRef.current) return;
      // Skip noise types
      if (NOISE_STREAM_TYPES.has(payload.event.type)) return;
      const seq = sseSeqRef.current++;
      const entries = streamEventToEntries(teamIdRef.current, payload.event, seq);
      dispatch({ type: 'APPEND_STREAM', entries });
    } else if (type === 'team_event') {
      const payload = data as SSEHookPayload;
      if (payload.team_id !== teamIdRef.current) return;
      const entry = hookPayloadToEntry(teamIdRef.current, payload);
      dispatch({ type: 'APPEND_HOOK', entry });
    }
  }, []);

  useFleetSSE(['team_output', 'team_event'], handleSSEEvent);

  const { entries } = state;

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
          const toolDetailText = getToolDetail(entry);
          const suffix = toolDetailText ? ` — ${toolDetailText}` : '';
          lines.push(`[${ts}] ${agent}: ${entry.tool.name}${suffix}`);
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
    const isTerminal = TERMINAL_STATUSES.has(teamStatus as TeamStatus);
    return (
      <div className="text-[11px] text-dark-muted italic py-2">
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
        className={`flex-1 min-h-0 font-mono text-[11px] overflow-y-auto bg-[#0D1117] p-2 rounded border border-dark-border custom-scrollbar${isThinking ? ' thinking-glow' : ''}`}
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
