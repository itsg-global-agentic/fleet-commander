// =============================================================================
// Fleet Commander -- GitHubSourceDialog (modal for adding/editing GitHub issue source)
// =============================================================================
// Follows the JiraSourceDialog pattern: modal overlay, dark theme, form fields,
// Test Connection + Save buttons.
// =============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ProjectIssueSourceResponse, GitHubSourceConfig, GitHubSourceCredentials, GitHubAuthMode } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitHubSourceDialogProps {
  open: boolean;
  projectId: number;
  source?: ProjectIssueSourceResponse | null;
  onClose: () => void;
  onSave: (data: {
    provider: string;
    label: string | null;
    configJson: string;
    credentialsJson: string;
    enabled: boolean;
  }) => Promise<void>;
}

interface TestResult {
  ok: boolean;
  repoName?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GitHubSourceDialog
// ---------------------------------------------------------------------------

export function GitHubSourceDialog({ open, projectId, source, onClose, onSave }: GitHubSourceDialogProps) {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [authMode, setAuthMode] = useState<GitHubAuthMode>('gh-cli');
  const [pat, setPat] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const ownerInputRef = useRef<HTMLInputElement>(null);

  // Populate fields when opening (create vs edit)
  useEffect(() => {
    if (open) {
      if (source) {
        // Edit mode: parse existing config
        try {
          const config: GitHubSourceConfig = JSON.parse(source.configJson);
          setOwner(config.owner || '');
          setRepo(config.repo || '');
          setAuthMode(config.authMode || 'gh-cli');
        } catch {
          setOwner('');
          setRepo('');
          setAuthMode('gh-cli');
        }
        // Fetch credentials from the dedicated endpoint
        setPat('');
        if (source.hasCredentials) {
          fetch(`/api/projects/${projectId}/issue-sources/${source.id}/credentials`)
            .then((res) => res.json())
            .then((data: { credentialsJson: string | null }) => {
              if (data.credentialsJson) {
                try {
                  const creds: GitHubSourceCredentials = JSON.parse(data.credentialsJson);
                  setPat(creds.pat || '');
                } catch {
                  // Invalid credentials JSON -- leave fields empty
                }
              }
            })
            .catch(() => {
              // Failed to fetch credentials -- leave fields empty
            });
        }
        setLabel(source.label || '');
        setEnabled(source.enabled);
      } else {
        // Create mode: reset all fields
        setOwner('');
        setRepo('');
        setAuthMode('gh-cli');
        setPat('');
        setLabel('');
        setEnabled(true);
      }
      setError(null);
      setTestResult(null);
      setSaving(false);
      setTesting(false);
      setTimeout(() => ownerInputRef.current?.focus(), 50);
    }
  }, [open, source, projectId]);

  const validate = useCallback((): string | null => {
    if (!owner.trim()) return 'Owner is required';
    if (!repo.trim()) return 'Repository is required';
    if (authMode === 'pat' && !pat.trim()) return 'Personal Access Token is required';
    return null;
  }, [owner, repo, authMode, pat]);

  const handleTestConnection = useCallback(async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setTestResult(null);
    setTesting(true);
    try {
      const resp = await fetch(`/api/projects/${projectId}/issue-sources/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          owner: owner.trim(),
          repo: repo.trim(),
          authMode,
          ...(authMode === 'pat' ? { pat: pat.trim() } : {}),
        }),
      });
      const data = await resp.json() as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setTesting(false);
    }
  }, [validate, projectId, owner, repo, authMode, pat]);

  const handleSubmit = useCallback(async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const configJson = JSON.stringify({
        owner: owner.trim(),
        repo: repo.trim(),
        authMode,
      } satisfies GitHubSourceConfig);
      const credentialsJson = authMode === 'pat'
        ? JSON.stringify({ pat: pat.trim() } satisfies GitHubSourceCredentials)
        : '';

      await onSave({
        provider: 'github',
        label: label.trim() || null,
        configJson,
        credentialsJson,
        enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setSaving(false);
    }
  }, [validate, owner, repo, authMode, pat, label, enabled, onSave]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[480px] max-w-[95vw] bg-dark-surface border border-dark-border rounded-lg shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-border">
          <h2 className="text-base font-semibold text-dark-text">
            {source ? 'Edit GitHub Source' : 'Add GitHub Source'}
          </h2>
          <button
            onClick={onClose}
            className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
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
        <div className="px-5 py-4 space-y-3">
          {/* Label (optional) */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Label (optional)</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="e.g. My GitHub Repo"
            />
          </div>

          {/* Owner */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Owner</label>
            <input
              ref={ownerInputRef}
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="e.g. octocat"
            />
          </div>

          {/* Repository */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Repository</label>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="e.g. hello-world"
            />
          </div>

          {/* Auth Mode */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Authentication</label>
            <div className="flex items-center gap-4 mt-1">
              <label className="flex items-center gap-1.5 text-sm text-dark-text cursor-pointer">
                <input
                  type="radio"
                  name="authMode"
                  value="gh-cli"
                  checked={authMode === 'gh-cli'}
                  onChange={() => setAuthMode('gh-cli')}
                  className="accent-[#3FB950]"
                />
                gh CLI (default)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-dark-text cursor-pointer">
                <input
                  type="radio"
                  name="authMode"
                  value="pat"
                  checked={authMode === 'pat'}
                  onChange={() => setAuthMode('pat')}
                  className="accent-[#3FB950]"
                />
                Personal Access Token
              </label>
            </div>
          </div>

          {/* gh CLI note */}
          {authMode === 'gh-cli' && (
            <div className="text-xs text-dark-muted/70 bg-dark-base/50 rounded px-3 py-2 border border-dark-border/50">
              Uses local <code className="text-dark-accent/80">gh auth</code> session -- no credentials needed.
            </div>
          )}

          {/* PAT input */}
          {authMode === 'pat' && (
            <div>
              <label className="block text-xs text-dark-muted mb-1">Personal Access Token</label>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
                className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
                placeholder="ghp_xxxxxxxxxxxx"
                autoComplete="off"
              />
            </div>
          )}

          {/* Enabled toggle (edit mode only) */}
          {source && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-dark-muted">Enabled</label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  enabled ? 'bg-[#3FB950]' : 'bg-dark-border'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          )}

          {/* Test Connection result */}
          {testResult && (
            <div
              className="text-xs rounded px-3 py-2 border"
              style={{
                color: testResult.ok ? '#3FB950' : '#F85149',
                borderColor: testResult.ok ? '#3FB95040' : '#F8514940',
                backgroundColor: testResult.ok ? '#3FB95010' : '#F8514910',
              }}
            >
              {testResult.ok
                ? `Connected successfully${testResult.repoName ? ` -- repo: ${testResult.repoName}` : ''}`
                : testResult.error || 'Connection failed'}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs text-[#F85149]">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-dark-border">
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors disabled:opacity-50"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-dark-border text-dark-muted hover:text-dark-text hover:border-dark-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="px-4 py-1.5 text-sm font-medium rounded border border-dark-accent/40 text-dark-accent bg-dark-accent/10 hover:bg-dark-accent/20 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : (source ? 'Save' : 'Create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
