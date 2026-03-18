import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import type { ProjectSummary, Team, TeamStatus } from '../../shared/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LaunchDialogProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Toast helper — brief success notification
// ---------------------------------------------------------------------------

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 2500);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded bg-[#3FB950]/20 border border-[#3FB950]/40 text-[#3FB950] text-sm font-medium shadow-lg animate-fade-in">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status label helper
// ---------------------------------------------------------------------------

function statusLabel(status: TeamStatus): string {
  switch (status) {
    case 'queued':     return 'Creating worktree...';
    case 'launching':  return 'Starting Claude Code...';
    case 'running':    return 'Team running';
    case 'idle':       return 'Team idle';
    case 'done':       return 'Completed';
    case 'failed':     return 'Failed';
    case 'stuck':      return 'Stuck';
    default:           return status;
  }
}

// ---------------------------------------------------------------------------
// LaunchLog — real-time progress view shown after launch
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  timestamp?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  tool?: { name?: string };
  [key: string]: unknown;
}

function getStreamEventColor(type: string): string {
  switch (type) {
    case 'assistant':    return 'text-[#58A6FF]';
    case 'tool_use':     return 'text-[#D29922]';
    case 'tool_result':  return 'text-[#A371F7]';
    case 'result':       return 'text-[#3FB950]';
    default:             return 'text-[#8B949E]';
  }
}

function summarizeStreamEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const text = content.find((c) => c.type === 'text')?.text ?? '';
        return text.substring(0, 100) + (text.length > 100 ? '...' : '');
      }
      return '';
    }
    case 'tool_use':
      return event.tool?.name ?? 'unknown';
    case 'tool_result':
      return 'completed';
    case 'result':
      return 'session complete';
    default:
      return '';
  }
}

interface LaunchLogProps {
  teamId: number;
  issueNumber: number;
  onClose: () => void;
}

