#!/bin/sh
# fleet-commander v0.0.15
# Fleet Commander hook: TaskCreated
# Fires when an agent creates or updates a task via TaskCreate/TodoWrite.
# stdin JSON example: {"session_id":"abc123","task_id":"task_1","subject":"Implement feature","status":"in_progress"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | task_created | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "task_created"
exit 0
