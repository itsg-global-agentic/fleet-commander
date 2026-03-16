import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import type { ProjectSummary } from '../../shared/types';

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
// LaunchDialog
// ---------------------------------------------------------------------------

export function LaunchDialog({ open, onClose }: LaunchDialogProps) {
  const api = useApi();

  // --- Form state ---
  const [batchMode, setBatchMode] = useState(false);
  const [issueNumber, setIssueNumber] = useState('');
  const [batchIssues, setBatchIssues] = useState('');
  const [prompt, setPrompt] = useState('');
  const [staggerDelay, setStaggerDelay] = useState('15000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay to allow transition to complete
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open, batchMode]);

  // Fetch projects when dialog opens
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
      setSelectedProjectId('');
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

  // Build default prompt with the issue number(s)
  function getDefaultPrompt(num: string): string {
    return `/next-issue-kea ${num}`;
  }

  // --- Single launch ---
  const handleLaunch = useCallback(async () => {
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

    const effectivePrompt = prompt.trim() || getDefaultPrompt(String(num));
    const projectId = selectedProjectId ? parseInt(selectedProjectId, 10) : undefined;

    setLoading(true);
    try {
      await api.post('teams/launch', {
        issueNumber: num,
        prompt: effectivePrompt,
        projectId,
      });
      setToast(`Team launched for #${num}`);
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to launch team');
    } finally {
      setLoading(false);
    }
  }, [issueNumber, prompt, api, onClose, projects, selectedProjectId]);

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
      });
      setToast(`Launched ${numbers.length} team${numbers.length > 1 ? 's' : ''}`);
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to launch batch');
    } finally {
      setLoading(false);
    }
  }, [batchIssues, staggerDelay, prompt, api, onClose, projects, selectedProjectId]);

  // Handle Enter key in single-mode input
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !loading) {
        if (batchMode) {
          handleLaunchBatch();
        } else {
          handleLaunch();
        }
      }
    },
    [batchMode, loading, handleLaunch, handleLaunchBatch],
  );

  if (!open && !toast) return null;

  return (
    <>
      {/* Toast notification — persists after dialog closes */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* Dialog */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleBackdropClick}
          aria-hidden="true"
        >
          <div
            ref={dialogRef}
            className="w-[480px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Launch Team"
          >
            {/* --- Header --- */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border">
              <h2 className="text-base font-semibold text-dark-text">
                Launch Team
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

            {/* --- Body --- */}
            <div className="px-5 py-4 space-y-4">
              {/* Project selector */}
              {projects.length > 0 && (
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
              )}

              {/* Batch mode toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={batchMode}
                  onChange={(e) => setBatchMode(e.target.checked)}
                  className="w-4 h-4 rounded border-dark-border bg-dark-base text-dark-accent focus:ring-dark-accent/50 focus:ring-offset-0 accent-[#58A6FF]"
                />
                <span className="text-sm text-dark-muted">Batch mode</span>
              </label>

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
                      ? 'Default: /next-issue-kea {number}'
                      : issueNumber.trim()
                        ? getDefaultPrompt(issueNumber.trim())
                        : '/next-issue-kea {number}'
                  }
                  className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
                  disabled={loading}
                />
                <p className="text-xs text-dark-muted mt-1">
                  Leave empty to use default: <code className="text-dark-accent/70">/next-issue-kea {'{'}<span className="text-dark-text/70">number</span>{'}'}</code>
                </p>
              </div>

              {/* Error message */}
              {error && (
                <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
                  {error}
                </div>
              )}
            </div>

            {/* --- Footer --- */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
                disabled={loading}
              >
                Cancel
              </button>

              <button
                onClick={batchMode ? handleLaunchBatch : handleLaunch}
                disabled={loading}
                className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading
                  ? 'Launching...'
                  : batchMode
                    ? 'Launch All'
                    : 'Launch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
