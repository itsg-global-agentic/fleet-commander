// =============================================================================
// Fleet Commander -- JiraIssueProvider Tests
// =============================================================================
// Tests for the JiraIssueProvider class, including:
//   - Issue mapping (Jira issue -> GenericIssue)
//   - Status mapping (default + custom + category fallback)
//   - Dependency extraction from issue links
//   - Linked PR parsing from remote links
//   - Error handling (401, 404, 429, timeouts)
//   - Provider capabilities and interface compliance
//   - queryIssues JQL construction
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JiraIssueProvider,
  DEFAULT_JIRA_STATUS_MAP,
  type JiraConfig,
} from '../../../src/server/providers/jira-issue-provider.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return {
    baseUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token-123',
    projectKey: 'TEST',
    ...overrides,
  };
}

function makeJiraIssue(overrides: { key?: string; fields?: Record<string, unknown>; [k: string]: unknown } = {}) {
  const { fields: fieldOverrides, ...topOverrides } = overrides;
  return {
    key: 'TEST-42',
    id: '10042',
    fields: {
      summary: 'Fix the login bug',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      issuetype: { name: 'Story', subtask: false },
      priority: { id: '2', name: 'High' },
      assignee: { displayName: 'Alice', accountId: 'abc123' },
      labels: ['bug', 'frontend'],
      parent: null,
      issuelinks: [],
      created: '2026-03-01T12:00:00.000Z',
      updated: '2026-03-15T14:30:00.000Z',
      ...(fieldOverrides ?? {}),
    },
    self: 'https://test.atlassian.net/rest/api/3/issue/10042',
    ...topOverrides,
  };
}

// ---------------------------------------------------------------------------
// Fetch mock setup
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

// ---------------------------------------------------------------------------
// DEFAULT_JIRA_STATUS_MAP
// ---------------------------------------------------------------------------

