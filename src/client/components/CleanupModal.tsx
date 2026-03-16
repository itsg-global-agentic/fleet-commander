import { useState, useCallback, useEffect, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import type { CleanupItem, CleanupPreview, CleanupResult } from '../../shared/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CleanupModalProps {
  projectId: number;
  open: boolean;
  onClose: () => void;
  onDone: () => void; // called after cleanup completes so parent can refresh
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_ORDER: Record<CleanupItem['type'], number> = {
  worktree: 0,
  signal_file: 1,
  stale_branch: 2,
};

const TYPE_LABELS: Record<CleanupItem['type'], string> = {
  worktree: 'Worktrees',
  signal_file: 'Signal Files',
  stale_branch: 'Branches',
};

const TYPE_ICONS: Record<CleanupItem['type'], string> = {
  worktree: '\uD83D\uDCC1',   // folder icon
  signal_file: '\uD83D\uDCC4', // page icon
  stale_branch: '\uD83C\uDF3F', // leaf icon
};

function groupByType(items: CleanupItem[]): Map<CleanupItem['type'], CleanupItem[]> {
  const sorted = [...items].sort(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type],
  );
  const map = new Map<CleanupItem['type'], CleanupItem[]>();
  for (const item of sorted) {
    if (!map.has(item.type)) map.set(item.type, []);
    map.get(item.type)!.push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CleanupModal({ projectId, open, onClose, onDone }: CleanupModalProps) {
  const api = useApi();
  const dialogRef = useRef<HTMLDivElement>(null);

  // State machine: loading -> preview -> executing -> result
  const [phase, setPhase] = useState<'loading' | 'preview' | 'executing' | 'result'>('loading');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------
  // Close handler (after result, also trigger parent refresh)
  // -------------------------------------------------------------------
  const handleClose = useCallback(() => {
    if (phase === 'result') {
      onDone();
    }
    onClose();
  }, [phase, onClose, onDone]);

  // -------------------------------------------------------------------
  // Fetch preview when modal opens
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    setPhase('loading');
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    setError(null);

    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<CleanupPreview>(
          `projects/${projectId}/cleanup-preview`,
        );
        if (cancelled) return;
        setPreview(data);
        // Select all items by default
        setSelected(new Set(data.items.map((it) => it.path)));
        setPhase('preview');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('preview');
      }
    })();
    return () => { cancelled = true; };
  }, [open, projectId, api]);

  // -------------------------------------------------------------------
  // Keyboard: Escape to close
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'executing') handleClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, phase, handleClose]);

  // -------------------------------------------------------------------
  // Selection helpers
  // -------------------------------------------------------------------
  const toggleItem = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!preview) return;
    setSelected(new Set(preview.items.map((it) => it.path)));
  }, [preview]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  // -------------------------------------------------------------------
  // Execute cleanup
  // -------------------------------------------------------------------
  const handleConfirm = useCallback(async () => {
    if (selected.size === 0) return;
    setPhase('executing');
    setError(null);

    try {
      const data = await api.post<CleanupResult>(`projects/${projectId}/cleanup`, {
        items: Array.from(selected),
      });
      setResult(data);
      setPhase('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('preview'); // go back to preview so user can retry
    }
  }, [api, projectId, selected]);

  // Backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        handleClose();
      }
    },
    [handleClose],
  );

  if (!open) return null;

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  const groups = preview ? groupByType(preview.items) : new Map();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className="w-[560px] max-w-[95vw] max-h-[80vh] flex flex-col bg-dark-surface border border-dark-border rounded-lg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Clean Up"
      >
        {/* ------- Header ------- */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border shrink-0">
          <h2 className="text-base font-semibold text-dark-text">
            Clean Up{preview ? ` \u2014 ${preview.projectName}` : ''}
          </h2>
          <button
            onClick={handleClose}
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

        {/* ------- Body ------- */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          {/* Loading */}
          {phase === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <p className="text-dark-muted text-sm">Scanning for items to clean up...</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
              {error}
            </div>
          )}

          {/* Preview — nothing to clean */}
          {phase === 'preview' && preview && preview.items.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <span className="text-3xl">&#x2728;</span>
              <p className="text-dark-muted text-sm">Nothing to clean up!</p>
              <p className="text-dark-muted/60 text-xs">This project is already tidy.</p>
            </div>
          )}

          {/* Preview — items to clean */}
          {phase === 'preview' && preview && preview.items.length > 0 && (
            <>
              {/* Select/Deselect buttons */}
              <div className="flex items-center gap-3 mb-3">
                <button
                  onClick={selectAll}
                  className="text-xs text-dark-accent hover:underline"
                >
                  Select All
                </button>
                <button
                  onClick={deselectAll}
                  className="text-xs text-dark-muted hover:underline"
                >
                  Deselect All
                </button>
                <span className="ml-auto text-xs text-dark-muted">
                  {selected.size} of {preview.items.length} selected
                </span>
              </div>

              {/* Groups */}
              {Array.from(groups.entries()).map(([type, items]) => (
                <div key={type} className="mb-4">
                  <h3 className="text-xs font-semibold text-dark-muted uppercase tracking-wider mb-2">
                    {TYPE_ICONS[type]} {TYPE_LABELS[type]} ({items.length})
                  </h3>
                  <div className="space-y-1">
                    {items.map((item) => (
                      <label
                        key={item.path}
                        className="flex items-start gap-2.5 px-3 py-2 rounded border border-dark-border/50 hover:border-dark-border bg-dark-base/50 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(item.path)}
                          onChange={() => toggleItem(item.path)}
                          className="mt-0.5 accent-[#F85149] shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-dark-text truncate" title={item.path}>
                            {item.name}
                          </div>
                          <div className="text-xs text-dark-muted/70 truncate">
                            {item.reason}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Executing */}
          {phase === 'executing' && (
            <div className="flex items-center justify-center py-12">
              <p className="text-dark-muted text-sm">Removing {selected.size} item{selected.size !== 1 ? 's' : ''}...</p>
            </div>
          )}

          {/* Result */}
          {phase === 'result' && result && (
            <div className="py-4 space-y-3">
              {result.removed.length > 0 && (
                <div>
                  <p className="text-sm text-dark-text font-medium mb-1">
                    Removed {result.removed.length} item{result.removed.length !== 1 ? 's' : ''}
                  </p>
                  <ul className="space-y-0.5">
                    {result.removed.map((name) => (
                      <li key={name} className="text-xs text-dark-muted flex items-center gap-1.5">
                        <span className="text-green-400">&#x2713;</span> {name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.failed.length > 0 && (
                <div>
                  <p className="text-sm text-[#F85149] font-medium mb-1">
                    {result.failed.length} failed
                  </p>
                  <ul className="space-y-0.5">
                    {result.failed.map((f) => (
                      <li key={f.name} className="text-xs text-[#F85149]/80 flex items-start gap-1.5">
                        <span className="shrink-0">&#x2717;</span>
                        <span className="truncate" title={f.error}>
                          {f.name}: {f.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.removed.length === 0 && result.failed.length === 0 && (
                <p className="text-sm text-dark-muted">No items were removed.</p>
              )}
            </div>
          )}
        </div>

        {/* ------- Footer ------- */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border shrink-0">
          {phase === 'preview' && preview && preview.items.length > 0 && (
            <>
              <button
                onClick={handleClose}
                className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={selected.size === 0}
                className="px-4 py-1.5 text-sm font-medium rounded border border-[#F85149]/40 text-[#F85149] bg-[#F85149]/10 hover:bg-[#F85149]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Remove Selected ({selected.size})
              </button>
            </>
          )}

          {(phase === 'result' || (phase === 'preview' && (!preview || preview.items.length === 0))) && (
            <button
              onClick={handleClose}
              className="px-4 py-1.5 text-sm font-medium rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
