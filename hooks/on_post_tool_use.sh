#!/bin/sh
# fleet-commander v0.0.9
# Fleet Commander hook: PostToolUse
# THE primary heartbeat signal. Every tool use proves the team is alive.
# Dashboard uses this to compute "last_seen" for stuck detection.
# stdin JSON example: {"session_id":"abc123","tool_name":"Bash","agent_type":"main"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | tool_use | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_use"
