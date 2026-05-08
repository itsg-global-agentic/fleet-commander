import { useState, useCallback, useEffect, useRef } from 'react';
import type { SpawnRecord } from '../../shared/types';
import { formatRelativeTime } from '../utils/format-time';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pill colors per terminal status. Matches the dark-theme palette used
 * elsewhere in the app: green=done, blue=running.
 */
const STATUS_PILL: Record<string, { label: string; color: string }> = {
  running: { label: 'running', color: '#58A6FF' },
  done: { label: 'done', color: '#3FB950' },
  // 'crashed' is not emitted from the server in v1; included for forward compat.
  crashed: { label: 'crashed', color: '#F85149' },
};

// ---------------------------------------------------------------------------
// Sub-component: SpawnCard — one captured spawn entry
// ---------------------------------------------------------------------------

interface SpawnCardProps {
  spawn: SpawnRecord;
}

function SpawnCard({ spawn }: SpawnCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!spawn.content) return;
    navigator.clipboard.writeText(spawn.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard API may not be available
    });
  }, [spawn.content]);

  const pill = STATUS_PILL[spawn.terminalStatus] || { label: spawn.terminalStatus, color: '#8B949E' };

  return (
    <div className="border border-dark-border/50 rounded-md bg-dark-surface/40">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-dark-border/30">
        <span
          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
          style={{ backgroundColor: pill.color + '20', color: pill.color }}
        >
          {pill.label}
        </span>
        <span className="text-xs text-dark-muted">from</span>
        <span className="text-xs text-dark-text font-mono">{spawn.sender}</span>
        <span className="flex-1" />
        <span className="text-xs text-dark-muted" title={spawn.createdAt}>
          {formatRelativeTime(spawn.createdAt)}
        </span>
      </div>

      {/* Prompt body */}
      {spawn.content === null ? (
        <div className="px-3 py-3 text-xs italic text-dark-muted/80">
          no prompt recorded
        </div>
      ) : (
        <>
          <div className="flex items-center justify-end px-3 py-1 bg-dark-surface/30">
            <button
              onClick={handleCopy}
              className="text-xs text-dark-muted hover:text-dark-text transition-colors flex items-center gap-1"
              title="Copy prompt"
            >
              {copied ? (
                <>
                  <svg className="w-3 h-3 text-[#3FB950]" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" clipRule="evenodd" />
                    <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" clipRule="evenodd" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="px-3 py-2 text-xs text-dark-text/90 whitespace-pre-wrap break-words max-h-72 overflow-y-auto custom-scrollbar font-mono leading-relaxed">
            {spawn.content}
          </pre>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SpawnPromptPanelProps {
  agentName: string;
  spawns: SpawnRecord[];
  onClose: () => void;
}

/**
 * Floating side panel shown inside the Team tab when a CommGraph node is
 * clicked. Lists every captured TL->subagent spawn for the selected agent
 * with its prompt, timestamp, sender, and terminal status. Issue #713.
 *
 * Closes on:
 *   - the X button
 *   - Escape key (handler installed at panel level so it fires before the
 *     parent TeamDetail's Esc handler)
 *   - click outside the panel
 */
export function SpawnPromptPanel({ agentName, spawns, onClose }: SpawnPromptPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key — close panel. Capture phase so we run BEFORE the parent
  // TeamDetail's Esc handler which closes the whole panel.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  // Click outside — close panel. We listen on mousedown to mirror the
  // pattern used elsewhere in the codebase.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const node = panelRef.current;
      if (node && !node.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute top-2 right-2 w-[480px] max-w-[90%] max-h-[85%] flex flex-col border border-dark-border bg-dark-surface rounded-md shadow-lg z-10"
      role="dialog"
      aria-label={`Spawn prompts for ${agentName}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-dark-border shrink-0">
        <span className="text-sm font-semibold text-dark-text truncate">{agentName}</span>
        <span className="text-xs text-dark-muted">
          {spawns.length} spawn{spawns.length === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="text-dark-muted hover:text-dark-text transition-colors p-1 rounded hover:bg-dark-border/30"
          title="Close (Esc)"
          aria-label="Close spawn prompt panel"
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
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 space-y-2">
        {spawns.length === 0 ? (
          <div className="text-center py-8 text-sm text-dark-muted/80 italic">
            No spawn records for this agent
          </div>
        ) : (
          spawns.map((spawn) => <SpawnCard key={spawn.id} spawn={spawn} />)
        )}
      </div>
    </div>
  );
}
