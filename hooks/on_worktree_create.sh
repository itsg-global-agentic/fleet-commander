#!/bin/sh
# fleet-commander v0.0.24
# Fleet Commander hook: WorktreeCreate
# Fires when CC creates a worktree via --worktree, EnterWorktree, or subagent isolation=worktree.
# stdin JSON example: {"session_id":"abc123","cwd":"/path/to/worktree","hookSpecificOutput":{"worktreePath":"/path/to/worktree"}}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | worktree_create | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "worktree_create"
exit 0
