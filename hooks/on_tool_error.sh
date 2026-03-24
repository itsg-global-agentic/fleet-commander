#!/bin/sh
# fleet-commander v0.0.9
# Fleet Commander hook: PostToolUseFailure (aliased as "tool_error")
# Tracks tool failures — repeated errors indicate the team is struggling.
# stdin JSON example: {"session_id":"abc123","tool_name":"Bash","error":"exit code 1","tool_use_id":"toolu_123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | tool_error | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_error"
