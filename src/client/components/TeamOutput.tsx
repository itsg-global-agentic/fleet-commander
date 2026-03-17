import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  timestamp?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  tool?: { name?: string; input?: unknown };
  result?: unknown;
  subtype?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  assistant:    { color: '#58A6FF', label: 'TL' },
  user:         { color: '#3FB950', label: 'you' },
  fc:           { color: '#D29922', label: 'FC' },
  system:       { color: '#8B949E', label: 'system' },
  tool_use:     { color: '#D29922', label: 'tool' },
  tool_result:  { color: '#A371F7', label: 'result' },
  result:       { color: '#3FB950', label: 'done' },
  rate_limit_event: { color: '#D29922', label: 'rate-limit' },
};

function getStyle(type: string) {
  return TYPE_STYLES[type] ?? { color: '#8B949E', label: type };
}

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

function getEventText(event: StreamEvent): string {
  const content = event.message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
    if (text) return text;
  }

  switch (event.type) {
    case 'tool_use':
      return event.tool?.name ?? 'unknown tool';
    case 'tool_result':
      return 'completed';
    case 'result':
      return 'session complete';
    case 'rate_limit_event':
      return 'waiting for rate limit...';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TeamOutputProps {
  teamId: number;
  teamStatus?: string;
}

export function TeamOutput({ teamId, teamStatus }: TeamOutputProps) {
  const api = useApi();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Poll for parsed stream events every 2 seconds
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const data = await api.get<StreamEvent[]>(`teams/${teamId}/stream-events`);
        if (!cancelled) {
          setEvents(data);
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

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  // Copy full log to clipboard
  const handleCopy = useCallback(() => {
    const text = events.map((e) => {
      const ts = e.timestamp ? formatLocalTime(e.timestamp) : '--:--';
      const { label } = getStyle(e.type);
      const body = getEventText(e);
      return body ? `[${ts}] ${label}: ${body}` : `[${ts}] ${label}`;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="text-xs text-dark-muted italic py-2">
        No stream events yet. Events appear when Claude Code is running.
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
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <div className="font-mono text-xs max-h-96 overflow-y-auto bg-[#0D1117] p-2 rounded border border-dark-border custom-scrollbar">
        {events.map((e, i) => {
          const { color, label } = getStyle(e.type);
          const text = getEventText(e);
          const isMultiline = text.includes('\n');

          return (
            <div key={`${e.timestamp}-${e.type}-${i}`} className="py-0.5 leading-relaxed">
              <span className="text-dark-muted">
                {e.timestamp ? formatLocalTime(e.timestamp) : '--:--'}
              </span>
              {' '}
              <span style={{ color }} className="font-semibold">{label}</span>
              {text && (
                <>
                  {' '}
                  {isMultiline ? (
                    <span className="text-dark-text whitespace-pre-wrap">{text}</span>
                  ) : (
                    <span className="text-dark-text">{text}</span>
                  )}
                </>
              )}
            </div>
          );
        })}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
