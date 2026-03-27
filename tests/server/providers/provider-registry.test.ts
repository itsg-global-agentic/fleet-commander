// =============================================================================
// Fleet Commander -- Provider Registry Tests
// =============================================================================
// Tests for the provider registry factory function and singleton caching.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { getIssueProvider, resetProviders, getCachedProvider } from '../../../src/server/providers/index.js';
import { GitHubIssueProvider } from '../../../src/server/providers/github-issue-provider.js';
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
    slug: 'test-project',
    status: 'active',
    maxActiveTeams: 3,
    promptFile: null,
    model: null,
    issueProvider: null,
    projectKey: null,
    providerConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
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

  it('should throw for unsupported provider type', () => {
    const project = makeProject({ issueProvider: 'jira' });
    expect(() => getIssueProvider(project)).toThrow('Unsupported issue provider: "jira"');
  });

  it('should include project name in error message for unsupported provider', () => {
    const project = makeProject({ name: 'my-project', issueProvider: 'linear' });
    expect(() => getIssueProvider(project)).toThrow('project "my-project"');
  });

  it('should mention supported providers in error message', () => {
    const project = makeProject({ issueProvider: 'unknown' });
    expect(() => getIssueProvider(project)).toThrow('Supported providers: github');
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
    expect(getCachedProvider('jira')).toBeUndefined();
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
