// =============================================================================
// Fleet Commander — Issue Context Generator Service
// =============================================================================
// Generates a `.fleet-issue-context.md` file in the worktree root before CC
// starts, providing the agent with full issue context (description, comments,
// linked PRs, dependencies) so it does not need to fetch this data itself.
//
// Supports GitHub (via `gh` CLI) and Jira (via provider API). For unsupported
// providers, generates a minimal context file with just key/title.
//
// Errors are caught and logged — context generation must NEVER block a launch.
// =============================================================================

import path from 'path';
import fs from 'fs';
import { execGHAsync } from '../utils/exec-gh.js';
import { isValidGithubRepo } from '../utils/exec-gh.js';
import { getIssueProvider } from '../providers/index.js';
import type { Project } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT_FILENAME = '.fleet-issue-context.md';
const MAX_BODY_LENGTH = 10_000;
const MAX_COMMENTS = 20;

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

interface IssueLinkedPR {
  number: number;
  state: string;
}

interface IssueDependency {
  key: string;
  title: string;
  state: string;
}

interface IssueContext {
  key: string;
  title: string;
  state: string;
  url: string | null;
  body: string | null;
  labels: string[];
  assignees: string[];
  comments: IssueComment[];
  linkedPRs: IssueLinkedPR[];
  dependencies: IssueDependency[];
  milestone: string | null;
}

// ---------------------------------------------------------------------------
// GitHub Issue Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch full issue context from GitHub using the `gh` CLI.
 * Returns null on any error (network, auth, rate-limit, etc.).
 */
