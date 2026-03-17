#!/bin/sh
# Fleet Commander hook: SessionEnd
# Detects team finish. Clean shutdown signal.
# stdin JSON example: {"session_id":"abc123"}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "session_end"
