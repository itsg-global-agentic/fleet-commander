import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Types (matching the enriched /api/costs/by-team response)
// ---------------------------------------------------------------------------

interface TeamCostRow {
  teamId: number;
  worktreeName: string;
  issueNumber: number;
  issueTitle: string | null;
  status: string;
  sessionCount: number;
  durationMin: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
}

interface CostByTeamResponse {
  count: number;
  teams: TeamCostRow[];
}

// ---------------------------------------------------------------------------
// Sortable columns
// ---------------------------------------------------------------------------

type SortField = 'issueNumber' | 'issueTitle' | 'status' | 'totalCostUsd' | 'sessionCount' | 'durationMin';

const COLUMNS: { label: string; field: SortField }[] = [
  { label: 'Issue #', field: 'issueNumber' },
  { label: 'Title', field: 'issueTitle' },
  { label: 'Status', field: 'status' },
  { label: 'Total Cost', field: 'totalCostUsd' },
  { label: 'Sessions', field: 'sessionCount' },
  { label: 'Duration', field: 'durationMin' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format duration in minutes to "Xh Ym" or "Xm" */
function formatDuration(minutes: number): string {
  if (!minutes || minutes < 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format USD with 2 decimals */
function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Truncate a string to maxLen characters with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CostTableProps {
  /** Trigger value that increments to force a refresh */
  refreshTick?: number;
}

export function CostTable({ refreshTick }: CostTableProps) {
  const api = useApi();
  const [teams, setTeams] = useState<TeamCostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('totalCostUsd');
  const [sortAsc, setSortAsc] = useState(false); // default: cost descending

  const fetchData = useCallback(async () => {
    try {
      const data = await api.get<CostByTeamResponse>('costs/by-team');
      setTeams(data.teams);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cost data');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshTick]);

  // Sort logic
  const sortedTeams = [...teams].sort((a, b) => {
    let aVal: string | number = a[sortField] ?? '';
    let bVal: string | number = b[sortField] ?? '';

    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();

    if (aVal < bVal) return sortAsc ? -1 : 1;
    if (aVal > bVal) return sortAsc ? 1 : -1;
    return 0;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      // Default: descending for numeric fields, ascending for text
      setSortAsc(field === 'issueTitle' || field === 'status');
    }
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return sortAsc ? ' \u25B2' : ' \u25BC';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-dark-muted text-sm">Loading cost data...</p>
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

  if (sortedTeams.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-dark-muted text-sm">No cost data recorded yet</p>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full table-auto">
        <thead>
          <tr className="border-b border-dark-border">
            {COLUMNS.map((col) => (
              <th
                key={col.field}
                onClick={() => handleSort(col.field)}
                className="px-4 py-3 text-left text-xs font-medium text-dark-muted uppercase tracking-wider cursor-pointer hover:text-dark-text transition-colors select-none"
              >
                {col.label}{sortIndicator(col.field)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedTeams.map((team) => (
            <tr
              key={team.teamId}
              className="h-12 border-b border-dark-border bg-dark-surface hover:bg-[#1C2128] transition-colors"
            >
              {/* Issue # */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm text-dark-muted">#{team.issueNumber}</span>
              </td>

              {/* Title */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm text-dark-text">
                  {team.issueTitle ? truncate(team.issueTitle, 50) : 'Untitled'}
                </span>
              </td>

              {/* Status */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm text-dark-muted capitalize">{team.status}</span>
              </td>

              {/* Total Cost */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm font-medium text-dark-text">
                  {formatUsd(team.totalCostUsd)}
                </span>
              </td>

              {/* Sessions */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm text-dark-muted">{team.sessionCount}</span>
              </td>

              {/* Duration */}
              <td className="px-4 whitespace-nowrap">
                <span className="text-sm text-dark-muted">
                  {formatDuration(team.durationMin)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
