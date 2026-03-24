#!/bin/sh
# fleet-commander v0.0.9
# Fleet Commander hook: StopFailure
# Fires when the agent stops due to rate limits or API errors.
# stdin JSON example: {"session_id":"abc123","error_details":"rate_limit","last_assistant_message":"..."}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | stop_failure | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "stop_failure"
