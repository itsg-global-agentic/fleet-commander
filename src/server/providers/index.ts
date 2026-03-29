// =============================================================================
// Fleet Commander -- Issue Provider Registry
// =============================================================================
// Factory function that returns the appropriate IssueProvider implementation
// based on the project's configured issue provider. Providers are cached as
// singletons keyed by provider name.
// =============================================================================

import type { IssueProvider, NormalizedStatus } from '../../shared/issue-provider.js';
import type { Project } from '../../shared/types.js';
import { getDatabase } from '../db.js';
import { GitHubIssueProvider } from './github-issue-provider.js';
import { JiraIssueProvider, type JiraConfig } from './jira-issue-provider.js';

// Singleton cache: provider key -> provider instance
// GitHub is keyed by 'github' (stateless singleton).
// Jira is keyed by 'jira:<projectId>' since each Jira project may have
// different credentials/baseUrl.
const providerCache = new Map<string, IssueProvider>();

/**
 * Get or create an IssueProvider instance for the given project.
 * Reads `project.issueProvider` (defaulting to 'github') and returns
 * the appropriate provider.
 *
 * GitHub providers are singletons keyed by 'github'.
 * Jira providers are cached per-project (keyed by 'jira:<projectId>').
 *
 * @throws Error if the provider type is not supported.
 */
export function getIssueProvider(project: Project): IssueProvider {
  const providerName = project.issueProvider ?? 'github';

  // Compute the cache key: GitHub is global, Jira is per-project
  const cacheKey = providerName === 'jira' ? `jira:${project.id}` : providerName;

  const cached = providerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let provider: IssueProvider;

  switch (providerName) {
    case 'github': {
      const ghProvider = new GitHubIssueProvider();

      // Restore persisted blockedBySupported state from the database
      try {
        const db = getDatabase();
        const persisted = db.getProviderState('github:blockedBySupported');
        if (persisted === 'false') {
          ghProvider.setBlockedBySupported(false);
        }
      } catch {
        // DB may not be ready during tests — ignore
      }

      // Persist blockedBySupported changes to the database
      ghProvider.onBlockedBySupportedChanged = (supported) => {
        try {
          getDatabase().setProviderState('github:blockedBySupported', String(supported));
        } catch {
          // DB may not be ready during tests — ignore
        }
      };

      provider = ghProvider;
      break;
    }
    case 'jira': {
      const jiraConfig = parseJiraConfig(project);
      provider = new JiraIssueProvider(jiraConfig);
      break;
    }
    default:
      throw new Error(
        `Unsupported issue provider: "${providerName}". ` +
        `Supported providers: github, jira. ` +
        `Check the issueProvider setting for project "${project.name}" (id: ${project.id}).`
      );
  }

  providerCache.set(cacheKey, provider);
  return provider;
}

/**
 * Get a cached provider by name without requiring a project.
 * Returns undefined if no provider of that name has been created yet.
 */
export function getCachedProvider(name: string): IssueProvider | undefined {
  return providerCache.get(name);
}

/**
 * Clear the provider cache. Called by IssueFetcher.reset() to ensure
 * fresh provider instances are created on factory reset.
 */
export function resetProviders(): void {
  providerCache.clear();
}

// ---------------------------------------------------------------------------
// Jira config parsing
// ---------------------------------------------------------------------------

/**
 * Parse JiraConfig from a Project's providerConfig JSON and projectKey fields.
 * Validates that all required fields are present.
 *
 * @throws Error if required Jira configuration fields are missing.
 */
function parseJiraConfig(project: Project): JiraConfig {
  let parsed: Record<string, unknown> = {};
  if (project.providerConfig) {
    try {
      parsed = JSON.parse(project.providerConfig) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid providerConfig JSON for Jira project "${project.name}" (id: ${project.id}).`
      );
    }
  }

  const baseUrl = (parsed.baseUrl as string) || '';
  const email = (parsed.email as string) || '';
  const apiToken = (parsed.apiToken as string) || '';
  const projectKey = project.projectKey || (parsed.projectKey as string) || '';

  if (!baseUrl) {
    throw new Error(`Jira baseUrl is required in providerConfig for project "${project.name}" (id: ${project.id}).`);
  }
  if (!email) {
    throw new Error(`Jira email is required in providerConfig for project "${project.name}" (id: ${project.id}).`);
  }
  if (!apiToken) {
    throw new Error(`Jira apiToken is required in providerConfig for project "${project.name}" (id: ${project.id}).`);
  }
  if (!projectKey) {
    throw new Error(`Jira projectKey is required for project "${project.name}" (id: ${project.id}).`);
  }

  const statusMapping = parsed.statusMapping as Record<string, NormalizedStatus> | undefined;

  return { baseUrl, email, apiToken, projectKey, statusMapping };
}
