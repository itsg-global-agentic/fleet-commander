import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

// ---------------------------------------------------------------------------
// AddProjectDialog
// ---------------------------------------------------------------------------

export function AddProjectDialog({ open, onClose, onAdded }: AddProjectDialogProps) {
  const api = useApi();

  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus first input when dialog opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => nameRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      setRepoPath('');
      setGithubRepo('');
      setError(null);
      setLoading(false);
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

  // Submit
  const handleSubmit = useCallback(async () => {
    setError(null);

    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    if (!repoPath.trim()) {
      setError('Repository path is required');
      return;
    }

    setLoading(true);
    try {
      await api.post('projects', {
        name: name.trim(),
        repoPath: repoPath.trim(),
        githubRepo: githubRepo.trim() || undefined,
      });
      onAdded();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to add project');
    } finally {
      setLoading(false);
    }
  }, [name, repoPath, githubRepo, api, onAdded]);

  // Enter key submits
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !loading) {
        handleSubmit();
      }
    },
    [loading, handleSubmit],
  );

  if (!open) return null;

  return (
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
        aria-label="Add Project"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border">
          <h2 className="text-base font-semibold text-dark-text">Add Project</h2>
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

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Project name */}
          <div>
            <label className="block text-sm text-dark-muted mb-1">
              Project Name <span className="text-[#F85149]">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my-project"
              className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
              disabled={loading}
            />
          </div>

          {/* Repository path */}
          <div>
            <label className="block text-sm text-dark-muted mb-1">
              Repository Path <span className="text-[#F85149]">*</span>
            </label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="C:/Git/my-repo"
              className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
              disabled={loading}
            />
          </div>

          {/* GitHub repo (optional) */}
          <div>
            <label className="block text-sm text-dark-muted mb-1">
              GitHub Repo <span className="text-dark-muted/50">(optional)</span>
            </label>
            <input
              type="text"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="org/repo (auto-detected)"
              className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
              disabled={loading}
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="px-3 py-2 rounded border border-[#F85149]/30 bg-[#F85149]/10 text-[#F85149] text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-dark-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Adding...' : 'Add Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