describe('DEFAULT_JIRA_STATUS_MAP', () => {
  it('should map common open statuses to open', () => {
    expect(DEFAULT_JIRA_STATUS_MAP['to do']).toBe('open');
    expect(DEFAULT_JIRA_STATUS_MAP['backlog']).toBe('open');
    expect(DEFAULT_JIRA_STATUS_MAP['open']).toBe('open');
    expect(DEFAULT_JIRA_STATUS_MAP['new']).toBe('open');
  });

  it('should map in-progress statuses to in_progress', () => {
    expect(DEFAULT_JIRA_STATUS_MAP['in progress']).toBe('in_progress');
    expect(DEFAULT_JIRA_STATUS_MAP['in review']).toBe('in_progress');
    expect(DEFAULT_JIRA_STATUS_MAP['code review']).toBe('in_progress');
  });

  it('should map done statuses to closed', () => {
    expect(DEFAULT_JIRA_STATUS_MAP['done']).toBe('closed');
    expect(DEFAULT_JIRA_STATUS_MAP['closed']).toBe('closed');
    expect(DEFAULT_JIRA_STATUS_MAP['resolved']).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

describe('JiraIssueProvider capabilities', () => {
  it('should have correct name', () => {
    const provider = new JiraIssueProvider(makeConfig());
    expect(provider.name).toBe('jira');
  });

  it('should declare all capabilities as true', () => {
    const provider = new JiraIssueProvider(makeConfig());
    expect(provider.capabilities).toEqual({
      dependencies: true,
      subIssues: true,
      labels: true,
      boardStatuses: true,
      priorities: true,
      assignees: true,
      linkedPRs: true,
    });
  });
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe('JiraIssueProvider.getIssue', () => {
  it('should fetch and map a single issue', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    const jiraIssue = makeJiraIssue();
    mockFetchResponse(jiraIssue);

    const result = await provider.getIssue('TEST-42');

    expect(result).not.toBeNull();
    expect(result!.key).toBe('TEST-42');
    expect(result!.title).toBe('Fix the login bug');
    expect(result!.status).toBe('in_progress');
    expect(result!.rawStatus).toBe('In Progress');
    expect(result!.url).toBe('https://test.atlassian.net/browse/TEST-42');
    expect(result!.labels).toEqual(['bug', 'frontend']);
    expect(result!.assignee).toBe('Alice');
    expect(result!.priority).toBe(2);
    expect(result!.provider).toBe('jira');
    expect(result!.parentKey).toBeNull();
    expect(result!.createdAt).toBe('2026-03-01T12:00:00.000Z');
    expect(result!.updatedAt).toBe('2026-03-15T14:30:00.000Z');
  });

  it('should return null for 404 responses', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    mockFetchResponse({ errorMessages: ['Issue not found'] }, 404);

    const result = await provider.getIssue('TEST-999');
    expect(result).toBeNull();
  });

  it('should return null on network errors', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await provider.getIssue('TEST-42');
    expect(result).toBeNull();
    spy.mockRestore();
  });

  it('should map parent key when present', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    const jiraIssue = makeJiraIssue({
      fields: { parent: { key: 'TEST-10', fields: { summary: 'Parent Epic' } } },
    });
    mockFetchResponse(jiraIssue);

    const result = await provider.getIssue('TEST-42');
    expect(result!.parentKey).toBe('TEST-10');
  });
});

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe('JiraIssueProvider status mapping', () => {
  it('should use default mapping for known statuses', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    const issue = makeJiraIssue({
      fields: { status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } } },
    });
    mockFetchResponse(issue);

    const result = await provider.getIssue('TEST-42');
    expect(result!.status).toBe('open');
  });

  it('should use custom status mapping when provided', async () => {
    const provider = new JiraIssueProvider(makeConfig({
      statusMapping: { 'custom status': 'in_progress' },
    }));

    const issue = makeJiraIssue({
      fields: { status: { name: 'Custom Status', statusCategory: { key: 'indeterminate', name: 'Custom' } } },
    });
    mockFetchResponse(issue);

    const result = await provider.getIssue('TEST-42');
    expect(result!.status).toBe('in_progress');
  });

  it('should fall back to status category for unknown statuses', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    const issue = makeJiraIssue({
      fields: { status: { name: 'Bizarre Custom Status', statusCategory: { key: 'done', name: 'Done' } } },
    });
    mockFetchResponse(issue);

    const result = await provider.getIssue('TEST-42');
    expect(result!.status).toBe('closed');
  });

  it('should return unknown for completely unrecognized statuses', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    const issue = makeJiraIssue({
      fields: { status: { name: 'Alien Status' } },
    });
    mockFetchResponse(issue);

    const result = await provider.getIssue('TEST-42');
    expect(result!.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// queryIssues
// ---------------------------------------------------------------------------

describe('JiraIssueProvider.queryIssues', () => {
  it('should construct JQL and return mapped issues', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse({
      issues: [makeJiraIssue(), makeJiraIssue({ key: 'TEST-43', fields: { summary: 'Another issue' } })],
      startAt: 0,
      maxResults: 100,
      total: 2,
    });

    const result = await provider.queryIssues({});

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].key).toBe('TEST-42');
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it('should use POST method for search', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse({ issues: [], startAt: 0, maxResults: 100, total: 0 });

    await provider.queryIssues({});

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rest/api/3/search');
    expect(options.method).toBe('POST');
  });

  it('should paginate when hasMore is true', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse({
      issues: [makeJiraIssue()],
      startAt: 0,
      maxResults: 1,
      total: 5,
    });

    const result = await provider.queryIssues({ limit: 1 });

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('1');
    expect(result.total).toBe(5);
  });

  it('should return empty results on error', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await provider.queryIssues({});
    expect(result.issues).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getDependencies
// ---------------------------------------------------------------------------

describe('JiraIssueProvider.getDependencies', () => {
  it('should extract blocking dependencies from issuelinks', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    const issue = makeJiraIssue({
      fields: {
        issuelinks: [
          {
            id: '1',
            type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
            inwardIssue: {
              key: 'TEST-10',
              fields: {
                summary: 'Blocking issue',
                status: { name: 'Open', statusCategory: { key: 'new', name: 'To Do' } },
              },
            },
          },
        ],
      },
    });
    mockFetchResponse(issue);

    const deps = await provider.getDependencies('TEST-42');

    expect(deps).toHaveLength(1);
    expect(deps[0].key).toBe('TEST-10');
    expect(deps[0].title).toBe('Blocking issue');
    expect(deps[0].status).toBe('open');
    expect(deps[0].provider).toBe('jira');
    expect(deps[0].projectKey).toBe('TEST');
  });

  it('should ignore non-blocking link types', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    const issue = makeJiraIssue({
      fields: {
        issuelinks: [
          {
            id: '1',
            type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
            inwardIssue: {
              key: 'TEST-10',
              fields: { summary: 'Related issue', status: { name: 'Open' } },
            },
          },
        ],
      },
    });
    mockFetchResponse(issue);

    const deps = await provider.getDependencies('TEST-42');
    expect(deps).toHaveLength(0);
  });

  it('should return empty array on error', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    fetchMock.mockRejectedValueOnce(new Error('API error'));

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = await provider.getDependencies('TEST-42');
    expect(deps).toHaveLength(0);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getLinkedPRs
// ---------------------------------------------------------------------------

describe('JiraIssueProvider.getLinkedPRs', () => {
  it('should parse GitHub PR URLs from remote links', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse([
      {
        id: 1,
        self: 'https://test.atlassian.net/rest/api/3/issue/TEST-42/remotelink/1',
        object: {
          url: 'https://github.com/myorg/myrepo/pull/42',
          title: 'PR #42',
          status: { resolved: false },
        },
      },
    ]);

    const prs = await provider.getLinkedPRs('TEST-42');

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(42);
    expect(prs[0].state).toBe('open');
    expect(prs[0].url).toBe('https://github.com/myorg/myrepo/pull/42');
  });

  it('should detect merged PRs from resolved status', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse([
      {
        id: 1,
        self: '',
        object: {
          url: 'https://github.com/myorg/myrepo/pull/99',
          title: 'Merged PR',
          status: { resolved: true },
        },
      },
    ]);

    const prs = await provider.getLinkedPRs('TEST-42');
    expect(prs[0].state).toBe('merged');
  });

  it('should parse GitLab MR URLs', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse([
      {
        id: 1,
        self: '',
        object: {
          url: 'https://gitlab.com/myorg/myrepo/-/merge_requests/55',
          title: 'MR !55',
        },
      },
    ]);

    const prs = await provider.getLinkedPRs('TEST-42');
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(55);
  });

  it('should ignore non-PR remote links', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    mockFetchResponse([
      {
        id: 1,
        self: '',
        object: {
          url: 'https://confluence.example.com/page/123',
          title: 'Design doc',
        },
      },
    ]);

    const prs = await provider.getLinkedPRs('TEST-42');
    expect(prs).toHaveLength(0);
  });

  it('should return empty array on error', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    fetchMock.mockRejectedValueOnce(new Error('API error'));

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prs = await provider.getLinkedPRs('TEST-42');
    expect(prs).toHaveLength(0);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('JiraIssueProvider authentication', () => {
  it('should send Basic auth header with base64 credentials', async () => {
    const provider = new JiraIssueProvider(makeConfig({
      email: 'user@test.com',
      apiToken: 'my-secret-token',
    }));

    mockFetchResponse(makeJiraIssue());

    await provider.getIssue('TEST-42');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expectedAuth = `Basic ${Buffer.from('user@test.com:my-secret-token').toString('base64')}`;
    expect((options.headers as Record<string, string>)['Authorization']).toBe(expectedAuth);
  });

  it('should include correct content-type headers', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    mockFetchResponse(makeJiraIssue());

    await provider.getIssue('TEST-42');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((options.headers as Record<string, string>)['Accept']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('JiraIssueProvider error handling', () => {
  it('should handle 401 unauthorized gracefully', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    mockFetchResponse({ errorMessages: ['Unauthorized'] }, 401);

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await provider.getIssue('TEST-42');
    expect(result).toBeNull();
    spy.mockRestore();
  });

  it('should handle 429 rate limiting gracefully', async () => {
    const provider = new JiraIssueProvider(makeConfig());
    mockFetchResponse({ errorMessages: ['Rate limit exceeded'] }, 429);

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await provider.queryIssues({});
    expect(result.issues).toHaveLength(0);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fetchAllOpenIssues
// ---------------------------------------------------------------------------

describe('JiraIssueProvider.fetchAllOpenIssues', () => {
  it('should fetch all pages of open issues', async () => {
    const provider = new JiraIssueProvider(makeConfig());

    // First page
    mockFetchResponse({
      issues: [makeJiraIssue({ key: 'TEST-1' }), makeJiraIssue({ key: 'TEST-2' })],
      startAt: 0,
      maxResults: 2,
      total: 3,
    });

    // Second page
    mockFetchResponse({
      issues: [makeJiraIssue({ key: 'TEST-3' })],
      startAt: 2,
      maxResults: 2,
      total: 3,
    });

    const issues = await provider.fetchAllOpenIssues();

    expect(issues).toHaveLength(3);
    expect(issues[0].key).toBe('TEST-1');
    expect(issues[2].key).toBe('TEST-3');
  });
});
