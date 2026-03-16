import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import type { Event } from '../../shared/types';

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Event type icon mapping
// ---------------------------------------------------------------------------

const EVENT_ICONS: Record<string, string> = {
  SessionStart: '\u25B6',    // play triangle
  SessionEnd: '\u25A0',      // stop square
  Stop: '\u23F9',            // stop button
  SubagentStart: '\u2192',   // right arrow
  SubagentStop: '\u2190',    // left arrow
  Notification: '\u26A0',    // warning
  PostToolUse: '\u2699',     // gear
  PostToolUseFailure: '\u2717', // ballot X
  PreCompact: '\u21BB',      // clockwise arrow
  ToolUse: '\u2699',         // gear
  CostUpdate: '\u0024',      // dollar sign
};

function getEventIcon(hookType: string): string {
  return EVENT_ICONS[hookType] ?? '\u2022'; // bullet fallback
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EventTimelineProps {
  teamId: number;
  /** Trigger refetch when this value changes (e.g., from SSE updates) */
  refreshKey?: number;
}

interface EventsResponse {
  teamId: number;
  events: Event[];
  total: number;
}

export function EventTimeline({ teamId, refreshKey }: EventTimelineProps) {
  const api = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchEvents() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<EventsResponse>(`teams/${teamId}/events?limit=20`);
        if (!cancelled) {
          setEvents(data.events ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load events');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchEvents();

    return () => {
      cancelled = true;
    };
  }, [teamId, refreshKey, api]);

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <span className="text-dark-muted text-sm">Loading events...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-6">
        <span className="text-[#F85149] text-sm">{error}</span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <span className="text-dark-muted text-sm">No events recorded yet</span>
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto custom-scrollbar">
      <ul className="space-y-0">
        {events.map((evt) => (
          <li
            key={evt.id}
            className="flex items-start gap-3 px-1 py-2 border-b border-dark-border/50 last:border-b-0"
          >
            {/* Event type icon */}
            <span className="text-dark-muted text-sm mt-0.5 w-5 text-center shrink-0">
              {getEventIcon(evt.hookType)}
            </span>

            {/* Event info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-dark-text font-medium">
                  {evt.hookType}
                </span>
                {evt.toolName && (
                  <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
                    {evt.toolName}
                  </span>
                )}
              </div>
              {evt.agentType && (
                <span className="text-xs text-dark-muted block mt-0.5">
                  agent: {evt.agentType}
                </span>
              )}
            </div>

            {/* Timestamp */}
            <span className="text-xs text-dark-muted whitespace-nowrap shrink-0 mt-0.5">
              {timeAgo(evt.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