function LaunchLog({ teamId, issueNumber, onClose }: LaunchLogProps) {
  const api = useApi();
  const [teamStatus, setTeamStatus] = useState<TeamStatus>('queued');
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll team status, output, and stream events every 2 seconds
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;

      try {
        // Fetch team status
        const team = await api.get<Team>(`teams/${teamId}`);
        if (cancelled) return;
        setTeamStatus(team.status);

        if (team.status === 'failed') {
          setErrorMessage(`Team failed${team.stoppedAt ? ` at ${new Date(team.stoppedAt).toLocaleTimeString()}` : ''}`);
        }

        // Fetch output log
        const output = await api.get<{ lines: string[] }>(`teams/${teamId}/output?lines=50`);
        if (cancelled) return;
        setOutputLines(output.lines);

        // Fetch parsed stream events
        const events = await api.get<StreamEvent[]>(`teams/${teamId}/stream-events`);
        if (cancelled) return;
        setStreamEvents(events);
      } catch {
        // Ignore polling errors — will retry
      }
    }

    // Initial poll immediately
    poll();

    // Then every 2 seconds
    const interval = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, teamId]);

  // Auto-scroll output to bottom
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [outputLines]);

  // Auto-scroll for stream events
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamEvents]);

  // Keep a stable ref to onClose so the timer effect only re-runs on teamStatus changes
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Status effect — only SETS the timer, never clears it
  useEffect(() => {
    if (teamStatus === 'running' && !autoCloseTimerRef.current) {
      autoCloseTimerRef.current = setTimeout(() => onCloseRef.current(), 3000);
    }
  }, [teamStatus]);

  // Unmount-only cleanup
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current) { clearTimeout(autoCloseTimerRef.current); autoCloseTimerRef.current = null; }
    };
  }, []);

  // Status indicator color
  const statusColor = (() => {
    switch (teamStatus) {
      case 'queued':
      case 'launching': return 'text-[#D29922]';
      case 'running':   return 'text-[#3FB950]';
      case 'failed':    return 'text-[#F85149]';
      default:          return 'text-dark-muted';
    }
  })();

  // Spinner for queued/launching states
  const isInProgress = teamStatus === 'queued' || teamStatus === 'launching';

  return (
    <div className="px-5 py-4 space-y-3">
      {/* Status header */}
      <div className="flex items-center gap-2">
        {isInProgress && (
          <svg className="animate-spin h-4 w-4 text-[#D29922]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {teamStatus === 'running' && (
          <svg className="h-4 w-4 text-[#3FB950]" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
        {teamStatus === 'failed' && (
          <svg className="h-4 w-4 text-[#F85149]" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        )}
        <span className={`text-sm font-medium ${statusColor}`}>
          {statusLabel(teamStatus)}
        </span>
        <span className="text-xs text-dark-muted ml-auto">
          Issue #{issueNumber} &middot; Team #{teamId}
        </span>
      </div>

      {/* Progress steps */}
      <div className="space-y-1">
        <ProgressStep
          label="Team queued"
          done={true}
        />
        <ProgressStep
          label="Creating worktree..."
          done={teamStatus !== 'queued'}
          active={teamStatus === 'queued'}
        />
        <ProgressStep
          label="Starting Claude Code..."
          done={teamStatus === 'running' || teamStatus === 'done' || teamStatus === 'idle'}
          active={teamStatus === 'launching'}
        />
        <ProgressStep
          label="Team running"
          done={teamStatus === 'running' || teamStatus === 'done' || teamStatus === 'idle'}
          active={false}
        />
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
          {errorMessage}
        </div>
      )}

      {/* Stream events (structured NDJSON output) */}
      {streamEvents.length > 0 && (
        <div className="bg-[#0D1117] border border-dark-border rounded p-2 max-h-[200px] overflow-y-auto font-mono text-xs">
          {streamEvents.slice(-30).map((e, i) => (
            <div key={i} className="py-0.5 leading-relaxed">
              <span className="text-dark-muted">
                {e.timestamp?.substring(11, 19) ?? '--:--:--'}
              </span>
              {' '}
              <span className={getStreamEventColor(e.type)}>{e.type}</span>
              {' '}
              <span className="text-dark-text">{summarizeStreamEvent(e)}</span>
            </div>
          ))}
          <div ref={outputEndRef} />
        </div>
      )}

      {/* Raw output log (fallback when no stream events) */}
      {streamEvents.length === 0 && outputLines.length > 0 && (
        <div className="bg-dark-base border border-dark-border rounded p-2 max-h-[200px] overflow-y-auto font-mono text-xs text-dark-muted">
          {outputLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all leading-relaxed">
              {line}
            </div>
          ))}
          <div ref={outputEndRef} />
        </div>
      )}

      {/* Auto-close notice */}
      {teamStatus === 'running' && (
        <p className="text-xs text-[#3FB950]/70">
          Auto-closing in 3 seconds...
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProgressStep — individual step in the launch progress
// ---------------------------------------------------------------------------

function ProgressStep({ label, done, active }: { label: string; done: boolean; active?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {done ? (
        <svg className="h-3 w-3 text-[#3FB950]" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : active ? (
        <svg className="animate-spin h-3 w-3 text-[#D29922]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <div className="h-3 w-3 rounded-full border border-dark-border" />
      )}
      <span className={done ? 'text-dark-text' : active ? 'text-[#D29922]' : 'text-dark-muted'}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LaunchDialog
// ---------------------------------------------------------------------------

export function LaunchDialog({ open, onClose }: LaunchDialogProps) {
  const api = useApi();

  // --- Form state ---
  const [batchMode, setBatchMode] = useState(false);
  const [headless, setHeadless] = useState(true);
  const [issueNumber, setIssueNumber] = useState('');
  const [batchIssues, setBatchIssues] = useState('');
  const [prompt, setPrompt] = useState('');
  const [staggerDelay, setStaggerDelay] = useState('15000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  // --- Usage zone state ---
  const [zone, setZone] = useState<'green' | 'yellow' | 'red'>('green');

  // --- Launch log state ---
  const [launchedTeamId, setLaunchedTeamId] = useState<number | null>(null);
  const [launchedIssueNumber, setLaunchedIssueNumber] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && !launchedTeamId) {
      // Small delay to allow transition to complete
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open, batchMode, launchedTeamId]);

  // Fetch projects and usage zone when dialog opens
  useEffect(() => {
    if (open) {
      api.get<ProjectSummary[]>('projects').then((data) => {
        setProjects(data);
        // Auto-select if only one project
        if (data.length === 1) {
          setSelectedProjectId(String(data[0].id));
        }
      }).catch(() => {
        setProjects([]);
      });

      // Fetch usage to determine zone
      api.get<{ dailyPercent: number; weeklyPercent: number; sonnetPercent: number; extraPercent: number }>('usage').then((data) => {
        const max = Math.max(data.dailyPercent, data.weeklyPercent, data.sonnetPercent, data.extraPercent);
        if (max > 80) setZone('red');
        else if (max >= 50) setZone('yellow');
        else setZone('green');
      }).catch(() => {
        setZone('green');
      });
    }
  }, [open, api]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setIssueNumber('');
      setBatchIssues('');
      setPrompt('');
      setStaggerDelay('15000');
      setError(null);
      setBatchMode(false);
      setHeadless(true);
      setSelectedProjectId('');
      setLaunchedTeamId(null);
      setLaunchedIssueNumber(null);
      setZone('green');
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  // --- Single launch (with optional force flag for red zone override) ---
  const handleLaunch = useCallback(async (force?: boolean) => {
    setError(null);

    if (projects.length > 0 && !selectedProjectId) {
      setError('Please select a project');
      return;
    }

    const num = parseInt(issueNumber.trim(), 10);
    if (isNaN(num) || num < 1) {
      setError('Issue number must be a positive integer');
      return;
    }

    const effectivePrompt = prompt.trim() || undefined;
    const projectId = selectedProjectId ? parseInt(selectedProjectId, 10) : undefined;

    setLoading(true);
    try {
      const team = await api.post<Team>('teams/launch', {
        issueNumber: num,
        prompt: effectivePrompt,
        projectId,
        headless,
        ...(force ? { force: true } : {}),
      });
      // Switch to launch log view instead of closing
      setLaunchedTeamId(team.id);
      setLaunchedIssueNumber(num);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to launch team');
    } finally {
      setLoading(false);
    }
  }, [issueNumber, prompt, api, projects, selectedProjectId, headless]);

  // --- Batch launch ---
  const handleLaunchBatch = useCallback(async () => {
    setError(null);

    const raw = batchIssues.trim();
    if (!raw) {
      setError('Enter at least one issue number');
      return;
    }

    const numbers = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10));

    if (numbers.some((n) => isNaN(n) || n < 1)) {
      setError('All issue numbers must be positive integers');
      return;
    }

    if (numbers.length === 0) {
      setError('Enter at least one issue number');
      return;
    }

    const delay = parseInt(staggerDelay.trim(), 10);
    if (isNaN(delay) || delay < 0) {
      setError('Stagger delay must be a non-negative number (ms)');
      return;
    }

    if (projects.length > 0 && !selectedProjectId) {
      setError('Please select a project');
      return;
    }

    const issues = numbers.map((n) => ({ number: n }));
    const effectivePrompt = prompt.trim() || undefined;
    const projectId = selectedProjectId ? parseInt(selectedProjectId, 10) : undefined;

    setLoading(true);
    try {
      await api.post('teams/launch-batch', {
        issues,
        prompt: effectivePrompt,
        delayMs: delay,
        projectId,
        headless,
      });
      setToast(`Launched ${numbers.length} team${numbers.length > 1 ? 's' : ''}`);
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to launch batch');
    } finally {
      setLoading(false);
    }
  }, [batchIssues, staggerDelay, prompt, api, onClose, projects, selectedProjectId, headless]);

  // Handle Enter key in single-mode input
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !loading) {
        if (batchMode) {
          handleLaunchBatch();
        } else {
          void handleLaunch();
        }
      }
    },
    [batchMode, loading, handleLaunch, handleLaunchBatch],
  );

  if (!open && !toast) return null;

  // Are we showing the launch log view?
  const showingLog = launchedTeamId !== null && launchedIssueNumber !== null;

  return (
    <>
      {/* Toast notification — persists after dialog closes */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* Dialog */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleBackdropClick}
        >
          <div
            ref={dialogRef}
            className="w-[480px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={showingLog ? 'Launch Progress' : 'Launch Team'}
          >
            {/* --- Header --- */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border">
              <h2 className="text-base font-semibold text-dark-text">
                {showingLog ? 'Launch Progress' : 'Launch Team'}
              </h2>
              <button
                onClick={onClose}
                className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
                title="Close (Esc)"
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {/* --- Body: either form or launch log --- */}
            {showingLog ? (
              <LaunchLog
                teamId={launchedTeamId}
                issueNumber={launchedIssueNumber}
                onClose={onClose}
              />
            ) : (
              <div className="px-5 py-4 space-y-4">
                {/* Project selector */}
                {projects.length > 0 ? (
                  <div>
                    <label className="block text-sm text-dark-muted mb-1">
                      Project <span className="text-[#F85149]">*</span>
                    </label>
                    <select
                      value={selectedProjectId}
                      onChange={(e) => setSelectedProjectId(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                      disabled={loading}
                    >
                      <option value="">Select a project...</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="px-3 py-2 rounded border border-[#D29922]/30 bg-[#D29922]/10 text-[#D29922] text-sm">
                    Add a project first
                  </div>
                )}

                {/* Mode toggles */}
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={batchMode}
                      onChange={(e) => setBatchMode(e.target.checked)}
                      className="w-4 h-4 rounded border-dark-border bg-dark-base text-dark-accent focus:ring-dark-accent/50 focus:ring-offset-0 accent-[#58A6FF]"
                    />
                    <span className="text-sm text-dark-muted">Batch mode</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer select-none" title={headless ? 'Runs Claude Code in the background with no visible window' : 'Opens Claude Code in a visible terminal window'}>
                    <input
                      type="checkbox"
                      checked={headless}
                      onChange={(e) => setHeadless(e.target.checked)}
                      className="w-4 h-4 rounded border-dark-border bg-dark-base text-dark-accent focus:ring-dark-accent/50 focus:ring-offset-0 accent-[#58A6FF]"
                    />
                    <span className="text-sm text-dark-muted">Run headless (background)</span>
                    {!headless && (
                      <span className="text-xs text-dark-muted/60">— opens in a visible terminal window</span>
                    )}
                  </label>
                </div>

                {/* Issue input — single or batch */}
                {!batchMode ? (
                  <div>
                    <label className="block text-sm text-dark-muted mb-1">
                      Issue number <span className="text-[#F85149]">*</span>
                    </label>
                    <input
                      ref={inputRef}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={issueNumber}
                      onChange={(e) => setIssueNumber(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="e.g. 763"
                      className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                      disabled={loading}
                    />
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm text-dark-muted mb-1">
                        Issue numbers <span className="text-[#F85149]">*</span>
                      </label>
                      <input
                        ref={inputRef}
                        type="text"
                        value={batchIssues}
                        onChange={(e) => setBatchIssues(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="e.g. 763, 812, 756"
                        className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                        disabled={loading}
                      />
                      <p className="text-xs text-dark-muted mt-1">
                        Comma or space separated
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm text-dark-muted mb-1">
                        Stagger delay (ms)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={staggerDelay}
                        onChange={(e) => setStaggerDelay(e.target.value)}
                        placeholder="15000"
                        className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                        disabled={loading}
                      />
                    </div>
                  </>
                )}

                {/* Prompt field (optional) */}
                <div>
                  <label className="block text-sm text-dark-muted mb-1">
                    Prompt <span className="text-dark-muted/50">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      batchMode
                        ? 'Custom prompt (default: project prompt file)'
                        : 'Custom prompt (default: project prompt file)'
                    }
                    className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                    disabled={loading}
                  />
                  <p className="text-xs text-dark-muted mt-1">
                    Leave empty to use the project's prompt file (with <code className="text-dark-accent/70">{'{{ISSUE_NUMBER}}'}</code> replaced automatically).
                  </p>
                </div>

                {/* Red zone warning banner */}
                {zone === 'red' && (
                  <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
                    Usage is in the red zone (&gt;80%). New launches will be queued instead of started immediately. Use "Force Launch" to override.
                  </div>
                )}

                {/* Error message */}
                {error && (
                  <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* --- Footer --- */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
              >
                {showingLog ? 'Close' : 'Cancel'}
              </button>

              {!showingLog && (
                <>
                  <button
                    onClick={() => batchMode ? handleLaunchBatch() : void handleLaunch()}
                    disabled={loading || projects.length === 0}
                    className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loading
                      ? 'Launching...'
                      : zone === 'red'
                        ? (batchMode ? 'Queue All' : 'Queue')
                        : (batchMode ? 'Launch All' : 'Launch')}
                  </button>
                  {zone === 'red' && !batchMode && (
                    <button
                      onClick={() => void handleLaunch(true)}
                      disabled={loading || projects.length === 0}
                      className="px-4 py-1.5 text-sm font-medium rounded border border-[#F85149]/40 text-[#F85149] bg-[#F85149]/10 hover:bg-[#F85149]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Force launch ignoring red zone usage limits"
                    >
                      Force Launch
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
