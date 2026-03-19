#!/bin/sh
# Fleet Commander hook: PostToolUseFailure (aliased as "tool_error")
# Tracks tool failures — repeated errors indicate the team is struggling.
# stdin JSON example: {"session_id":"abc123","tool_name":"Bash","error":"exit code 1","tool_use_id":"toolu_123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "tool_error"
