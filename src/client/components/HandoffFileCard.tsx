import { useState, useCallback } from 'react';
import type { HandoffFile } from '../../shared/types';
import { formatRelativeTime } from '../utils/format-time';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Label and color for each file type */
const FILE_TYPE_META: Record<string, { label: string; color: string }> = {
  'plan.md': { label: 'Plan', color: '#58A6FF' },
  'changes.md': { label: 'Changes', color: '#3FB950' },
  'review.md': { label: 'Review', color: '#D29922' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HandoffFileCardProps {
  file: HandoffFile;
  defaultExpanded?: boolean;
}

export function HandoffFileCard({ file, defaultExpanded = false }: HandoffFileCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const meta = FILE_TYPE_META[file.fileType] || { label: file.fileType, color: '#8B949E' };

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(file.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard API may not be available
    });
  }, [file.content]);

  return (
    <div className="border border-dark-border/50 rounded-md overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-border/10 transition-colors text-left"
      >
        {/* Expand/collapse chevron */}
        <svg
          className={`w-3.5 h-3.5 text-dark-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
        </svg>

        {/* File type badge */}
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded"
          style={{ backgroundColor: meta.color + '20', color: meta.color }}
        >
          {meta.label}
        </span>

        {/* File name */}
        <span className="text-sm text-dark-text font-mono">{file.fileType}</span>

        {/* Agent name */}
        {file.agentName && (
          <span className="text-[10px] text-dark-muted px-1.5 py-0.5 rounded bg-dark-border/20">
            {file.agentName}
          </span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Timestamp */}
        <span className="text-xs text-dark-muted">
          {formatRelativeTime(file.capturedAt)}
        </span>
      </button>

      {/* Content */}
      {expanded && (
        <div className="border-t border-dark-border/30">
          {/* Toolbar */}
          <div className="flex items-center justify-end px-3 py-1 bg-dark-surface/30">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className="text-xs text-dark-muted hover:text-dark-text transition-colors flex items-center gap-1"
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

          {/* Pre-formatted content */}
          <pre className="px-3 py-2 text-xs text-dark-text/90 whitespace-pre-wrap break-words max-h-96 overflow-y-auto custom-scrollbar font-mono leading-relaxed">
            {file.content}
          </pre>
        </div>
      )}
    </div>
  );
}
