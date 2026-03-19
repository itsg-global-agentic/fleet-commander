#!/bin/sh
# Fleet Commander hook: StopFailure
# Fires when the agent stops due to rate limits or API errors.
# stdin JSON example: {"session_id":"abc123","error_details":"rate_limit","last_assistant_message":"..."}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "stop_failure"
