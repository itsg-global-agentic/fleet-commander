// =============================================================================
// Fleet Commander -- buildEventPayloadFromCc (issue #735)
// =============================================================================
// Round-trip parity tests: feeding the same CC stdin object through the
// shared `buildEventPayloadFromCc` helper must produce the same EventPayload
// as the legacy `buildPayloadFromCcStdin` wrapper in routes/events.ts. The
// HTTP hook route and the legacy bash-curl route both depend on this
// equivalence so behaviour stays bit-identical across transports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildEventPayloadFromCc } from '../../../src/server/utils/build-event-payload.js';
import { buildPayloadFromCcStdin } from '../../../src/server/routes/events.js';

/**
 * Build the legacy body shape (what the shell hook posts to /api/events)
 * from a CC stdin object, then run both code paths and compare.
 *
 * The shared helper does NOT preserve the original `cc_stdin` string (it
 * re-serializes the parsed object), whereas the legacy route preserves it
 * as-is. We assert on cc_stdin via JSON equivalence rather than string
 * equality so canonical JSON serialization differences don't trip the test.
 */
function assertParity(cc: Record<string, unknown>, eventType = 'tool_use', team = 'kea-100') {
  const legacy = buildPayloadFromCcStdin({
    event: eventType,
    team,
    cc_stdin: JSON.stringify(cc),
  });

  const shared = buildEventPayloadFromCc(cc, team, eventType);

  // Compare every field except cc_stdin (which has different but
  // semantically equivalent representations across the two paths).
  const stripCcStdin = ({ cc_stdin: _omit, ...rest }: typeof legacy) => rest;
  expect(stripCcStdin(shared)).toEqual(stripCcStdin(legacy));

  // cc_stdin must JSON-parse to the same object on both paths.
  expect(JSON.parse(shared.cc_stdin || '{}')).toEqual(JSON.parse(legacy.cc_stdin || '{}'));
}

describe('buildEventPayloadFromCc — round-trip parity with routes/events.ts', () => {
  it('matches for a SessionStart payload', () => {
    assertParity(
      {
        session_id: 'sess-1',
        cwd: '/repo/.claude/worktrees/kea-100',
        source: 'startup',
        model: 'claude-opus-4-7',
      },
      'session_start',
    );
  });

  it('matches for a PostToolUse Bash payload', () => {
    assertParity({
      session_id: 'sess-2',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr view 123', description: 'check PR' },
      agent_type: 'fleet-dev',
      duration_ms: 245,
    });
  });

  it('matches for a SendMessage payload (msg_to / msg_summary extraction)', () => {
    assertParity({
      session_id: 'sess-3',
      tool_name: 'SendMessage',
      tool_input: { to: 'reviewer', summary: 'Please review', body: 'long body...' },
      agent_type: 'fleet-dev',
    });
  });

  it('matches for a TaskCreated payload', () => {
    assertParity(
      {
        session_id: 'sess-4',
        task_id: 'task-42',
        subject: 'Implement feature X',
        description: 'see plan.md',
        status: 'pending',
        owner: 'fleet-planner',
        agent_id: 'agent-abc',
      },
      'task_created',
    );
  });

  it('matches for a Stop payload with background_tasks (CC 2.1.145+)', () => {
    assertParity(
      {
        session_id: 'sess-5',
        background_tasks: [
          { id: 't1', state: 'pending' },
          { id: 't2', state: 'pending' },
        ],
        last_assistant_message: 'shutting down',
      },
      'stop',
    );
  });

  it('matches for a SubagentStop payload with session_crons', () => {
    assertParity(
      {
        session_id: 'sess-6',
        teammate_name: 'fleet-dev',
        session_crons: [{ id: 'c1', cron: '*/5 * * * *' }],
      },
      'subagent_stop',
    );
  });

  it('matches for an empty CC object', () => {
    assertParity({}, 'session_start');
  });

  it('matches for a PostToolUseFailure payload with error fields', () => {
    assertParity(
      {
        session_id: 'sess-7',
        tool_name: 'Bash',
        tool_use_id: 'tu-1',
        error: 'exit 1',
        error_details: 'command failed',
        tool_input: { command: 'false' },
      },
      'tool_error',
    );
  });

  it('matches for a Notification payload', () => {
    assertParity(
      {
        session_id: 'sess-8',
        notification_type: 'stuck',
        message: 'No tool calls for 5 minutes',
      },
      'notification',
    );
  });

  it('rejects non-finite duration_ms (NaN / Infinity / string)', () => {
    // The legacy route accepts only finite numbers; the shared helper must too.
    const cc = {
      session_id: 'sess-9',
      tool_name: 'Read',
      duration_ms: 'not-a-number',
    };
    const payload = buildEventPayloadFromCc(cc, 'kea-100', 'tool_use');
    expect(payload.duration_ms).toBeUndefined();
  });

  it('stringifies object tool_input but preserves string tool_input as-is', () => {
    const objectInput = buildEventPayloadFromCc(
      { tool_name: 'Read', tool_input: { file_path: '/a/b/c' } },
      'kea-100',
      'tool_use',
    );
    expect(objectInput.tool_input).toBe(JSON.stringify({ file_path: '/a/b/c' }));

    const stringInput = buildEventPayloadFromCc(
      { tool_name: 'Read', tool_input: '{"file_path":"/x/y/z"}' },
      'kea-100',
      'tool_use',
    );
    expect(stringInput.tool_input).toBe('{"file_path":"/x/y/z"}');
  });

  it('always sets cc_stdin to the JSON-stringified ccBody (TaskCreated parser dependency)', () => {
    // The TaskCreated handler in event-collector calls `JSON.parse(payload.cc_stdin)`,
    // so cc_stdin MUST be set even on a minimal payload. Without it, task extraction
    // would silently no-op for the HTTP route.
    const cc = { task_id: 't-1', subject: 'x' };
    const payload = buildEventPayloadFromCc(cc, 'kea-100', 'task_created');
    expect(payload.cc_stdin).toBeDefined();
    expect(JSON.parse(payload.cc_stdin!)).toEqual(cc);
  });
});
