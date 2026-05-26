// =============================================================================
// Fleet Commander — Permission Policy Service Unit Tests (issue #736)
// =============================================================================
// Tests evaluatePermission() covering all policy rules.
// Pure unit tests — no network, no database, no filesystem.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  evaluatePermission,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  NETWORK_TOOLS,
} from '../../../src/server/services/permission-policy.js';
import type { PermissionRequest } from '../../../src/server/services/permission-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKTREE_PATH = 'C:/Git/test-repo/.claude/worktrees/my-project-42';
const ALLOWED_DOMAINS = ['api.github.com', 'registry.npmjs.org'];

function makeReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolName: 'Read',
    toolInput: {},
    worktreePath: WORKTREE_PATH,
    projectAllowedDomains: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1: Read-only tools
// ---------------------------------------------------------------------------

describe('evaluatePermission — read-only tools', () => {
  for (const tool of READ_ONLY_TOOLS) {
    it(`should allow ${tool}`, () => {
      const result = evaluatePermission(makeReq({ toolName: tool }));
      expect(result.decision).toBe('allow');
      expect(result.reason).toContain('read-only');
    });
  }
});

// ---------------------------------------------------------------------------
// Rule 2: Network tools (WebFetch / WebSearch)
// ---------------------------------------------------------------------------

describe('evaluatePermission — WebFetch', () => {
  it('should allow WebFetch when domain is in allowlist', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'https://api.github.com/repos/foo/bar' },
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('api.github.com');
    expect(result.reason).toContain('allowlist');
  });

  it('should deny WebFetch when domain is not in allowlist', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'https://evil.example.com/steal' },
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('evil.example.com');
  });

  it('should deny WebFetch when allowedDomains is null (no domains allowed)', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'https://api.github.com/repos/foo/bar' },
      projectAllowedDomains: null,
    }));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('allowlist');
  });

  it('should deny WebFetch when allowedDomains is empty array', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'https://api.github.com/repos/foo/bar' },
      projectAllowedDomains: [],
    }));
    expect(result.decision).toBe('deny');
  });

  it('should deny WebFetch when URL is malformed', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'not-a-url' },
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('malformed');
  });

  it('should deny WebFetch when no URL in tool_input', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: {},
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('no URL');
  });

  it('should allow registry.npmjs.org from allowlist', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebFetch',
      toolInput: { url: 'https://registry.npmjs.org/vitest' },
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('allow');
  });
});

describe('evaluatePermission — WebSearch', () => {
  it('should deny WebSearch when no URL/query in tool_input', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'WebSearch',
      toolInput: {},
      projectAllowedDomains: ALLOWED_DOMAINS,
    }));
    expect(result.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Write tools (worktree boundary enforcement)
// ---------------------------------------------------------------------------

describe('evaluatePermission — write tools', () => {
  for (const tool of WRITE_TOOLS) {
    it(`should allow ${tool} for path inside worktree`, () => {
      const result = evaluatePermission(makeReq({
        toolName: tool,
        toolInput: {
          file_path: `${WORKTREE_PATH}/src/foo.ts`,
        },
      }));
      expect(result.decision).toBe('allow');
      expect(result.reason).toContain('inside worktree boundary');
    });

    it(`should deny ${tool} for path outside worktree`, () => {
      const result = evaluatePermission(makeReq({
        toolName: tool,
        toolInput: {
          file_path: 'C:/Windows/System32/evil.bat',
        },
      }));
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('outside worktree boundary');
    });
  }

  it('should allow Write at exactly the worktree root', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'Write',
      toolInput: { file_path: WORKTREE_PATH },
    }));
    // Root itself is at the boundary — allow
    expect(result.decision).toBe('allow');
  });

  it('should deny Write when path looks like worktree but is a sibling', () => {
    // e.g. worktree is "my-project-42" and path targets "my-project-421"
    const result = evaluatePermission(makeReq({
      toolName: 'Write',
      toolInput: {
        file_path: 'C:/Git/test-repo/.claude/worktrees/my-project-421/evil.ts',
      },
    }));
    expect(result.decision).toBe('deny');
  });

  it('should allow Write with backslash path inside worktree (Windows paths)', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'Write',
      toolInput: {
        file_path: 'C:\\Git\\test-repo\\.claude\\worktrees\\my-project-42\\src\\foo.ts',
      },
    }));
    expect(result.decision).toBe('allow');
  });

  it('should deny Write with backslash path outside worktree', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'Write',
      toolInput: {
        file_path: 'C:\\Windows\\System32\\evil.bat',
      },
    }));
    expect(result.decision).toBe('deny');
  });

  it('should allow Write when file_path is in path field', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'Edit',
      toolInput: {
        path: `${WORKTREE_PATH}/README.md`,
      },
    }));
    expect(result.decision).toBe('allow');
  });

  it('should allow Write when no file_path in tool_input (cannot enforce boundary)', () => {
    const result = evaluatePermission(makeReq({
      toolName: 'Write',
      toolInput: {},
    }));
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('no file_path');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Bash
// ---------------------------------------------------------------------------

describe('evaluatePermission — Bash', () => {
  it('should allow Bash (audit-only in hook mode)', () => {
    const result = evaluatePermission(makeReq({ toolName: 'Bash' }));
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Default (unknown tools)
// ---------------------------------------------------------------------------

describe('evaluatePermission — default allow', () => {
  it('should allow unknown tool types by default', () => {
    const result = evaluatePermission(makeReq({ toolName: 'Task' }));
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('default allow');
  });

  it('should allow SendMessage by default', () => {
    const result = evaluatePermission(makeReq({ toolName: 'SendMessage' }));
    expect(result.decision).toBe('allow');
  });

  it('should allow mcp tool by default', () => {
    const result = evaluatePermission(makeReq({ toolName: 'mcp__fleet-commander__fleet_list_teams' }));
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Exported constant sanity checks
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('READ_ONLY_TOOLS includes expected tools', () => {
    expect(READ_ONLY_TOOLS.has('Read')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Glob')).toBe(true);
    expect(READ_ONLY_TOOLS.has('Grep')).toBe(true);
    expect(READ_ONLY_TOOLS.has('LS')).toBe(true);
    expect(READ_ONLY_TOOLS.has('View')).toBe(true);
  });

  it('WRITE_TOOLS includes expected tools', () => {
    expect(WRITE_TOOLS.has('Write')).toBe(true);
    expect(WRITE_TOOLS.has('Edit')).toBe(true);
    expect(WRITE_TOOLS.has('MultiEdit')).toBe(true);
    expect(WRITE_TOOLS.has('NotebookEdit')).toBe(true);
  });

  it('NETWORK_TOOLS includes expected tools', () => {
    expect(NETWORK_TOOLS.has('WebFetch')).toBe(true);
    expect(NETWORK_TOOLS.has('WebSearch')).toBe(true);
  });
});
