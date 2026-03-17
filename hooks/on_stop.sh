#!/bin/sh
# Fleet Commander hook: Stop
# Fires when the main agent stops — could mean task complete, error, or stuck.
# stdin JSON example: {"session_id":"abc123","stop_reason":"end_turn"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "stop"
