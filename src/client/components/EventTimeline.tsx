import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import type { Event } from '../../shared/types';
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
  DollarSignIcon,
  CircleDotIcon,
} from './Icons';

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

function timeAgo(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
}

// ---------------------------------------------------------------------------
// Event type icon mapping
// ---------------------------------------------------------------------------

const EVENT_ICONS: Record<string, React.ReactNode> = {
  SessionStart: <PlayIcon size={14} />,
  SessionEnd: <SquareIcon size={14} />,
  Stop: <CircleStopIcon size={14} />,
  SubagentStart: <ArrowRightIcon size={14} />,
  SubagentStop: <ArrowLeftIcon size={14} />,
  Notification: <AlertTriangleIcon size={14} />,
  PostToolUse: <SettingsIcon size={14} />,
  PostToolUseFailure: <XCircleIcon size={14} />,
  PreCompact: <RefreshCwIcon size={14} />,
  ToolUse: <SettingsIcon size={14} />,
  CostUpdate: <DollarSignIcon size={14} />,
};

function getEventIcon(eventType: string): React.ReactNode {
  return EVENT_ICONS[eventType] ?? <CircleDotIcon size={14} />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EventTimelineProps {
  teamId: number;
  /** Trigger refetch when this value changes (e.g., from SSE updates) */
  refreshKey?: number;
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
        const data = await api.get<Event[]>(`teams/${teamId}/events?limit=20`);
        if (!cancelled) {
          setEvents(data ?? []);
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
    <div className="overflow-y-auto custom-scrollbar">
      <ul className="space-y-0">
        {events.map((evt) => (
          <li
            key={evt.id}
            className="flex items-start gap-3 px-1 py-2 border-b border-dark-border/50 last:border-b-0"
          >
            {/* Event type icon */}
            <span className="text-dark-muted text-sm mt-0.5 w-5 flex items-center justify-center shrink-0">
              {getEventIcon(evt.eventType)}
            </span>

            {/* Event info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-dark-text font-medium">
                  {evt.eventType}
                </span>
                {evt.toolName && (
                  <span className="text-xs text-dark-muted bg-dark-border/30 px-1.5 py-0.5 rounded">
                    {evt.toolName}
                  </span>
                )}
              </div>
              {evt.agentName && (
                <span className="text-xs text-dark-muted block mt-0.5">
                  agent: {evt.agentName}
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
