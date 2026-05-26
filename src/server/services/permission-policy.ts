// =============================================================================
// Fleet Commander — Permission Policy Service (issue #736)
// =============================================================================
// Pure function module (no class, no state) that evaluates PermissionRequest
// hook payloads and returns a synchronous allow/deny/ask decision.
//
// Used by POST /api/hooks/PermissionRequest when a project has
// permission_policy='hook'. The route handler calls evaluatePermission(),
// returns the decision to CC (which blocks waiting for the response), and
// then fires a best-effort audit event via setImmediate.
//
// Policy rules (priority order):
//   1. Read-only tools (Read, Glob, Grep, LS, View) → always allow
//   2. WebFetch / WebSearch → deny by default; allow if domain in allowlist
//   3. Write tools (Write, Edit, MultiEdit, NotebookEdit) →
//        allow if filePath starts with worktreePath; deny otherwise
//   4. Bash → allow (audit-only in hook mode for this beta)
//   5. Default → allow (err on permissive; audit trail captures everything)
//
// Note: 'ask' is only returned as the safe fallback when the project does
// NOT have permission_policy='hook', handled in the route layer, not here.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Absolute path to the team's git worktree directory (normalized to forward slashes). */
  worktreePath: string;
  /** Parsed JSON array of allowed hostnames, or null to deny all network access. */
  projectAllowedDomains: string[] | null;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
}

// ---------------------------------------------------------------------------
// Tool classification constants (exported for tests)
// ---------------------------------------------------------------------------

/** Read-only built-in tools that never modify files or make network calls. */
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'View',
]);

/** File-write tools whose target path is checked against the worktree boundary. */
export const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/** Network-access tools whose target domain is checked against the allowlist. */
export const NETWORK_TOOLS = new Set([
  'WebFetch',
  'Web',
  'WebSearch',
]);

// ---------------------------------------------------------------------------
// Path normalization helper
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to forward-slash form for cross-platform startsWith
 * comparison. On Windows, CC may emit backslash paths while worktreePath uses
 * forward slashes.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Core evaluation function
// ---------------------------------------------------------------------------

/**
 * Evaluate a PermissionRequest hook payload and return a synchronous decision.
 *
 * This is a pure function: same inputs always produce the same output.
 * No side effects, no I/O, no database access.
 *
 * @param req - The permission request context.
 * @returns A decision and human-readable reason string.
 */
export function evaluatePermission(req: PermissionRequest): PermissionResult {
  const { toolName, toolInput, worktreePath, projectAllowedDomains } = req;

  // Rule 1: Read-only tools are always safe.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: 'read-only tool' };
  }

  // Rule 2: Network-access tools — check domain allowlist.
  if (NETWORK_TOOLS.has(toolName)) {
    const url = (toolInput['url'] as string | undefined) ?? (toolInput['query'] as string | undefined);
    if (!url) {
      // No URL to inspect — deny to be safe.
      return { decision: 'deny', reason: 'network access: no URL in tool_input' };
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      if (projectAllowedDomains && projectAllowedDomains.includes(hostname)) {
        return { decision: 'allow', reason: `network access: domain '${hostname}' is in project allowlist` };
      }
      return {
        decision: 'deny',
        reason: `network access: domain '${hostname}' is not in project allowlist`,
      };
    } catch {
      return { decision: 'deny', reason: `network access: malformed URL '${url}'` };
    }
  }

  // Rule 3: Write tools — enforce worktree boundary.
  if (WRITE_TOOLS.has(toolName)) {
    // Different tools use different field names for the target path.
    const rawPath =
      (toolInput['file_path'] as string | undefined) ??
      (toolInput['path'] as string | undefined) ??
      (toolInput['filePath'] as string | undefined);

    if (!rawPath) {
      // Cannot determine target path — allow with note (avoids blocking legitimate tool use).
      return { decision: 'allow', reason: 'write tool: no file_path in tool_input (cannot enforce boundary)' };
    }

    const normalizedFilePath = normalizePath(rawPath);
    const normalizedWorktreePath = normalizePath(worktreePath);

    // Ensure worktreePath ends with / so a path like /worktree-foo doesn't
    // accidentally match /worktree-foobar.
    const worktreePrefix = normalizedWorktreePath.endsWith('/')
      ? normalizedWorktreePath
      : normalizedWorktreePath + '/';

    if (normalizedFilePath.startsWith(worktreePrefix) || normalizedFilePath === normalizedWorktreePath) {
      return { decision: 'allow', reason: 'write tool: path is inside worktree boundary' };
    }
    return {
      decision: 'deny',
      reason: `write tool: path '${rawPath}' is outside worktree boundary '${worktreePath}'`,
    };
  }

  // Rule 4: Bash — allow in hook mode (audit trail captures command text).
  if (toolName === 'Bash') {
    return { decision: 'allow', reason: 'bash: allowed in hook mode (audit only)' };
  }

  // Rule 5: Default — allow everything else (task tools, mcp tools, etc.).
  return { decision: 'allow', reason: 'default allow' };
}