async function fetchGitHubIssueContext(
  issueNumber: number,
  githubRepo: string,
): Promise<IssueContext | null> {
  if (!isValidGithubRepo(githubRepo)) {
    console.warn(`[IssueContextGenerator] Invalid GitHub repo slug: "${githubRepo}"`);
    return null;
  }

  const fields = 'number,title,body,state,url,labels,assignees,comments,milestone,closedByPullRequests';
  const raw = await execGHAsync(
    `gh issue view ${issueNumber} --repo "${githubRepo}" --json ${fields}`,
    { timeout: 15_000 },
  );

  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;

    // Map labels: [{name: string}] -> string[]
    const rawLabels = Array.isArray(data.labels) ? data.labels : [];
    const labels = rawLabels
      .map((l: unknown) => (typeof l === 'object' && l !== null && 'name' in l ? (l as { name: string }).name : ''))
      .filter(Boolean);

    // Map assignees: [{login: string}] -> string[]
    const rawAssignees = Array.isArray(data.assignees) ? data.assignees : [];
    const assignees = rawAssignees
      .map((a: unknown) => (typeof a === 'object' && a !== null && 'login' in a ? (a as { login: string }).login : ''))
      .filter(Boolean);

    // Map comments: [{author:{login}, body, createdAt}] -> IssueComment[]
    const rawComments = Array.isArray(data.comments) ? data.comments : [];
    const comments: IssueComment[] = rawComments
      .filter((c: unknown): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c: Record<string, unknown>) => ({
        author: typeof c.author === 'object' && c.author !== null && 'login' in c.author
          ? String((c.author as { login: string }).login)
          : 'unknown',
        body: typeof c.body === 'string' ? c.body : '',
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      }));

    // Map closedByPullRequests: [{number, state}] -> IssueLinkedPR[]
    const rawPRs = Array.isArray(data.closedByPullRequests) ? data.closedByPullRequests : [];
    const linkedPRs: IssueLinkedPR[] = rawPRs
      .filter((pr: unknown): pr is Record<string, unknown> => typeof pr === 'object' && pr !== null)
      .map((pr: Record<string, unknown>) => ({
        number: typeof pr.number === 'number' ? pr.number : 0,
        state: typeof pr.state === 'string' ? pr.state : 'unknown',
      }))
      .filter((pr) => pr.number > 0);

    // Milestone
    const milestoneObj = typeof data.milestone === 'object' && data.milestone !== null ? data.milestone : null;
    const milestone = milestoneObj && 'title' in milestoneObj
      ? String((milestoneObj as { title: string }).title)
      : null;

    return {
      key: String(data.number ?? issueNumber),
      title: typeof data.title === 'string' ? data.title : `Issue #${issueNumber}`,
      state: typeof data.state === 'string' ? data.state : 'unknown',
      url: typeof data.url === 'string' ? data.url : null,
      body: typeof data.body === 'string' ? data.body : null,
      labels,
      assignees,
      comments,
      linkedPRs,
      dependencies: [], // GitHub dependencies require separate GraphQL query — skip for now
      milestone,
    };
  } catch (err) {
    console.warn(`[IssueContextGenerator] Failed to parse GitHub issue JSON:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Jira Issue Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch issue context from Jira using the provider API.
 * Returns null on any error.
 */
async function fetchJiraIssueContext(
  issueKey: string,
  project: Project,
): Promise<IssueContext | null> {
  try {
    const provider = getIssueProvider(project);
    const issue = await provider.getIssue(issueKey);
    if (!issue) return null;

    // Fetch linked PRs and dependencies in parallel
    const [linkedPRs, dependencies] = await Promise.all([
      provider.getLinkedPRs(issueKey).catch(() => [] as Array<{ number: number; state: string }>),
      provider.getDependencies(issueKey).catch(() => [] as Array<{ key: string; title: string; status: string }>),
    ]);

    return {
      key: issue.key,
      title: issue.title,
      state: issue.rawStatus,
      url: issue.url,
      body: null, // Jira REST v3 body is ADF (Atlassian Document Format), not plain text
      labels: issue.labels,
      assignees: issue.assignee ? [issue.assignee] : [],
      comments: [], // Jira comments require a separate API call — skip for MVP
      linkedPRs: linkedPRs.map((pr) => ({ number: pr.number, state: pr.state })),
      dependencies: dependencies.map((dep) => ({ key: dep.key, title: dep.title, state: dep.status })),
      milestone: null, // Jira uses fixVersions, not milestones
    };
  } catch (err) {
    console.warn(`[IssueContextGenerator] Failed to fetch Jira issue ${issueKey}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Markdown Formatting
// ---------------------------------------------------------------------------

/**
 * Render an IssueContext into a structured markdown string.
 * Empty sections are omitted.
 */
export function formatContextMarkdown(ctx: IssueContext): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Issue ${ctx.key}: ${ctx.title}`);
  lines.push('');

  // Metadata table
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| **Key** | ${ctx.key} |`);
  lines.push(`| **Title** | ${ctx.title} |`);
  lines.push(`| **State** | ${ctx.state} |`);
  if (ctx.url) {
    lines.push(`| **URL** | ${ctx.url} |`);
  }
  if (ctx.milestone) {
    lines.push(`| **Milestone** | ${ctx.milestone} |`);
  }
  if (ctx.labels.length > 0) {
    lines.push(`| **Labels** | ${ctx.labels.join(', ')} |`);
  }
  if (ctx.assignees.length > 0) {
    lines.push(`| **Assignees** | ${ctx.assignees.join(', ')} |`);
  }
  lines.push('');

  // Description
  if (ctx.body) {
    const truncatedBody = ctx.body.length > MAX_BODY_LENGTH
      ? ctx.body.substring(0, MAX_BODY_LENGTH) + '\n\n*(truncated — original exceeds 10,000 characters)*'
      : ctx.body;
    lines.push('## Description');
    lines.push('');
    lines.push(truncatedBody);
    lines.push('');
  }

  // Comments (most recent N)
  if (ctx.comments.length > 0) {
    const recentComments = ctx.comments.slice(-MAX_COMMENTS);
    const omitted = ctx.comments.length - recentComments.length;

    lines.push('## Comments');
    lines.push('');
    if (omitted > 0) {
      lines.push(`*${omitted} older comment(s) omitted — showing most recent ${MAX_COMMENTS}.*`);
      lines.push('');
    }
    for (const comment of recentComments) {
      const dateStr = comment.createdAt ? ` (${comment.createdAt})` : '';
      lines.push(`### @${comment.author}${dateStr}`);
      lines.push('');
      lines.push(comment.body);
      lines.push('');
    }
  }

  // Linked PRs
  if (ctx.linkedPRs.length > 0) {
    lines.push('## Linked Pull Requests');
    lines.push('');
    for (const pr of ctx.linkedPRs) {
      lines.push(`- PR #${pr.number} — ${pr.state}`);
    }
    lines.push('');
  }

  // Dependencies
  if (ctx.dependencies.length > 0) {
    lines.push('## Dependencies');
    lines.push('');
    for (const dep of ctx.dependencies) {
      lines.push(`- ${dep.key}: ${dep.title} — ${dep.state}`);
    }
    lines.push('');
  }

  return lines.join('\n');
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
 * Fetches full issue context from the appropriate provider (GitHub, Jira),
 * formats it as structured markdown, and writes it to the worktree.
 *
 * This function NEVER throws — errors are caught and logged as warnings.
 * A failed context generation must not block a team launch.
 */
export async function generateIssueContext(params: GenerateIssueContextParams): Promise<void> {
  const { worktreeAbsPath, issueKey, issueNumber, issueTitle, issueProvider, project } = params;

  try {
    let ctx: IssueContext | null = null;

    if (issueProvider === 'github' && project.githubRepo) {
      ctx = await fetchGitHubIssueContext(issueNumber, project.githubRepo);
    } else if (issueProvider === 'jira') {
      ctx = await fetchJiraIssueContext(issueKey, project);
    }

    // Fallback: minimal context for unsupported providers or fetch failures
    if (!ctx) {
      ctx = {
        key: issueKey,
        title: issueTitle ?? `Issue ${issueKey}`,
        state: 'unknown',
        url: null,
        body: null,
        labels: [],
        assignees: [],
        comments: [],
        linkedPRs: [],
        dependencies: [],
        milestone: null,
      };
    }

    const markdown = formatContextMarkdown(ctx);
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
