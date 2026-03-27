// =============================================================================
// Fleet Commander -- Issue Provider Registry
// =============================================================================
// Factory function that returns the appropriate IssueProvider implementation
// based on the project's configured issue provider. Providers are cached as
// singletons keyed by provider name.
// =============================================================================

import type { IssueProvider } from '../../shared/issue-provider.js';
import type { Project } from '../../shared/types.js';
import { GitHubIssueProvider } from './github-issue-provider.js';

// Singleton cache: provider name -> provider instance
const providerCache = new Map<string, IssueProvider>();

/**
 * Get or create an IssueProvider instance for the given project.
 * Reads `project.issueProvider` (defaulting to 'github') and returns
 * the appropriate provider. Providers are singletons keyed by name.
 *
 * @throws Error if the provider type is not supported.
 */
export function getIssueProvider(project: Project): IssueProvider {
  const providerName = project.issueProvider ?? 'github';

  const cached = providerCache.get(providerName);
  if (cached) {
    return cached;
  }

  let provider: IssueProvider;

  switch (providerName) {
    case 'github':
      provider = new GitHubIssueProvider();
      break;
    default:
      throw new Error(
        `Unsupported issue provider: "${providerName}". ` +
        `Supported providers: github. ` +
        `Check the issueProvider setting for project "${project.name}" (id: ${project.id}).`
      );
  }

  providerCache.set(providerName, provider);
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
