#!/bin/sh
# fleet-commander v0.0.10
# Fleet Commander hook: WorktreeCreate
# Fires when CC creates a worktree for an isolated subagent.
# stdin JSON example: {"session_id":"abc123","worktree_path":"/path/to/worktree","teammate_name":"dev"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | worktree_create | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "worktree_create"
