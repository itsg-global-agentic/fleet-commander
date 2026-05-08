// =============================================================================
// Time formatting helpers (shared across components)
// =============================================================================

/**
 * Format an ISO 8601 timestamp into a human-readable relative or absolute
 * representation. Used by HandoffFileCard and SpawnPromptPanel to label
 * captured artifacts and spawn events.
 *
 * Returns:
 *   - "just now"               when the diff is < 1 minute
 *   - "Xm ago"                 when the diff is < 1 hour
 *   - "Xh ago"                 when the diff is < 24 hours
 *   - "M/D/YYYY HH:MM"         otherwise (locale-formatted absolute)
 */
export function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
