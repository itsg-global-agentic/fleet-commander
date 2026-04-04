import { useMemo } from 'react';
import type { TeamDashboardRow, TeamStatus } from '../../shared/types';
import { useTeams } from '../context/FleetContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueBlockReasonProps {
  team: TeamDashboardRow;
}

interface BlockerInfo {
  key: string;
  failed: boolean;
  done: boolean;
}

interface ChildInfo {
  key: string;
  done: boolean;
}

/** Statuses that consume an active slot */
const ACTIVE_STATUSES: ReadonlySet<TeamStatus> = new Set([
  'launching',
  'running',
  'idle',
  'stuck',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse blockedByJson into an array of issue keys (strings).
 * Handles both numeric arrays `[49, 50]` and string arrays `["PROJ-123"]`.
 * Returns an empty array on null, empty string, empty array, or malformed JSON.
 */
function parseBlockers(blockedByJson: string | null): string[] {
  if (!blockedByJson) return [];
  try {
    const parsed: unknown = JSON.parse(blockedByJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    return parsed.map((v: unknown) => String(v));
  } catch {
    return [];
  }
}

/**
 * Build a GitHub issue URL from a repo slug and issue key.
 * Only works for numeric issue keys (GitHub issues).
 */
function issueUrl(githubRepo: string, key: string): string {
  return `https://github.com/${githubRepo}/issues/${key}`;
}

/**
 * Check whether a key looks like a GitHub issue number (pure digits).
 */
function isNumericKey(key: string): boolean {
  return /^\d+$/.test(key);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Displays the block reason for a queued team:
 * - "Waiting for sub-issues: #X, #Y (N/M done)" (blue) when sub-issues are open
 * - "Blocked by FAILED #49" (red) when a dependency team has failed
 * - "Blocked by #49, #50" (orange) when dependencies are pending
 * - "Waiting for slot" (gray) when all project slots are occupied
 * - null (nothing rendered) for generic queued with no specific reason
 */
export function QueueBlockReason({ team }: QueueBlockReasonProps) {
  const { teams: allTeams } = useTeams();

  const result = useMemo(() => {
    // -----------------------------------------------------------------------
    // 1. Check for pending children (parent issue waiting for sub-issues)
    // -----------------------------------------------------------------------
    const childKeys = parseBlockers(team.pendingChildrenJson);

    if (childKeys.length > 0) {
      const children: ChildInfo[] = childKeys.map((key) => {
        const match = allTeams.find((t) => {
          if (t.projectId !== team.projectId) return false;
          if (t.issueKey && t.issueKey === key) return true;
          if (isNumericKey(key) && t.issueNumber === Number(key)) return true;
          return false;
        });
        return {
          key,
          done: match?.status === 'done',
        };
      });
      return { type: 'children' as const, children };
    }

    // -----------------------------------------------------------------------
    // 2. Check for dependency blockers
    // -----------------------------------------------------------------------
    const blockerKeys = parseBlockers(team.blockedByJson);

    if (blockerKeys.length > 0) {
      const blockers: BlockerInfo[] = blockerKeys.map((key) => {
        // Find a matching team in the same project
        const match = allTeams.find((t) => {
          if (t.projectId !== team.projectId) return false;
          // Match by issueKey first (works for Jira/Linear keys like "PROJ-123")
          if (t.issueKey && t.issueKey === key) return true;
          // Match by issueNumber for numeric keys (GitHub)
          if (isNumericKey(key) && t.issueNumber === Number(key)) return true;
          return false;
        });
        return {
          key,
          failed: match?.status === 'failed',
          done: match?.status === 'done',
        };
      });

      const hasFailedBlocker = blockers.some((b) => b.failed);

      return { type: 'dependency' as const, blockers, hasFailedBlocker };
    }

    // -----------------------------------------------------------------------
    // 3. Check for slot blocking
    // -----------------------------------------------------------------------
    if (team.maxActiveTeams != null) {
      const activeCount = allTeams.filter(
        (t) => t.projectId === team.projectId && ACTIVE_STATUSES.has(t.status),
      ).length;

      if (activeCount >= team.maxActiveTeams) {
        return { type: 'slot' as const };
      }
    }

    // -----------------------------------------------------------------------
    // 4. Generic fallback — no specific reason
    // -----------------------------------------------------------------------
    return null;
  }, [team.pendingChildrenJson, team.blockedByJson, team.projectId, team.maxActiveTeams, allTeams]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!result) return null;

  if (result.type === 'slot') {
    return (
      <span className="block text-xs text-dark-muted mt-0.5">
        Waiting for slot
      </span>
    );
  }

  if (result.type === 'children') {
    const { children } = result;
    return (
      <span className="block text-xs text-[#58A6FF] mt-0.5">
        {'Waiting for sub-issues: '}
        {children.map((child, i) => {
          const label = isNumericKey(child.key) ? `#${child.key}` : child.key;
          const doneClass = child.done ? 'line-through text-dark-muted/60' : '';
          const link =
            team.githubRepo && isNumericKey(child.key) ? (
              <a
                key={child.key}
                href={issueUrl(team.githubRepo, child.key)}
                target="_blank"
                rel="noopener noreferrer"
                className={`underline hover:text-dark-text ${doneClass}`}
                onClick={(e) => e.stopPropagation()}
              >
                {label}
              </a>
            ) : (
              <span key={child.key} className={doneClass}>{label}</span>
            );

          return (
            <span key={child.key}>
              {i > 0 && ', '}
              {link}
            </span>
          );
        })}
      </span>
    );
  }

  // Dependency-blocked
  const { blockers, hasFailedBlocker } = result;
  const colorClass = hasFailedBlocker ? 'text-[#F85149]' : 'text-[#D29922]';

  return (
    <span className={`block text-xs ${colorClass} mt-0.5`}>
      {'Blocked by '}
      {blockers.map((b, i) => {
        const prefix = b.failed ? 'FAILED ' : '';
        const label = isNumericKey(b.key) ? `${prefix}#${b.key}` : `${prefix}${b.key}`;

        const doneClass = b.done ? 'line-through text-dark-muted/60' : '';

        const link =
          team.githubRepo && isNumericKey(b.key) ? (
            <a
              key={b.key}
              href={issueUrl(team.githubRepo, b.key)}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline hover:text-dark-text ${doneClass}`}
              onClick={(e) => e.stopPropagation()}
            >
              {label}
            </a>
          ) : (
            <span key={b.key} className={doneClass}>{label}</span>
          );

        return (
          <span key={b.key}>
            {i > 0 && ', '}
            {link}
          </span>
        );
      })}
    </span>
  );
}
