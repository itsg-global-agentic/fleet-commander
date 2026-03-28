// =============================================================================
// Fleet Commander — Issue Context File Types & Generator
// =============================================================================
// Defines the IssueContextData interface and the pure generateIssueContextMarkdown()
// function that produces a structured markdown context file from issue data.
// This file lives in shared/ because it has no server-side dependencies — the
// generator is a pure data-to-string transformation.
// =============================================================================

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/** A comment on the issue, pre-filtered (no bots, no minimized). */
export interface IssueContextComment {
  /** GitHub login of the comment author */
  author: string;
  /** ISO 8601 date string */
  date: string;
  /** Comment body (markdown) */
  body: string;
}

/** A dependency reference (blocked-by or blocking). */
export interface IssueContextDependency {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue state (e.g. "OPEN", "CLOSED") */
  state: string;
  /** URL to the issue, or undefined if unavailable */
  url?: string;
}

/** A linked pull request. */
export interface IssueContextPR {
  /** PR number */
  number: number;
  /** PR state (e.g. "OPEN", "MERGED", "CLOSED") */
  state: string;
  /** URL to the PR, or undefined if unavailable */
  url?: string;
}

/** A child / sub-issue. */
export interface IssueContextChild {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue state (e.g. "OPEN", "CLOSED") */
  state: string;
}

/** Metadata about what was truncated in the context file. */
export interface TruncationMeta {
  /** Whether the issue body was truncated */
  bodyTruncated: boolean;
  /** Whether comments were truncated (count or individual body) */
  commentsTruncated: boolean;
  /** Total number of comments on the issue (before filtering) */
  totalComments: number;
  /** Number of comments included in the context */
  includedComments: number;
}

// ---------------------------------------------------------------------------
// Main interface
// ---------------------------------------------------------------------------

/** All data needed to generate an issue context file. */
export interface IssueContextData {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue state (e.g. "OPEN", "CLOSED") */
  state: string;
  /** GitHub repository (owner/repo) */
  repo: string;
  /** Issue author login */
  author: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-updated timestamp */
  updatedAt: string;
  /** Labels attached to the issue */
  labels: string[];
  /** Assignees (GitHub logins) */
  assignees: string[];
  /** Milestone title, or null if none */
  milestone: string | null;
  /** Parent issue reference, or null if top-level */
  parent: { number: number; title: string } | null;
  /** Child / sub-issues */
  children: IssueContextChild[];
  /** Issues that block this one */
  blockedBy: IssueContextDependency[];
  /** Issues that this one blocks */
  blocking: IssueContextDependency[];
  /** Linked pull requests */
  linkedPRs: IssueContextPR[];
  /** Issue body (markdown) */
  body: string;
  /** Pre-filtered, most-recent comments */
  comments: IssueContextComment[];
  /** Truncation metadata */
  truncation: TruncationMeta;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum body size in bytes before truncation. */
const MAX_BODY_BYTES = 8 * 1024; // 8KB

/** Maximum size per comment body in bytes. */
const MAX_COMMENT_BYTES = 2 * 1024; // 2KB

/** Hard cap on total output size in bytes. */
const MAX_TOTAL_BYTES = 16 * 1024; // 16KB

/** Reduced comment count when total exceeds hard cap. */
const REDUCED_COMMENT_COUNT = 5;

/** Reduced comment size when total exceeds hard cap. */
const REDUCED_COMMENT_BYTES = 1024; // 1KB

// ---------------------------------------------------------------------------
// Pure helper: truncate text at a paragraph boundary
// ---------------------------------------------------------------------------

/**
 * Truncate text to fit within maxBytes (UTF-8), cutting at paragraph boundaries.
 * If the text contains an "Acceptance Criteria" section, that section is preserved
 * even if the body exceeds the limit — the preceding text is truncated instead.
 *
 * Returns { text, truncated } where truncated indicates whether the text was cut.
 */
export function truncateAtParagraphBoundary(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, truncated: false };
  }

  // Check for Acceptance Criteria section (case-insensitive heading match)
  const acPattern = /^##\s+Acceptance\s+Criteria/im;
  const acMatch = acPattern.exec(text);

  if (acMatch) {
    const acSection = text.slice(acMatch.index);
    const acBytes = Buffer.byteLength(acSection, 'utf-8');

    // If AC section alone exceeds the limit, just hard-truncate the whole thing
    if (acBytes >= maxBytes) {
      return {
        text: hardTruncateToBytes(text, maxBytes, '\n\n[... body truncated ...]'),
        truncated: true,
      };
    }

    // Budget for the pre-AC text
    const preBudget = maxBytes - acBytes - Buffer.byteLength('\n\n[... body truncated ...]\n\n', 'utf-8');
    const preText = text.slice(0, acMatch.index);

    if (preBudget <= 0) {
      // No room for pre-text, just return AC section
      return {
        text: '[... body truncated ...]\n\n' + acSection,
        truncated: true,
      };
    }

    const truncatedPre = truncateTextAtParagraph(preText, preBudget);
    return {
      text: truncatedPre + '\n\n[... body truncated ...]\n\n' + acSection,
      truncated: true,
    };
  }

  // No AC section — truncate at paragraph boundary
  return {
    text: truncateTextAtParagraph(text, maxBytes - Buffer.byteLength('\n\n[... body truncated ...]', 'utf-8'))
      + '\n\n[... body truncated ...]',
    truncated: true,
  };
}

