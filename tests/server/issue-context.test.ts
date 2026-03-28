// =============================================================================
// Fleet Commander -- Issue Context Generator Tests
// =============================================================================
// Tests for the pure generateIssueContextMarkdown() function and its helpers:
//   - truncateAtParagraphBoundary
//   - truncateComment
//   - Full issue context generation
//   - Minimal issue context generation
//   - Body truncation with Acceptance Criteria preservation
//   - Comment truncation
//   - 16KB hard cap enforcement
//   - Unicode handling
//   - Deterministic output
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  generateIssueContextMarkdown,
  truncateAtParagraphBoundary,
  truncateComment,
  type IssueContextData,
} from '../../src/shared/issue-context.js';

// ---------------------------------------------------------------------------
// Helper: create a minimal valid IssueContextData
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<IssueContextData> = {}): IssueContextData {
  return {
    number: 42,
    title: 'Fix login bug',
    state: 'OPEN',
    repo: 'acme/widget',
    author: 'alice',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-16T14:30:00Z',
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// truncateAtParagraphBoundary
// ---------------------------------------------------------------------------

describe('truncateAtParagraphBoundary', () => {
  it('should return text unchanged when under the limit', () => {
    const text = 'Short text.';
    const result = truncateAtParagraphBoundary(text, 1024);
    expect(result.text).toBe('Short text.');
    expect(result.truncated).toBe(false);
  });

  it('should truncate at paragraph boundary when over the limit', () => {
    const paragraph1 = 'First paragraph.';
    const paragraph2 = 'Second paragraph that is longer and pushes us past the budget.';
    const text = `${paragraph1}\n\n${paragraph2}`;
    // Budget: enough for first paragraph + truncation marker but NOT both paragraphs
    const markerBytes = Buffer.byteLength('\n\n[... body truncated ...]', 'utf-8');
    const budget = Buffer.byteLength(paragraph1, 'utf-8') + markerBytes + 5;
    const result = truncateAtParagraphBoundary(text, budget);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('First paragraph.');
    expect(result.text).toContain('[... body truncated ...]');
    expect(result.text).not.toContain('Second paragraph');
  });

  it('should preserve Acceptance Criteria section when body exceeds limit', () => {
    const longPreamble = 'A'.repeat(10000);
    const acSection = '## Acceptance Criteria\n\n- [ ] Must work\n- [ ] Must pass tests';
    const text = `${longPreamble}\n\n${acSection}`;
    const result = truncateAtParagraphBoundary(text, 8192);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('## Acceptance Criteria');
    expect(result.text).toContain('Must work');
    expect(result.text).toContain('[... body truncated ...]');
  });

  it('should handle case-insensitive Acceptance Criteria heading', () => {
    const longPreamble = 'B'.repeat(10000);
    const acSection = '## acceptance criteria\n\n- [ ] Item one';
    const text = `${longPreamble}\n\n${acSection}`;
    const result = truncateAtParagraphBoundary(text, 8192);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('## acceptance criteria');
    expect(result.text).toContain('Item one');
  });

  it('should handle text with no paragraph breaks', () => {
    const text = 'x'.repeat(200);
    const result = truncateAtParagraphBoundary(text, 100);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('should handle empty text', () => {
    const result = truncateAtParagraphBoundary('', 1024);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('should handle unicode correctly (byte-based)', () => {
    // Each emoji is 4 bytes in UTF-8
    const emoji = '\u{1F600}'; // grinning face, 4 bytes
    const text = emoji.repeat(100); // 400 bytes
    const result = truncateAtParagraphBoundary(text, 50);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf-8')).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// truncateComment
// ---------------------------------------------------------------------------

describe('truncateComment', () => {
  it('should return comment unchanged when under the limit', () => {
    const result = truncateComment('Short comment.', 2048);
    expect(result.body).toBe('Short comment.');
    expect(result.truncated).toBe(false);
  });

  it('should truncate long comments', () => {
    const longBody = 'x'.repeat(3000);
    const result = truncateComment(longBody, 2048);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body, 'utf-8')).toBeLessThanOrEqual(2048);
    expect(result.body).toContain('[... comment truncated ...]');
  });

  it('should handle unicode in comments', () => {
    // CJK characters are 3 bytes each in UTF-8
    const cjk = '\u4e00'.repeat(1000); // 3000 bytes
    const result = truncateComment(cjk, 2048);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.body, 'utf-8')).toBeLessThanOrEqual(2048);
  });
});

// ---------------------------------------------------------------------------
// generateIssueContextMarkdown — minimal issue
// ---------------------------------------------------------------------------

describe('generateIssueContextMarkdown', () => {
  it('should generate valid output for a minimal issue', () => {
    const data = makeContext();
    const output = generateIssueContextMarkdown(data);

    // Should start with YAML frontmatter
    expect(output).toMatch(/^---\n/);
    expect(output).toContain('issue: 42');
    expect(output).toContain('state: OPEN');
    expect(output).toContain('repo: acme/widget');
    expect(output).toContain('author: alice');
    expect(output).toContain('---');

    // Should have title heading
    expect(output).toContain('# Issue #42: Fix login bug');

    // Should have description section with placeholder
    expect(output).toContain('## Description');
    expect(output).toContain('No description provided.');

    // Should NOT have empty sections
    expect(output).not.toContain('## Sub-issues');
    expect(output).not.toContain('## Blocked By');
    expect(output).not.toContain('## Blocking');
    expect(output).not.toContain('## Linked Pull Requests');
    expect(output).not.toContain('## Comments');
  });

  it('should generate full output with all sections', () => {
    const data = makeContext({
      labels: ['bug', 'priority:high'],
      assignees: ['bob', 'charlie'],
      milestone: 'v2.0',
      parent: { number: 10, title: 'Epic: Authentication' },
      children: [
        { number: 43, title: 'Subtask A', state: 'OPEN' },
        { number: 44, title: 'Subtask B', state: 'CLOSED' },
      ],
      blockedBy: [
        { number: 30, title: 'Setup DB', state: 'OPEN' },
      ],
      blocking: [
        { number: 50, title: 'Deploy', state: 'OPEN' },
      ],
      linkedPRs: [
        { number: 100, state: 'OPEN' },
      ],
      body: 'This is the issue body.\n\nWith multiple paragraphs.',
      comments: [
        { author: 'dave', date: '2025-01-16T12:00:00Z', body: 'Working on this.' },
        { author: 'eve', date: '2025-01-16T13:00:00Z', body: 'LGTM' },
      ],
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 2,
        includedComments: 2,
      },
    });

    const output = generateIssueContextMarkdown(data);

    // Frontmatter
    expect(output).toContain('labels: [bug, "priority:high"]');
    expect(output).toContain('assignees: [bob, charlie]');
    expect(output).toContain('milestone: v2.0');
    expect(output).toContain('parent: "#10 Epic: Authentication"');

    // Body
    expect(output).toContain('This is the issue body.');
    expect(output).toContain('With multiple paragraphs.');

    // All sections present
    expect(output).toContain('## Sub-issues');
    expect(output).toContain('#43: Subtask A [OPEN]');
    expect(output).toContain('#44: Subtask B [CLOSED]');

    expect(output).toContain('## Blocked By');
    expect(output).toContain('#30: Setup DB [OPEN]');

    expect(output).toContain('## Blocking');
    expect(output).toContain('#50: Deploy [OPEN]');

    expect(output).toContain('## Linked Pull Requests');
    expect(output).toContain('#100 [OPEN]');

    expect(output).toContain('## Comments');
    expect(output).toContain('@dave');
    expect(output).toContain('Working on this.');
    expect(output).toContain('@eve');
    expect(output).toContain('LGTM');
  });

  it('should produce valid YAML frontmatter', () => {
    const data = makeContext({
      title: 'Fix: "quoted" title with colons: and [brackets]',
      labels: ['bug', 'has:colon'],
    });
    const output = generateIssueContextMarkdown(data);

    // Frontmatter should be between --- markers
    const frontmatterMatch = output.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const fm = frontmatterMatch![1];

    // Title with special chars should be quoted
    expect(fm).toContain('title: "Fix: \\"quoted\\" title with colons: and [brackets]"');
  });

  it('should truncate body when it exceeds 8KB', () => {
    const largeBody = 'Long paragraph.\n\n'.repeat(600); // well over 8KB
    const data = makeContext({ body: largeBody });
    const output = generateIssueContextMarkdown(data);

    expect(output).toContain('[... body truncated ...]');
  });

  it('should truncate comments when they exceed 2KB each', () => {
    const longComment = 'x'.repeat(3000);
    const data = makeContext({
      comments: [
        { author: 'user', date: '2025-01-01T00:00:00Z', body: longComment },
      ],
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 1,
        includedComments: 1,
      },
    });
    const output = generateIssueContextMarkdown(data);

    expect(output).toContain('[... comment truncated ...]');
  });

  it('should enforce 16KB hard cap', () => {
    // Create data that would generate well over 16KB
    const largeBody = 'x'.repeat(8000);
    const comments = Array.from({ length: 10 }, (_, i) => ({
      author: `user${i}`,
      date: '2025-01-01T00:00:00Z',
      body: 'y'.repeat(2000),
    }));

    const data = makeContext({
      body: largeBody,
      comments,
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 10,
        includedComments: 10,
      },
    });

    const output = generateIssueContextMarkdown(data);
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(16384);
  });

  it('should omit Comments section when there are no comments', () => {
    const data = makeContext({ comments: [] });
    const output = generateIssueContextMarkdown(data);
    expect(output).not.toContain('## Comments');
  });

  it('should handle empty body', () => {
    const data = makeContext({ body: '' });
    const output = generateIssueContextMarkdown(data);
    expect(output).toContain('No description provided.');
  });

  it('should handle null-ish body', () => {
    const data = makeContext({ body: '' });
    const output = generateIssueContextMarkdown(data);
    expect(output).toContain('No description provided.');
  });

  it('should produce deterministic output', () => {
    const data = makeContext({
      body: 'Deterministic body content.',
      labels: ['bug'],
      comments: [
        { author: 'user', date: '2025-01-01T00:00:00Z', body: 'Comment body.' },
      ],
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 1,
        includedComments: 1,
      },
    });

    const output1 = generateIssueContextMarkdown(data);
    const output2 = generateIssueContextMarkdown(data);
    expect(output1).toBe(output2);
  });

  it('should handle unicode in body and comments', () => {
    const data = makeContext({
      body: 'Unicode: \u4e16\u754c \u{1F600} \u00e9\u00e8\u00ea',
      comments: [
        {
          author: 'user',
          date: '2025-01-01T00:00:00Z',
          body: 'Comment with \u{1F4A9} emoji',
        },
      ],
      truncation: {
        bodyTruncated: false,
        commentsTruncated: false,
        totalComments: 1,
        includedComments: 1,
      },
    });

    const output = generateIssueContextMarkdown(data);
    expect(output).toContain('\u4e16\u754c');
    expect(output).toContain('\u{1F600}');
    expect(output).toContain('\u{1F4A9}');
  });

  it('should preserve Acceptance Criteria when body is truncated', () => {
    const longPreamble = 'Description text.\n\n' + 'X'.repeat(9000);
    const acSection = '## Acceptance Criteria\n\n- [ ] Must work\n- [ ] Must pass';
    const body = `${longPreamble}\n\n${acSection}`;

    const data = makeContext({ body });
    const output = generateIssueContextMarkdown(data);

    expect(output).toContain('## Acceptance Criteria');
    expect(output).toContain('Must work');
    expect(output).toContain('[... body truncated ...]');
  });
});
