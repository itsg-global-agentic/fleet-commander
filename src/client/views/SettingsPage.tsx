import { useState, useEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsResponse {
  host: string;
  port: number;
  idleThresholdMin: number;
  stuckThresholdMin: number;
  maxUniqueCiFailures: number;
  githubPollIntervalMs: number;
  issuePollIntervalMs: number;
  stuckCheckIntervalMs: number;
  usagePollIntervalMs: number;
  sseHeartbeatMs: number;
  outputBufferLines: number;
  claudeCmd: string;
  fleetCommanderRoot: string;
  dbPath: string;
}

interface SettingRow {
  key: keyof SettingsResponse;
  label: string;
  envVar: string;
  description: string;
  format?: (value: unknown) => string;
}

interface SettingGroup {
  title: string;
  rows: SettingRow[];
}

// ---------------------------------------------------------------------------
// Setting definitions grouped by category
// ---------------------------------------------------------------------------

function formatMs(value: unknown): string {
  const ms = Number(value);
  if (ms >= 60000) return `${ms / 1000}s (${ms / 60000}min)`;
  if (ms >= 1000) return `${ms / 1000}s`;
  return `${ms}ms`;
}

const SETTING_GROUPS: SettingGroup[] = [
  {
    title: 'Server',
    rows: [
      {
        key: 'host',
        label: 'Host',
        envVar: 'FLEET_HOST',
        description: 'Network interface to bind to',
      },
      {
        key: 'port',
        label: 'Port',
        envVar: 'PORT',
        description: 'HTTP server port',
      },
      {
        key: 'claudeCmd',
        label: 'Claude Command',
        envVar: 'FLEET_CLAUDE_CMD',
        description: 'CLI command used to invoke Claude',
      },
      {
        key: 'outputBufferLines',
        label: 'Output Buffer Lines',
        envVar: '(hardcoded)',
        description: 'Max lines kept in team output buffer',
      },
    ],
  },
  {
    title: 'Thresholds',
    rows: [
      {
        key: 'idleThresholdMin',
        label: 'Idle Threshold',
        envVar: 'FLEET_IDLE_THRESHOLD_MIN',
        description: 'Minutes before a team is considered idle',
        format: (v) => `${v} min`,
      },
      {
        key: 'stuckThresholdMin',
        label: 'Stuck Threshold',
        envVar: 'FLEET_STUCK_THRESHOLD_MIN',
        description: 'Minutes before a team is considered stuck',
        format: (v) => `${v} min`,
      },
      {
        key: 'maxUniqueCiFailures',
        label: 'Max CI Failures',
        envVar: 'FLEET_MAX_CI_FAILURES',
        description: 'Unique CI failures before a team is blocked',
      },
    ],
  },
  {
    title: 'Polling Intervals',
    rows: [
      {
        key: 'githubPollIntervalMs',
        label: 'GitHub Poll Interval',
        envVar: 'FLEET_GITHUB_POLL_MS',
        description: 'How often to poll GitHub for PR/CI updates',
        format: formatMs,
      },
      {
        key: 'issuePollIntervalMs',
        label: 'Issue Poll Interval',
        envVar: 'FLEET_ISSUE_POLL_MS',
        description: 'How often to poll for new issues',
        format: formatMs,
      },
      {
        key: 'stuckCheckIntervalMs',
        label: 'Stuck Check Interval',
        envVar: 'FLEET_STUCK_CHECK_MS',
        description: 'How often to check for stuck teams',
        format: formatMs,
      },
      {
        key: 'usagePollIntervalMs',
        label: 'Usage Poll Interval',
        envVar: 'FLEET_USAGE_POLL_MS',
        description: 'How often to poll API usage data',
        format: formatMs,
      },
      {
        key: 'sseHeartbeatMs',
        label: 'SSE Heartbeat',
        envVar: '(hardcoded)',
        description: 'Interval between SSE keepalive pings',
        format: formatMs,
      },
    ],
  },
  {
    title: 'Paths',
    rows: [
      {
        key: 'fleetCommanderRoot',
        label: 'Fleet Commander Root',
        envVar: 'FLEET_COMMANDER_ROOT',
        description: 'Installation root directory',
      },
      {
        key: 'dbPath',
        label: 'Database Path',
        envVar: 'FLEET_DB_PATH',
        description: 'SQLite database file location',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// SettingsPage
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const api = useApi();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await api.get<SettingsResponse>('settings');
      setSettings(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleFactoryReset = async () => {
    const confirmed = window.confirm(
      'FACTORY RESET\n\nThis will:\n- Stop all running teams\n- Uninstall hooks from all projects\n- Delete ALL data (projects, teams, events)\n\nThis cannot be undone. Continue?',
    );
    if (!confirmed) return;

    const doubleConfirm = window.confirm(
      'Are you absolutely sure? All data will be permanently deleted.',
    );
    if (!doubleConfirm) return;

    setResetting(true);
    try {
      await api.post('system/factory-reset');
      window.location.href = '/';
    } catch (err) {
      alert('Factory reset failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setResetting(false);
    }
  };

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-dark-muted text-sm">Loading settings...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-[#F85149] text-sm mb-2">Failed to load settings</p>
          <p className="text-dark-muted text-xs">{error}</p>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-dark-text">Settings</h1>
        <p className="text-dark-muted text-sm mt-1">
          Current runtime configuration. Set via environment variables — changes require a server restart.
        </p>
      </div>

      {/* Setting groups */}
      <div className="space-y-6">
        {SETTING_GROUPS.map((group) => (
          <div key={group.title}>
            {/* Section header */}
            <h2 className="text-sm font-semibold text-dark-muted uppercase tracking-wider mb-2">
              {group.title}
            </h2>

            {/* Table */}
            <div className="bg-dark-surface border border-dark-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-dark-border">
                    <th className="text-left px-4 py-2 text-xs font-medium text-dark-muted uppercase tracking-wider w-[180px]">
                      Setting
                    </th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-dark-muted uppercase tracking-wider w-[200px]">
                      Value
                    </th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-dark-muted uppercase tracking-wider w-[200px]">
                      Env Variable
                    </th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-dark-muted uppercase tracking-wider">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, idx) => {
                    const rawValue = settings[row.key];
                    const displayValue = row.format
                      ? row.format(rawValue)
                      : String(rawValue);

                    return (
                      <tr
                        key={row.key}
                        className={`border-b border-dark-border/50 last:border-b-0 ${
                          idx % 2 === 1 ? 'bg-dark-base/30' : ''
                        }`}
                      >
                        <td className="px-4 py-2.5 text-dark-text font-medium">
                          {row.label}
                        </td>
                        <td className="px-4 py-2.5">
                          <code className="text-dark-accent font-mono text-xs bg-dark-base/50 px-1.5 py-0.5 rounded">
                            {displayValue}
                          </code>
                        </td>
                        <td className="px-4 py-2.5">
                          <code className="text-dark-muted font-mono text-xs">
                            {row.envVar}
                          </code>
                        </td>
                        <td className="px-4 py-2.5 text-dark-muted">
                          {row.description}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* Prompt files note */}
      <div className="mt-6 bg-dark-surface border border-dark-border rounded-lg px-4 py-3">
        <h2 className="text-sm font-semibold text-dark-muted uppercase tracking-wider mb-1">
          Launch Prompt
        </h2>
        <p className="text-dark-muted text-sm">
          Configured per-project via prompt files:{' '}
          <code className="text-dark-accent font-mono text-xs bg-dark-base/50 px-1.5 py-0.5 rounded">
            {'prompts/{slug}-prompt.md'}
          </code>
        </p>
      </div>

      {/* Danger Zone */}
      <div className="mt-8 border border-[#F85149]/30 rounded p-4">
        <h3 className="text-[#F85149] font-semibold mb-2">Danger Zone</h3>
        <p className="text-[#8B949E] text-sm mb-3">
          Factory reset will stop all running teams, uninstall hooks from all projects,
          and delete all data. The database will be recreated fresh with default settings.
        </p>
        <button
          onClick={handleFactoryReset}
          disabled={resetting}
          className="px-4 py-2 text-sm bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40 rounded hover:bg-[#F85149]/20 disabled:opacity-50"
        >
          {resetting ? 'Resetting...' : 'Factory Reset'}
        </button>
      </div>
    </div>
  );
}
