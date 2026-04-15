// =============================================================================
// Fleet Commander — Workflow Template Size Ceiling Test
// =============================================================================
// Prevents templates/workflow.md from exceeding Claude Code's Read limit.
// The CC Read tool has a hard ~10,000-token limit. At ~3.73 chars/token,
// 35,000 chars corresponds to ~9,380 tokens — leaving ~620 tokens of headroom.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_CHARS = 35_000;

describe('workflow.md token ceiling', () => {
  it('must stay under 9500 tokens (~35000 chars)', () => {
    const workflowPath = resolve(__dirname, '../../templates/workflow.md');
    const content = readFileSync(workflowPath, 'utf-8');
    expect(content.length).toBeLessThan(MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Fix #692 (B) — `gh issue close` must not appear in the workflow template.
// The PR `Closes #N` footer auto-closes the issue on merge; an explicit
// `gh issue close` wastes a turn and yields `already closed` stderr noise.
// ---------------------------------------------------------------------------

describe('Fix #692 (B) — workflow must not instruct `gh issue close`', () => {
  const workflowPath = resolve(__dirname, '../../templates/workflow.md');
  const content = readFileSync(workflowPath, 'utf-8');

  it('does not contain an instruction to run `gh issue close`', () => {
    // Match the command invocation, not the "do NOT run gh issue close" note.
    // The positive instruction form is a line starting/containing a literal
    // `gh issue close {N}` with no preceding "NOT" / "Do NOT".
    const lines = content.split(/\r?\n/);
    const badLines = lines.filter((line) => {
      if (!line.includes('gh issue close')) return false;
      // Skip don't-do notes
      const lower = line.toLowerCase();
      if (lower.includes('not') || lower.includes('do not')) return false;
      return true;
    });
    expect(badLines).toEqual([]);
  });

  it('contains a note explicitly telling TLs NOT to run `gh issue close`', () => {
    // The replacement note must be present so future edits don't reintroduce
    // the bad instruction inadvertently.
    const hasNote = /do\s*\*?\*?\s*NOT\s*\*?\*?\s*run\s*`gh issue close`/i.test(content);
    expect(hasNote).toBe(true);
  });
});