/**
 * Truncate text at a paragraph boundary (double newline) to fit within maxBytes.
 */
function truncateTextAtParagraph(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  // Find the last paragraph break that fits within the byte budget
  const paragraphs = text.split(/\n\n/);
  let result = '';

  for (const para of paragraphs) {
    const candidate = result ? result + '\n\n' + para : para;
    if (Buffer.byteLength(candidate, 'utf-8') > maxBytes) {
      break;
    }
    result = candidate;
  }

  // If no complete paragraph fits, hard-truncate the first paragraph
  if (!result && paragraphs.length > 0) {
    result = hardTruncateToBytes(paragraphs[0], maxBytes, '');
  }

  return result;
}

/**
 * Hard-truncate a string to fit within maxBytes (UTF-8), appending a suffix.
 * Cuts at a character boundary to avoid splitting multi-byte chars.
 */
function hardTruncateToBytes(text: string, maxBytes: number, suffix: string): string {
  const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
  const budget = maxBytes - suffixBytes;
  if (budget <= 0) return suffix;

  // Progressively slice to fit within byte budget
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf-8') > budget) {
    end--;
  }
  return text.slice(0, end) + suffix;
}

// ---------------------------------------------------------------------------
// Pure helper: truncate a comment body
// ---------------------------------------------------------------------------

/**
 * Truncate a single comment body to maxBytes.
 * Returns { body, truncated }.
 */
export function truncateComment(
  body: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, 'utf-8') <= maxBytes) {
    return { body, truncated: false };
  }

  const truncated = hardTruncateToBytes(
    body,
    maxBytes,
    '\n\n[... comment truncated ...]',
  );
  return { body: truncated, truncated: true };
}

// ---------------------------------------------------------------------------
// YAML frontmatter builder
// ---------------------------------------------------------------------------

/**
 * Build YAML frontmatter string from issue context data.
 * Uses manual string building — no YAML library needed for simple scalars.
 */
