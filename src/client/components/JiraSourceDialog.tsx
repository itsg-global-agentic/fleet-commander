// =============================================================================
// Fleet Commander -- JiraSourceDialog (modal for adding/editing Jira issue source)
// =============================================================================
// Follows the GroupDialog pattern: modal overlay, dark theme, form fields,
// Test Connection + Save buttons.
// =============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ProjectIssueSource, JiraSourceConfig, JiraSourceCredentials } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JiraSourceDialogProps {
  open: boolean;
  projectId: number;
  source?: ProjectIssueSource | null;
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
  projectName?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// JiraSourceDialog
// ---------------------------------------------------------------------------

export function JiraSourceDialog({ open, projectId, source, onClose, onSave }: JiraSourceDialogProps) {
  const [jiraUrl, setJiraUrl] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const urlInputRef = useRef<HTMLInputElement>(null);

  // Populate fields when opening (create vs edit)
  useEffect(() => {
    if (open) {
      if (source) {
        // Edit mode: parse existing config/credentials
        try {
          const config: JiraSourceConfig = JSON.parse(source.configJson);
          setJiraUrl(config.jiraUrl || '');
          setProjectKey(config.projectKey || '');
        } catch {
          setJiraUrl('');
          setProjectKey('');
        }
        try {
          if (source.credentialsJson) {
            const creds: JiraSourceCredentials = JSON.parse(source.credentialsJson);
            setEmail(creds.email || '');
            setApiToken(creds.apiToken || '');
          } else {
            setEmail('');
            setApiToken('');
          }
        } catch {
          setEmail('');
          setApiToken('');
        }
        setLabel(source.label || '');
        setEnabled(source.enabled);
      } else {
        // Create mode: reset all fields
        setJiraUrl('');
        setProjectKey('');
        setEmail('');
        setApiToken('');
        setLabel('');
        setEnabled(true);
      }
      setError(null);
      setTestResult(null);
      setSaving(false);
      setTesting(false);
      setTimeout(() => urlInputRef.current?.focus(), 50);
    }
  }, [open, source]);

  const validate = useCallback((): string | null => {
    if (!jiraUrl.trim()) return 'Jira URL is required';
    if (!jiraUrl.trim().startsWith('https://')) return 'Jira URL must start with https://';
    if (!projectKey.trim()) return 'Project Key is required';
    if (!email.trim()) return 'Email is required';
    if (!apiToken.trim()) return 'API Token is required';
    return null;
  }, [jiraUrl, projectKey, email, apiToken]);

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
          jiraUrl: jiraUrl.trim().replace(/\/+$/, ''),
          projectKey: projectKey.trim(),
          email: email.trim(),
          apiToken: apiToken.trim(),
        }),
      });
      const data = await resp.json() as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setTesting(false);
    }
  }, [validate, projectId, jiraUrl, projectKey, email, apiToken]);

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
        jiraUrl: jiraUrl.trim().replace(/\/+$/, ''),
        projectKey: projectKey.trim(),
      } satisfies JiraSourceConfig);
      const credentialsJson = JSON.stringify({
        email: email.trim(),
        apiToken: apiToken.trim(),
      } satisfies JiraSourceCredentials);

      await onSave({
        provider: 'jira',
        label: label.trim() || null,
        configJson,
        credentialsJson,
        enabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setSaving(false);
    }
  }, [validate, jiraUrl, projectKey, email, apiToken, label, enabled, onSave]);

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
            {source ? 'Edit Jira Source' : 'Add Jira Source'}
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
              placeholder="e.g. My Jira Project"
            />
          </div>

          {/* Jira URL */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Jira URL</label>
            <input
              ref={urlInputRef}
              type="text"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="https://your-domain.atlassian.net"
            />
          </div>

          {/* Project Key */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Project Key</label>
            <input
              type="text"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="e.g. PROJ"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="you@company.com"
            />
          </div>

          {/* API Token (password-masked) */}
          <div>
            <label className="block text-xs text-dark-muted mb-1">API Token</label>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              className="w-full px-3 py-1.5 text-sm rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent"
              placeholder="Jira API token"
              autoComplete="off"
            />
          </div>

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
                ? `Connected successfully${testResult.projectName ? ` — project: ${testResult.projectName}` : ''}`
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
