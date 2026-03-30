import React, { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { formatIssueKey } from '../../shared/issue-provider';
import type { IssueRelations, IssueRelationRef } from '../../shared/issue-provider';
import { LinkIcon, XIcon } from './Icons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelationsPanelProps {
  issueKey: string;
  projectId: number;
  issueProvider: string;
  relations: IssueRelations;
  onClose: () => void;
  onRelationChanged: () => void;
}

// ---------------------------------------------------------------------------
// Inline add input
// ---------------------------------------------------------------------------

function AddRelationInput({
  placeholder,
  onSubmit,
  loading,
}: {
  placeholder: string;
  onSubmit: (key: string) => void;
  loading: boolean;
}) {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setValue('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-1 mt-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={loading}
        className="w-24 px-1.5 py-0.5 text-xs bg-dark-bg border border-dark-border rounded text-dark-text placeholder-dark-muted/50 focus:outline-none focus:border-dark-accent"
      />
      <button
        type="submit"
        disabled={loading || !value.trim()}
        className="px-1.5 py-0.5 text-xs rounded border border-dark-border text-dark-muted hover:text-dark-accent hover:border-dark-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : (
          'Add'
        )}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Relation ref row (with optional remove button)
// ---------------------------------------------------------------------------

function RelationRefRow({
  relRef,
  issueProvider,
  onRemove,
  removing,
}: {
  relRef: IssueRelationRef;
  issueProvider: string;
  onRemove?: () => void;
  removing: boolean;
}) {
  const displayKey = formatIssueKey(relRef.key, issueProvider);
  const isClosed = relRef.state === 'closed';

  return (
    <div className="flex items-center gap-1.5 py-0.5 group/ref">
      <span
        className={`text-xs ${isClosed ? 'text-dark-muted/60 line-through' : 'text-dark-text'}`}
        title={`${relRef.title} (${relRef.state})`}
      >
        {displayKey}
      </span>
      <span className="text-xs text-dark-muted truncate max-w-[120px]" title={relRef.title}>
        {relRef.title}
      </span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          disabled={removing}
          className="opacity-0 group-hover/ref:opacity-100 transition-opacity text-dark-muted hover:text-[#F85149] disabled:opacity-50"
          title="Remove"
        >
          {removing ? (
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          ) : (
            <XIcon size={10} />
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relations Panel
// ---------------------------------------------------------------------------

export const RelationsPanel = React.memo(function RelationsPanel({
  issueKey,
  projectId,
  issueProvider,
  relations,
  onClose,
  onRelationChanged,
}: RelationsPanelProps) {
  const api = useApi();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const basePath = `projects/${projectId}/issues/${issueKey}`;

  const handleError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
    setTimeout(() => setError(null), 3000);
  }, []);

  const withLoading = useCallback(
    async (actionKey: string, fn: () => Promise<void>) => {
      setLoadingAction(actionKey);
      setError(null);
      try {
        await fn();
        onRelationChanged();
      } catch (err) {
        handleError(err);
      } finally {
        setLoadingAction(null);
      }
    },
    [onRelationChanged, handleError],
  );

  // Blocked-by actions
  const addBlockedBy = useCallback(
    (blockerKey: string) =>
      withLoading(`add-blocker-${blockerKey}`, () =>
        api.post(`${basePath}/blocked-by`, { blockerKey }).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  const removeBlockedBy = useCallback(
    (blockerKey: string) =>
      withLoading(`rm-blocker-${blockerKey}`, () =>
        api.del(`${basePath}/blocked-by/${blockerKey}`).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  // Parent actions
  const setParent = useCallback(
    (parentKey: string) =>
      withLoading(`set-parent-${parentKey}`, () =>
        api.post(`${basePath}/parent`, { parentKey }).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  const removeParent = useCallback(
    () =>
      withLoading('rm-parent', () =>
        api.del(`${basePath}/parent`).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  // Children actions
  const addChild = useCallback(
    (childKey: string) =>
      withLoading(`add-child-${childKey}`, () =>
        api.post(`${basePath}/children`, { childKey }).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  const removeChild = useCallback(
    (childKey: string) =>
      withLoading(`rm-child-${childKey}`, () =>
        api.del(`${basePath}/children/${childKey}`).then(() => undefined),
      ),
    [api, basePath, withLoading],
  );

  const isLoading = loadingAction !== null;

  return (
    <div className="bg-dark-surface/60 border border-dark-border rounded-md p-2 mt-1 mb-1 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-dark-muted font-medium flex items-center gap-1">
          <LinkIcon size={12} />
          Relations for {formatIssueKey(issueKey, issueProvider)}
        </span>
        <button
          onClick={onClose}
          className="text-dark-muted hover:text-dark-text transition-colors"
          title="Close relations panel"
        >
          <XIcon size={12} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-[#F85149] text-xs mb-2 px-1">
          {error}
        </div>
      )}

      {/* Parent section */}
      <div className="mb-2">
        <div className="text-dark-muted font-medium mb-0.5">Parent</div>
        {relations.parent ? (
          <RelationRefRow
            relRef={relations.parent}
            issueProvider={issueProvider}
            onRemove={removeParent}
            removing={loadingAction === 'rm-parent'}
          />
        ) : (
          <div className="text-dark-muted/60 italic">None</div>
        )}
        {!relations.parent && (
          <AddRelationInput
            placeholder={issueProvider === 'github' ? 'Issue #' : 'Issue key'}
            onSubmit={setParent}
            loading={isLoading}
          />
        )}
      </div>

      {/* Children section */}
      <div className="mb-2">
        <div className="text-dark-muted font-medium mb-0.5">Children</div>
        {relations.children.length > 0 ? (
          relations.children.map((child) => (
            <RelationRefRow
              key={child.key}
              relRef={child}
              issueProvider={issueProvider}
              onRemove={() => removeChild(child.key)}
              removing={loadingAction === `rm-child-${child.key}`}
            />
          ))
        ) : (
          <div className="text-dark-muted/60 italic">None</div>
        )}
        <AddRelationInput
          placeholder={issueProvider === 'github' ? 'Child issue #' : 'Child key'}
          onSubmit={addChild}
          loading={isLoading}
        />
      </div>

      {/* Blocked by section */}
      <div className="mb-2">
        <div className="text-dark-muted font-medium mb-0.5">Blocked by</div>
        {relations.blockedBy.length > 0 ? (
          relations.blockedBy.map((blocker) => (
            <RelationRefRow
              key={blocker.key}
              relRef={blocker}
              issueProvider={issueProvider}
              onRemove={() => removeBlockedBy(blocker.key)}
              removing={loadingAction === `rm-blocker-${blocker.key}`}
            />
          ))
        ) : (
          <div className="text-dark-muted/60 italic">None</div>
        )}
        <AddRelationInput
          placeholder={issueProvider === 'github' ? 'Blocker issue #' : 'Blocker key'}
          onSubmit={addBlockedBy}
          loading={isLoading}
        />
      </div>

      {/* Blocking section (read-only) */}
      <div>
        <div className="text-dark-muted font-medium mb-0.5">Blocking</div>
        {relations.blocking.length > 0 ? (
          relations.blocking.map((blocked) => (
            <RelationRefRow
              key={blocked.key}
              relRef={blocked}
              issueProvider={issueProvider}
              removing={false}
            />
          ))
        ) : (
          <div className="text-dark-muted/60 italic">None</div>
        )}
      </div>
    </div>
  );
});