function buildFrontmatter(data: IssueContextData): string {
  const lines: string[] = ['---'];
  lines.push(`issue: ${data.number}`);
  lines.push(`title: ${yamlQuote(data.title)}`);
  lines.push(`state: ${data.state}`);
  lines.push(`repo: ${data.repo}`);
  lines.push(`author: ${data.author}`);
  lines.push(`created: ${data.createdAt}`);
  lines.push(`updated: ${data.updatedAt}`);

  if (data.labels.length > 0) {
    lines.push(`labels: [${data.labels.map(yamlQuote).join(', ')}]`);
  }

  if (data.assignees.length > 0) {
    lines.push(`assignees: [${data.assignees.map(yamlQuote).join(', ')}]`);
  }

  if (data.milestone) {
    lines.push(`milestone: ${yamlQuote(data.milestone)}`);
  }

  if (data.parent) {
    lines.push(`parent: "#${data.parent.number} ${yamlQuoteInner(data.parent.title)}"`);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Quote a string for YAML if it contains special characters.
 * Uses double-quoting to handle colons, brackets, hash signs, etc.
 */
function yamlQuote(value: string): string {
  // If the value contains characters that need quoting in YAML, wrap in double quotes
  if (/[:#\[\]{}&*!|>'"%@`,\n\r\t]/.test(value) || value.trim() !== value || value === '') {
    // Escape backslashes and double quotes within the value
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Quote the inner part of a string that will be embedded in a YAML double-quoted value.
 * Escapes backslashes and double quotes.
 */
function yamlQuoteInner(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildBodySection(body: string): string {
  if (!body) {
    return '## Description\n\nNo description provided.';
  }
  return `## Description\n\n${body}`;
}

function buildChildrenSection(children: IssueContextChild[]): string | null {
  if (children.length === 0) return null;
  const lines = children.map(
    (c) => `- #${c.number}: ${c.title} [${c.state}]`,
  );
  return `## Sub-issues\n\n${lines.join('\n')}`;
}

function buildDepsSection(
  label: string,
  deps: IssueContextDependency[],
): string | null {
  if (deps.length === 0) return null;
  const lines = deps.map(
    (d) => `- #${d.number}: ${d.title} [${d.state}]`,
  );
  return `## ${label}\n\n${lines.join('\n')}`;
}

function buildPRsSection(prs: IssueContextPR[]): string | null {
  if (prs.length === 0) return null;
  const lines = prs.map(
    (pr) => `- #${pr.number} [${pr.state}]`,
  );
  return `## Linked Pull Requests\n\n${lines.join('\n')}`;
}

function buildCommentsSection(comments: IssueContextComment[]): string | null {
  if (comments.length === 0) return null;
  const blocks = comments.map((c) =>
    `### @${c.author} (${c.date})\n\n${c.body}`,
  );
  return `## Comments\n\n${blocks.join('\n\n---\n\n')}`;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate a structured markdown context file from issue data.
 *
 * Pure function — no side effects. The output is a markdown document with:
 *   1. YAML frontmatter (issue metadata)
 *   2. Description section (issue body, truncated to 8KB at paragraph boundaries)
 *   3. Sub-issues section (if any)
 *   4. Blocked By section (if any)
 *   5. Blocking section (if any)
 *   6. Linked Pull Requests section (if any)
 *   7. Comments section (up to 10 most recent, 2KB each)
 *
 * Empty sections are omitted entirely. The total output is capped at 16KB
 * (UTF-8 bytes). If exceeded, comments are reduced to 5 at 1KB each, then
 * the body is further truncated, and finally a hard truncation is applied.
 */
export function generateIssueContextMarkdown(data: IssueContextData): string {
  // --- Step 1: Truncate body ---
  const { text: truncatedBody, truncated: bodyWasTruncated } =
    truncateAtParagraphBoundary(data.body || '', MAX_BODY_BYTES);

  // --- Step 2: Truncate comments ---
  let processedComments = data.comments.map((c) => {
    const { body, truncated } = truncateComment(c.body, MAX_COMMENT_BYTES);
    return { ...c, body, truncated };
  });
  let anyCommentTruncated = processedComments.some((c) => c.truncated);

  // --- Step 3: Build initial output ---
  let output = buildOutput(data, truncatedBody, processedComments);

  // --- Step 4: Enforce 16KB hard cap ---
  if (Buffer.byteLength(output, 'utf-8') > MAX_TOTAL_BYTES) {
    // Reduce to 5 comments at 1KB each
    processedComments = data.comments.slice(0, REDUCED_COMMENT_COUNT).map((c) => {
      const { body, truncated } = truncateComment(c.body, REDUCED_COMMENT_BYTES);
      return { ...c, body, truncated };
    });
    anyCommentTruncated = true;
    output = buildOutput(data, truncatedBody, processedComments);
  }

  if (Buffer.byteLength(output, 'utf-8') > MAX_TOTAL_BYTES) {
    // Further truncate the body
    const bodyBudget = Math.max(1024, MAX_BODY_BYTES - 4096);
    const { text: smallerBody } = truncateAtParagraphBoundary(
      data.body || '',
      bodyBudget,
    );
    output = buildOutput(
      { ...data, truncation: { ...data.truncation, bodyTruncated: true } },
      smallerBody,
      processedComments,
    );
  }

  if (Buffer.byteLength(output, 'utf-8') > MAX_TOTAL_BYTES) {
    // Last resort: hard-truncate the entire output
    output = hardTruncateToBytes(output, MAX_TOTAL_BYTES, '\n\n[... output truncated to 16KB limit ...]');
  }

  // Update truncation metadata for the final output
  // (The caller sets initial truncation; we override here based on actual processing)
  return output;

  // --- Helper: assemble all sections ---
  function buildOutput(
    d: IssueContextData,
    body: string,
    comments: Array<IssueContextComment & { truncated?: boolean }>,
  ): string {
    // Build truncation-aware data for frontmatter
    const contextData: IssueContextData = {
      ...d,
      truncation: {
        bodyTruncated: bodyWasTruncated || d.truncation.bodyTruncated,
        commentsTruncated: anyCommentTruncated || d.truncation.commentsTruncated,
        totalComments: d.truncation.totalComments,
        includedComments: comments.length,
      },
    };

    const sections: string[] = [];
    sections.push(buildFrontmatter(contextData));
    sections.push('');
    sections.push(`# Issue #${d.number}: ${d.title}`);
    sections.push('');
    sections.push(buildBodySection(body));

    const childrenSection = buildChildrenSection(d.children);
    if (childrenSection) {
      sections.push('');
      sections.push(childrenSection);
    }

    const blockedBySection = buildDepsSection('Blocked By', d.blockedBy);
    if (blockedBySection) {
      sections.push('');
      sections.push(blockedBySection);
    }

    const blockingSection = buildDepsSection('Blocking', d.blocking);
    if (blockingSection) {
      sections.push('');
      sections.push(blockingSection);
    }

    const prsSection = buildPRsSection(d.linkedPRs);
    if (prsSection) {
      sections.push('');
      sections.push(prsSection);
    }

    const commentsSection = buildCommentsSection(comments);
    if (commentsSection) {
      sections.push('');
      sections.push(commentsSection);
    }

    sections.push('');
    return sections.join('\n');
  }
}
