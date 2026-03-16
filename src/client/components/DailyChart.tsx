import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Types (matching /api/costs/by-day response)
// ---------------------------------------------------------------------------

interface DayEntry {
  day: string;       // ISO date string, e.g. "2026-03-15"
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
}

interface CostByDayResponse {
  count: number;
  days: DayEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format USD with 2 decimals */
function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Format date string (YYYY-MM-DD) to shorter display (Mon DD) */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DailyChartProps {
  /** Trigger value that increments to force a refresh */
  refreshTick?: number;
}

export function DailyChart({ refreshTick }: DailyChartProps) {
  const api = useApi();
  const [days, setDays] = useState<DayEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await api.get<CostByDayResponse>('costs/by-day');
      // Take only the last 7 days, sorted chronologically (oldest first)
      const last7 = data.days.slice(0, 7).reverse();
      setDays(last7);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch daily cost data');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshTick]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-dark-muted text-sm">Loading chart data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-[#F85149] text-sm">{error}</p>
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-dark-muted text-sm">No daily cost data available</p>
      </div>
    );
  }

  // Determine max cost for proportional bar widths
  const maxCost = Math.max(...days.map((d) => d.totalCostUsd));

  return (
    <div className="flex flex-col gap-2">
      {days.map((day) => {
        const widthPct = maxCost > 0 ? (day.totalCostUsd / maxCost) * 100 : 0;

        return (
          <div key={day.day} className="flex items-center gap-3">
            {/* Date label — fixed width */}
            <span className="text-xs text-dark-muted w-28 shrink-0 text-right">
              {formatDate(day.day)}
            </span>

            {/* Bar container */}
            <div className="flex-1 h-7 bg-dark-base rounded overflow-hidden flex items-center">
              <div
                className="h-full bg-dark-accent/30 rounded flex items-center transition-all duration-300"
                style={{ width: `${Math.max(widthPct, 1)}%` }}
              >
                {/* Cost label inside or beside the bar */}
                <span className="text-xs font-medium text-dark-accent px-2 whitespace-nowrap">
                  {formatUsd(day.totalCostUsd)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
