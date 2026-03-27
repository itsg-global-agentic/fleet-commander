// =============================================================================
// Fleet Commander -- Provider Registry Tests
// =============================================================================
// Tests for the provider registry factory function and singleton caching.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { getIssueProvider, resetProviders, getCachedProvider } from '../../../src/server/providers/index.js';
import { GitHubIssueProvider } from '../../../src/server/providers/github-issue-provider.js';
import { JiraIssueProvider } from '../../../src/server/providers/jira-issue-provider.js';
import type { Project } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'test-project',
    repoPath: '/tmp/test',
    githubRepo: 'octocat/hello-world',
    status: 'active',
    hooksInstalled: false,
    maxActiveTeams: 3,
    promptFile: null,
    model: null,
    issueProvider: null,
    projectKey: null,
    providerConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    groupId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getIssueProvider
// ---------------------------------------------------------------------------

describe('getIssueProvider', () => {
  beforeEach(() => {
    resetProviders();
  });

  it('should return a GitHubIssueProvider when issueProvider is null (default)', () => {
    const project = makeProject({ issueProvider: null });
    const provider = getIssueProvider(project);
    expect(provider).toBeInstanceOf(GitHubIssueProvider);
    expect(provider.name).toBe('github');
  });

  it('should return a GitHubIssueProvider when issueProvider is "github"', () => {
    const project = makeProject({ issueProvider: 'github' });
    const provider = getIssueProvider(project);
    expect(provider).toBeInstanceOf(GitHubIssueProvider);
  });

  it('should return the same instance for the same provider name (singleton)', () => {
    const project1 = makeProject({ id: 1, issueProvider: 'github' });
    const project2 = makeProject({ id: 2, issueProvider: 'github' });

    const provider1 = getIssueProvider(project1);
    const provider2 = getIssueProvider(project2);

    expect(provider1).toBe(provider2); // Same instance
  });

  it('should return a JiraIssueProvider when issueProvider is "jira"', () => {
    const project = makeProject({
      issueProvider: 'jira',
      projectKey: 'TEST',
      providerConfig: JSON.stringify({
        baseUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'token-123',
        projectKey: 'TEST',
      }),
    });
    const provider = getIssueProvider(project);
    expect(provider).toBeInstanceOf(JiraIssueProvider);
    expect(provider.name).toBe('jira');
  });

  it('should cache Jira providers per project ID', () => {
    const project1 = makeProject({
      id: 1,
      issueProvider: 'jira',
      projectKey: 'PROJ1',
      providerConfig: JSON.stringify({
        baseUrl: 'https://proj1.atlassian.net',
        email: 'a@example.com',
        apiToken: 'token-1',
        projectKey: 'PROJ1',
      }),
    });
    const project2 = makeProject({
      id: 2,
      issueProvider: 'jira',
      projectKey: 'PROJ2',
      providerConfig: JSON.stringify({
        baseUrl: 'https://proj2.atlassian.net',
        email: 'b@example.com',
        apiToken: 'token-2',
        projectKey: 'PROJ2',
      }),
    });

    const provider1 = getIssueProvider(project1);
    const provider2 = getIssueProvider(project2);

    // Different projects should get different Jira provider instances
    expect(provider1).not.toBe(provider2);
    expect(provider1).toBeInstanceOf(JiraIssueProvider);
    expect(provider2).toBeInstanceOf(JiraIssueProvider);
  });

  it('should throw for unsupported provider type', () => {
    const project = makeProject({ issueProvider: 'linear' });
    expect(() => getIssueProvider(project)).toThrow('Unsupported issue provider: "linear"');
  });

  it('should include project name in error message for unsupported provider', () => {
    const project = makeProject({ name: 'my-project', issueProvider: 'linear' });
    expect(() => getIssueProvider(project)).toThrow('project "my-project"');
  });

  it('should mention supported providers in error message', () => {
    const project = makeProject({ issueProvider: 'unknown' });
    expect(() => getIssueProvider(project)).toThrow('Supported providers: github, jira');
  });

  it('should throw for Jira provider with missing providerConfig', () => {
    const project = makeProject({ issueProvider: 'jira', providerConfig: null });
    expect(() => getIssueProvider(project)).toThrow('Jira baseUrl is required');
  });

  it('should throw for Jira provider with invalid JSON in providerConfig', () => {
    const project = makeProject({ issueProvider: 'jira', providerConfig: 'not json' });
    expect(() => getIssueProvider(project)).toThrow('Invalid providerConfig JSON');
  });
});

// ---------------------------------------------------------------------------
// getCachedProvider
// ---------------------------------------------------------------------------

describe('getCachedProvider', () => {
  beforeEach(() => {
    resetProviders();
  });

  it('should return undefined when no provider has been created', () => {
    expect(getCachedProvider('github')).toBeUndefined();
  });

  it('should return the cached provider after getIssueProvider creates one', () => {
    const project = makeProject({ issueProvider: 'github' });
    const provider = getIssueProvider(project);
    expect(getCachedProvider('github')).toBe(provider);
  });

  it('should return undefined for a non-existent provider name', () => {
    const project = makeProject({ issueProvider: 'github' });
    getIssueProvider(project);
    expect(getCachedProvider('linear')).toBeUndefined();
  });

  it('should return Jira provider cached by project-specific key', () => {
    const project = makeProject({
      id: 42,
      issueProvider: 'jira',
      projectKey: 'TEST',
      providerConfig: JSON.stringify({
        baseUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'token',
        projectKey: 'TEST',
      }),
    });
    const provider = getIssueProvider(project);
    expect(getCachedProvider('jira:42')).toBe(provider);
    expect(getCachedProvider('jira')).toBeUndefined(); // Not cached under plain 'jira'
  });
});

// ---------------------------------------------------------------------------
// resetProviders
// ---------------------------------------------------------------------------

describe('resetProviders', () => {
  beforeEach(() => {
    resetProviders();
  });

  it('should clear all cached providers', () => {
    const project = makeProject({ issueProvider: 'github' });
    const provider1 = getIssueProvider(project);

    resetProviders();

    // After reset, a new instance should be created
    const provider2 = getIssueProvider(project);
    expect(provider2).not.toBe(provider1);
    expect(provider2).toBeInstanceOf(GitHubIssueProvider);
  });

  it('should be safe to call multiple times', () => {
    resetProviders();
    resetProviders();
    resetProviders();
    // Should not throw
    expect(getCachedProvider('github')).toBeUndefined();
  });
});
