import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { CostTable } from '../components/CostTable';
import { DailyChart } from '../components/DailyChart';

// ---------------------------------------------------------------------------
// Types (matching /api/costs response — CostSummary)
// ---------------------------------------------------------------------------

interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format USD with 2 decimals */
function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Format large token counts with K/M suffixes */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CostViewPage() {
  const api = useApi();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const fetchSummary = useCallback(async () => {
    try {
      const data = await api.get<CostSummary>('costs');
      setSummary(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cost summary');
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Initial fetch + auto-refresh every 60s
  useEffect(() => {
    fetchSummary();

    const interval = setInterval(() => {
      setRefreshTick((t) => t + 1);
      fetchSummary();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchSummary]);

  return (
    <div className="p-6 max-w-6xl mx-auto flex flex-col gap-8">
      {/* -------------------------------------------------------------------
        Total Fleet Cost — hero section
      ------------------------------------------------------------------- */}
      <section className="flex flex-col items-center gap-2 py-6">
        <h2 className="text-xs font-medium text-dark-muted uppercase tracking-widest">
          Total Fleet Cost
        </h2>
        {loading && !summary ? (
          <p className="text-dark-muted text-lg">Loading...</p>
        ) : error && !summary ? (
          <p className="text-[#F85149] text-sm">{error}</p>
        ) : summary ? (
          <>
            <p className="text-5xl font-bold text-dark-text tabular-nums">
              {formatUsd(summary.totalCostUsd)}
            </p>
            <div className="flex gap-6 text-xs text-dark-muted mt-1">
              <span>
                <span className="text-dark-text font-medium">{formatTokens(summary.totalInputTokens)}</span>
                {' '}input tokens
              </span>
              <span>
                <span className="text-dark-text font-medium">{formatTokens(summary.totalOutputTokens)}</span>
                {' '}output tokens
              </span>
              <span>
                <span className="text-dark-text font-medium">{summary.entryCount}</span>
                {' '}entries
              </span>
            </div>
          </>
        ) : null}
      </section>

      {/* -------------------------------------------------------------------
        Cost By Team — sortable table
      ------------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-dark-muted uppercase tracking-wider mb-3">
          Cost by Team
        </h3>
        <div className="bg-dark-surface rounded-lg border border-dark-border overflow-hidden">
          <CostTable refreshTick={refreshTick} />
        </div>
      </section>

      {/* -------------------------------------------------------------------
        Daily Cost — bar chart (last 7 days)
      ------------------------------------------------------------------- */}
      <section>
        <h3 className="text-sm font-medium text-dark-muted uppercase tracking-wider mb-3">
          Daily Cost (Last 7 Days)
        </h3>
        <div className="bg-dark-surface rounded-lg border border-dark-border p-4">
          <DailyChart refreshTick={refreshTick} />
        </div>
      </section>
    </div>
  );
}
