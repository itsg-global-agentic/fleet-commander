// =============================================================================
// Fleet Commander — Issue Context Generator Service
// =============================================================================
// Generates a `.fleet-issue-context.md` file in the worktree root before CC
// starts, providing the agent with full issue context (description, comments,
// linked PRs, dependencies) so it does not need to fetch this data itself.
//
// GitHub issues are fetched via GitHubIssueProvider.fetchFullIssueContext()
// (GraphQL), which returns rich data including dependencies, sub-issues,
// parent references, and pre-filtered comments (no bots, no minimized).
//
// Jira issues are fetched via the Jira provider API and converted to
// IssueContextData format for rendering by the shared generator.
//
// For unsupported providers or fetch failures, generates a minimal context
// file with YAML frontmatter and just key/title.
//
// Errors are caught and logged — context generation must NEVER block a launch.
// =============================================================================

import path from 'path';
import fs from 'fs';
import { getIssueProvider } from '../providers/index.js';
import { GitHubIssueProvider, parseRepo } from '../providers/github-issue-provider.js';
import { generateIssueContextMarkdown } from '../../shared/issue-context.js';
import type { IssueContextData } from '../../shared/issue-context.js';
import type { Project } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTEXT_FILENAME = '.fleet-issue-context.md';

// ---------------------------------------------------------------------------
// Jira Issue Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch issue context from Jira using the provider API.
 * Returns an IssueContextData object on success, or null on error.
 */
async function fetchJiraIssueContext(
  issueKey: string,
  project: Project,
): Promise<IssueContextData | null> {
  try {
    const provider = getIssueProvider(project);
    const issue = await provider.getIssue(issueKey);
    if (!issue) return null;

    // Fetch linked PRs and dependencies in parallel
    const [linkedPRs, dependencies] = await Promise.all([
      provider.getLinkedPRs(issueKey).catch(() => [] as Array<{ number: number; state: string }>),
      provider.getDependencies(issueKey).catch(() => [] as Array<{ key: string; title: string; status: string }>),
    ]);

    // Convert to IssueContextData format for the shared generator
    return {
      number: parseInt(issueKey.replace(/\D/g, ''), 10) || 0,
      title: issue.title,
      state: issue.rawStatus,
      repo: project.githubRepo ?? '',
      author: '',
      createdAt: issue.createdAt ?? '',
      updatedAt: issue.updatedAt ?? '',
      labels: issue.labels,
      assignees: issue.assignee ? [issue.assignee] : [],
      milestone: null,
      parent: null,
      children: [],
      blockedBy: dependencies.map((dep) => ({
        number: parseInt(dep.key.replace(/\D/g, ''), 10) || 0,
        title: dep.title,
        state: dep.status,
      })),
      blocking: [],
      linkedPRs: linkedPRs.map((pr) => ({ number: pr.number, state: pr.state })),
      body: '', // Jira REST v3 body is ADF (Atlassian Document Format), not plain text
      comments: [], // Jira comments require a separate API call — skip for MVP
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 0,
        includedComments: 0,
      },
    };
  } catch (err) {
    console.warn(`[IssueContextGenerator] Failed to fetch Jira issue ${issueKey}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback: minimal IssueContextData
// ---------------------------------------------------------------------------

/**
 * Build a minimal IssueContextData for unsupported providers or fetch failures.
 */
function buildFallbackContextData(
  issueKey: string,
  issueNumber: number,
  issueTitle: string | null,
  project: Project,
): IssueContextData {
  return {
    number: issueNumber,
    title: issueTitle ?? `Issue ${issueKey}`,
    state: 'unknown',
    repo: project.githubRepo ?? '',
    author: '',
    createdAt: '',
    updatedAt: '',
    labels: [],
    assignees: [],
    milestone: null,
    parent: null,
    children: [],
    blockedBy: [],
    blocking: [],
    linkedPRs: [],
    body: '',
    comments: [],
    truncation: {
      bodyTruncated: false,
      commentsTruncated: false,
      totalComments: 0,
      includedComments: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateIssueContextParams {
  worktreeAbsPath: string;
  issueKey: string;
  issueNumber: number;
  issueTitle: string | null;
  issueProvider: string;
  project: Project;
}

/**
 * Generate a `.fleet-issue-context.md` file in the worktree root.
 *
 * Fetches full issue context from the appropriate provider (GitHub via
 * GitHubIssueProvider.fetchFullIssueContext GraphQL, Jira via provider API),
 * formats it as structured markdown with YAML frontmatter using the shared
 * generateIssueContextMarkdown(), and writes it to the worktree.
 *
 * This function NEVER throws — errors are caught and logged as warnings.
 * A failed context generation must not block a team launch.
 */
export async function generateIssueContext(params: GenerateIssueContextParams): Promise<void> {
  const { worktreeAbsPath, issueKey, issueNumber, issueTitle, issueProvider, project } = params;

  try {
    let contextData: IssueContextData | null = null;

    if (issueProvider === 'github' && project.githubRepo) {
      const provider = getIssueProvider(project);
      if (provider instanceof GitHubIssueProvider) {
        const [owner, repo] = parseRepo(project.githubRepo);
        contextData = await provider.fetchFullIssueContext(owner, repo, issueNumber);
      }
    } else if (issueProvider === 'jira') {
      contextData = await fetchJiraIssueContext(issueKey, project);
    }

    // Fallback: minimal context for unsupported providers or fetch failures
    if (!contextData) {
      contextData = buildFallbackContextData(issueKey, issueNumber, issueTitle, project);
    }

    const markdown = generateIssueContextMarkdown(contextData);
    const filePath = path.join(worktreeAbsPath, CONTEXT_FILENAME);
    fs.writeFileSync(filePath, markdown, 'utf-8');

    console.log(`[IssueContextGenerator] Wrote ${CONTEXT_FILENAME} to ${worktreeAbsPath}`);
  } catch (err) {
    console.warn(
      `[IssueContextGenerator] Failed to generate issue context for ${issueKey}:`,
      err instanceof Error ? err.message : err,
    );
    // Never throw — context generation failure must not block launch
  }
}
