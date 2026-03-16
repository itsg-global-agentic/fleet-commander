import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseDirsResponse {
  parentPath: string;
  dirs: DirEntry[];
}

// ---------------------------------------------------------------------------
// AddProjectDialog
// ---------------------------------------------------------------------------

export function AddProjectDialog({ open, onClose, onAdded }: AddProjectDialogProps) {
  const api = useApi();

  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [maxActiveTeams, setMaxActiveTeams] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Path picker state
  const [suggestions, setSuggestions] = useState<DirEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const [parentPath, setParentPath] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setMaxActiveTeams(5);
      setError(null);
      setLoading(false);
      setSuggestions([]);
      setShowSuggestions(false);
      setSelectedSuggestion(-1);
      setParentPath('');
    }
  }, [open]);

  // Close on Escape (only when suggestions are not shown)
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showSuggestions) {
          setShowSuggestions(false);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, showSuggestions]);

  // Close suggestions when clicking outside the path input area
  useEffect(() => {
    if (!showSuggestions) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        pathInputRef.current && !pathInputRef.current.contains(target) &&
        suggestionsRef.current && !suggestionsRef.current.contains(target)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSuggestions]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  // Fetch directory suggestions
  const fetchSuggestions = useCallback(
    async (searchPath: string) => {
      if (!searchPath.trim()) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }

      try {
        const encoded = encodeURIComponent(searchPath);
        const result = await api.get<BrowseDirsResponse>(
          `system/browse-dirs?path=${encoded}`,
        );
        setSuggestions(result.dirs);
        setParentPath(result.parentPath);
        setShowSuggestions(result.dirs.length > 0);
        setSelectedSuggestion(-1);
      } catch {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    [api],
  );

  // Debounced path change handler
  const handlePathChange = useCallback(
    (value: string) => {
      setRepoPath(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Browse the directory when path ends with / or \, or browse the parent
      const browsePath = value.endsWith('/') || value.endsWith('\\')
        ? value
        : value.substring(0, Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);

      if (browsePath) {
        debounceRef.current = setTimeout(() => {
          fetchSuggestions(browsePath);
        }, 300);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    [fetchSuggestions],
  );

  // Select a suggestion
  const selectSuggestion = useCallback(
    (dir: DirEntry) => {
      setRepoPath(dir.path);
      setShowSuggestions(false);
      setSelectedSuggestion(-1);

      // Auto-fill name from directory name if name is empty
      if (!name.trim()) {
        setName(dir.name);
      }

      // If it's not a git repo, browse into it
      if (!dir.isGitRepo) {
        setTimeout(() => {
          fetchSuggestions(dir.path + '/');
        }, 100);
      }

      pathInputRef.current?.focus();
    },
    [name, fetchSuggestions],
  );

  // Navigate to parent directory
  const navigateUp = useCallback(() => {
    if (!parentPath) return;
    const parent = parentPath.replace(/\/[^/]+\/?$/, '');
    if (parent && parent !== parentPath) {
      setRepoPath(parent);
      fetchSuggestions(parent + '/');
    }
  }, [parentPath, fetchSuggestions]);

  // Check if current path looks like a git repo
  const isCurrentPathGitRepo = suggestions.length === 0
    ? false
    : repoPath === parentPath
      ? false
      : suggestions.some((d) => d.path === repoPath && d.isGitRepo);

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
        maxActiveTeams,
      });
      onAdded();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to add project');
    } finally {
      setLoading(false);
    }
  }, [name, repoPath, githubRepo, maxActiveTeams, api, onAdded]);

  // Keyboard navigation for suggestions + Enter to submit
  const handlePathKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSuggestions && suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedSuggestion((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedSuggestion((prev) =>
            prev > 0 ? prev - 1 : suggestions.length - 1,
          );
          return;
        }
        if (e.key === 'Enter' && selectedSuggestion >= 0) {
          e.preventDefault();
          selectSuggestion(suggestions[selectedSuggestion]);
          return;
        }
        if (e.key === 'Tab' && selectedSuggestion >= 0) {
          e.preventDefault();
          selectSuggestion(suggestions[selectedSuggestion]);
          return;
        }
      }
      if (e.key === 'Enter' && !loading) {
        handleSubmit();
      }
    },
    [showSuggestions, suggestions, selectedSuggestion, selectSuggestion, loading, handleSubmit],
  );

  // Enter key submits for other fields
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

          {/* Repository path with suggestions */}
          <div className="relative">
            <label className="block text-sm text-dark-muted mb-1">
              Repository Path <span className="text-[#F85149]">*</span>
            </label>
            <div className="relative">
              <input
                ref={pathInputRef}
                type="text"
                value={repoPath}
                onChange={(e) => handlePathChange(e.target.value)}
                onKeyDown={handlePathKeyDown}
                onFocus={() => {
                  if (suggestions.length > 0) setShowSuggestions(true);
                }}
                placeholder="C:/Git/my-repo"
                className={`w-full px-3 py-2 text-sm rounded border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:ring-1 ${
                  isCurrentPathGitRepo
                    ? 'border-green-500/50 focus:border-green-500 focus:ring-green-500/30'
                    : 'border-dark-border focus:border-dark-accent focus:ring-dark-accent/30'
                }`}
                disabled={loading}
                autoComplete="off"
              />
              {/* Git repo indicator */}
              {isCurrentPathGitRepo && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-green-400" title="Valid git repository">
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-dark-muted/60">
              Type a path and subdirectories will appear. End with / to browse.
            </p>

            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute z-10 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded border border-dark-border bg-dark-base shadow-lg"
              >
                {/* Parent dir option */}
                {parentPath && (
                  <button
                    type="button"
                    onClick={navigateUp}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-dark-muted hover:bg-dark-border/30 hover:text-dark-text transition-colors text-left"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>..</span>
                    <span className="ml-auto text-xs text-dark-muted/50 truncate">{parentPath}</span>
                  </button>
                )}
                {suggestions.map((dir, i) => (
                  <button
                    key={dir.path}
                    type="button"
                    onClick={() => selectSuggestion(dir)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors text-left ${
                      i === selectedSuggestion
                        ? 'bg-dark-accent/20 text-dark-text'
                        : 'text-dark-text hover:bg-dark-border/30'
                    }`}
                  >
                    {/* Git repo indicator or folder icon */}
                    {dir.isGitRepo ? (
                      <span className="w-3.5 h-3.5 shrink-0 rounded-full bg-green-500/80 inline-flex items-center justify-center" title="Git repository">
                        <svg className="w-2 h-2 text-white" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    ) : (
                      <svg className="w-3.5 h-3.5 shrink-0 text-dark-muted/50" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                    )}
                    <span className="truncate">{dir.name}</span>
                    {dir.isGitRepo && (
                      <span className="ml-auto text-xs text-green-400/70 shrink-0">git</span>
                    )}
                  </button>
                ))}
              </div>
            )}
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

          {/* Max Active Teams */}
          <div>
            <label className="block text-sm text-dark-muted mb-1">
              Max Active Teams
            </label>
            <input
              type="number"
              value={maxActiveTeams}
              onChange={(e) => setMaxActiveTeams(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
              onKeyDown={handleKeyDown}
              min={1}
              max={50}
              className="w-full px-3 py-2 text-sm rounded border border-dark-border bg-dark-base text-dark-text placeholder:text-dark-muted/50 focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-dark-muted/60">
              Max concurrent active teams before new launches are queued (1-50, default: 5).
            </p>
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
