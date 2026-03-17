import { useState, useEffect, useRef } from 'react';
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
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventColor(type: string): string {
  switch (type) {
    case 'assistant':    return 'text-[#58A6FF]';
    case 'tool_use':     return 'text-[#D29922]';
    case 'tool_result':  return 'text-[#A371F7]';
    case 'result':       return 'text-[#3FB950]';
    case 'system':       return 'text-[#8B949E]';
    default:             return 'text-[#8B949E]';
  }
}

function summarizeEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const text = content.find((c) => c.type === 'text')?.text ?? '';
        return text.substring(0, 120) + (text.length > 120 ? '...' : '');
      }
      return '';
    }
    case 'tool_use': {
      const toolName = event.tool?.name ?? 'unknown';
      return toolName;
    }
    case 'tool_result':
      return 'completed';
    case 'result':
      return 'session complete';
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

  if (events.length === 0) {
    return (
      <div className="text-xs text-dark-muted italic py-2">
        No stream events yet. Events appear when Claude Code is running in headless mode.
      </div>
    );
  }

  return (
    <div className="font-mono text-xs max-h-64 overflow-y-auto bg-[#0D1117] p-2 rounded border border-dark-border custom-scrollbar">
      {events.map((e, i) => (
        <div key={`${e.timestamp}-${e.type}-${i}`} className="py-0.5 leading-relaxed">
          <span className="text-dark-muted">
            {e.timestamp?.substring(11, 19) ?? '--:--:--'}
          </span>
          {' '}
          <span className={getEventColor(e.type)}>{e.type}</span>
          {' '}
          <span className="text-dark-text">{summarizeEvent(e)}</span>
        </div>
      ))}
      <div ref={scrollRef} />
    </div>
  );
}
