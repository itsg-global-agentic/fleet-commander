#!/bin/sh
# fleet-commander v0.0.20
# Fleet Commander hook: Notification
# Detects idle prompts, permission prompts, and other notifications.
# These are important for detecting teams that are stuck waiting for input.
# stdin JSON example: {"session_id":"abc123","message":"Permission requested..."}

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
_LOG="${FLEET_HOOK_LOG:-/tmp/fleet-hooks.log}"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) | HOOK  | notification | ${FLEET_TEAM_ID:-?} | cwd=$(pwd)" >> "$_LOG" 2>/dev/null || true
input=$(cat)
echo "$input" | "$HOOK_DIR/send_event.sh" "notification"
exit 0
