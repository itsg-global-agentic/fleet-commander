#!/bin/sh
# fleet-commander v0.0.19
# Fleet Commander hook: SessionStart
# Detects team startup. Captures session_id, worktree, model info.
# stdin JSON example: {"session_id":"abc123","agent_type":"main"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | session_start | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "session_start"
exit 0
