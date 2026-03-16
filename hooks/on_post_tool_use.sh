#!/bin/sh
# Fleet Commander hook: PostToolUse
# THE primary heartbeat signal. Every tool use proves the team is alive.
# Dashboard uses this to compute "last_seen" for stuck detection.
# stdin JSON example: {"session_id":"abc123","tool_name":"Bash","agent_type":"main"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_use" &
